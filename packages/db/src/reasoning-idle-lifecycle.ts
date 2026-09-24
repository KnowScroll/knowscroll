import type pg from 'pg';

import type {AuthScope} from './identity.js';
import {releaseUnconsumed} from './reasoning-admission.js';
import {lockFairnessResources} from './reasoning-fairness-accounting.js';
import {finalizeIdleJobFairness} from './reasoning-idle-fairness.js';
import {IDLE_WITHDRAWAL_LIMITS,type IdleDirectJobScope,type IdleWithdrawalResult} from './reasoning-idle-lifecycle-contract.js';
import {ReasoningDenied} from './reasoning-runtime-policy.js';

type Reason=IdleWithdrawalResult['status'];
type Job={status:string;lease_fence:string;withdrawn_at:Date|null;wake_kind:string;healthy:boolean;expired:boolean};
type Attempt={id:string;permit_id:string;state:string;permit_state:string;dispatch_id:string|null;permit_dispatch_id:string|null};

function deny(code:string):never {throw new ReasoningDenied(code);}
const EXPECTED_REFUSALS=new Set([
 'idle_job_ineligible','idle_missing_binding','idle_original_session_required','idle_session_authority',
 'idle_stale_epoch','idle_unknown_job','idle_healthy_lease','idle_deadline_not_elapsed','idle_fence_overflow',
 'idle_graph_too_large','idle_incomplete_graph','idle_unsafe_attempt','idle_missing_bucket','idle_job_changed',
 'idle_withdrawal_race','reservation_counter_mismatch','permit_not_releasable','idle_fairness_scope_mismatch',
 'idle_fairness_membership_changed','fairness_ready_count_mismatch','idle_fairness_scheduler_missing',
]);
/** Only known eligibility/integrity refusals are skippable by background probes.
 * SQL failures and programming errors must still fail the caller. */
export function isIdleWithdrawalIneligible(error:unknown):boolean {
 return error instanceof ReasoningDenied&&EXPECTED_REFUSALS.has(error.code);
}
function validateScope(scope:IdleDirectJobScope):void {
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(!uuid.test(scope.jobId)||!uuid.test(scope.universeId)||!Number.isSafeInteger(scope.privacyEpoch)||scope.privacyEpoch<0) deny('idle_invalid_scope');
}

/** Reads only already-owned rows when lock=false. Expiry deliberately does not
 * require a live session: its authority is the actual Job database deadline. */
async function checkAuthority(client:pg.PoolClient,scope:IdleDirectJobScope,sessionId:string,auth?:AuthScope,lock=false):Promise<void> {
 const row=(await client.query(
  `SELECT s.id FROM reasoning_context_job_session b
   JOIN device_session s ON (s.id,s.universe_id)=(b.session_id,b.universe_id)
   JOIN universe u ON u.id=b.universe_id AND u.privacy_epoch=b.privacy_epoch
   WHERE (b.job_id,b.universe_id,b.privacy_epoch)=($1,$2,$3) AND b.session_id=$4
    AND ($5::uuid IS NULL OR (s.id=$5 AND s.device_id=$6 AND s.privacy_epoch=$3
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()))
   ${lock?'FOR UPDATE OF s':''}`,
  [scope.jobId,scope.universeId,scope.privacyEpoch,sessionId,auth?.sessionId??null,auth?.deviceId??null],
 )).rows[0];
 if(!row) deny('idle_session_authority');
}

async function readJob(client:pg.PoolClient,scope:IdleDirectJobScope,lock=false):Promise<Job> {
 const row=(await client.query<Job>(
  `SELECT status,lease_fence::text,withdrawn_at,wake_kind,
    (lease_owner IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at>clock_timestamp())) AS healthy,
    deadline<=clock_timestamp() AS expired FROM reasoning_job
   WHERE (id,universe_id,privacy_epoch)=($1,$2,$3) ${lock?'FOR UPDATE':''}`,
  [scope.jobId,scope.universeId,scope.privacyEpoch],
 )).rows[0];
 if(!row) deny('idle_unknown_job');
 return row;
}

function assertEligible(job:Job,reason:Reason):void {
 if(job.wake_kind!=='direct'||!['queued','waiting'].includes(job.status)||job.withdrawn_at!==null) deny('idle_job_ineligible');
 if(job.healthy) deny('idle_healthy_lease');
 if(reason==='expired'&&!job.expired) deny('idle_deadline_not_elapsed');
 if(BigInt(job.lease_fence)>=9223372036854775807n) deny('idle_fence_overflow');
}

async function withdraw(client:pg.PoolClient,scope:IdleDirectJobScope,reason:Reason,auth?:AuthScope):Promise<IdleWithdrawalResult> {
 validateScope(scope);
 const universe=await client.query('SELECT id FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE',[scope.universeId,scope.privacyEpoch]);
 if(universe.rowCount!==1) deny('idle_stale_epoch');
 // An optional session-lock helper cannot prove this required immutable binding.
 const binding=await client.query<{session_id:string}>(
  'SELECT session_id FROM reasoning_context_job_session WHERE (job_id,universe_id,privacy_epoch)=($1,$2,$3)',
  [scope.jobId,scope.universeId,scope.privacyEpoch],
 );
 if(binding.rowCount!==1) deny('idle_missing_binding');
 const sessionId=binding.rows[0]!.session_id;
 if(auth&&sessionId!==auth.sessionId) deny('idle_original_session_required');
 await checkAuthority(client,scope,sessionId,auth,true);
 const job=await readJob(client,scope,true);
 await checkAuthority(client,scope,sessionId,auth);
 if(job.status===reason&&job.withdrawn_at!==null&&job.wake_kind==='direct') {
  return {status:reason,changed:false,closedNotSent:0,preservedUnknown:0};
 }
 assertEligible(job,reason);
 const counts=(await client.query<{steps:string;attempts:string}>(
  `SELECT (SELECT count(*) FROM reasoning_step WHERE job_id=$1)::text AS steps,
    (SELECT count(*) FROM reasoning_attempt WHERE job_id=$1)::text AS attempts`,[scope.jobId],
 )).rows[0]!;
 if(Number(counts.steps)>IDLE_WITHDRAWAL_LIMITS.steps||Number(counts.attempts)>IDLE_WITHDRAWAL_LIMITS.attempts) deny('idle_graph_too_large');
 const steps=await client.query('SELECT id FROM reasoning_step WHERE job_id=$1 AND universe_id=$2 AND privacy_epoch=$3 ORDER BY id FOR UPDATE',
  [scope.jobId,scope.universeId,scope.privacyEpoch]);
 const attempts=await client.query<Attempt>(
  `SELECT a.id,a.permit_id,ac.state,p.state AS permit_state,ac.dispatch_id,p.dispatch_id AS permit_dispatch_id
   FROM reasoning_attempt a JOIN reasoning_accounting ac ON ac.attempt_id=a.id
   JOIN reasoning_permit p ON p.id=a.permit_id AND p.attempt_id=a.id
   WHERE a.job_id=$1 AND a.universe_id=$2 AND a.privacy_epoch=$3
   ORDER BY a.id FOR UPDATE OF a,ac,p`,[scope.jobId,scope.universeId,scope.privacyEpoch],
 );
 if(steps.rowCount!==Number(counts.steps)||attempts.rowCount!==Number(counts.attempts)) deny('idle_incomplete_graph');
 for(const attempt of attempts.rows) {
  const unconsumed=attempt.state==='reserved'&&attempt.permit_state==='reserved'&&attempt.dispatch_id===null&&attempt.permit_dispatch_id===null;
  const closed=attempt.state==='not_sent'&&['revoked','expired'].includes(attempt.permit_state)&&attempt.dispatch_id===null;
  const consumed=['dispatch_committed','unknown','responded'].includes(attempt.state)&&attempt.permit_state==='consumed'
   &&attempt.dispatch_id!==null&&attempt.permit_dispatch_id===attempt.dispatch_id;
  if(!unconsumed&&!closed&&!consumed) deny('idle_unsafe_attempt');
 }
 const attemptIds=attempts.rows.map(attempt=>attempt.id);
 // Lock reservations before resources: releaseUnconsumed later reuses these locks.
 const reservations=await client.query<{attempt_id:string;bucket_id:string;state:string}>(
  'SELECT attempt_id,bucket_id,state FROM reasoning_reservation WHERE attempt_id=ANY($1::uuid[]) ORDER BY attempt_id,bucket_id FOR UPDATE',[attemptIds],
 );
 for(const attempt of attempts.rows) {
  const vector=reservations.rows.filter(row=>row.attempt_id===attempt.id);
  // Reserved admission creates a held vector. A partially altered graph is not
  // evidence for releasing already-accounted usage or stamping safe closure.
  if(attempt.state==='reserved'&&(vector.length===0||vector.some(row=>row.state!=='held'))) deny('idle_unsafe_attempt');
  if(attempt.state==='not_sent'&&vector.some(row=>row.state==='held')) deny('idle_unsafe_attempt');
 }
 await lockFairnessResources(client,attemptIds,scope.universeId);
 await client.query('SELECT job_id FROM reasoning_fairness_ready WHERE job_id=$1 AND universe_id=$2 FOR UPDATE',[scope.jobId,scope.universeId]);
 const bucketIds=[...new Set(reservations.rows.map(row=>row.bucket_id))].sort();
 const buckets=await client.query('SELECT id FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[bucketIds]);
 if(buckets.rowCount!==bucketIds.length) deny('idle_missing_bucket');
 // The final authority/fence/deadline check acquires NO new locks. It runs after
 // scheduler and physical resource waits, before any closure/refund writes.
 await checkAuthority(client,scope,sessionId,auth);
 const current=await readJob(client,scope);
 assertEligible(current,reason);
 if(current.status!==job.status||current.lease_fence!==job.lease_fence) deny('idle_job_changed');
 let closedNotSent=0,preservedUnknown=0;
 for(const attempt of attempts.rows) {
  if(attempt.state==='reserved') {
   await releaseUnconsumed(client,attempt.id,attempt.permit_id,true);
   closedNotSent+=1;
  } else {
   await client.query(`UPDATE reasoning_accounting SET output_authority='withdrawn',
     state=CASE WHEN state='dispatch_committed' THEN 'unknown' ELSE state END WHERE attempt_id=$1`,[attempt.id]);
   await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1 AND active',[attempt.id]);
   if(['dispatch_committed','unknown'].includes(attempt.state)) preservedUnknown+=1;
  }
 }
 await client.query(`UPDATE reasoning_step SET status='cancelled' WHERE job_id=$1
   AND status NOT IN ('succeeded','failed','cancelled','superseded')`,[scope.jobId]);
 // Refund first, then clamp idle lanes; arbitrary removal must not skip siblings.
 await finalizeIdleJobFairness(client,{jobId:scope.jobId,universeId:scope.universeId,attemptIds});
 const updated=await client.query(
  `UPDATE reasoning_job j SET status=$4,lease_owner=NULL,lease_expires_at=NULL,
    lease_fence=lease_fence+1,withdrawn_at=clock_timestamp()
   WHERE (id,universe_id,privacy_epoch)=($1,$2,$3) AND status=$5 AND lease_fence=$6::bigint
    AND (lease_owner IS NULL OR lease_expires_at<=clock_timestamp())
    AND ($4<>'expired' OR deadline<=clock_timestamp())
    AND EXISTS(SELECT 1 FROM reasoning_context_job_session b
      JOIN device_session s ON (s.id,s.universe_id)=(b.session_id,b.universe_id)
      JOIN universe u ON u.id=b.universe_id AND u.privacy_epoch=b.privacy_epoch
      WHERE (b.job_id,b.universe_id,b.privacy_epoch)=(j.id,j.universe_id,j.privacy_epoch) AND s.id=$7
       AND ($8::uuid IS NULL OR (s.id=$8 AND s.device_id=$9 AND s.privacy_epoch=j.privacy_epoch
         AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())))`,
  [scope.jobId,scope.universeId,scope.privacyEpoch,reason,job.status,job.lease_fence,sessionId,auth?.sessionId??null,auth?.deviceId??null],
 );
 if(updated.rowCount!==1) deny('idle_withdrawal_race');
 return {status:reason,changed:true,closedNotSent,preservedUnknown};
}

/** Caller authenticated on this client and owns the transaction. */
export async function cancelIdleDirectJob(client:pg.PoolClient,authScope:AuthScope,input:{jobId:string}):Promise<IdleWithdrawalResult> {
 return withdraw(client,{jobId:input.jobId,universeId:authScope.universeId,privacyEpoch:authScope.privacyEpoch},'cancelled',authScope);
}

/** Trusted maintenance/scheduler operation. Caller owns the transaction. */
export async function expireIdleDirectJob(client:pg.PoolClient,scope:IdleDirectJobScope):Promise<IdleWithdrawalResult> {
 return withdraw(client,scope,'expired');
}

/** Trusted worker maintenance (#132 review B2). A direct Job whose worker lost its lease, and whose
 * attempts `recoverAttempt` has already closed (leaseless `waiting`, none active), is cancelled the
 * way a reader's idle cancel is: never-sent attempts release everything they held, possibly-sent
 * ones stay `unknown`. ADR-0018 allows `cancelled` only while the original session is live; for a
 * signed-out reader this refuses (`idle_session_authority`) and the Job waits for its deadline,
 * when `expireIdleDirectJob` needs no session. Caller owns the transaction. */
export async function withdrawRecoveredDirectJob(client:pg.PoolClient,scope:IdleDirectJobScope):Promise<IdleWithdrawalResult> {
 validateScope(scope);
 const row=(await client.query<{status:string;lease_owner:string|null;attempts:number;active:number;live:boolean}>(
  `SELECT j.status,j.lease_owner,
    (SELECT count(*) FROM reasoning_attempt a WHERE a.job_id=j.id)::int AS attempts,
    (SELECT count(*) FROM reasoning_attempt a WHERE a.job_id=j.id AND a.active)::int AS active,
    EXISTS(SELECT 1 FROM reasoning_context_job_session b
      JOIN device_session s ON (s.id,s.universe_id)=(b.session_id,b.universe_id)
      JOIN universe u ON u.id=b.universe_id AND u.privacy_epoch=b.privacy_epoch
      WHERE (b.job_id,b.universe_id,b.privacy_epoch)=(j.id,j.universe_id,j.privacy_epoch)
       AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.privacy_epoch=u.privacy_epoch) AS live
   FROM reasoning_job j WHERE (j.id,j.universe_id,j.privacy_epoch)=($1,$2,$3)`,
  [scope.jobId,scope.universeId,scope.privacyEpoch],
 )).rows[0];
 if(!row) deny('idle_unknown_job');
 if(row.status!=='waiting'||row.lease_owner!==null||row.attempts<1||row.active>0) deny('idle_job_ineligible');
 if(!row.live) deny('idle_session_authority');
 return withdraw(client,scope,'cancelled');
}
