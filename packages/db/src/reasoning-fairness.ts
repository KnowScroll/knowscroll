import {randomUUID} from 'node:crypto';
import type pg from 'pg';

import {reserveAttemptInTransaction, type ClaimJobInput, type ReasoningAdmission, type ReserveAttemptInput, type ReservedAttempt} from './reasoning-admission.js';
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
      const attempts = 3;
      for (let retry = 0; retry < attempts; retry += 1) {
        try {
          const outcome = await tx(db, async client => {
            const {policy} = await policyFor(client, input.policyVersion);
            const scheduler = (await client.query<Scheduler>('SELECT generation,class_cursor,paused FROM reasoning_fairness_scheduler WHERE policy_version=$1', [input.policyVersion])).rows[0];
            if (!scheduler) return denied('fairness_policy_missing');
            if (scheduler.paused) return {kind: 'policy_paused'} as FairnessNoWork;
            // The finite query is the ready-set/probe bound.  It is intentionally not
            // a lock: all mutable choices are rechecked below after universe locking.
            const ready = (await client.query<Ready>(`SELECT r.*,r.seq::text AS seq,r.charge::text AS charge
              FROM reasoning_fairness_ready r JOIN reasoning_job j ON j.id=r.job_id
              WHERE r.policy_version=$1 AND j.status='queued' AND j.privacy_epoch=r.privacy_epoch AND r.deadline>clock_timestamp()
              ORDER BY r.class,r.universe_id,r.seq LIMIT $2`, [input.policyVersion, policy.maxProbes])).rows;
            if (!ready.length) return {kind: 'no_candidate'} as FairnessNoWork;
            const openClass = (await client.query<{class: FairnessClass}>('SELECT class FROM reasoning_fairness_class WHERE policy_version=$1 AND remaining IS NOT NULL ORDER BY class LIMIT 1', [input.policyVersion])).rows[0]?.class ?? null;
            const klass = nextClass(scheduler.class_cursor, openClass);
            const candidates = ready.filter(row => row.class === klass);
            if (!candidates.length) return {kind: 'temporarily_blocked'} as FairnessNoWork;
            const classLane = (await client.query<Lane>('SELECT credit,universe_cursor::text,remaining,open_universe_id::text,universe_remaining,visit_generation,inner_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2', [input.policyVersion, klass])).rows[0];
            if (!classLane) return denied('fairness_lane_missing');
            const universes = [...new Set(candidates.map(row => row.universeId))].sort();
            const start = classLane.open_universe_id ? Math.max(0, universes.indexOf(classLane.open_universe_id)) : Math.max(0, universes.findIndex(id => !classLane.universe_cursor || id > classLane.universe_cursor));
            const candidate = candidates.find(row => row.universeId === universes[start < 0 ? 0 : start]) ?? candidates[0]!;
            if (!await lockCandidateUniverse(client, candidate.universeId, candidate.privacyEpoch)) return {kind: 'temporarily_blocked'} as FairnessNoWork;
            const live = (await client.query<Ready>('SELECT r.*,r.seq::text AS seq,r.charge::text AS charge FROM reasoning_fairness_ready r JOIN reasoning_job j ON j.id=r.job_id WHERE r.job_id=$1 AND j.status=\'queued\' AND r.deadline>clock_timestamp() FOR UPDATE', [candidate.jobId])).rows[0];
            if (!live) return {kind: 'temporarily_blocked'} as FairnessNoWork;
            let claim: FairnessScheduled['claim'] | undefined;
            const claimed = await client.query<{lease_fence: string; lease_expires_at: Date}>(`UPDATE reasoning_job SET status='running',lease_owner=$2,lease_fence=lease_fence+1,lease_expires_at=clock_timestamp()+($3::bigint*interval '1 millisecond')
              WHERE id=$1 AND status='queued' AND lease_fence<9223372036854775807 RETURNING lease_fence,lease_expires_at`, [live.jobId,input.owner,input.leaseMs]);
            if (!claimed.rowCount) return {kind: 'temporarily_blocked'} as FairnessNoWork;
            claim={jobId:live.jobId,universeId:live.universeId,privacyEpoch:live.privacyEpoch,leaseFence:claimed.rows[0]!.lease_fence,leaseExpiresAt:claimed.rows[0]!.lease_expires_at};
            const reserveInput: ReserveAttemptInput = {...live, owner: input.owner, leaseFence: claim.leaseFence, costCeilingMicroUsd: live.costCeilingMicroUsd, deadline: new Date(live.deadline).toISOString(), permitTtlMs: live.permitTtlMs};
            const charge = Number(live.charge);
            let debit: {class: FairnessClass; classCredit: bigint; universeCredit: bigint} | undefined;
            const reserved = await reserveAttemptInTransaction(client, authority, reserveInput, async hookClient => {
              const changed = await hookClient.query(`UPDATE reasoning_fairness_scheduler SET generation=generation+1,class_cursor=$3
                WHERE policy_version=$1 AND generation=$2::bigint RETURNING generation`, [input.policyVersion,scheduler.generation,(FAIRNESS_CLASSES.indexOf(klass)+1)%FAIRNESS_CLASSES.length]);
              if (!changed.rowCount) denied('fairness_cas_retry');
              const lane = (await hookClient.query<Lane>('SELECT credit,universe_cursor::text,remaining,open_universe_id::text,universe_remaining,visit_generation,inner_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2 FOR UPDATE', [input.policyVersion,klass])).rows[0];
              const universe = (await hookClient.query<{credit: string}>('SELECT credit FROM reasoning_fairness_universe WHERE policy_version=$1 AND class=$2 AND universe_id=$3 FOR UPDATE', [input.policyVersion,klass,live.universeId])).rows[0];
              if (!lane || !universe) return denied('fairness_lane_missing');
              let cc=BigInt(lane.credit), uc=BigInt(universe.credit), remaining=lane.remaining===null ? BigInt(fairnessClassCap(policy,klass)) : BigInt(lane.remaining), universeRemaining=BigInt(lane.universe_remaining);
              const newClass = lane.remaining===null;
              if (newClass) cc=cap(add(cc,BigInt(policy.quantum*FAIRNESS_WEIGHTS[klass])),fairnessClassCap(policy,klass));
              const newUniverse = newClass || lane.open_universe_id !== live.universeId;
              if (newUniverse) { uc=cap(add(uc,BigInt(policy.quantum)),fairnessUniverseCap(policy)); universeRemaining=BigInt(fairnessUniverseCap(policy)); }
              if (BigInt(charge)>cc || BigInt(charge)>uc || BigInt(charge)>remaining || BigInt(charge)>universeRemaining) denied('fairness_credit_wait');
              cc-=BigInt(charge); uc-=BigInt(charge); remaining-=BigInt(charge); universeRemaining-=BigInt(charge);
              await hookClient.query(`UPDATE reasoning_fairness_class SET credit=$3::bigint,universe_cursor=$4,remaining=$5::bigint,open_universe_id=$4,universe_remaining=$6::bigint,
                 visit_generation=visit_generation+$7,inner_generation=inner_generation+$8 WHERE policy_version=$1 AND class=$2`, [input.policyVersion,klass,cc.toString(),live.universeId,remaining.toString(),universeRemaining.toString(),newClass?1:0,newUniverse?1:0]);
              await hookClient.query('UPDATE reasoning_fairness_universe SET credit=$4::bigint,candidate_cursor=$5::bigint WHERE policy_version=$1 AND class=$2 AND universe_id=$3', [input.policyVersion,klass,live.universeId,uc.toString(),live.seq]);
              debit={class:klass,classCredit:cc,universeCredit:uc};
            });
            await client.query('INSERT INTO reasoning_fairness_attempt(attempt_id,policy_version,class,universe_id,reserved_charge,recognized_charge) VALUES($1,$2,$3,$4,$5,$5)', [reserved.attemptId,input.policyVersion,klass,live.universeId,charge]);
            await client.query('INSERT INTO reasoning_fairness_delta(attempt_id,revision,prior_charge,recognized_charge,class_delta,universe_delta,class_refund_discarded,universe_refund_discarded) VALUES($1,0,0,$2,$2,$2,0,0)', [reserved.attemptId,charge]);
            await client.query('DELETE FROM reasoning_fairness_ready WHERE job_id=$1', [live.jobId]);
            return {kind:'admitted',claim,reserved,charge,class:debit!.class} as FairnessScheduled;
          });
          return outcome;
        } catch (error) {
          if (error instanceof ReasoningDenied && error.code === 'fairness_cas_retry') continue;
          if (error instanceof ReasoningDenied && error.code === 'fairness_credit_wait') return {kind:'credit_wait'};
          if (error instanceof ReasoningDenied && (error.code === 'insufficient_capacity' || error.code === 'bucket_paused')) return {kind:error.code === 'bucket_paused' ? 'policy_paused' : 'capacity_exhausted'};
          throw error;
        }
      }
      return {kind:'scan_exhausted'};
    },
  };
}
