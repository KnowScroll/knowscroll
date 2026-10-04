import type pg from 'pg';
import { parseBridgeInquiryReply } from '@knowscroll/core/reasoning/bridge-inquiry';
import { submitBridgeProposal } from '../../semantic/proposals.ts';
import type { InquiryRow } from '../inquiries.ts';
import { readInquiryPayload } from '../inquiry-context.ts';
import { type ReasoningAuthority, ReasoningDenied } from '../runtime-policy.ts';
import { continueInquiry } from './continue.ts';
import {
  type InquiryFence,
  type InquiryOutcome,
  lockFence,
  type ProviderReply,
} from './load.ts';

/** Close the execution graph safely: output consumed, attempt inactive, Step and Job terminal (ADR-0019 guard). */
export async function finish(
  client: pg.PoolClient,
  f: InquiryFence,
  succeeded: boolean,
): Promise<void> {
  await client.query(
    "UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1",
    [f.attemptId],
  );
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [
    f.attemptId,
  ]);
  await client.query('UPDATE reasoning_step SET status=$2 WHERE id=$1', [
    f.stepId,
    succeeded ? 'succeeded' : 'failed',
  ]);
  await client.query(
    'UPDATE reasoning_job SET status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',
    [f.jobId, succeeded ? 'completed' : 'failed'],
  );
}
/** Closes an open inquiry; if it was a family's last open child, its parent settles in the same transaction. */
export async function closeInquiry(
  client: pg.PoolClient,
  inquiryId: string,
  status: string,
  fields: {
    attemptId?: string | null;
    proposalId?: string | null;
    reasons?: string[];
  },
  owner: string,
): Promise<void> {
  const closed = await client.query(
    `
    UPDATE background_inquiry
    SET
      status = $2,
      attempt_id = $3,
      proposal_id = $4,
      reasons = $5
    WHERE
      id = $1
      AND status = 'queued'
  `,
    [
      inquiryId,
      status,
      fields.attemptId ?? null,
      fields.proposalId ?? null,
      JSON.stringify(fields.reasons ?? []),
    ],
  );
  if (closed.rowCount !== 1) throw new Error('Inquiry is no longer open');
  await settleParent(client, inquiryId, owner);
}
/**
 * ADR-0042 §4.5: once no child is open, the parent inquiry is `settled` and its waiting Job completed.
 * ADR-0019 finishes a Job only under a live lease, so the settling worker takes the idle parent's for
 * that one transition. Caller holds the universe lock, so the last child is decided by one transaction.
 */
async function settleParent(
  client: pg.PoolClient,
  childId: string,
  owner: string,
): Promise<void> {
  const parent = (
    await client.query<{ id: string; job_id: string }>(
      `
      SELECT
        p.id,
        p.job_id
      FROM
        background_inquiry c
        JOIN background_inquiry p ON p.id = c.parent_id
      WHERE
        c.id = $1
        AND p.status = 'queued'
        AND NOT EXISTS (
          SELECT
            1
          FROM
            background_inquiry s
          WHERE
            s.parent_id = p.id
            AND s.status IN ('pending', 'queued')
        )
      FOR UPDATE OF
        p
    `,
      [childId],
    )
  ).rows[0];
  if (!parent) return;
  await client.query(
    `UPDATE background_inquiry SET status='settled' WHERE id=$1`,
    [parent.id],
  );
  const leased = await client.query(
    `
      UPDATE reasoning_job
      SET
        status = 'running',
        lease_owner = $2,
        lease_fence = lease_fence + 1,
        lease_expires_at = clock_timestamp() + interval '1 minute'
      WHERE
        id = $1
        AND status = 'waiting'
        AND lease_owner IS NULL
        AND lease_fence < 9223372036854775807
    `,
    [parent.job_id, owner],
  );
  if (leased.rowCount !== 1)
    throw new Error('A parent inquiry Job only waits for its children');
  await client.query(
    `UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
    [parent.job_id],
  );
}
/** A sealed fact that no longer holds: consent off or a pause withdraw it, a passed deadline expires it; anything else is stale. */
export function staleOutcome(refusal: string): {
  status: 'withdrawn' | 'failed';
  reasons: string[];
  outcome: InquiryOutcome;
} {
  if (refusal === 'consent_inactive')
    return {
      status: 'withdrawn',
      reasons: ['consent_off'],
      outcome: { kind: 'withdrawn', reason: 'consent_off' },
    };
  if (refusal === 'recording_paused')
    return {
      status: 'withdrawn',
      reasons: ['recording_paused'],
      outcome: { kind: 'withdrawn', reason: 'recording_paused' },
    };
  if (refusal === 'expired')
    return {
      status: 'failed',
      reasons: ['expired'],
      outcome: { kind: 'failed', reason: 'expired' },
    };
  return {
    status: 'failed',
    reasons: ['stale_context', refusal],
    outcome: { kind: 'failed', reason: 'stale_context' },
  };
}
/**
 * ADR-0038 §7: under the current fence, epoch and eligible output authority, recheck the sealed
 * context, then let the reply become at most one proposal that bridge-validator-v1 decides. A shape
 * failure stores only its reasons; "none" stores nothing; stale context discards the reply; a reply
 * that did not finish its turn is `truncated` (ADR-0042 §2). A refusal may continue (ADR-0042 §1).
 */
export async function applyInquiryReply(
  client: pg.PoolClient,
  f: InquiryFence,
  reply: ProviderReply,
  authority: ReasoningAuthority,
): Promise<InquiryOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const account = (
    await client.query<{ state: string; output_authority: string }>(
      'SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE',
      [f.attemptId],
    )
  ).rows[0];
  if (
    !account ||
    account.state !== 'responded' ||
    account.output_authority !== 'eligible'
  ) {
    // A reply that lands after the Job's deadline has no output authority (ADR-0012). Say so now,
    // rather than leaving the inquiry "looking" until the lease-expiry sweep calls it apply_failed.
    const late =
      account?.state === 'responded' &&
      (
        await client.query<{ past: boolean }>(
          'SELECT deadline <= clock_timestamp() AS past FROM reasoning_job WHERE id=$1',
          [f.jobId],
        )
      ).rows[0]?.past;
    const open = late
      ? (
          await client.query<InquiryRow>(
            `SELECT * FROM background_inquiry WHERE job_id=$1 AND status='queued' FOR UPDATE`,
            [f.jobId],
          )
        ).rows[0]
      : undefined;
    if (!open) return { kind: 'discarded', reason: 'output_not_eligible' };
    await closeInquiry(
      client,
      open.id,
      'failed',
      { attemptId: f.attemptId, reasons: ['expired'] },
      f.owner,
    );
    await finish(client, f, false);
    return { kind: 'failed', reason: 'expired' };
  }
  const inquiry = (
    await client.query<InquiryRow>(
      'SELECT * FROM background_inquiry WHERE job_id=$1 FOR UPDATE',
      [f.jobId],
    )
  ).rows[0];
  if (!inquiry || inquiry.status !== 'queued')
    return { kind: 'discarded', reason: 'inquiry_closed' };
  const check = {
    universeId: f.universeId,
    privacyEpoch: f.privacyEpoch,
    jobId: f.jobId,
    stepId: f.stepId,
    contextId: inquiry.context_id!,
    policyVersion: inquiry.policy_version!,
  };
  let refusal: string | null = null;
  try {
    await authority.validateContext(client, check, 'lock');
    await authority.validateContext(client, check, 'recheck');
  } catch (error) {
    if (!(error instanceof ReasoningDenied)) throw error;
    refusal = error.code.replace(/^context_/, '');
  }
  if (refusal) {
    const end = staleOutcome(refusal);
    await closeInquiry(
      client,
      inquiry.id,
      end.status,
      { attemptId: f.attemptId, reasons: end.reasons },
      f.owner,
    );
    await finish(client, f, false);
    return end.outcome;
  }
  if (reply.stopReason === 'max_tokens') {
    await closeInquiry(
      client,
      inquiry.id,
      'failed',
      { attemptId: f.attemptId, reasons: ['truncated'] },
      f.owner,
    );
    await finish(client, f, false);
    return { kind: 'failed', reason: 'truncated' };
  }
  const payload = await readInquiryPayload(client, inquiry.context_id!);
  const parsed = parseBridgeInquiryReply(reply.text, payload.pairs);
  if (parsed.kind === 'shape') {
    await closeInquiry(
      client,
      inquiry.id,
      'rejected',
      { attemptId: f.attemptId, reasons: parsed.reasons },
      f.owner,
    );
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  if (parsed.kind === 'none') {
    await closeInquiry(
      client,
      inquiry.id,
      'none',
      { attemptId: f.attemptId },
      f.owner,
    );
    await finish(client, f, true);
    return { kind: 'applied', status: 'none' };
  }
  // The validator's decision is the outcome. Should storage refuse what the schema already parsed,
  // the reply is rejected here rather than thrown, so no provider text travels in a database error.
  await client.query('SAVEPOINT inquiry_proposal');
  let decided: Awaited<ReturnType<typeof submitBridgeProposal>>;
  try {
    decided = await submitBridgeProposal(client, {
      scope: {
        kind: 'universe',
        universeId: f.universeId,
        privacyEpoch: f.privacyEpoch,
      },
      proposerKind: 'model',
      proposerRef: f.attemptId,
      payload: parsed.payload,
    });
    await client.query('RELEASE SAVEPOINT inquiry_proposal');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT inquiry_proposal');
    await closeInquiry(
      client,
      inquiry.id,
      'rejected',
      { attemptId: f.attemptId, reasons: ['storage_refused'] },
      f.owner,
    );
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  if (decided.decision.outcome === 'rejected') {
    const ordinal = await continueInquiry(client, f, inquiry, payload, {
      assistant: reply.content,
      reasons: decided.decision.reasons,
    });
    if (ordinal !== null) return { kind: 'continued', ordinal };
  }
  const admitted = decided.status === 'admitted';
  await closeInquiry(
    client,
    inquiry.id,
    admitted ? 'admitted' : 'rejected',
    {
      attemptId: f.attemptId,
      proposalId: decided.proposalId,
      reasons:
        decided.decision.outcome === 'rejected' ? decided.decision.reasons : [],
    },
    f.owner,
  );
  await finish(client, f, admitted);
  return { kind: 'applied', status: admitted ? 'admitted' : 'rejected' };
}
