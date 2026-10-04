/** Ending an inquiry honestly when the call was refused, failed or unconfirmed (ADR-0038). */
import type pg from 'pg';
import { closeInquiry, finish } from './apply.ts';
import { type InquiryFence, type InquiryOutcome, lockFence } from './load.ts';

/** A refused, failed or unconfirmed call ends the inquiry honestly; nothing the provider said is kept. */
export type InquiryFailure =
  | 'outcome_unknown'
  | 'provider_error'
  | 'provider_refusal'
  | 'apply_failed';
export async function failInquiry(
  client: pg.PoolClient,
  f: InquiryFence,
  reason: InquiryFailure,
): Promise<InquiryOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const inquiry = (
    await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM background_inquiry WHERE job_id=$1 FOR UPDATE',
      [f.jobId],
    )
  ).rows[0];
  if (!inquiry || inquiry.status !== 'queued')
    return { kind: 'discarded', reason: 'inquiry_closed' };
  await closeInquiry(
    client,
    inquiry.id,
    'failed',
    { attemptId: f.attemptId, reasons: [reason] },
    f.owner,
  );
  await finish(client, f, false);
  return { kind: 'failed', reason };
}
