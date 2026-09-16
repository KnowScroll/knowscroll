import type pg from 'pg';
import {ReasoningDenied} from './reasoning-runtime-policy.js';

type Lane={policy_version:string;class:string;universe_id:string};
type Input={jobId:string;universeId:string;attemptIds:string[]};

/** ADR-0018 arbitrary Job removal, not selected-head dequeue.
 * Caller holds universe/Job/children, lockFairnessResources(..., universeId),
 * the scoped ready row, and physical buckets. Call AFTER all not_sent refunds.
 * All reads here use already-owned rows; no new lock acquisition or provider work.
 */
export async function finalizeIdleJobFairness(client:pg.PoolClient,input:Input):Promise<void> {
 const ready=(await client.query<Lane>(
  'SELECT policy_version,class,universe_id FROM reasoning_fairness_ready WHERE job_id=$1',[input.jobId],
 )).rows[0];
 if(ready&&ready.universe_id!==input.universeId) throw new ReasoningDenied('idle_fairness_scope_mismatch');
 const attempts=(await client.query<Lane>(
  `SELECT DISTINCT policy_version,class,universe_id FROM reasoning_fairness_attempt
   WHERE attempt_id=ANY($1::uuid[]) ORDER BY policy_version,class,universe_id`,[input.attemptIds],
 )).rows;
 if(attempts.some(lane=>lane.universe_id!==input.universeId)) throw new ReasoningDenied('idle_fairness_scope_mismatch');
 const lanes=new Map<string,Lane>();
 for(const lane of [...attempts,...(ready?[ready]:[])]) lanes.set(`${lane.policy_version}\0${lane.class}`,lane);
 const changed=new Set<string>();
 if(ready) {
  const removed=await client.query('DELETE FROM reasoning_fairness_ready WHERE job_id=$1 AND universe_id=$2',[input.jobId,input.universeId]);
  if(removed.rowCount!==1) throw new ReasoningDenied('idle_fairness_membership_changed');
  const decremented=await client.query(
   `UPDATE reasoning_fairness_universe SET ready_count=ready_count-1
    WHERE policy_version=$1 AND class=$2 AND universe_id=$3 AND ready_count>0`,
   [ready.policy_version,ready.class,input.universeId],
  );
  if(decremented.rowCount!==1) throw new ReasoningDenied('fairness_ready_count_mismatch');
  changed.add(ready.policy_version);
 }
 for(const lane of [...lanes.values()].sort((a,b)=>a.policy_version.localeCompare(b.policy_version)||a.class.localeCompare(b.class))) {
  const params=[lane.policy_version,lane.class,input.universeId];
  const counts=(await client.query<{ready_count:string;actual:string}>(
   `SELECT ready_count,(SELECT count(*)::text FROM reasoning_fairness_ready r
      WHERE (r.policy_version,r.class,r.universe_id)=(u.policy_version,u.class,u.universe_id)) AS actual
    FROM reasoning_fairness_universe u WHERE policy_version=$1 AND class=$2 AND universe_id=$3`,params,
  )).rows[0];
  if(!counts||BigInt(counts.ready_count)!==BigInt(counts.actual)) throw new ReasoningDenied('fairness_ready_count_mismatch');
  if(BigInt(counts.ready_count)>0n) continue;
  const universe=await client.query(
   `UPDATE reasoning_fairness_universe SET credit=LEAST(credit,0),candidate_cursor=0
    WHERE policy_version=$1 AND class=$2 AND universe_id=$3 AND (credit>0 OR candidate_cursor<>0)`,params,
  );
  const open=await client.query(
   `UPDATE reasoning_fairness_class SET open_universe_id=NULL,universe_remaining=0,universe_cursor=$3
    WHERE policy_version=$1 AND class=$2 AND open_universe_id=$3`,params,
  );
  const emptyClass=await client.query(
   `UPDATE reasoning_fairness_class c SET credit=LEAST(credit,0),remaining=NULL,
      open_universe_id=NULL,universe_remaining=0,universe_cursor=NULL
    WHERE policy_version=$1 AND class=$2
     AND NOT EXISTS(SELECT 1 FROM reasoning_fairness_ready r
       WHERE (r.policy_version,r.class)=(c.policy_version,c.class))
     AND (credit>0 OR remaining IS NOT NULL OR open_universe_id IS NOT NULL
       OR universe_remaining<>0 OR universe_cursor IS NOT NULL)`,[lane.policy_version,lane.class],
  );
  if(universe.rowCount||open.rowCount||emptyClass.rowCount) changed.add(lane.policy_version);
 }
 if(changed.size>0) {
  const versions=[...changed].sort();
  const updated=await client.query(
   'UPDATE reasoning_fairness_scheduler SET generation=generation+1 WHERE policy_version=ANY($1::text[])', [versions],
  );
  if(updated.rowCount!==versions.length) throw new ReasoningDenied('idle_fairness_scheduler_missing');
 }
}
