import type pg from 'pg';
import { ReasoningDenied, type ReasoningAuthority } from '../runtime-policy.ts';
import {
  FAIRNESS_WEIGHTS,
  fairnessCharge,
  fairnessClassCap,
  fairnessUniverseCap,
} from '../fairness-policy.ts';
import {
  preflightAttemptInTransaction,
  reserveAttemptInTransaction,
} from '../admission.ts';
import { lockBoundContextSession } from '../context-session.ts';
import { expireIdleDirectJob } from '../idle-lifecycle.ts';
import type {
  FairnessScheduleInput,
  FairnessObservation,
  FairnessScheduled,
  State,
  UniverseLane,
  Discovery,
} from './types.ts';
import {
  deny,
  INELIGIBLE_HEAD,
  nextClass,
  cap,
  tx,
  policyFor,
} from './shared.ts';

/** #177: a scheduler's probes run one at a time. Each one that progresses moves the single generation,
 * so concurrent probes can only fence each other: one that found the head's universe held by another
 * probe committed a blocked round under it, and two in step did so until both spent every probe.
 * Taken first, while nothing else is held, so it adds no edge to the universe-first lock order. */
const FAIRNESS_PROBE_LOCK = 0x0fa1_0177;
export async function lockProbe(
  client: pg.PoolClient,
  version: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::int,hashtext($2))', [
    FAIRNESS_PROBE_LOCK,
    version,
  ]);
}
export async function lockCursor(
  client: pg.PoolClient,
  version: string,
  d: Discovery,
): Promise<void> {
  const state = (
    await client.query<State>(
      'SELECT * FROM reasoning_fairness_scheduler WHERE policy_version=$1 FOR UPDATE',
      [version],
    )
  ).rows[0];
  if (
    !state ||
    state.generation !== d.state.generation ||
    state.class_cursor !== d.state.class_cursor
  )
    return deny('fairness_cas_retry');
  if (state.paused) deny('fairness_policy_paused');
  await client.query(
    'SELECT class FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2 FOR UPDATE',
    [version, d.klass],
  );
}
export async function save(
  client: pg.PoolClient,
  version: string,
  d: Discovery,
  advance = false,
): Promise<void> {
  await client.query(
    `
   UPDATE reasoning_fairness_class
   SET
     credit = $3,
     remaining = $4,
     universe_cursor = $5,
     open_universe_id = $6,
     universe_remaining = $7,
     visit_generation = $8,
     inner_generation = $9
   WHERE
     policy_version = $1
     AND class = $2
 `,
    [
      version,
      d.klass,
      d.lane.credit,
      d.lane.remaining,
      d.lane.universe_cursor,
      d.lane.open_universe_id,
      d.lane.universe_remaining,
      d.lane.visit_generation,
      d.lane.inner_generation,
    ],
  );
  const changed = await client.query(
    `
   UPDATE reasoning_fairness_scheduler
   SET
     generation = generation + 1,
     class_cursor = $3,
     visit_generation = $4,
     inner_generation = $5
   WHERE
     policy_version = $1
     AND generation = $2
   RETURNING
     generation
 `,
    [
      version,
      d.state.generation,
      advance ? nextClass(d.klass) : d.state.class_cursor,
      d.state.visit_generation,
      d.state.inner_generation,
    ],
  );
  if (!changed.rowCount) deny('fairness_cas_retry');
}
function closeInner(d: Discovery) {
  if (d.universe) d.lane.universe_cursor = d.universe.universe_id;
  d.lane.open_universe_id = null;
  d.lane.universe_remaining = '0';
}
async function dequeue(client: pg.PoolClient, version: string, d: Discovery) {
  await client.query('DELETE FROM reasoning_fairness_ready WHERE job_id=$1', [
    d.ready!.jobId,
  ]);
  const u = (
    await client.query<UniverseLane>(
      `
   UPDATE reasoning_fairness_universe
   SET
     ready_count = ready_count -1,
     candidate_cursor = $4,
     credit = CASE
       WHEN ready_count = 1 THEN LEAST(credit, 0)
       ELSE credit
     END
   WHERE
     policy_version = $1
     AND class = $2
     AND universe_id = $3
     AND ready_count > 0
   RETURNING
     *
 `,
      [version, d.klass, d.universe!.universe_id, d.ready!.seq],
    )
  ).rows[0];
  if (!u) return deny('fairness_ready_count_mismatch');
  d.universe = u;
  if (u.ready_count === '0') closeInner(d);
  if (
    !(
      await client.query(
        `
   SELECT
     1
   FROM
     reasoning_fairness_universe
   WHERE
     policy_version = $1
     AND class = $2
     AND ready_count > 0
   LIMIT
     1
 `,
        [version, d.klass],
      )
    ).rowCount
  ) {
    d.lane.credit = String(BigInt(d.lane.credit) < 0n ? d.lane.credit : 0);
    d.lane.remaining = null;
    closeInner(d);
    d.lane.universe_cursor = null;
  }
}
export const observation = (
  d: Discovery,
  kind: FairnessObservation['kind'],
  reason?: string,
): FairnessObservation => ({
  kind,
  reason,
  class: d.klass,
  ...(d.ready
    ? {
        jobId: d.ready.jobId,
        universeId: d.ready.universeId,
        queueAgeMs: d.ready.queueAgeMs,
        deadlineMissed: d.ready.deadlineMissed,
      }
    : {}),
});
async function bypass(
  client: pg.PoolClient,
  version: string,
  d: Discovery,
  remove = false,
) {
  if (remove) await dequeue(client, version, d);
  else if (d.ready)
    await client.query(
      `
   UPDATE reasoning_fairness_universe
   SET
     candidate_cursor = $4
   WHERE
     policy_version = $1
     AND class = $2
     AND universe_id = $3
 `,
      [version, d.klass, d.ready.universeId, d.ready.seq],
    );
  closeInner(d);
  await save(client, version, d);
}
/** One inspected head/empty scope per transaction. Every successful claim, debit,
 * full reservation and Attempt/Permit is in this same transaction. A no-credit
 * visit can commit its earned quantum, but only after all physical guards pass.
 */
export async function probe(
  db: pg.Pool,
  authority: ReasoningAuthority,
  input: FairnessScheduleInput,
  d: Discovery,
): Promise<{
  event: FairnessObservation;
  terminalExpiry?: true;
  admitted?: Omit<FairnessScheduled, 'observations' | 'probes'>;
}> {
  return tx(db, async (client) => {
    await lockProbe(client, input.policyVersion);
    if (!d.universe) {
      await lockCursor(client, input.policyVersion, d);
      d.lane.credit = String(BigInt(d.lane.credit) < 0n ? d.lane.credit : 0);
      d.lane.remaining = null;
      closeInner(d);
      await save(client, input.policyVersion, d, true);
      return { event: observation(d, 'no_candidate', 'empty_class') };
    }
    const domain = (
      await client.query<{ privacy_epoch: number }>(
        'SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE SKIP LOCKED',
        [d.universe.universe_id],
      )
    ).rows[0];
    if (!domain) {
      await lockCursor(client, input.policyVersion, d);
      closeInner(d);
      await save(client, input.policyVersion, d);
      return {
        event: observation(d, 'temporarily_blocked', 'universe_locked'),
      };
    }
    if (!d.ready) {
      await lockCursor(client, input.policyVersion, d);
      await client.query(
        `
    UPDATE reasoning_fairness_universe
    SET
      ready_count = 0,
      credit = LEAST(credit, 0),
      candidate_cursor = 0
    WHERE
      policy_version = $1
      AND class = $2
      AND universe_id = $3
  `,
        [input.policyVersion, d.klass, d.universe.universe_id],
      );
      closeInner(d);
      await save(client, input.policyVersion, d);
      return { event: observation(d, 'ineligible', 'empty_membership') };
    }
    // Original session precedes Job; dependency locks precede shared resources.
    await lockBoundContextSession(client, d.ready);
    const job = (
      await client.query<{
        class: string;
        status: string;
        privacy_epoch: number;
        deadline: Date;
        wake_kind: string | null;
        deadline_expired: boolean;
        healthy_lease: boolean;
      }>(
        `
    SELECT
      class,
      status,
      privacy_epoch,
      deadline,
      wake_kind,
      deadline <= clock_timestamp() AS deadline_expired,
      (
        lease_owner IS NOT NULL
        AND lease_expires_at > clock_timestamp()
      ) AS healthy_lease
    FROM
      reasoning_job
    WHERE
      id = $1
    FOR UPDATE
  `,
        [d.ready.jobId],
      )
    ).rows[0];
    if (!job) {
      deny('fairness_cas_retry');
    }
    // Expiry uses the Job's own deadline and original binding, never a shorter
    // request deadline or a stale discovery clock. This precedes shared locks.
    const originalBinding =
      (
        await client.query(
          `SELECT 1 FROM reasoning_context_job_session
    WHERE (job_id,universe_id,privacy_epoch)=($1,$2,$3)`,
          [d.ready.jobId, d.ready.universeId, domain.privacy_epoch],
        )
      ).rowCount === 1;
    const boundDirect = job.wake_kind === 'direct' && originalBinding;
    const currentScope =
      job.privacy_epoch === domain.privacy_epoch &&
      d.ready.privacyEpoch === domain.privacy_epoch;
    if (
      boundDirect &&
      currentScope &&
      job.status === 'queued' &&
      job.deadline_expired
    ) {
      if (job.healthy_lease) {
        await lockCursor(client, input.policyVersion, d);
        await bypass(client, input.policyVersion, d);
        return {
          event: observation(d, 'temporarily_blocked', 'idle_healthy_lease'),
        };
      }
      await client.query('SAVEPOINT idle_direct_expiry');
      try {
        await expireIdleDirectJob(client, {
          jobId: d.ready.jobId,
          universeId: d.ready.universeId,
          privacyEpoch: d.ready.privacyEpoch,
        });
        await client.query('RELEASE SAVEPOINT idle_direct_expiry');
        return {
          event: observation(d, 'ineligible', 'deadline_missed'),
          terminalExpiry: true,
        };
      } catch (error) {
        // Only closed, permanent graph eligibility failures may advance this head.
        // Authority/membership/CAS failures and SQL errors abort the whole probe.
        if (
          !(error instanceof ReasoningDenied) ||
          ![
            'idle_graph_too_large',
            'idle_incomplete_graph',
            'idle_unsafe_attempt',
            'idle_fence_overflow',
          ].includes(error.code)
        )
          throw error;
        await client.query('ROLLBACK TO SAVEPOINT idle_direct_expiry');
        await client.query('RELEASE SAVEPOINT idle_direct_expiry');
        await lockCursor(client, input.policyVersion, d);
        await bypass(client, input.policyVersion, d);
        return { event: observation(d, 'ineligible', error.code) };
      }
    }
    if (
      job.class !== d.klass ||
      job.status !== 'queued' ||
      domain.privacy_epoch !== d.ready.privacyEpoch ||
      job.privacy_epoch !== domain.privacy_epoch ||
      d.ready.deadlineMissed
    ) {
      await lockCursor(client, input.policyVersion, d);
      if (d.ready.deadlineMissed && job.status === 'queued' && !boundDirect)
        await client.query(
          "UPDATE reasoning_job SET status='expired' WHERE id=$1",
          [d.ready.jobId],
        );
      await bypass(client, input.policyVersion, d, true);
      return {
        event: observation(
          d,
          'ineligible',
          d.ready.deadlineMissed ? 'deadline_missed' : 'stale_job',
        ),
      };
    }
    let locked = false;
    let preflight;
    try {
      preflight = await preflightAttemptInTransaction(
        client,
        authority,
        d.ready,
        async (hook) => {
          await lockCursor(hook, input.policyVersion, d);
          locked = true;
        },
      );
    } catch (error) {
      // A head whose sealed context no longer holds (`context_*`) is skipped like any other ineligible head:
      // its own sweep withdraws it, never sent, and the round never waits for that sweep (#153).
      if (
        !(error instanceof ReasoningDenied) ||
        !(
          INELIGIBLE_HEAD.includes(error.code) ||
          error.code.startsWith('context_')
        )
      )
        throw error;
      if (!locked) await lockCursor(client, input.policyVersion, d);
      await bypass(client, input.policyVersion, d);
      return { event: observation(d, 'ineligible', error.code) };
    }
    if (preflight.physicallyFits !== 'fit') {
      const kind =
        preflight.physicallyFits === 'impossible'
          ? 'impossible'
          : preflight.physicallyFits === 'paused'
            ? 'policy_paused'
            : 'capacity_exhausted';
      await bypass(client, input.policyVersion, d, kind === 'impossible');
      return { event: observation(d, kind, 'physical_vector') };
    }
    const { policy } = await policyFor(client, input.policyVersion);
    const charge = fairnessCharge(
      policy,
      d.ready.inputTokensUpperBound,
      d.ready.maxOutputTokens,
    );
    if (BigInt(charge) !== BigInt(d.ready.charge))
      deny('fairness_charge_changed');
    const c = d.lane,
      u = d.universe;
    if (c.remaining === null) {
      c.credit = cap(
        BigInt(c.credit) + BigInt(policy.quantum * FAIRNESS_WEIGHTS[d.klass]),
        fairnessClassCap(policy, d.klass),
      ).toString();
      c.remaining = String(fairnessClassCap(policy, d.klass));
      d.state.visit_generation = (
        BigInt(d.state.visit_generation) + 1n
      ).toString();
      c.visit_generation = d.state.visit_generation;
    }
    if (c.open_universe_id !== u.universe_id) {
      u.credit = cap(
        BigInt(u.credit) + BigInt(policy.quantum),
        fairnessUniverseCap(policy),
      ).toString();
      c.open_universe_id = u.universe_id;
      c.universe_remaining = String(fairnessUniverseCap(policy));
      d.state.inner_generation = (
        BigInt(d.state.inner_generation) + 1n
      ).toString();
      c.inner_generation = d.state.inner_generation;
    }
    await client.query(
      `
    UPDATE reasoning_fairness_universe
    SET
      credit = $4
    WHERE
      policy_version = $1
      AND class = $2
      AND universe_id = $3
  `,
      [input.policyVersion, d.klass, u.universe_id, u.credit],
    );
    if (
      BigInt(charge) > BigInt(c.credit) ||
      BigInt(charge) > BigInt(c.remaining)
    ) {
      c.remaining = null;
      await save(client, input.policyVersion, d, true);
      return { event: observation(d, 'credit_wait', 'class_deficit_or_spend') };
    }
    if (
      BigInt(charge) > BigInt(u.credit) ||
      BigInt(charge) > BigInt(c.universe_remaining)
    ) {
      closeInner(d);
      await save(client, input.policyVersion, d);
      return {
        event: observation(d, 'credit_wait', 'universe_deficit_or_spend'),
      };
    }
    const row = (
      await client.query<{ lease_fence: string; lease_expires_at: Date }>(
        `
    UPDATE reasoning_job
    SET
      status = 'running',
      lease_owner = $2,
      lease_fence = lease_fence + 1,
      lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond')
    WHERE
      id = $1
      AND status = 'queued'
      AND deadline > clock_timestamp()
      AND lease_fence < 9223372036854775807
    RETURNING
      lease_fence,
      lease_expires_at
  `,
        [d.ready.jobId, input.owner, input.leaseMs],
      )
    ).rows[0];
    if (!row) deny('expired_lease_or_job');
    const claim = {
      jobId: d.ready.jobId,
      universeId: d.ready.universeId,
      privacyEpoch: d.ready.privacyEpoch,
      leaseFence: row.lease_fence as string,
      leaseExpiresAt: row.lease_expires_at as Date,
    };
    // Preflight locked the exact context dependencies in this transaction, before shared resources.
    const reserved = await reserveAttemptInTransaction(
      client,
      authority,
      { ...d.ready, owner: input.owner, leaseFence: claim.leaseFence },
      async (_hook, resolved) => {
        if (resolved.bindingHash !== preflight.bindingHash)
          deny('policy_binding_changed');
      },
      'recheck',
    );
    c.credit = (BigInt(c.credit) - BigInt(charge)).toString();
    c.remaining = (BigInt(c.remaining) - BigInt(charge)).toString();
    c.universe_remaining = (
      BigInt(c.universe_remaining) - BigInt(charge)
    ).toString();
    u.credit = (BigInt(u.credit) - BigInt(charge)).toString();
    await client.query(
      `
    UPDATE reasoning_fairness_universe
    SET
      credit = $4
    WHERE
      policy_version = $1
      AND class = $2
      AND universe_id = $3
  `,
      [input.policyVersion, d.klass, u.universe_id, u.credit],
    );
    await client.query(
      `
    INSERT INTO
      reasoning_fairness_attempt (
        attempt_id,
        policy_version,
        class,
        universe_id,
        reserved_charge,
        recognized_charge
      )
    VALUES
      ($1, $2, $3, $4, $5, $5)
  `,
      [reserved.attemptId, input.policyVersion, d.klass, u.universe_id, charge],
    );
    await dequeue(client, input.policyVersion, d);
    const closeClass =
      c.remaining === null ||
      BigInt(c.remaining) === 0n ||
      BigInt(c.credit) <= 0n;
    if (closeClass) c.remaining = null;
    if (
      c.open_universe_id &&
      (BigInt(c.universe_remaining) === 0n || BigInt(d.universe!.credit) <= 0n)
    )
      closeInner(d);
    await save(client, input.policyVersion, d, closeClass);
    return {
      event: observation(d, 'admitted'),
      admitted: { kind: 'admitted', claim, reserved, charge, class: d.klass },
    };
  });
}
