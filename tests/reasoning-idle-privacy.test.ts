import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {authenticateAndLock} from '../packages/db/src/identity.ts';
import {cancelIdleDirectJob, expireIdleDirectJob} from '../packages/db/src/reasoning-idle-lifecycle.ts';
import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {compileDirectContext, createDirectContextAuthority} from '../packages/db/src/reasoning-context.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {appendRestrictedReasoningReceipt} from '../packages/db/src/reasoning-storage.ts';
import {
  attachPendingStep,
  inTransaction,
  seedDirectContextGraph,
  withReasoningContextSchema,
  type DirectContextGraph,
} from './helpers/reasoning-context-fixture.ts';

type SealedGraph=DirectContextGraph&{token:string;stepId:string};

const tokenHash=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
const resolverFor=(graph:DirectContextGraph)=>async()=>graph.policy;
const fairnessPolicy=(version:string)=>({version,quantum:100,maxCharge:100,scale:100,
 basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1,
});

async function retoken(pool:pg.Pool,sessionId:string):Promise<string> {
 const token=randomBytes(32).toString('base64url');
 await pool.query('UPDATE device_session SET token_hash=$1 WHERE id=$2',[tokenHash(token),sessionId]);
 return token;
}

async function addSession(pool:pg.Pool,universeId:string):Promise<{token:string;sessionId:string}> {
 const token=randomBytes(32).toString('base64url'),sessionId=randomUUID();
 await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
  VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,[sessionId,universeId,randomUUID(),tokenHash(token)]);
 return {token,sessionId};
}

async function seal(pool:pg.Pool):Promise<SealedGraph> {
 const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
 await inTransaction(pool,client=>compileDirectContext(client,graph.scope,{
  contextId:graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds,
 },resolverFor(graph)));
 const stepId=await attachPendingStep(pool,graph);
 return {...graph,token,stepId};
}

async function cancel(pool:pg.Pool,token:string,jobId:string) {
 return inTransaction(pool,async client=>cancelIdleDirectJob(client,await authenticateAndLock(client,token),{jobId}));
}

async function expire(pool:pg.Pool,graph:SealedGraph) {
 return inTransaction(pool,client=>expireIdleDirectJob(client,{
  jobId:graph.jobId,universeId:graph.scope.universeId,privacyEpoch:graph.scope.privacyEpoch,
 }));
}

async function count(pool:pg.Pool,table:string,column:string,value:string):Promise<number> {
 return (await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,[value])).rows[0]!.count;
}

async function waitForBlocked(pool:pg.Pool,blockerPid:number,label:string):Promise<void> {
 const until=Date.now()+5_000;
 while(Date.now()<until) {
  if((await pool.query(`SELECT 1 FROM pg_stat_activity
    WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,[blockerPid])).rowCount) return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail(`did not observe ${label} lock wait`);
}

async function waitForDbTime(pool:pg.Pool,deadline:Date,label:string):Promise<void> {
 const until=Date.now()+5_000;
 while(Date.now()<until) {
  if((await pool.query<{elapsed:boolean}>('SELECT clock_timestamp()>=$1 AS elapsed',[deadline])).rows[0]!.elapsed) return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail(`database clock did not pass ${label}`);
}

async function backendPid(client:pg.PoolClient):Promise<number> {
 return Number((await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
}

async function ageWithdrawal(pool:pg.Pool,jobId:string):Promise<void> {
 await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
 try {await pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '169 hours' WHERE id=$1",[jobId]);}
 finally {await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');}
}

test('idle direct cancellation is bound to the original live session and is replay-safe',async()=>{
 await withReasoningContextSchema('idle_original_session',async pool=>{
  const graph=await seal(pool),other=await addSession(pool,graph.scope.universeId);
  await assert.rejects(cancel(pool,other.token,graph.jobId),error=>error instanceof ReasoningDenied&&error.code==='idle_original_session_required');
  assert.deepEqual(await cancel(pool,graph.token,graph.jobId),{
   status:'cancelled',changed:true,closedNotSent:0,preservedUnknown:0,
  });
  assert.deepEqual(await cancel(pool,graph.token,graph.jobId),{
   status:'cancelled',changed:false,closedNotSent:0,preservedUnknown:0,
  });
  assert.deepEqual((await pool.query('SELECT status,lease_fence::text,withdrawn_at IS NOT NULL AS stamped FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0],{
   status:'cancelled',lease_fence:'1',stamped:true,
  });
  await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
  await assert.rejects(cancel(pool,graph.token,graph.jobId),/Unauthorized/);
 });
});

test('a cancellation waiting on fair resources rechecks the original session against database time',async()=>{
 await withReasoningContextSchema('idle_resource_expiry',async pool=>{
  const graph=await seal(pool),authority=createDirectContextAuthority(resolverFor(graph));
  const fairness=createReasoningFairness(pool,authority),version=graph.policy.policyVersion;
  await fairness.installPolicy(fairnessPolicy(version));
  const requestId=randomUUID(),requestHash='a'.repeat(64);
  await fairness.enqueue({policyVersion:version,class:'interactive',universeId:graph.scope.universeId,
   privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,requestId,requestHash,
   inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,
   deadline:new Date(Date.now()+60_000).toISOString(),permitTtlMs:30_000,
  });
  const expiresAt=(await pool.query<{expires_at:Date}>("UPDATE device_session SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at",[graph.scope.sessionId])).rows[0]!.expires_at;
  const blocker=await pool.connect();let open=true;
  let pending:Promise<unknown>|undefined;
  try {
   await blocker.query('BEGIN');
   await blocker.query('SELECT policy_version FROM reasoning_fairness_scheduler WHERE policy_version=$1 FOR UPDATE',[version]);
   pending=cancel(pool,graph.token,graph.jobId);void pending.catch(()=>undefined);
   await waitForBlocked(pool,await backendPid(blocker),'fairness scheduler');
   await waitForDbTime(pool,expiresAt,'session expiry');
   await blocker.query('COMMIT');open=false;
   await assert.rejects(pending,error=>error instanceof ReasoningDenied&&error.code==='idle_session_authority');
  } finally {
   if(open) await blocker.query('ROLLBACK');
   blocker.release();
   if(pending) await pending.catch(()=>undefined);
  }
  assert.deepEqual((await pool.query('SELECT status,withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0],{status:'queued',withdrawn_at:null});
  assert.equal(await count(pool,'reasoning_fairness_ready','job_id',graph.jobId),1);
 });
});

test('a healthy claim refuses cancellation, while recovered unknown work expires without refunding its liability',async()=>{
 await withReasoningContextSchema('idle_healthy_and_unknown',async pool=>{
  const graph=await seal(pool),authority=createDirectContextAuthority(resolverFor(graph));
  const admission=createReasoningAdmission(pool,authority),claim=await admission.claimJob({owner:'idle-privacy-worker',leaseMs:60_000});
  assert(claim&&claim.jobId===graph.jobId);
  await assert.rejects(cancel(pool,graph.token,graph.jobId),error=>error instanceof ReasoningDenied&&error.code==='idle_job_ineligible');
  const requestId=randomUUID(),requestHash='b'.repeat(64),requestDeadline=new Date(Date.now()+60_000).toISOString();
  const reserved=await admission.reserveAttempt({universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,
   stepId:graph.stepId,contextId:graph.contextId,owner:'idle-privacy-worker',leaseFence:claim.leaseFence,
   requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline:requestDeadline,permitTtlMs:30_000,
  });
  const dispatchId=randomUUID();
  await admission.authorizeDispatch({universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,
   attemptId:reserved.attemptId,owner:'idle-privacy-worker',leaseFence:claim.leaseFence,requestId,requestHash,
   inputTokensUpperBound:1,maxOutputTokens:1,dispatchId,
  });
  await pool.query("UPDATE reasoning_job SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[graph.jobId]);
  assert.equal((await admission.recoverAttempt({universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,
   stepId:graph.stepId,attemptId:reserved.attemptId,owner:'idle-privacy-worker'})).outcome,'unknown');
  await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[graph.jobId]);
  assert.deepEqual(await expire(pool,graph),{status:'expired',changed:true,closedNotSent:0,preservedUnknown:1});
  assert.deepEqual((await pool.query('SELECT state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.attemptId])).rows[0],{
   state:'unknown',output_authority:'withdrawn',liability_state:'held',remote_state:'held',
  });
  await ageWithdrawal(pool,graph.jobId);
  assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:2})).retiredJobs,1);
  const receipt={version:1,receiptId:randomUUID(),attemptId:reserved.attemptId,dispatchId,requestId,
   routeId:reserved.routeId,routeProfileVersion:reserved.routeProfileVersion,evidenceKind:'original_transport',
   observedAt:new Date().toISOString(),remoteDisposition:'terminal',outcome:'success',httpStatus:200,
   usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:1},
  };
  assert.equal((await inTransaction(pool,client=>appendRestrictedReasoningReceipt(client,receipt,'worker'))).replayed,false);
  assert.deepEqual((await pool.query('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1',[reserved.attemptId])).rows[0],{state:'responded',output_authority:'withdrawn'});
  assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
 });
});

test('Clear History wins an idle-expiry universe wait and closure rollback leaves no partial withdrawal',async()=>{
 await withReasoningContextSchema('idle_clear_and_rollback',async pool=>{
  const graph=await seal(pool);
  await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[graph.jobId]);
  const clearer=await pool.connect();let clearOpen=true;
  let pending:Promise<unknown>|undefined;
  try {
   await clearer.query('BEGIN');
   const scope=await authenticateAndLock(clearer,graph.token);
   await clearScrollHistory(clearer,scope,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
   pending=expire(pool,graph);void pending.catch(()=>undefined);
   await waitForBlocked(pool,await backendPid(clearer),'Clear History universe');
   await clearer.query('COMMIT');clearOpen=false;
   await assert.rejects(pending,error=>error instanceof ReasoningDenied&&['idle_stale_epoch','idle_unknown_job'].includes(error.code));
  } finally {
   if(clearOpen) await clearer.query('ROLLBACK');
   clearer.release();
   if(pending) await pending.catch(()=>undefined);
  }
  assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);

  const rollback=await seal(pool);
  await pool.query("CREATE FUNCTION reject_idle_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced idle rollback'; END $$");
  await pool.query('CREATE TRIGGER reject_idle_stamp BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_idle_stamp()');
  try {await assert.rejects(cancel(pool,rollback.token,rollback.jobId),/forced idle rollback/);}
  finally {
   await pool.query('DROP TRIGGER reject_idle_stamp ON reasoning_job');
   await pool.query('DROP FUNCTION reject_idle_stamp()');
  }
  assert.deepEqual((await pool.query('SELECT status,lease_fence::text,withdrawn_at FROM reasoning_job WHERE id=$1',[rollback.jobId])).rows[0],{
   status:'queued',lease_fence:'0',withdrawn_at:null,
  });
  assert.equal((await pool.query('SELECT status FROM reasoning_step WHERE id=$1',[rollback.stepId])).rows[0]!.status,'pending');
 });
});

test('seven-day retirement erases private direct state while explicit Ask replay remains source-only',async()=>{
 await withReasoningContextSchema('idle_retirement_ask_source',async pool=>{
  const graph=await seal(pool),clientAskId=randomUUID(),question='  Keep this literal Ask source after private retirement.  ';
  const ask=await inTransaction(pool,async client=>{
   const scope=await authenticateAndLock(client,graph.token);
   return recordExplicitAsk(client,scope,{clientAskId,exposureId:graph.exposureId,expectedPrivacyEpoch:0,question});
  });
  await pool.query('UPDATE reasoning_job SET intent_id=$1 WHERE id=$2',[ask.askId,graph.jobId]);
  await cancel(pool,graph.token,graph.jobId);
  await ageWithdrawal(pool,graph.jobId);
  assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:2})).retiredJobs,1);
  const replay=await inTransaction(pool,async client=>{
   const scope=await authenticateAndLock(client,graph.token);
   return recordExplicitAsk(client,scope,{clientAskId,exposureId:graph.exposureId,expectedPrivacyEpoch:0,question});
  });
  assert.deepEqual(replay,ask);
  assert.equal(await count(pool,'explicit_ask','id',ask.askId),1);
  for(const [table,column,value] of [
   ['reasoning_job','id',graph.jobId],['reasoning_context','id',graph.contextId],
   ['reasoning_context_job_session','job_id',graph.jobId],['reasoning_step','job_id',graph.jobId],
  ] as const) assert.equal(await count(pool,table,column,value),0,table);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_accounting WHERE universe_id=$1',[graph.scope.universeId])).rows[0]!.count,0);
 });
});
