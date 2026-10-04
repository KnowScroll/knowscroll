/**
 * Worker-side execution of one answer attempt: rebuilding the reserved bytes, the lease fence taken
 * in ADR-0017 order, and applying or failing the reply. Provider text changes state only through the
 * answer validator (ADR-0033 §4); a stale fence discards the reply instead.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  serializeAskAnswerRequest,
  validateAskAnswerProposal,
} from '@knowscroll/core/reasoning/ask-answer';
import { lockBoundContextSession } from '../context-session.ts';
import type { ReasoningAuthority } from '../runtime-policy.ts';
import { routeFor, sourceOf } from './route.ts';
import type { RequestRow } from './shared.ts';

export type AnswerWork = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  contextId: string;
  askId: string;
  requestId: string;
  requestHash: string;
  inputTokensUpperBound: number;
  maxOutputTokens: number;
  transport: 'fixture' | 'minimax';
  model: string;
  body: Uint8Array;
};
/**
 * What the worker may send for an admitted answer attempt: the bytes rebuilt from the sealed
 * context with the same serializer, refused unless their hash equals the reserved one.
 */
export async function loadAnswerWork(
  db: pg.Pool | pg.PoolClient,
  jobId: string,
  attemptId: string,
): Promise<AnswerWork> {
  const request = (
    await db.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE job_id=$1',
      [jobId],
    )
  ).rows[0];
  if (!request || request.request_hash === null || request.input_bytes === null)
    throw new Error('No answer request for this Job');
  const route = await routeFor(db as pg.PoolClient, request.policy_version);
  const attempt = (
    await db.query<{ request_hash: string }>(
      'SELECT request_hash FROM reasoning_attempt WHERE id=$1 AND job_id=$2',
      [attemptId, jobId],
    )
  ).rows[0];
  const payload = (
    await db.query<{ canonical_payload: string }>(
      'SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',
      [request.context_id],
    )
  ).rows[0];
  if (!route || !attempt || !payload)
    throw new Error('Answer work is incomplete');
  const body = serializeAskAnswerRequest(sourceOf(payload.canonical_payload), {
    model: route.model,
    maxOutputTokens: route.max_output_tokens,
  });
  const hash = createHash('sha256').update(body).digest('hex');
  if (hash !== request.request_hash || hash !== attempt.request_hash)
    throw new Error('Rebuilt answer request does not match its reservation');
  return {
    universeId: request.universe_id,
    privacyEpoch: request.privacy_epoch,
    jobId,
    stepId: request.step_id,
    contextId: request.context_id,
    askId: request.ask_id,
    requestId: request.request_id,
    requestHash: hash,
    inputTokensUpperBound: request.input_bytes,
    maxOutputTokens: route.max_output_tokens,
    transport: route.transport,
    model: route.model,
    body,
  };
}
export type Fence = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  attemptId: string;
  owner: string;
  leaseFence: string;
};
export type AnswerOutcome =
  | { kind: 'applied'; status: 'answered' | 'not_in_source' | 'rejected' }
  | { kind: 'failed'; status: 'failed' }
  | { kind: 'discarded'; reason: string };
/** Lock in ADR-0017 order and prove the caller still holds this Job's live lease in the current epoch. */
async function lockFence(
  client: pg.PoolClient,
  f: Fence,
): Promise<string | null> {
  const universe = (
    await client.query<{ privacy_epoch: number }>(
      'SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE',
      [f.universeId],
    )
  ).rows[0];
  if (universe?.privacy_epoch !== f.privacyEpoch) return 'stale_epoch';
  await lockBoundContextSession(client, {
    universeId: f.universeId,
    privacyEpoch: f.privacyEpoch,
    jobId: f.jobId,
  });
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
/** Close the execution graph safely: output consumed, attempt inactive, Step and Job terminal (ADR-0019 guard). */
async function finish(
  client: pg.PoolClient,
  f: Fence,
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
/**
 * ADR-0033 §4: apply provider text only through the answer validator (ask-answer-v2), under the current fence, epoch,
 * eligible output authority and a clean context recheck. Anything stale is discarded, not applied.
 */
export async function applyAskAnswer(
  client: pg.PoolClient,
  f: Fence,
  text: string,
  authority: ReasoningAuthority,
): Promise<AnswerOutcome> {
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
  )
    return { kind: 'discarded', reason: 'output_not_eligible' };
  const request = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE job_id=$1',
      [f.jobId],
    )
  ).rows[0]!;
  const check = {
    universeId: f.universeId,
    privacyEpoch: f.privacyEpoch,
    jobId: f.jobId,
    stepId: f.stepId,
    contextId: request.context_id,
    policyVersion: request.policy_version,
  };
  if (
    !(await authority.validateContext(client, check, 'lock')) ||
    !(await authority.validateContext(client, check, 'recheck'))
  ) {
    await insertAnswer(client, request, f.attemptId, {
      status: 'failed',
      reasons: ['context_changed'],
    });
    await finish(client, f, false);
    return { kind: 'failed', status: 'failed' };
  }
  const payload = (
    await client.query<{ canonical_payload: string }>(
      'SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',
      [request.context_id],
    )
  ).rows[0]!;
  const verdict = validateAskAnswerProposal(
    text,
    sourceOf(payload.canonical_payload),
  );
  if (!verdict.ok) {
    await insertAnswer(client, request, f.attemptId, {
      status: 'rejected',
      reasons: verdict.reasons,
      validatorVersion: verdict.validatorVersion,
    });
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  const p = verdict.proposal;
  // The validator refuses everything the schema would; should they ever disagree, the reply is
  // rejected here rather than thrown, so no provider text travels in a database error.
  await client.query('SAVEPOINT ask_answer_insert');
  try {
    await insertAnswer(
      client,
      request,
      f.attemptId,
      p.kind === 'answered'
        ? {
            status: 'answered',
            answer: p.answer,
            basis: p.basis,
            limits: p.limits,
            validatorVersion: verdict.validatorVersion,
          }
        : {
            status: 'not_in_source',
            limits: p.limits,
            validatorVersion: verdict.validatorVersion,
          },
    );
    await client.query('RELEASE SAVEPOINT ask_answer_insert');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT ask_answer_insert');
    await insertAnswer(client, request, f.attemptId, {
      status: 'rejected',
      reasons: ['storage_refused'],
      validatorVersion: verdict.validatorVersion,
    });
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  await finish(client, f, true);
  return { kind: 'applied', status: p.kind };
}
/** A refused, failed or unconfirmed call ends the answer honestly; nothing the provider said is kept. */
export type AnswerFailure =
  | 'outcome_unknown'
  | 'provider_error'
  | 'provider_refusal'
  | 'apply_failed';
export async function failAskAnswer(
  client: pg.PoolClient,
  f: Fence,
  reason: AnswerFailure,
): Promise<AnswerOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const request = (
    await client.query<RequestRow>(
      'SELECT * FROM ask_answer_request WHERE job_id=$1',
      [f.jobId],
    )
  ).rows[0]!;
  await insertAnswer(client, request, f.attemptId, {
    status: 'failed',
    reasons: [reason],
  });
  await finish(client, f, false);
  return { kind: 'failed', status: 'failed' };
}
export async function insertAnswer(
  client: pg.PoolClient,
  request: RequestRow,
  attemptId: string | null,
  a: {
    status: 'answered' | 'not_in_source' | 'rejected' | 'failed' | 'cancelled';
    answer?: string;
    basis?: { quote: string }[];
    limits?: string;
    reasons?: string[];
    validatorVersion?: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO
        ask_answer (
          ask_id,
          universe_id,
          privacy_epoch,
          attempt_id,
          status,
          answer,
          basis,
          limits,
          reasons,
          validator_version
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      request.ask_id,
      request.universe_id,
      request.privacy_epoch,
      attemptId,
      a.status,
      a.answer ?? null,
      JSON.stringify(a.basis ?? []),
      a.limits ?? null,
      JSON.stringify(a.reasons ?? []),
      a.validatorVersion ?? null,
    ],
  );
}
