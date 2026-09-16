import type pg from 'pg';
import {preflightAttemptInTransaction,reserveAttemptInTransaction,REASONING_ADMISSION_LIMITS,type ClaimJobInput,type ReserveAttemptInput,type ReservedAttempt} from './reasoning-admission.js';
import {ReasoningDenied,type ReasoningAuthority} from './reasoning-runtime-policy.js';
import {FAIRNESS_CLASSES,FAIRNESS_WEIGHTS,fairnessCharge,fairnessClassCap,fairnessUniverseCap,validateFairnessPolicy,type FairnessClass,type SqlFairnessPolicy} from './reasoning-fairness-policy.js';

export type FairnessReadyInput=Omit<ReserveAttemptInput,'owner'|'leaseFence'>&{policyVersion:string;class:FairnessClass};
export type FairnessScheduleInput=ClaimJobInput&{policyVersion:string};
export type FairnessObservation={kind:'admitted'|'no_candidate'|'ineligible'|'impossible'|'temporarily_blocked'|'credit_wait'|'capacity_exhausted'|'policy_paused'|'scan_exhausted';reason?:string;jobId?:string;universeId?:string;class?:FairnessClass;queueAgeMs?:number;deadlineMissed?:boolean};
export type FairnessScheduled={kind:'admitted';claim:{jobId:string;universeId:string;privacyEpoch:number;leaseFence:string;leaseExpiresAt:Date};reserved:ReservedAttempt;charge:number;class:FairnessClass;observations:FairnessObservation[];probes:number};
export type FairnessNoWork={kind:Exclude<FairnessObservation['kind'],'admitted'>;observations:FairnessObservation[];probes:number};
export type ReasoningFairness={installPolicy(input:unknown):Promise<{version:string;hash:string}>;enqueue(input:FairnessReadyInput):Promise<void>;schedule(input:FairnessScheduleInput):Promise<FairnessScheduled|FairnessNoWork>};
type State={generation:string;class_cursor:number;paused:boolean;visit_generation:string;inner_generation:string};
type Lane={credit:string;remaining:string|null;universe_cursor:string|null;open_universe_id:string|null;universe_remaining:string;visit_generation:string;inner_generation:string};
type UniverseLane={universe_id:string;credit:string;candidate_cursor:string;ready_count:string};
type Ready=FairnessReadyInput&{seq:string;charge:string;queueAgeMs:number;deadlineMissed:boolean};
type Discovery={state:State;lane:Lane;klass:FairnessClass;universe:UniverseLane|undefined;ready:Ready|undefined};
const deny=(code:string):never=>{throw new ReasoningDenied(code);};
const nextClass=(klass:FairnessClass)=>(FAIRNESS_CLASSES.indexOf(klass)+1)%FAIRNESS_CLASSES.length;
const cap=(value:bigint,maximum:number)=>value>BigInt(maximum)?BigInt(maximum):value;
async function tx<T>(db:pg.Pool,body:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 const client=await db.connect();try{await client.query('BEGIN');const result=await body(client);await client.query('COMMIT');return result;}
 catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}
async function policyFor(db:pg.Pool|pg.PoolClient,version:string){
 const row=(await db.query('SELECT config,policy_hash FROM reasoning_fairness_policy WHERE version=$1',[version])).rows[0];
 if(!row)return deny('fairness_policy_missing');const value=validateFairnessPolicy(row.config);
 if(value.hash!==row.policy_hash||value.policy.version!==version)deny('fairness_policy_changed');return value;
}
const readyColumns=`r.job_id AS "jobId",r.step_id AS "stepId",r.context_id AS "contextId",r.universe_id AS "universeId",r.privacy_epoch AS "privacyEpoch",
 r.policy_version AS "policyVersion",r.class,r.request_id AS "requestId",r.request_hash AS "requestHash",r.input_tokens_upper_bound AS "inputTokensUpperBound",
 r.max_output_tokens AS "maxOutputTokens",r.cost_ceiling_micro_usd AS "costCeilingMicroUsd",r.deadline,r.permit_ttl_ms AS "permitTtlMs",r.seq,r.charge,
 GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-j.created_at))*1000)::double precision AS "queueAgeMs",
 (r.deadline<=clock_timestamp() OR j.deadline<=clock_timestamp()) AS "deadlineMissed"`;
function decode(row:Ready):Ready{return {...row,inputTokensUpperBound:Number(row.inputTokensUpperBound),maxOutputTokens:Number(row.maxOutputTokens),costCeilingMicroUsd:row.costCeilingMicroUsd===null?null:Number(row.costCeilingMicroUsd),deadline:new Date(row.deadline).toISOString()};}
/** Constant-size indexed probes; expired/ineligible heads are inspected, never
 * filtered through an unbounded scan before LIMIT. The generation is advisory.
 */
async function discover(db:pg.Pool,version:string,inspectHead=true):Promise<Discovery>{
 const state=(await db.query<State>('SELECT * FROM reasoning_fairness_scheduler WHERE policy_version=$1',[version])).rows[0];if(!state)return deny('fairness_policy_missing');
 const klass=FAIRNESS_CLASSES[state.class_cursor]!;
 const lane=(await db.query<Lane>('SELECT * FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2',[version,klass])).rows[0];if(!lane)return deny('fairness_lane_missing');
 if(!inspectHead)return {state,lane,klass,universe:undefined,ready:undefined};
 let universe:UniverseLane|undefined;
 if(lane.open_universe_id)universe=(await db.query<UniverseLane>('SELECT * FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND universe_id=$3 AND ready_count>0',[version,klass,lane.open_universe_id])).rows[0];
 if(!universe&&lane.universe_cursor)universe=(await db.query<UniverseLane>('SELECT * FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND ready_count>0 AND universe_id>$3 ORDER BY universe_id LIMIT 1',[version,klass,lane.universe_cursor])).rows[0];
 if(!universe)universe=(await db.query<UniverseLane>('SELECT * FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND ready_count>0 ORDER BY universe_id LIMIT 1',[version,klass])).rows[0];
 let ready:Ready|undefined;
 if(universe){
  const select=`SELECT ${readyColumns} FROM reasoning_fairness_ready r JOIN reasoning_job j ON j.id=r.job_id WHERE r.policy_version=$1 AND r.class=$2 AND r.universe_id=$3`;
  ready=(await db.query<Ready>(select+' AND r.seq>$4 ORDER BY r.seq LIMIT 1',[version,klass,universe.universe_id,universe.candidate_cursor])).rows[0];
  if(!ready)ready=(await db.query<Ready>(select+' ORDER BY r.seq LIMIT 1',[version,klass,universe.universe_id])).rows[0];
 }
 return {state,lane,klass,universe,ready:ready?decode(ready):undefined};
}
async function lockCursor(client:pg.PoolClient,version:string,d:Discovery):Promise<void>{
 const state=(await client.query<State>('SELECT * FROM reasoning_fairness_scheduler WHERE policy_version=$1 FOR UPDATE',[version])).rows[0];
 if(!state||state.generation!==d.state.generation||state.class_cursor!==d.state.class_cursor)return deny('fairness_cas_retry');
 if(state.paused)deny('fairness_policy_paused');
 await client.query('SELECT class FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2 FOR UPDATE',[version,d.klass]);
}
async function save(client:pg.PoolClient,version:string,d:Discovery,advance=false):Promise<void>{
 await client.query(`UPDATE reasoning_fairness_class SET credit=$3,remaining=$4,universe_cursor=$5,open_universe_id=$6,universe_remaining=$7,visit_generation=$8,inner_generation=$9 WHERE policy_version=$1 AND class=$2`,
  [version,d.klass,d.lane.credit,d.lane.remaining,d.lane.universe_cursor,d.lane.open_universe_id,d.lane.universe_remaining,d.lane.visit_generation,d.lane.inner_generation]);
 const changed=await client.query(`UPDATE reasoning_fairness_scheduler SET generation=generation+1,class_cursor=$3,visit_generation=$4,inner_generation=$5 WHERE policy_version=$1 AND generation=$2 RETURNING generation`,
  [version,d.state.generation,advance?nextClass(d.klass):d.state.class_cursor,d.state.visit_generation,d.state.inner_generation]);
 if(!changed.rowCount)deny('fairness_cas_retry');
}
function closeInner(d:Discovery){if(d.universe)d.lane.universe_cursor=d.universe.universe_id;d.lane.open_universe_id=null;d.lane.universe_remaining='0';}
async function dequeue(client:pg.PoolClient,version:string,d:Discovery){
 await client.query('DELETE FROM reasoning_fairness_ready WHERE job_id=$1',[d.ready!.jobId]);
 const u=(await client.query<UniverseLane>(`UPDATE reasoning_fairness_universe SET ready_count=ready_count-1,candidate_cursor=$4,
  credit=CASE WHEN ready_count=1 THEN LEAST(credit,0) ELSE credit END WHERE policy_version=$1 AND class=$2 AND universe_id=$3 AND ready_count>0 RETURNING *`,[version,d.klass,d.universe!.universe_id,d.ready!.seq])).rows[0];
 if(!u)return deny('fairness_ready_count_mismatch');d.universe=u;if(u.ready_count==='0')closeInner(d);
 if(!(await client.query('SELECT 1 FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND ready_count>0 LIMIT 1',[version,d.klass])).rowCount){d.lane.credit=String(BigInt(d.lane.credit)<0n?d.lane.credit:0);d.lane.remaining=null;closeInner(d);d.lane.universe_cursor=null;}
}
const observation=(d:Discovery,kind:FairnessObservation['kind'],reason?:string):FairnessObservation=>({kind,reason,class:d.klass,...(d.ready?{jobId:d.ready.jobId,universeId:d.ready.universeId,queueAgeMs:d.ready.queueAgeMs,deadlineMissed:d.ready.deadlineMissed}: {})});
async function bypass(client:pg.PoolClient,version:string,d:Discovery,remove=false){
 if(remove)await dequeue(client,version,d);
 else if(d.ready)await client.query('UPDATE reasoning_fairness_universe SET candidate_cursor=$4 WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[version,d.klass,d.ready.universeId,d.ready.seq]);
 closeInner(d);await save(client,version,d);
}
/** One inspected head/empty scope per transaction. Every successful claim, debit,
 * full reservation and Attempt/Permit is in this same transaction. A no-credit
 * visit can commit its earned quantum, but only after all physical guards pass.
 */
async function probe(db:pg.Pool,authority:ReasoningAuthority,input:FairnessScheduleInput,d:Discovery):Promise<{event:FairnessObservation;admitted?:Omit<FairnessScheduled,'observations'|'probes'>}>{
 return tx(db,async client=>{
  if(!d.universe){await lockCursor(client,input.policyVersion,d);d.lane.credit=String(BigInt(d.lane.credit)<0n?d.lane.credit:0);d.lane.remaining=null;closeInner(d);await save(client,input.policyVersion,d,true);return {event:observation(d,'no_candidate','empty_class')};}
  const domain=(await client.query<{privacy_epoch:number}>('SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE SKIP LOCKED',[d.universe.universe_id])).rows[0];
  if(!domain){await lockCursor(client,input.policyVersion,d);closeInner(d);await save(client,input.policyVersion,d);return {event:observation(d,'temporarily_blocked','universe_locked')};}
  if(!d.ready){await lockCursor(client,input.policyVersion,d);await client.query('UPDATE reasoning_fairness_universe SET ready_count=0,credit=LEAST(credit,0),candidate_cursor=0 WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[input.policyVersion,d.klass,d.universe.universe_id]);closeInner(d);await save(client,input.policyVersion,d);return {event:observation(d,'ineligible','empty_membership')};}
  // Private row locks precede the shared cursor and bucket namespace.
  const job=(await client.query('SELECT class,status,privacy_epoch,deadline FROM reasoning_job WHERE id=$1 FOR UPDATE',[d.ready.jobId])).rows[0];
  if(!job){deny('fairness_cas_retry');}
  if(job.class!==d.klass||job.status!=='queued'||domain.privacy_epoch!==d.ready.privacyEpoch||job.privacy_epoch!==domain.privacy_epoch||d.ready.deadlineMissed){
   await lockCursor(client,input.policyVersion,d);
   if(d.ready.deadlineMissed&&job.status==='queued')await client.query("UPDATE reasoning_job SET status='expired' WHERE id=$1",[d.ready.jobId]);
   await bypass(client,input.policyVersion,d,true);return {event:observation(d,'ineligible',d.ready.deadlineMissed?'deadline_missed':'stale_job')};
  }
  let locked=false;
  let preflight;
  try{
   preflight=await preflightAttemptInTransaction(client,authority,d.ready,async hook=>{await lockCursor(hook,input.policyVersion,d);locked=true;});
  }catch(error){
   if(!(error instanceof ReasoningDenied)||!['stale_context','unknown_step','step_not_pending','retry_not_supported','invalid_deadline','policy_limit_exceeded','policy_version_mismatch'].includes(error.code))throw error;
   if(!locked)await lockCursor(client,input.policyVersion,d);await bypass(client,input.policyVersion,d);return {event:observation(d,'ineligible',error.code)};
  }
  if(preflight.physicallyFits!=='fit'){
   const kind=preflight.physicallyFits==='impossible'?'impossible':preflight.physicallyFits==='paused'?'policy_paused':'capacity_exhausted';
   await bypass(client,input.policyVersion,d,kind==='impossible');return {event:observation(d,kind,'physical_vector')};
  }
  const {policy}=await policyFor(client,input.policyVersion);
  const charge=fairnessCharge(policy,d.ready.inputTokensUpperBound,d.ready.maxOutputTokens);
  if(BigInt(charge)!==BigInt(d.ready.charge))deny('fairness_charge_changed');
  const c=d.lane,u=d.universe;
  if(c.remaining===null){c.credit=cap(BigInt(c.credit)+BigInt(policy.quantum*FAIRNESS_WEIGHTS[d.klass]),fairnessClassCap(policy,d.klass)).toString();c.remaining=String(fairnessClassCap(policy,d.klass));d.state.visit_generation=(BigInt(d.state.visit_generation)+1n).toString();c.visit_generation=d.state.visit_generation;}
  if(c.open_universe_id!==u.universe_id){u.credit=cap(BigInt(u.credit)+BigInt(policy.quantum),fairnessUniverseCap(policy)).toString();c.open_universe_id=u.universe_id;c.universe_remaining=String(fairnessUniverseCap(policy));d.state.inner_generation=(BigInt(d.state.inner_generation)+1n).toString();c.inner_generation=d.state.inner_generation;}
  await client.query('UPDATE reasoning_fairness_universe SET credit=$4 WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[input.policyVersion,d.klass,u.universe_id,u.credit]);
  if(BigInt(charge)>BigInt(c.credit)||BigInt(charge)>BigInt(c.remaining)){
   c.remaining=null;await save(client,input.policyVersion,d,true);return {event:observation(d,'credit_wait','class_deficit_or_spend')};
  }
  if(BigInt(charge)>BigInt(u.credit)||BigInt(charge)>BigInt(c.universe_remaining)){
   closeInner(d);await save(client,input.policyVersion,d);return {event:observation(d,'credit_wait','universe_deficit_or_spend')};
  }
  const row=(await client.query(`UPDATE reasoning_job SET status='running',lease_owner=$2,lease_fence=lease_fence+1,lease_expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond') WHERE id=$1 AND status='queued' AND deadline>clock_timestamp() AND lease_fence<9223372036854775807 RETURNING lease_fence,lease_expires_at`,[d.ready.jobId,input.owner,input.leaseMs])).rows[0];
  if(!row)deny('expired_lease_or_job');
  const claim={jobId:d.ready.jobId,universeId:d.ready.universeId,privacyEpoch:d.ready.privacyEpoch,leaseFence:row.lease_fence as string,leaseExpiresAt:row.lease_expires_at as Date};
  const reserved=await reserveAttemptInTransaction(client,authority,{...d.ready,owner:input.owner,leaseFence:claim.leaseFence},async(_hook,resolved)=>{if(resolved.bindingHash!==preflight.bindingHash)deny('policy_binding_changed');});
  c.credit=(BigInt(c.credit)-BigInt(charge)).toString();c.remaining=(BigInt(c.remaining)-BigInt(charge)).toString();c.universe_remaining=(BigInt(c.universe_remaining)-BigInt(charge)).toString();u.credit=(BigInt(u.credit)-BigInt(charge)).toString();
  await client.query('UPDATE reasoning_fairness_universe SET credit=$4 WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[input.policyVersion,d.klass,u.universe_id,u.credit]);
  await client.query('INSERT INTO reasoning_fairness_attempt(attempt_id,policy_version,class,universe_id,reserved_charge,recognized_charge) VALUES($1,$2,$3,$4,$5,$5)',[reserved.attemptId,input.policyVersion,d.klass,u.universe_id,charge]);
  await dequeue(client,input.policyVersion,d);
  const closeClass=c.remaining===null||BigInt(c.remaining)===0n||BigInt(c.credit)<=0n;
  if(closeClass)c.remaining=null;
  if(c.open_universe_id&&(BigInt(c.universe_remaining)===0n||BigInt(d.universe!.credit)<=0n))closeInner(d);
  await save(client,input.policyVersion,d,closeClass);
  return {event:observation(d,'admitted'),admitted:{kind:'admitted',claim,reserved,charge,class:d.klass}};
 });
}

export function createReasoningFairness(db:pg.Pool,authority:ReasoningAuthority):ReasoningFairness{
 return {
  async installPolicy(input){const {policy,hash}=validateFairnessPolicy(input);await tx(db,async client=>{
   await client.query('INSERT INTO reasoning_fairness_policy(version,policy_hash,config) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[policy.version,hash,JSON.stringify(policy)]);
   if((await policyFor(client,policy.version)).hash!==hash)deny('fairness_policy_changed');
   await client.query('INSERT INTO reasoning_fairness_scheduler(policy_version) VALUES($1) ON CONFLICT DO NOTHING',[policy.version]);
   for(const klass of FAIRNESS_CLASSES)await client.query('INSERT INTO reasoning_fairness_class(policy_version,class) VALUES($1,$2) ON CONFLICT DO NOTHING',[policy.version,klass]);
  });return {version:policy.version,hash};},
  async enqueue(input){await tx(db,async client=>{
   const {policy}=await policyFor(client,input.policyVersion);if(!FAIRNESS_CLASSES.includes(input.class))deny('invalid_fairness_class');const charge=fairnessCharge(policy,input.inputTokensUpperBound,input.maxOutputTokens);
   const universe=(await client.query('SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',[input.universeId])).rows[0];if(universe?.privacy_epoch!==input.privacyEpoch)deny('stale_epoch');
   const job=(await client.query('SELECT * FROM reasoning_job WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];
   if(!job||job.universe_id!==input.universeId||job.privacy_epoch!==input.privacyEpoch||job.class!==input.class||job.status!=='queued'||job.policy_version!==input.policyVersion)deny('fairness_not_queueable');
   if(!(await client.query("SELECT 1 FROM reasoning_step WHERE id=$1 AND job_id=$2 AND context_id=$3 AND universe_id=$4 AND privacy_epoch=$5 AND status='pending' FOR UPDATE",[input.stepId,input.jobId,input.contextId,input.universeId,input.privacyEpoch])).rowCount)deny('fairness_not_queueable');
   await client.query('SELECT policy_version FROM reasoning_fairness_scheduler WHERE policy_version=$1 FOR UPDATE',[input.policyVersion]);
   await client.query('INSERT INTO reasoning_fairness_universe(policy_version,class,universe_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.policyVersion,input.class,input.universeId]);
   await client.query('UPDATE reasoning_fairness_universe SET credit=LEAST(credit,0) WHERE policy_version=$1 AND class=$2 AND universe_id=$3 AND ready_count=0',[input.policyVersion,input.class,input.universeId]);
   if(!(await client.query('SELECT 1 FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND ready_count>0 LIMIT 1',[input.policyVersion,input.class])).rowCount)await client.query('UPDATE reasoning_fairness_class SET credit=LEAST(credit,0),remaining=NULL,open_universe_id=NULL,universe_remaining=0 WHERE policy_version=$1 AND class=$2',[input.policyVersion,input.class]);
   await client.query(`INSERT INTO reasoning_fairness_ready(job_id,step_id,context_id,universe_id,privacy_epoch,class,policy_version,request_id,request_hash,input_tokens_upper_bound,max_output_tokens,cost_ceiling_micro_usd,deadline,permit_ttl_ms,charge) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[input.jobId,input.stepId,input.contextId,input.universeId,input.privacyEpoch,input.class,input.policyVersion,input.requestId,input.requestHash,input.inputTokensUpperBound,input.maxOutputTokens,input.costCeilingMicroUsd,input.deadline,input.permitTtlMs,charge]);
   await client.query('UPDATE reasoning_fairness_universe SET ready_count=ready_count+1 WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[input.policyVersion,input.class,input.universeId]);
   await client.query('UPDATE reasoning_fairness_scheduler SET generation=generation+1 WHERE policy_version=$1',[input.policyVersion]);
  });},
  async schedule(input){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(input.owner)||!Number.isInteger(input.leaseMs)||input.leaseMs<1||input.leaseMs>REASONING_ADMISSION_LIMITS.maxLeaseMs)deny('invalid_fairness_lease');
   const {policy}=await policyFor(db,input.policyVersion);const observations:FairnessObservation[]=[];let lastProgress:{generation:string;klass:FairnessClass}|undefined;
   for(let probes=1;probes<=policy.maxProbes;probes++){
    const d=await discover(db,input.policyVersion);
    if(d.state.paused)return {kind:'policy_paused',observations:[...observations,observation(d,'policy_paused')],probes};
    try{const result=await probe(db,authority,input,d);lastProgress={generation:(BigInt(d.state.generation)+1n).toString(),klass:d.klass};observations.push(result.event);if(result.admitted)return {...result.admitted,observations,probes};}
    catch(error){if(!(error instanceof ReasoningDenied)||!['fairness_cas_retry','fairness_policy_paused','policy_binding_changed','expired_lease_or_job'].includes(error.code))throw error;observations.push(observation(d,error.code==='fairness_policy_paused'?'policy_paused':'temporarily_blocked',error.code));}
   }
   // A bounded scan cannot establish absence. Yield its current class opportunity
   // without granting a quantum or resetting any unfinished spend allowance.
   const d=await discover(db,input.policyVersion,false);
   try{if(lastProgress?.generation===d.state.generation&&lastProgress.klass===d.klass)await tx(db,async client=>{await lockCursor(client,input.policyVersion,d);await save(client,input.policyVersion,d,true);});}catch(error){if(!(error instanceof ReasoningDenied)||!['fairness_cas_retry','fairness_policy_paused'].includes(error.code))throw error;}
   const distinct=new Set(observations.map(x=>x.kind));const kind=distinct.size===1&&observations[0]!.kind!=='no_candidate'?observations[0]!.kind:'scan_exhausted';
   return {kind:kind as FairnessNoWork['kind'],observations:[...observations,{kind:'scan_exhausted',reason:'probe_budget'}],probes:policy.maxProbes};
  },
 };
}
