import type pg from 'pg';
import {fairnessCharge,fairnessClassCap,fairnessUniverseCap,validateFairnessPolicy,type FairnessClass} from './reasoning-fairness-policy.js';

/** Caller holds universe and affected accounting locks. All scheduler resources
 * precede physical bucket locks; multi-attempt operations acquire the union once.
 */
export async function lockFairnessResources(client:pg.PoolClient,attemptIds:string[],clearUniverseId?:string):Promise<void> {
  const versions=(await client.query<{policy_version:string}>(
    `SELECT policy_version FROM reasoning_fairness_attempt WHERE attempt_id=ANY($1::uuid[])
     UNION SELECT policy_version FROM reasoning_fairness_universe WHERE universe_id=$2 ORDER BY policy_version`,
    [attemptIds,clearUniverseId??null],
  )).rows.map(row=>row.policy_version);
  if(versions.length===0) return;
  await client.query('SELECT policy_version FROM reasoning_fairness_scheduler WHERE policy_version=ANY($1::text[]) ORDER BY policy_version FOR UPDATE',[versions]);
  await client.query('SELECT policy_version,class FROM reasoning_fairness_class WHERE policy_version=ANY($1::text[]) ORDER BY policy_version,class FOR UPDATE',[versions]);
  // The policy scheduler lock serializes lane changes. Lock only affected universes;
  // never take another universe's domain row while holding a shared resource.
  await client.query(`SELECT f.policy_version,f.class,f.universe_id FROM reasoning_fairness_universe f
    WHERE f.policy_version=ANY($1::text[]) AND (f.universe_id=$2 OR EXISTS(
      SELECT 1 FROM reasoning_fairness_attempt a WHERE a.attempt_id=ANY($3::uuid[])
      AND (a.policy_version,a.class,a.universe_id)=(f.policy_version,f.class,f.universe_id)))
    ORDER BY f.policy_version,f.class,f.universe_id FOR UPDATE`,[versions,clearUniverseId??null,attemptIds]);
}

export async function pauseFairnessForAttempt(client:pg.PoolClient,attemptId:string):Promise<void> {
  await client.query(`UPDATE reasoning_fairness_scheduler SET paused=true,generation=generation+1
    WHERE policy_version IN (SELECT policy_version FROM reasoning_fairness_attempt WHERE attempt_id=$1)`,[attemptId]);
}

/** Requires lockFairnessResources before any physical bucket locks. revision zero
 * is reserved for a proven not_sent closure; receipt revisions start at one.
 */
async function adjustFairness(client:pg.PoolClient,attemptId:string,revision:number,nextCharge:number):Promise<void> {
  const row=(await client.query(`SELECT a.*,p.config,p.policy_hash,c.credit AS class_credit,u.credit AS universe_credit
    FROM reasoning_fairness_attempt a JOIN reasoning_fairness_policy p ON p.version=a.policy_version
    JOIN reasoning_fairness_class c ON (c.policy_version,c.class)=(a.policy_version,a.class)
    JOIN reasoning_fairness_universe u ON (u.policy_version,u.class,u.universe_id)=(a.policy_version,a.class,a.universe_id)
    WHERE a.attempt_id=$1`,[attemptId])).rows[0];
  if(!row) return;
  if((await client.query('SELECT 1 FROM reasoning_fairness_delta WHERE attempt_id=$1 AND revision=$2',[attemptId,revision])).rowCount) return;
  const {policy,hash}=validateFairnessPolicy(row.config);
  if(hash!==row.policy_hash||policy.version!==row.policy_version) throw new Error('Fairness policy binding changed');
  const prior=BigInt(row.recognized_charge),next=BigInt(nextCharge),refund=prior-next;
  const classCredit=BigInt(row.class_credit),universeCredit=BigInt(row.universe_credit);
  const classCap=BigInt(fairnessClassCap(policy,row.class as FairnessClass)),universeCap=BigInt(fairnessUniverseCap(policy));
  const cap=(value:bigint,maximum:bigint)=>value>maximum?maximum:value;
  const nextClass=cap(classCredit+refund,classCap),nextUniverse=cap(universeCredit+refund,universeCap);
  const classDelta=nextClass-classCredit,universeDelta=nextUniverse-universeCredit;
  await client.query('UPDATE reasoning_fairness_class SET credit=$3 WHERE policy_version=$1 AND class=$2',[row.policy_version,row.class,nextClass.toString()]);
  await client.query('UPDATE reasoning_fairness_universe SET credit=$4 WHERE policy_version=$1 AND class=$2 AND universe_id=$3',[row.policy_version,row.class,row.universe_id,nextUniverse.toString()]);
  await client.query('UPDATE reasoning_fairness_attempt SET recognized_charge=$2 WHERE attempt_id=$1',[attemptId,nextCharge]);
  await client.query(`INSERT INTO reasoning_fairness_delta
    (attempt_id,revision,prior_charge,recognized_charge,class_delta,universe_delta,class_refund_discarded,universe_refund_discarded)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[attemptId,revision,prior.toString(),nextCharge,classDelta.toString(),universeDelta.toString(),
      (refund-classDelta).toString(),(refund-universeDelta).toString()]);
  await client.query(`UPDATE reasoning_fairness_scheduler SET generation=generation+1,paused=paused OR $2
    WHERE policy_version=$1`,[row.policy_version,next>BigInt(row.reserved_charge)]);
}

export async function releaseNotSentFairness(client:pg.PoolClient,attemptId:string):Promise<void> {
  const state=(await client.query('SELECT state,dispatch_id FROM reasoning_accounting WHERE attempt_id=$1',[attemptId])).rows[0];
  if(!state||state.state!=='not_sent'||state.dispatch_id!==null) throw new Error('Fairness refund requires proven not_sent');
  await adjustFairness(client,attemptId,0,0);
}

export async function settleFairness(client:pg.PoolClient,attemptId:string,revision:number,usage:{inputTokens:number|null;outputTokens:number|null}):Promise<void> {
  const row=(await client.query(`SELECT f.policy_version,p.config,p.policy_hash,a.input_reservation_ceiling,a.max_output_tokens
    FROM reasoning_fairness_attempt f JOIN reasoning_fairness_policy p ON p.version=f.policy_version
    JOIN reasoning_accounting a ON a.attempt_id=f.attempt_id WHERE f.attempt_id=$1`,[attemptId])).rows[0];
  if(!row) return;
  const {policy,hash}=validateFairnessPolicy(row.config);
  if(hash!==row.policy_hash||policy.version!==row.policy_version) throw new Error('Fairness policy binding changed');
  const charge=fairnessCharge(policy,usage.inputTokens??Number(row.input_reservation_ceiling),usage.outputTokens??Number(row.max_output_tokens),false);
  await adjustFairness(client,attemptId,revision,charge);
}

/** Private rows have been deleted. Retain debt and minimal accounting balances,
 * but no candidate/open membership that can re-authorize erased work.
 */
export async function clearFairnessMembership(client:pg.PoolClient,universeId:string):Promise<void> {
  const versions=(await client.query<{policy_version:string}>('SELECT DISTINCT policy_version FROM reasoning_fairness_universe WHERE universe_id=$1',[universeId])).rows.map(row=>row.policy_version);
  if(versions.length===0) return;
  await client.query('UPDATE reasoning_fairness_universe SET credit=LEAST(credit,0),candidate_cursor=0,ready_count=0 WHERE universe_id=$1',[universeId]);
  await client.query(`UPDATE reasoning_fairness_class SET
    universe_cursor=CASE WHEN universe_cursor=$1 THEN NULL ELSE universe_cursor END,
    open_universe_id=CASE WHEN open_universe_id=$1 THEN NULL ELSE open_universe_id END,
    universe_remaining=CASE WHEN open_universe_id=$1 THEN 0 ELSE universe_remaining END
    WHERE policy_version=ANY($2::text[]) AND (universe_cursor=$1 OR open_universe_id=$1)`,[universeId,versions]);
  await client.query(`UPDATE reasoning_fairness_class c SET credit=LEAST(credit,0),remaining=NULL
    WHERE c.policy_version=ANY($1::text[]) AND NOT EXISTS(
      SELECT 1 FROM reasoning_fairness_ready r WHERE (r.policy_version,r.class)=(c.policy_version,c.class))`,[versions]);
  await client.query('UPDATE reasoning_fairness_scheduler SET generation=generation+1 WHERE policy_version=ANY($1::text[])',[versions]);
}
