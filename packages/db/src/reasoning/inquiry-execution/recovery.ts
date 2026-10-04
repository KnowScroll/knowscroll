/**
 * Recovery of inquiry Jobs whose worker did not finish: giving back an unsent attempt, closing a
 * terminal Job, and withdrawing idle ones (ADR-0019, ADR-0018). Nothing here re-sends a request.
 */
import type pg from 'pg';
import { inTransaction } from '../../sql/transactions.ts';
import type { ReasoningAdmission } from '../admission.ts';
import { withdrawIdleBackgroundJob } from '../idle-lifecycle.ts';
import type { InquiryRow } from '../inquiries.ts';
import { closeInquiry, staleOutcome } from './apply.ts';
import type { InquiryFence, InquiryOutcome } from './load.ts';

/** The Job's last Attempt: that of its latest Step (a continuation adds Steps, ADR-0042 §1). */
export async function latestAttempt(
  client: pg.PoolClient,
  jobId: string,
): Promise<{ id: string; state: string } | undefined> {
  return (
    await client.query<{ id: string; state: string }>(
      `
      SELECT
        at.id,
        ac.state
      FROM
        reasoning_attempt at
        JOIN reasoning_step s ON s.id = at.step_id
        JOIN reasoning_accounting ac ON ac.attempt_id = at.id
      WHERE
        at.job_id = $1
      ORDER BY
        s.ordinal DESC
      LIMIT
        1
    `,
      [jobId],
    )
  ).rows[0];
}
/** Why an inquiry whose Job ended without an outcome ended: unknown if anything may have been sent. */
export async function closeTerminalInquiry(
  client: pg.PoolClient,
  jobId: string,
  fallback: string[],
  owner: string,
): Promise<boolean> {
  const inquiry = (
    await client.query<InquiryRow>(
      'SELECT * FROM background_inquiry WHERE job_id=$1',
      [jobId],
    )
  ).rows[0];
  if (!inquiry) return false;
  await client.query(
    'SELECT id FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE',
    [inquiry.universe_id, inquiry.privacy_epoch],
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
  const open = (
    await client.query<{ status: string }>(
      'SELECT status FROM background_inquiry WHERE id=$1 FOR UPDATE',
      [inquiry.id],
    )
  ).rows[0];
  if (open?.status !== 'queued') return false;
  const attempt = await latestAttempt(client, jobId);
  const reasons = !attempt
    ? job.status === 'expired'
      ? ['expired']
      : fallback
    : ['dispatch_committed', 'unknown'].includes(attempt.state)
      ? ['outcome_unknown']
      : attempt.state === 'responded'
        ? ['apply_failed']
        : fallback;
  const withdrawn =
    reasons[0] === 'consent_off' || reasons[0] === 'recording_paused';
  await closeInquiry(
    client,
    inquiry.id,
    withdrawn ? 'withdrawn' : 'failed',
    { attemptId: attempt?.id ?? null, reasons },
    owner,
  );
  return true;
}
/**
 * An admitted attempt that was never sent (the worker stopped, or the sealed facts no longer held at
 * dispatch) is given back while this worker still holds the lease: every reservation released, the
 * Job cancelled; the inquiry then records why.
 */
export async function giveBackUnsentInquiry(
  pool: pg.Pool,
  admission: ReasoningAdmission,
  f: InquiryFence,
  refusal: string | null,
): Promise<InquiryOutcome> {
  await admission.withdrawJob({
    universeId: f.universeId,
    privacyEpoch: f.privacyEpoch,
    jobId: f.jobId,
    owner: f.owner,
    leaseFence: f.leaseFence,
    reason: 'cancelled',
  });
  const end = refusal
    ? staleOutcome(refusal)
    : {
        reasons: ['not_sent'],
        outcome: { kind: 'failed', reason: 'not_sent' } as InquiryOutcome,
      };
  const closed = await inTransaction(pool, (client) =>
    closeTerminalInquiry(client, f.jobId, end.reasons, f.owner),
  );
  return closed
    ? end.outcome
    : { kind: 'discarded', reason: 'already_settled' };
}
/** A reply recorded but never applied has no text left: withdraw its output and leave the Job
 * leaseless `waiting` (as `recoverAttempt` does for the other states), so the sweep can close it. */
export async function recoverRespondedInquiry(
  client: pg.PoolClient,
  row: {
    job_id: string;
    universe_id: string;
    privacy_epoch: number;
    step_id: string;
    attempt_id: string;
  },
): Promise<void> {
  if (
    !(
      await client.query(
        'SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE',
        [row.universe_id, row.privacy_epoch],
      )
    ).rowCount
  )
    return;
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
/** Close an idle inquiry Job: the inquiry records why first (the schema requires it), then the Job is
 * withdrawn (ADR-0018 background branch). One transaction; the universe lock first. */
export async function withdrawIdleInquiry(
  client: pg.PoolClient,
  row: { job_id: string; universe_id: string; privacy_epoch: number },
  decide: (
    inquiry: InquiryRow,
  ) => Promise<{ status: string; reasons: string[]; expire: boolean } | null>,
  owner: string,
): Promise<boolean> {
  if (
    !(
      await client.query(
        'SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE',
        [row.universe_id, row.privacy_epoch],
      )
    ).rowCount
  )
    return false;
  const job = (
    await client.query<{ status: string; idle: boolean }>(
      `
      SELECT
        status,
        (
          lease_owner IS NULL
          OR lease_expires_at <= clock_timestamp()
        ) AS idle
      FROM
        reasoning_job
      WHERE
        id = $1
      FOR UPDATE
    `,
      [row.job_id],
    )
  ).rows[0];
  const inquiry = (
    await client.query<InquiryRow>(
      'SELECT * FROM background_inquiry WHERE job_id=$1 FOR UPDATE',
      [row.job_id],
    )
  ).rows[0];
  if (
    !job?.idle ||
    !['queued', 'waiting'].includes(job.status) ||
    inquiry?.status !== 'queued'
  )
    return false;
  const verdict = await decide(inquiry);
  if (!verdict) return false;
  const attempt = await latestAttempt(client, row.job_id);
  await closeInquiry(
    client,
    inquiry.id,
    verdict.status,
    { attemptId: attempt?.id ?? null, reasons: verdict.reasons },
    owner,
  );
  await withdrawIdleBackgroundJob(
    client,
    {
      jobId: row.job_id,
      universeId: row.universe_id,
      privacyEpoch: row.privacy_epoch,
    },
    verdict.expire ? 'expired' : 'cancelled',
  );
  return true;
}
