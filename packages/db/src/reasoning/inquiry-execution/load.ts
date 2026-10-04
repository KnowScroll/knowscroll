import { createHash } from 'node:crypto';
import type pg from 'pg';
import { inquiryAssistantTurn } from '@knowscroll/contracts/reasoning-inquiry-context';
import {
  type ContinuationTurn,
  serializeBridgeInquiryRequest,
  type AssistantBlock,
} from '@knowscroll/core/reasoning/bridge-inquiry';
import {
  type InquiryRow,
  inquiryRouteFor,
  requestRoute,
} from '../inquiries.ts';
import { readInquiryPayload } from '../inquiry-context.ts';

export type InquiryWork = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  contextId: string;
  inquiryId: string;
  requestId: string;
  requestHash: string;
  inputTokensUpperBound: number;
  maxOutputTokens: number;
  transport: 'fixture' | 'minimax';
  model: string;
  body: Uint8Array;
};
type ContinuationRow = {
  step_id: string;
  ordinal: number;
  request_id: string;
  request_hash: string;
  input_bytes: number;
  reasons: string[];
  assistant_turn: unknown;
};
export const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
/** The refused turns a Step's request carries: none for the first, each earlier continuation's for the next (ADR-0042 §1). */
export async function continuationTurns(
  db: pg.Pool | pg.PoolClient,
  jobId: string,
  throughOrdinal: number,
): Promise<{ rows: ContinuationRow[]; turns: ContinuationTurn[] }> {
  const rows = (
    await db.query<ContinuationRow>(
      'SELECT * FROM background_inquiry_continuation WHERE job_id=$1 AND ordinal<=$2 ORDER BY ordinal',
      [jobId, throughOrdinal],
    )
  ).rows;
  return {
    rows,
    turns: rows.map((r) => ({
      assistant: inquiryAssistantTurn.parse(r.assistant_turn),
      reasons: r.reasons,
    })),
  };
}
/** What the worker may send for an admitted inquiry attempt: the bytes rebuilt from the sealed context
 * (and, for a continuation Step, the protected refused turns) with the same serializer, refused unless
 * their hash equals the one reserved for that Step. */
export async function loadInquiryWork(
  db: pg.Pool | pg.PoolClient,
  jobId: string,
  attemptId: string,
): Promise<InquiryWork> {
  const inquiry = (
    await db.query<InquiryRow>(
      'SELECT * FROM background_inquiry WHERE job_id=$1',
      [jobId],
    )
  ).rows[0];
  if (
    !inquiry?.policy_version ||
    !inquiry.context_id ||
    !inquiry.request_hash ||
    inquiry.input_bytes === null
  )
    throw new Error('No inquiry request for this Job');
  const route = await inquiryRouteFor(db, inquiry.policy_version);
  const attempt = (
    await db.query<{ request_hash: string; step_id: string; ordinal: number }>(
      `
      SELECT
        a.request_hash,
        a.step_id,
        s.ordinal
      FROM
        reasoning_attempt a
        JOIN reasoning_step s ON s.id = a.step_id
      WHERE
        a.id = $1
        AND a.job_id = $2
    `,
      [attemptId, jobId],
    )
  ).rows[0];
  if (!route || !attempt) throw new Error('Inquiry work is incomplete');
  const { rows, turns } = await continuationTurns(db, jobId, attempt.ordinal);
  const continuation = rows.find((r) => r.step_id === attempt.step_id);
  if (!continuation && attempt.step_id !== inquiry.step_id)
    throw new Error('Inquiry work is incomplete');
  const request = continuation
    ? {
        id: continuation.request_id,
        hash: continuation.request_hash,
        bytes: continuation.input_bytes,
      }
    : {
        id: inquiry.request_id!,
        hash: inquiry.request_hash,
        bytes: inquiry.input_bytes,
      };
  const payload = await readInquiryPayload(db, inquiry.context_id);
  const body = serializeBridgeInquiryRequest(
    payload.pairs,
    requestRoute(route),
    turns,
  );
  const hash = sha(body);
  if (hash !== request.hash || hash !== attempt.request_hash)
    throw new Error('Rebuilt inquiry request does not match its reservation');
  return {
    universeId: inquiry.universe_id,
    privacyEpoch: inquiry.privacy_epoch,
    jobId,
    stepId: attempt.step_id,
    contextId: inquiry.context_id,
    inquiryId: inquiry.id,
    requestId: request.id,
    requestHash: hash,
    inputTokensUpperBound: request.bytes,
    maxOutputTokens: route.max_output_tokens,
    transport: route.transport,
    model: route.model,
    body,
  };
}
export type InquiryFence = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  attemptId: string;
  owner: string;
  leaseFence: string;
};
/** What the provider returned for the validator: its text, and the whole turn and stop reason (ADR-0042 §1–§2). */
export type ProviderReply = {
  text: string;
  content: readonly AssistantBlock[];
  stopReason: string | null;
};
export type InquiryOutcome =
  | { kind: 'applied'; status: 'admitted' | 'rejected' | 'none' }
  /** The validator refused; the next Step waits in the fair queue (ADR-0042 §1). */
  | { kind: 'continued'; ordinal: number }
  | { kind: 'withdrawn'; reason: 'consent_off' | 'recording_paused' }
  | { kind: 'failed'; reason: string }
  | { kind: 'discarded'; reason: string };
/** Lock in ADR-0017 order (universe → Job → Step) and prove the caller still holds this Job's live lease. */
export async function lockFence(
  client: pg.PoolClient,
  f: InquiryFence,
): Promise<string | null> {
  const universe = (
    await client.query<{ privacy_epoch: number }>(
      'SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',
      [f.universeId],
    )
  ).rows[0];
  if (universe?.privacy_epoch !== f.privacyEpoch) return 'stale_epoch';
  const job = (
    await client.query<{
      status: string;
      lease_owner: string | null;
      lease_fence: string;
      live: boolean;
    }>(
      `
      SELECT
        status,
        lease_owner,
        lease_fence::text,
        lease_expires_at > clock_timestamp() AS live
      FROM
        reasoning_job
      WHERE
        id = $1
        AND universe_id = $2
        AND privacy_epoch = $3
      FOR UPDATE
    `,
      [f.jobId, f.universeId, f.privacyEpoch],
    )
  ).rows[0];
  if (!job) return 'private_state_gone';
  if (
    !['running', 'waiting'].includes(job.status) ||
    job.lease_owner !== f.owner ||
    job.lease_fence !== f.leaseFence ||
    !job.live
  )
    return 'lease_lost';
  await client.query(
    'SELECT id FROM reasoning_step WHERE id=$1 AND job_id=$2 FOR UPDATE',
    [f.stepId, f.jobId],
  );
  return null;
}
