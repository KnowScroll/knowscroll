import type pg from 'pg';
import {
  type ReasoningAdmission,
  createReasoningAdmission,
} from '../admission.ts';
import {
  expireIdleDirectJob,
  withdrawRecoveredDirectJob,
} from '../idle-lifecycle.ts';
import { answerAuthority } from './route.ts';
import type { RequestRow } from './shared.ts';
import { type AnswerOutcome, type Fence, insertAnswer } from './worker.ts';
import { inTransaction } from '../../sql/transactions.ts';

/**
 * #132 review B2: an admitted attempt that was never sent is given back while this worker still holds
 * the lease — every reservation released, the Job cancelled — and the answer fails as `not_sent`.
 */
export async function giveBackUnsentAnswer(
  pool: pg.Pool,
  admission: ReasoningAdmission,
  f: Fence,
): Promise<AnswerOutcome> {
  await admission.withdrawJob({
    universeId: f.universeId,
    privacyEpoch: f.privacyEpoch,
    jobId: f.jobId,
    owner: f.owner,
    leaseFence: f.leaseFence,
    reason: 'cancelled',
  });
  const closed = await inTransaction(pool, (client) =>
    closeTerminalAnswer(client, f.jobId, 'not_sent'),
  );
  return closed
    ? { kind: 'failed', status: 'failed' }
    : { kind: 'discarded', reason: 'already_settled' };
}
/** A terminal answer Job with no answer gets its honest failure: unknown if anything may have been sent. */
async function closeTerminalAnswer(
  client: pg.PoolClient,
  jobId: string,
  fallback: 'not_sent' | 'worker_stopped',
): Promise<boolean> {
  const request = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE job_id=$1',
      [jobId],
    )
  ).rows[0];
  if (!request) return false;
  await client.query(
    'SELECT id FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE',
    [request.universe_id, request.privacy_epoch],
  );
  const job = (
    await client.query<{ status: string }>(
      'SELECT status FROM reasoning_job WHERE id=$1 FOR UPDATE',
      [jobId],
    )
  ).rows[0];
  if (
    !job ||
    !['cancelled', 'expired', 'failed', 'completed'].includes(job.status)
  )
    return false;
  if (
    (
      await client.query('SELECT 1 FROM ask_answer WHERE ask_id=$1', [
        request.ask_id,
      ])
    ).rowCount
  )
    return false;
  const attempt = (
    await client.query<{ id: string; state: string }>(
      `
      SELECT
        at.id,
        ac.state
      FROM
        reasoning_attempt at
        JOIN reasoning_accounting ac ON ac.attempt_id = at.id
      WHERE
        at.job_id = $1
      ORDER BY
        at.id DESC
      LIMIT
        1
    `,
      [jobId],
    )
  ).rows[0];
  // Possibly sent → unknown; a reply received but never applied → apply_failed; admitted but never
  // sent → the caller's reason; never admitted and past its deadline → expired.
  const reason = !attempt
    ? job.status === 'expired'
      ? 'expired'
      : fallback
    : ['dispatch_committed', 'unknown'].includes(attempt.state)
      ? 'outcome_unknown'
      : attempt.state === 'responded'
        ? 'apply_failed'
        : fallback;
  await insertAnswer(client, request, attempt?.id ?? null, {
    status: 'failed',
    reasons: [reason],
  });
  return true;
}
/**
 * A reply that was recorded but never applied (it arrived after the lease expired, or the worker
 * died between recording and applying) has no text left to apply. Its output is withdrawn, its
 * attempt and Step closed, and the Job left leaseless `waiting`, like `recoverAttempt` does for the
 * other states, so the idle withdrawal can end it. Locks universe → Job → Step → attempt.
 */
async function recoverRespondedAnswer(
  client: pg.PoolClient,
  row: {
    job_id: string;
    universe_id: string;
    privacy_epoch: number;
    step_id: string;
    attempt_id: string;
  },
): Promise<void> {
  const universe = (
    await client.query(
      'SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE',
      [row.universe_id, row.privacy_epoch],
    )
  ).rowCount;
  if (!universe) return;
  const job = (
    await client.query<{ expired: boolean }>(
      `
      SELECT
        lease_expires_at <= clock_timestamp() AS expired
      FROM
        reasoning_job
      WHERE
        id = $1
        AND status = 'running'
      FOR UPDATE
    `,
      [row.job_id],
    )
  ).rows[0];
  if (!job?.expired) return;
  await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE', [
    row.step_id,
  ]);
  const accounting = (
    await client.query<{ state: string }>(
      `
      SELECT
        ac.state
      FROM
        reasoning_attempt at
        JOIN reasoning_accounting ac ON ac.attempt_id = at.id
      WHERE
        at.id = $1
        AND at.active
      FOR UPDATE OF
        at,
        ac
    `,
      [row.attempt_id],
    )
  ).rows[0];
  if (accounting?.state !== 'responded') return;
  await client.query(
    "UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1",
    [row.attempt_id],
  );
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [
    row.attempt_id,
  ]);
  await client.query("UPDATE reasoning_step SET status='failed' WHERE id=$1", [
    row.step_id,
  ]);
  await client.query(
    `
      UPDATE reasoning_job
      SET
        status = 'waiting',
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_fence = lease_fence + 1
      WHERE
        id = $1
        AND lease_fence < 9223372036854775807
    `,
    [row.job_id],
  );
}
/**
 * #132 review B2: the recovery sweep. An answer Job whose worker died never keeps its reservations
 * or its remote slot beyond what it may have spent, and never stops the sweep for anyone else:
 *  1. a running Job whose lease expired has its attempt recovered (ADR-0019), or, when its reply was
 *     already recorded, closed as unapplied;
 *  2. the leaseless Job is then withdrawn (ADR-0018): `expired` once its deadline has passed,
 *     `cancelled` before that only while the reader's original session is live — a signed-out
 *     reader's Job waits for its deadline;
 *  3. every terminal answer Job without an answer gets its honest failure.
 * Every row is handled on its own: one that cannot move now is left for a later sweep.
 * Returns how many answers it settled.
 */
export async function settleAbandonedAnswers(
  pool: pg.Pool,
  input: { owner: string; limit?: number },
): Promise<number> {
  const limit = input.limit ?? 10;
  const admission = createReasoningAdmission(pool, answerAuthority());
  const expiredLeases = (
    await pool.query<{
      job_id: string;
      universe_id: string;
      privacy_epoch: number;
      step_id: string;
      attempt_id: string;
      state: string;
    }>(
      `
      SELECT
        j.id AS job_id,
        j.universe_id,
        j.privacy_epoch,
        at.step_id,
        at.id AS attempt_id,
        ac.state
      FROM
        ask_answer_request r
        JOIN reasoning_job j ON j.id = r.job_id
        JOIN reasoning_attempt at ON at.job_id = j.id
        AND at.active
        JOIN reasoning_accounting ac ON ac.attempt_id = at.id
      WHERE
        j.status = 'running'
        AND j.lease_expires_at <= clock_timestamp()
        AND ac.state IN (
          'reserved',
          'dispatch_committed',
          'unknown',
          'responded'
        )
        AND NOT EXISTS (
          SELECT
            1
          FROM
            ask_answer a
          WHERE
            a.ask_id = r.ask_id
        )
      ORDER BY
        j.id
      LIMIT
        $1
    `,
      [limit],
    )
  ).rows;
  for (const row of expiredLeases) {
    try {
      if (row.state === 'responded')
        await inTransaction(pool, (client) =>
          recoverRespondedAnswer(client, row),
        );
      else
        await admission.recoverAttempt({
          universeId: row.universe_id,
          privacyEpoch: row.privacy_epoch,
          jobId: row.job_id,
          stepId: row.step_id,
          attemptId: row.attempt_id,
          owner: input.owner,
        });
    } catch {
      /* another worker moved it, or it changed meanwhile; the next sweep sees its new state */
    }
  }
  const leaseless = (
    await pool.query<{
      job_id: string;
      universe_id: string;
      privacy_epoch: number;
      past: boolean;
    }>(
      `
      SELECT
        j.id AS job_id,
        j.universe_id,
        j.privacy_epoch,
        j.deadline <= clock_timestamp() AS past
      FROM
        ask_answer_request r
        JOIN reasoning_job j ON j.id = r.job_id
      WHERE
        j.status = 'waiting'
        AND j.lease_owner IS NULL
        AND EXISTS (
          SELECT
            1
          FROM
            reasoning_attempt at
          WHERE
            at.job_id = j.id
        )
        AND NOT EXISTS (
          SELECT
            1
          FROM
            reasoning_attempt at
          WHERE
            at.job_id = j.id
            AND at.active
        )
        AND NOT EXISTS (
          SELECT
            1
          FROM
            ask_answer a
          WHERE
            a.ask_id = r.ask_id
        )
      ORDER BY
        j.deadline,
        j.id
      LIMIT
        $1
    `,
      [limit],
    )
  ).rows;
  for (const row of leaseless) {
    const scope = {
      jobId: row.job_id,
      universeId: row.universe_id,
      privacyEpoch: row.privacy_epoch,
    };
    try {
      await inTransaction(pool, (client) =>
        row.past
          ? expireIdleDirectJob(client, scope)
          : withdrawRecoveredDirectJob(client, scope),
      );
    } catch {
      /* e.g. a signed-out reader before the deadline: left for a later sweep */
    }
  }
  const terminal = (
    await pool.query<{ job_id: string }>(
      `
      SELECT
        j.id AS job_id
      FROM
        ask_answer_request r
        JOIN reasoning_job j ON j.id = r.job_id
      WHERE
        j.status IN ('cancelled', 'expired', 'failed', 'completed')
        AND NOT EXISTS (
          SELECT
            1
          FROM
            ask_answer a
          WHERE
            a.ask_id = r.ask_id
        )
      ORDER BY
        j.id
      LIMIT
        $1
    `,
      [limit],
    )
  ).rows;
  let settled = 0;
  for (const row of terminal) {
    try {
      if (
        await inTransaction(pool, (client) =>
          closeTerminalAnswer(client, row.job_id, 'worker_stopped'),
        )
      )
        settled += 1;
    } catch {
      /* left for a later sweep */
    }
  }
  return settled;
}
