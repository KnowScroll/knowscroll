/** Withdrawing pending inquiries when consent goes off or recording pauses (ADR-0038 §8). */
import type pg from 'pg';
import {
  withdrawIdleBackgroundJob,
  isIdleWithdrawalIneligible,
} from '../idle-lifecycle.ts';

/**
 * ADR-0038 §8: consent off or pause withdraws every pending inquiry and every queued Job not yet
 * admitted (ADR-0018 withdrawal, the cause recorded on the inquiry first, as the schema requires).
 * A call in flight holds a live lease and is left alone: its reply is discarded at apply, because
 * the sealed consent/recording facts no longer hold. Caller holds the universe lock.
 */
export async function withdrawInquiries(
  client: pg.PoolClient,
  universeId: string,
  privacyEpoch: number,
  cause: 'consent_off' | 'recording_paused',
): Promise<number> {
  const reasons = JSON.stringify([cause]);
  let withdrawn =
    (
      await client.query(
        `
    UPDATE background_inquiry
    SET
      status = 'withdrawn',
      reasons = $3
    WHERE
      universe_id = $1
      AND privacy_epoch = $2
      AND status = 'pending'
  `,
        [universeId, privacyEpoch, reasons],
      )
    ).rowCount ?? 0;
  const queued = (
    await client.query<{ id: string; job_id: string }>(
      `
      SELECT
        i.id,
        i.job_id
      FROM
        background_inquiry i
        JOIN reasoning_job j ON j.id = i.job_id
      WHERE
        i.universe_id = $1
        AND i.privacy_epoch = $2
        AND i.status = 'queued'
        AND j.status IN ('queued', 'waiting')
        AND (
          j.lease_owner IS NULL
          OR j.lease_expires_at <= clock_timestamp()
        )
      ORDER BY
        i.id
    `,
      [universeId, privacyEpoch],
    )
  ).rows;
  for (const q of queued) {
    await client.query('SAVEPOINT inquiry_withdrawal');
    try {
      await client.query(
        `UPDATE background_inquiry SET status='withdrawn', reasons=$2 WHERE id=$1 AND status='queued'`,
        [q.id, reasons],
      );
      await withdrawIdleBackgroundJob(
        client,
        { jobId: q.job_id, universeId, privacyEpoch },
        'cancelled',
      );
      await client.query('RELEASE SAVEPOINT inquiry_withdrawal');
      withdrawn += 1;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT inquiry_withdrawal');
      if (!isIdleWithdrawalIneligible(error)) throw error;
    }
  }
  return withdrawn;
}
