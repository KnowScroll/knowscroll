import {randomUUID} from 'node:crypto';
import type pg from 'pg';

import {reserveAttemptInTransaction, type ClaimJobInput, type ReserveAttemptInput, type ReservedAttempt} from './reasoning-admission.js';
import {ReasoningDenied, type ReasoningAuthority} from './reasoning-runtime-policy.js';
import {FAIRNESS_CLASSES, FAIRNESS_WEIGHTS, fairnessCharge, fairnessClassCap, fairnessUniverseCap, validateFairnessPolicy, type FairnessClass, type SqlFairnessPolicy} from './reasoning-fairness-policy.js';

export type FairnessReadyInput = Omit<ReserveAttemptInput, 'owner' | 'leaseFence'> & {policyVersion: string; class: FairnessClass};
export type FairnessScheduleInput = ClaimJobInput & {policyVersion: string};
export type FairnessScheduled = {kind: 'admitted'; claim: {jobId: string; universeId: string; privacyEpoch: number; leaseFence: string; leaseExpiresAt: Date}; reserved: ReservedAttempt; charge: number; class: FairnessClass};
export type FairnessNoWork = {kind: 'no_candidate' | 'temporarily_blocked' | 'credit_wait' | 'capacity_exhausted' | 'policy_paused' | 'scan_exhausted'};
export type ReasoningFairness = {
  installPolicy(input: unknown): Promise<{version: string; hash: string}>;
  enqueue(input: FairnessReadyInput): Promise<void>;
  schedule(input: FairnessScheduleInput): Promise<FairnessScheduled | FairnessNoWork>;
};

type Ready = FairnessReadyInput & {seq: string; charge: string};
type Scheduler = {generation: string; class_cursor: number; paused: boolean};
type Lane = {credit: string; universe_cursor: string | null; remaining: string | null; open_universe_id: string | null; universe_remaining: string; visit_generation: string; inner_generation: string};
const max = 9007199254740991n;
const add = (a: bigint, b: bigint) => { const v = a + b; if (v > max || v < -max) throw new ReasoningDenied('fairness_credit_overflow'); return v; };
const cap = (value: bigint, ceiling: number) => value > BigInt(ceiling) ? BigInt(ceiling) : value;
const denied = (code: string): never => { throw new ReasoningDenied(code); };

async function tx<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}

function checkedPolicy(raw: unknown): {policy: SqlFairnessPolicy; hash: string} { return validateFairnessPolicy(raw); }

async function policyFor(client: pg.PoolClient, version: string): Promise<{policy: SqlFairnessPolicy; hash: string}> {
  const row = (await client.query<{policy_hash: string; config: unknown}>('SELECT policy_hash,config FROM reasoning_fairness_policy WHERE version=$1', [version])).rows[0];
  if (!row) return denied('fairness_policy_missing');
  const value = checkedPolicy(row.config);
  if (value.policy.version !== version || value.hash !== row.policy_hash) denied('fairness_policy_changed');
  return value;
}

async function lockCandidateUniverse(client: pg.PoolClient, universeId: string, epoch: number): Promise<boolean> {
  const locked = await client.query('SELECT id FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE SKIP LOCKED', [universeId, epoch]);
  return locked.rowCount === 1;
}

const readyColumns = `r.job_id AS "jobId",r.step_id AS "stepId",r.context_id AS "contextId",r.universe_id AS "universeId",
 r.privacy_epoch AS "privacyEpoch",r.class,r.policy_version AS "policyVersion",r.request_id AS "requestId",r.request_hash AS "requestHash",
 r.input_tokens_upper_bound AS "inputTokensUpperBound",r.max_output_tokens AS "maxOutputTokens",r.cost_ceiling_micro_usd AS "costCeilingMicroUsd",
 r.deadline,r.permit_ttl_ms AS "permitTtlMs",r.seq::text AS seq,r.charge::text AS charge`;

async function candidatesForClass(client: pg.PoolClient, policyVersion: string, klass: FairnessClass, probes: number): Promise<Ready[]> {
  const result = await client.query<Ready>(`SELECT * FROM (
    SELECT DISTINCT ON (r.universe_id) ${readyColumns}
    FROM reasoning_fairness_ready r JOIN reasoning_job j ON j.id=r.job_id
    JOIN reasoning_fairness_universe u ON (u.policy_version,u.class,u.universe_id)=(r.policy_version,r.class,r.universe_id)
    WHERE r.policy_version=$1 AND r.class=$2 AND j.status='queued' AND j.privacy_epoch=r.privacy_epoch AND r.deadline>clock_timestamp()
    ORDER BY r.universe_id,CASE WHEN r.seq>u.candidate_cursor THEN 0 ELSE 1 END,r.seq
  ) ready ORDER BY "universeId" LIMIT $3`, [policyVersion,klass,probes]);
  return result.rows;
}

async function advanceEmptyClass(db: pg.Pool, policyVersion: string, observedGeneration: string, klass: FairnessClass): Promise<boolean> {
  return tx(db, async client => {
    const changed = await client.query(`UPDATE reasoning_fairness_scheduler SET generation=generation+1,class_cursor=$3
      WHERE policy_version=$1 AND generation=$2::bigint RETURNING policy_version`, [policyVersion,observedGeneration,(FAIRNESS_CLASSES.indexOf(klass)+1)%FAIRNESS_CLASSES.length]);
    if (!changed.rowCount) return false;
    await client.query(`UPDATE reasoning_fairness_class SET credit=LEAST(credit,0),remaining=NULL,open_universe_id=NULL,universe_remaining=0
      WHERE policy_version=$1 AND class=$2`, [policyVersion,klass]);
    return true;
  });
}

/** Credit earns on a durable visit, independently of physical reservation. It
 * never advances a permit/job and therefore a later failed reserve spends none. */
async function prepareVisit(db: pg.Pool, policyVersion: string, candidate: Ready): Promise<void> {
  await tx(db, async client => {
    const {policy} = await policyFor(client, policyVersion);
    if (!await lockCandidateUniverse(client,candidate.universeId,candidate.privacyEpoch)) denied('fairness_scope_locked');
    await client.query('SELECT policy_version FROM reasoning_fairness_scheduler WHERE policy_version=$1 FOR UPDATE', [policyVersion]);
    const lane=(await client.query<Lane>('SELECT credit,universe_cursor::text,remaining,open_universe_id::text,universe_remaining,visit_generation,inner_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2 FOR UPDATE',[policyVersion,candidate.class])).rows[0];
    const universe=(await client.query<{credit:string}>('SELECT credit FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND universe_id=$3 FOR UPDATE',[policyVersion,candidate.class,candidate.universeId])).rows[0];
    if(!lane||!universe) return denied('fairness_lane_missing');
    const newClass=lane.remaining===null;
    const newUniverse=newClass||lane.open_universe_id!==candidate.universeId;
    let cc=BigInt(lane.credit),uc=BigInt(universe.credit),remaining=lane.remaining===null?BigInt(fairnessClassCap(policy,candidate.class)):BigInt(lane.remaining),ur=BigInt(lane.universe_remaining);
    if(newClass) cc=cap(add(cc,BigInt(policy.quantum*FAIRNESS_WEIGHTS[candidate.class])),fairnessClassCap(policy,candidate.class));
    if(newUniverse) {uc=cap(add(uc,BigInt(policy.quantum)),fairnessUniverseCap(policy));ur=BigInt(fairnessUniverseCap(policy));}
    await client.query(`UPDATE reasoning_fairness_class SET credit=$3::bigint,remaining=$4::bigint,open_universe_id=$5,universe_remaining=$6::bigint,
      visit_generation=visit_generation+$7,inner_generation=inner_generation+$8 WHERE policy_version=$1 AND class=$2`,[policyVersion,candidate.class,cc.toString(),remaining.toString(),candidate.universeId,ur.toString(),newClass?1:0,newUniverse?1:0]);
    await client.query('UPDATE reasoning_fairness_universe SET credit=$4::bigint WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[policyVersion,candidate.class,candidate.universeId,uc.toString()]);
  });
}

function nextClass(cursor: number, open: FairnessClass | null): FairnessClass {
  return open ?? FAIRNESS_CLASSES[cursor]!;
}

/** Durable, bounded two-level DRR. Discovery is deliberately advisory; the hook
 * CASes the scheduler generation after the selected universe/job is locked. */
export function createReasoningFairness(db: pg.Pool, authority: ReasoningAuthority): ReasoningFairness {
  return {
    async installPolicy(input) {
      const {policy, hash} = checkedPolicy(input);
      await tx(db, async client => {
        const old = (await client.query<{policy_hash: string}>('SELECT policy_hash FROM reasoning_fairness_policy WHERE version=$1', [policy.version])).rows[0];
        if (old) { if (old.policy_hash !== hash) denied('fairness_policy_changed'); return; }
        await client.query('INSERT INTO reasoning_fairness_policy(version,policy_hash,config) VALUES($1,$2,$3::jsonb)', [policy.version, hash, JSON.stringify(policy)]);
        await client.query('INSERT INTO reasoning_fairness_scheduler(policy_version) VALUES($1)', [policy.version]);
        for (const klass of FAIRNESS_CLASSES) await client.query('INSERT INTO reasoning_fairness_class(policy_version,class) VALUES($1,$2)', [policy.version, klass]);
      });
      return {version: policy.version, hash};
    },

    async enqueue(input) {
      await tx(db, async client => {
        const {policy} = await policyFor(client, input.policyVersion);
        if (!FAIRNESS_CLASSES.includes(input.class)) denied('invalid_fairness_class');
        const charge = fairnessCharge(policy, input.inputTokensUpperBound, input.maxOutputTokens);
        const universe = await client.query<{privacy_epoch:number}>('SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',[input.universeId]);
        if(universe.rows[0]?.privacy_epoch!==input.privacyEpoch) denied('stale_epoch');
        const job = (await client.query<{class: FairnessClass; universe_id: string; privacy_epoch: number; status: string; policy_version: string}>('SELECT class,universe_id,privacy_epoch,status,policy_version FROM reasoning_job WHERE id=$1 FOR UPDATE', [input.jobId])).rows[0];
        if (!job || job.class !== input.class || job.universe_id !== input.universeId || job.privacy_epoch !== input.privacyEpoch || job.status !== 'queued' || job.policy_version !== input.policyVersion) denied('fairness_not_queueable');
        const valid = await client.query('SELECT 1 FROM reasoning_step WHERE id=$1 AND job_id=$2 AND context_id=$3 AND universe_id=$4 AND privacy_epoch=$5 AND status=\'pending\'', [input.stepId,input.jobId,input.contextId,input.universeId,input.privacyEpoch]);
        if (!valid.rowCount) denied('fairness_not_queueable');
        await client.query('INSERT INTO reasoning_fairness_universe(policy_version,class,universe_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [input.policyVersion,input.class,input.universeId]);
        await client.query(`INSERT INTO reasoning_fairness_ready
          (job_id,step_id,context_id,universe_id,privacy_epoch,class,policy_version,request_id,request_hash,input_tokens_upper_bound,max_output_tokens,cost_ceiling_micro_usd,deadline,permit_ttl_ms,charge)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14,$15)`,
          [input.jobId,input.stepId,input.contextId,input.universeId,input.privacyEpoch,input.class,input.policyVersion,input.requestId,input.requestHash,input.inputTokensUpperBound,input.maxOutputTokens,input.costCeilingMicroUsd,input.deadline,input.permitTtlMs,charge]);
      });
    },

    async schedule(input) {
      for (let outer=0; outer<8; outer+=1) {
        const snapshot=await tx(db,async client=> {
          const {policy}=await policyFor(client,input.policyVersion);
          const scheduler=(await client.query<Scheduler>('SELECT generation,class_cursor,paused FROM reasoning_fairness_scheduler WHERE policy_version=$1',[input.policyVersion])).rows[0];
          if(!scheduler) return denied('fairness_policy_missing');
          if(scheduler.paused) return {policy,scheduler,candidate:null,klass:null};
          const open=(await client.query<{class:FairnessClass}>('SELECT class FROM reasoning_fairness_class WHERE policy_version=$1 AND remaining IS NOT NULL ORDER BY visit_generation LIMIT 1',[input.policyVersion])).rows[0]?.class??null;
          const klass=nextClass(scheduler.class_cursor,open);
          const all=await candidatesForClass(client,input.policyVersion,klass,policy.maxProbes);
          if(!all.length) return {policy,scheduler,candidate:null,klass};
          const lane=(await client.query<Lane>('SELECT credit,universe_cursor::text,remaining,open_universe_id::text,universe_remaining,visit_generation,inner_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2',[input.policyVersion,klass])).rows[0];
          if(!lane) return denied('fairness_lane_missing');
          const cursor=lane.universe_cursor;
          const start=cursor?Math.max(0,all.findIndex(row=>row.universeId>cursor)):0;
          return {policy,scheduler,candidate:all[start<0?0:start]!,klass};
        });
        if(snapshot.scheduler.paused) return {kind:'policy_paused'};
        if(!snapshot.candidate||!snapshot.klass) {
          if(snapshot.klass&&await advanceEmptyClass(db,input.policyVersion,snapshot.scheduler.generation,snapshot.klass)) continue;
          return {kind:'no_candidate'};
        }
        try { await prepareVisit(db,input.policyVersion,snapshot.candidate); }
        catch(error) { if(error instanceof ReasoningDenied&&error.code==='fairness_scope_locked') return {kind:'temporarily_blocked'}; throw error; }
        try {
          return await tx(db,async client=> {
            const scheduler=(await client.query<Scheduler>('SELECT generation,class_cursor,paused FROM reasoning_fairness_scheduler WHERE policy_version=$1',[input.policyVersion])).rows[0];
            if(!scheduler) return denied('fairness_policy_missing'); if(scheduler.paused) return {kind:'policy_paused'} as FairnessNoWork;
            const liveRows=await candidatesForClass(client,input.policyVersion,snapshot.klass!,snapshot.policy.maxProbes);
            const live=liveRows.find(row=>row.jobId===snapshot.candidate!.jobId);
            if(!live) return {kind:'temporarily_blocked'} as FairnessNoWork;
            if(!await lockCandidateUniverse(client,live.universeId,live.privacyEpoch)) return {kind:'temporarily_blocked'} as FairnessNoWork;
            const current=(await client.query<Ready>(`SELECT ${readyColumns} FROM reasoning_fairness_ready r JOIN reasoning_job j ON j.id=r.job_id
              WHERE r.job_id=$1 AND j.status='queued' AND r.deadline>clock_timestamp() FOR UPDATE`,[live.jobId])).rows[0];
            if(!current) return {kind:'temporarily_blocked'} as FairnessNoWork;
            const claimed=await client.query<{lease_fence:string;lease_expires_at:Date}>(`UPDATE reasoning_job SET status='running',lease_owner=$2,lease_fence=lease_fence+1,lease_expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond')
              WHERE id=$1 AND status='queued' AND lease_fence<9223372036854775807 RETURNING lease_fence,lease_expires_at`,[current.jobId,input.owner,input.leaseMs]);
            if(!claimed.rowCount) return {kind:'temporarily_blocked'} as FairnessNoWork;
            const claim={jobId:current.jobId,universeId:current.universeId,privacyEpoch:current.privacyEpoch,leaseFence:claimed.rows[0]!.lease_fence,leaseExpiresAt:claimed.rows[0]!.lease_expires_at};
            const charge=Number(current.charge);
            const reserved=await reserveAttemptInTransaction(client,authority,{...current,owner:input.owner,leaseFence:claim.leaseFence,deadline:new Date(current.deadline).toISOString()},async hook=>{
              const {policy}=await policyFor(hook,input.policyVersion); const computed=fairnessCharge(policy,current.inputTokensUpperBound,current.maxOutputTokens);
              if(computed!==charge) denied('fairness_charge_changed');
              const changed=await hook.query('UPDATE reasoning_fairness_scheduler SET generation=generation+1 WHERE policy_version=$1 AND generation=$2::bigint RETURNING generation',[input.policyVersion,scheduler.generation]);
              if(!changed.rowCount) denied('fairness_cas_retry');
              const lane=(await hook.query<Lane>('SELECT credit,universe_cursor::text,remaining,open_universe_id::text,universe_remaining,visit_generation,inner_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2 FOR UPDATE',[input.policyVersion,current.class])).rows[0];
              const universe=(await hook.query<{credit:string}>('SELECT credit FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND universe_id=$3 FOR UPDATE',[input.policyVersion,current.class,current.universeId])).rows[0];
              if(!lane||!universe||lane.remaining===null) return denied('fairness_visit_lost');
              let cc=BigInt(lane.credit),uc=BigInt(universe.credit),remaining=BigInt(lane.remaining),ur=BigInt(lane.universe_remaining);
              if(BigInt(charge)>cc||BigInt(charge)>uc||BigInt(charge)>remaining||BigInt(charge)>ur) denied('fairness_credit_wait');
              cc-=BigInt(charge);uc-=BigInt(charge);remaining-=BigInt(charge);ur-=BigInt(charge);
              const close=remaining===0n;
              await hook.query(`UPDATE reasoning_fairness_class SET credit=$3::bigint,universe_cursor=$4,remaining=$5::bigint,open_universe_id=$4,universe_remaining=$6::bigint
                WHERE policy_version=$1 AND class=$2`,[input.policyVersion,current.class,cc.toString(),current.universeId,close?null:remaining.toString(),ur.toString()]);
              await hook.query('UPDATE reasoning_fairness_universe SET credit=$4::bigint,candidate_cursor=$5::bigint WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[input.policyVersion,current.class,current.universeId,uc.toString(),current.seq]);
              if(close) await hook.query('UPDATE reasoning_fairness_scheduler SET class_cursor=$2 WHERE policy_version=$1',[input.policyVersion,(FAIRNESS_CLASSES.indexOf(current.class)+1)%FAIRNESS_CLASSES.length]);
            });
            await client.query('INSERT INTO reasoning_fairness_attempt(attempt_id,policy_version,class,universe_id,reserved_charge,recognized_charge) VALUES($1,$2,$3,$4,$5,$5)',[reserved.attemptId,input.policyVersion,current.class,current.universeId,charge]);
            await client.query('DELETE FROM reasoning_fairness_ready WHERE job_id=$1',[current.jobId]);
            return {kind:'admitted',claim,reserved,charge,class:current.class} as FairnessScheduled;
          });
        } catch(error) {
          if(error instanceof ReasoningDenied&&error.code==='fairness_cas_retry') continue;
          if(error instanceof ReasoningDenied&&error.code==='fairness_credit_wait') return {kind:'credit_wait'};
          if(error instanceof ReasoningDenied&&(error.code==='insufficient_capacity'||error.code==='bucket_paused')) return {kind:error.code==='bucket_paused'?'policy_paused':'capacity_exhausted'};
          throw error;
        }
      }
      return {kind:'scan_exhausted'};
    },
  };
}
