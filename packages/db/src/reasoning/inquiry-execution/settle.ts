import type pg from 'pg';
import { createReasoningAdmission } from '../admission.ts';
import { inquiryAuthority, resolveInquiryPolicy } from '../inquiries.ts';
import { validateInquiryContext } from '../inquiry-context.ts';
import { staleOutcome } from './apply.ts';
import {
  closeTerminalInquiry,
  inTransaction,
  latestAttempt,
  recoverRespondedInquiry,
  withdrawIdleInquiry,
} from './recovery.ts';

/**
 * The recovery sweep (ADR-0019 primitives, as for answers). Every row is handled on its own; one that
 * cannot move now is left for a later sweep. Returns how many inquiries it closed.
 *  1. a running Job whose lease expired has its attempt recovered, or its recorded reply withdrawn;
 *  2. a leaseless Job after recovery closes as unknown/apply_failed/not_sent and is withdrawn;
 *  3. a queued Job whose sealed facts no longer hold (consent, pause, a claim, the pair, a place) or
 *     whose deadline passed is withdrawn before anything is admitted — never sent;
 *  4. a terminal Job whose inquiry is still open gets its honest failure.
 */
export async function settleInquiries(
  pool: pg.Pool,
  input: { owner: string; limit?: number },
): Promise<number> {
  const limit = input.limit ?? 10;
  const admission = createReasoningAdmission(pool, inquiryAuthority());
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
        background_inquiry i
        JOIN reasoning_job j ON j.id = i.job_id
        JOIN reasoning_attempt at ON at.job_id = j.id
        AND at.active
        JOIN reasoning_accounting ac ON ac.attempt_id = at.id
      WHERE
        i.status = 'queued'
        AND j.status = 'running'
        AND j.lease_expires_at <= clock_timestamp()
        AND ac.state IN (
          'reserved',
          'dispatch_committed',
          'unknown',
          'responded'
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
          recoverRespondedInquiry(client, row),
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
      /* another worker moved it; the next sweep sees its new state */
    }
  }
  let settled = 0;
  const idle = (
    await pool.query<{
      job_id: string;
      universe_id: string;
      privacy_epoch: number;
      queued: boolean;
    }>(
      `
      SELECT
        j.id AS job_id,
        j.universe_id,
        j.privacy_epoch,
        j.status = 'queued' AS queued
      FROM
        background_inquiry i
        JOIN reasoning_job j ON j.id = i.job_id
      WHERE
        i.status = 'queued'
        AND i.role <> 'parent'
        AND j.status IN ('queued', 'waiting')
        AND (
          j.lease_owner IS NULL
          OR j.lease_expires_at <= clock_timestamp()
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
      ORDER BY
        j.deadline,
        j.id
      LIMIT
        $1
    `,
      [limit],
    )
  ).rows;
  for (const row of idle) {
    try {
      const closed = await inTransaction(pool, (client) =>
        withdrawIdleInquiry(
          client,
          row,
          async (inquiry) => {
            const past = (
              await client.query<{ past: boolean }>(
                'SELECT deadline <= clock_timestamp() AS past FROM reasoning_job WHERE id=$1',
                [row.job_id],
              )
            ).rows[0]!.past;
            // A leaseless waiting Job was recovered after its worker's lease expired; a queued one waits for
            // admission, of its first Step or of a continuation (ADR-0042 §1).
            if (!row.queued) {
              const state = (await latestAttempt(client, row.job_id))?.state;
              const reason =
                state === 'unknown' || state === 'dispatch_committed'
                  ? 'outcome_unknown'
                  : state === 'responded'
                    ? 'apply_failed'
                    : 'worker_stopped';
              return { status: 'failed', reasons: [reason], expire: past };
            }
            if (past)
              return { status: 'failed', reasons: ['expired'], expire: true };
            const pending = (
              await client.query<{ id: string }>(
                `SELECT id FROM reasoning_step WHERE job_id=$1 AND status='pending'`,
                [row.job_id],
              )
            ).rows[0]!;
            const check = await validateInquiryContext(
              client,
              {
                universeId: row.universe_id,
                privacyEpoch: row.privacy_epoch,
                jobId: row.job_id,
                stepId: pending.id,
                contextId: inquiry.context_id!,
                policyVersion: inquiry.policy_version!,
              },
              resolveInquiryPolicy,
              'lock',
            );
            if (check.valid) return null;
            const end = staleOutcome(check.reason);
            return { status: end.status, reasons: end.reasons, expire: false };
          },
          input.owner,
        ),
      );
      if (closed) settled += 1;
    } catch {
      /* e.g. the worker took it meanwhile: left for a later sweep */
    }
  }
  const terminal = (
    await pool.query<{ job_id: string }>(
      `
      SELECT
        j.id AS job_id
      FROM
        background_inquiry i
        JOIN reasoning_job j ON j.id = i.job_id
      WHERE
        i.status = 'queued'
        AND i.role <> 'parent'
        AND j.status IN ('cancelled', 'expired', 'failed', 'completed')
      ORDER BY
        j.id
      LIMIT
        $1
    `,
      [limit],
    )
  ).rows;
  for (const row of terminal) {
    try {
      if (
        await inTransaction(pool, (client) =>
          closeTerminalInquiry(
            client,
            row.job_id,
            ['worker_stopped'],
            input.owner,
          ),
        )
      )
        settled += 1;
    } catch {
      /* left for a later sweep */
    }
  }
  return settled;
}
