/**
 * #132 — authorized Scroll Ask answers (ADR-0033), on top of the existing reasoning primitives.
 *
 * `requestAskAnswer` is the only path from a recorded Ask to execution: one explicit request, from
 * the Ask's original live session, creates the direct Job, compiles the sealed Ask context
 * (ADR-0017), creates the Step, derives the exact request bytes and enqueues fairly — in the
 * caller's authenticated transaction. The worker then calls `loadAnswerWork` (rebuilds the bytes
 * and proves the reserved hash), sends them through `invokeReasoningOnce`, and finishes with
 * `applyAskAnswer` or `failAskAnswer`. Provider text changes state only through the answer validator (ask-answer-v2).
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { askContextPayload } from '../../contracts/src/reasoning-ask-context.ts';
import { serializeAskAnswerRequest, validateAskAnswerProposal, type AskAnswerSource } from '../../core/src/reasoning/ask-answer.ts';
import type { AuthScope } from './identity.ts';
import { compileDirectAskContext } from './reasoning-ask-context.ts';
import { createSealedContextAuthority } from './reasoning-context-authority.ts';
import { lockBoundContextSession } from './reasoning-context-session.ts';
import { cancelIdleDirectJob, expireIdleDirectJob, isIdleWithdrawalIneligible, withdrawRecoveredDirectJob } from './reasoning-idle-lifecycle.ts';
import { createReasoningAdmission, type ReasoningAdmission } from './reasoning-admission.ts';
import { enqueueFairInTransaction } from './reasoning-fairness.ts';
import type { ReasoningAuthority, ResolvedReasoningPolicy } from './reasoning-runtime-policy.ts';

export class AskAnswerError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 503, message: string) { super(message); this.name = 'AskAnswerError'; }
}

export const askAnswerRequestInput = z.object({
  clientRequestId: z.string().uuid(),
  expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
}).strict();

type Route = {
  policy_version: string; route_id: string; route_profile_version: string; transport: 'fixture' | 'minimax'; model: string;
  max_input_tokens: number; max_output_tokens: number; global_bucket_id: string; provider_account_bucket_id: string;
  route_quota_bucket_id: string; remote_concurrency_bucket_id: string; owner_capacity: string; job_capacity: string;
  answer_ttl_seconds: number; enabled: boolean;
};
type RequestRow = {
  id: string; ask_id: string; universe_id: string; privacy_epoch: number; session_id: string; client_request_id: string;
  policy_version: string; job_id: string; step_id: string; context_id: string; request_id: string; request_hash: string | null;
  input_bytes: number | null; job_bucket_id: string; requested_at: Date;
};

/** The fairness policy an answer route is scheduled under: its basis is the route's own bounds, so
 * any request the route admits costs at most one quantum (ADR-0013 charges the largest fraction). */
export function answerFairnessPolicy(version: string, bounds: { maxInputTokens: number; maxOutputTokens: number }) {
  return { version, quantum: 100, maxCharge: 100, scale: 100, maxProbes: 8, maxAdmissions: 1,
    basis: { input_tokens: bounds.maxInputTokens, output_tokens: bounds.maxOutputTokens, total_tokens: bounds.maxInputTokens + bounds.maxOutputTokens, requests: 1 } };
}

/** Operator/test setup: one route with its shared buckets and fairness policy. Nothing else enables answers. */
export async function installAskAnswerRoute(client: pg.PoolClient, input: {
  policyVersion: string; routeId: string; routeProfileVersion: string; transport: 'fixture' | 'minimax'; model: string;
  maxInputTokens: number; maxOutputTokens: number; requestCap: number; tokenBudget: number; ownerCapacity: number; jobCapacity: number;
  answerTtlSeconds: number;
  /** Concurrent remote calls. An unconfirmed outcome keeps its slot until evidence or an operator
   * decision (ADR-0012), so this also bounds how many unknowns can accumulate before the route stops. */
  remoteSlots: number;
}): Promise<void> {
  // The fairness policy of the same version must already be installed (`createReasoningFairness(pool).installPolicy`).
  const bucket = async (dimension: string, unit: string, capacity: number) => {
    const id = randomUUID();
    await client.query('INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,$4)', [id, dimension, unit, capacity]);
    return id;
  };
  const global = await bucket('global_budget', 'tokens', input.tokenBudget);
  const account = await bucket('provider_account', 'requests', input.requestCap);
  const quota = await bucket('route_quota', 'requests', input.requestCap);
  const remote = await bucket('remote_concurrency', 'slots', input.remoteSlots);
  await client.query('UPDATE ask_answer_route SET enabled=false WHERE enabled');
  await client.query(
    `INSERT INTO ask_answer_route(policy_version,route_id,route_profile_version,transport,model,max_input_tokens,max_output_tokens,
       global_bucket_id,provider_account_bucket_id,route_quota_bucket_id,remote_concurrency_bucket_id,owner_capacity,job_capacity,answer_ttl_seconds,enabled)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
    [input.policyVersion, input.routeId, input.routeProfileVersion, input.transport, input.model, input.maxInputTokens, input.maxOutputTokens,
      global, account, quota, remote, input.ownerCapacity, input.jobCapacity, input.answerTtlSeconds],
  );
}

async function routeFor(client: pg.PoolClient | pg.Pool, policyVersion: string): Promise<Route | undefined> {
  return (await client.query<Route>('SELECT * FROM ask_answer_route WHERE policy_version=$1', [policyVersion])).rows[0];
}

/** The reasoning policy an answer Job resolves to: the route's shared buckets plus its owner and job buckets. */
function policyOf(route: Route, universeId: string, jobId: string, ownerBucket: string, jobBucket: string): ResolvedReasoningPolicy {
  const b = (bucketId: string, dimension: string, unit: string, basis: string, scope: 'shared' | 'owner' | 'job', handling: 'budget' | 'remote') =>
    ({ bucketId, dimension, unit, windowId: null, scope, scopeId: scope === 'owner' ? universeId : scope === 'job' ? jobId : null, basis, handling });
  return {
    version: 1, routeId: route.route_id, routeProfileVersion: route.route_profile_version, policyVersion: route.policy_version,
    maxInputTokens: route.max_input_tokens, maxOutputTokens: route.max_output_tokens, priceBasis: null,
    requiredDimensions: ['global_budget', 'owner_budget', 'job_budget', 'provider_account', 'route_quota', 'remote_concurrency'],
    buckets: [
      b(route.global_bucket_id, 'global_budget', 'tokens', 'total_tokens', 'shared', 'budget'),
      b(ownerBucket, 'owner_budget', 'tokens', 'total_tokens', 'owner', 'budget'),
      b(jobBucket, 'job_budget', 'tokens', 'total_tokens', 'job', 'budget'),
      b(route.provider_account_bucket_id, 'provider_account', 'requests', 'requests', 'shared', 'budget'),
      b(route.route_quota_bucket_id, 'route_quota', 'requests', 'requests', 'shared', 'budget'),
      b(route.remote_concurrency_bucket_id, 'remote_concurrency', 'slots', 'remote_slots', 'shared', 'remote'),
    ],
  } as ResolvedReasoningPolicy;
}

/** Trusted local SQL only: resolves an answer Job's policy from its request row. */
export const resolveAnswerPolicy: ReasoningAuthority['resolvePolicy'] = async (client, scope) => {
  const request = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE job_id=$1 AND universe_id=$2 AND privacy_epoch=$3', [scope.jobId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!request) return undefined;
  const route = await routeFor(client, request.policy_version);
  const owner = (await client.query<{ bucket_id: string }>('SELECT bucket_id FROM ask_answer_owner_bucket WHERE policy_version=$1 AND universe_id=$2', [request.policy_version, request.universe_id])).rows[0];
  if (!route || !owner) return undefined;
  return policyOf(route, request.universe_id, request.job_id, owner.bucket_id, request.job_bucket_id);
};

/** The authority fair admission and dispatch use for answer Jobs (ADR-0017 family routing). */
export function answerAuthority(): ReasoningAuthority {
  return createSealedContextAuthority(resolveAnswerPolicy);
}

function sourceOf(canonicalPayload: string): AskAnswerSource {
  const payload = askContextPayload.parse(JSON.parse(canonicalPayload));
  const a = payload.asset;
  return { question: payload.fact.question, scroll: { title: a.title, summary: a.summary, body: a.body, sourceTitle: a.sourceTitle, sourceUrl: a.sourceUrl, truthState: a.truthState } };
}

export type AnswerRequestReceipt = { requestId: string; askId: string; jobId: string; status: 'queued' };

/**
 * The fresh authority (ADR-0033 §1). The caller holds the authenticated universe lock
 * (`authenticateAndLock`); this acquires the original session, Job and asset locks in ADR-0017 order.
 */
export async function requestAskAnswer(client: pg.PoolClient, scope: AuthScope, askId: string, raw: unknown): Promise<AnswerRequestReceipt> {
  const parsed = askAnswerRequestInput.safeParse(raw);
  if (!parsed.success || !z.string().uuid().safeParse(askId).success) throw new AskAnswerError(400, 'Invalid answer request');
  const input = parsed.data;
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new AskAnswerError(409, 'Answer request privacy epoch is stale');

  const receipt = (r: RequestRow): AnswerRequestReceipt => ({ requestId: r.id, askId: r.ask_id, jobId: r.job_id, status: 'queued' });
  const byKey = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE universe_id=$1 AND client_request_id=$2', [scope.universeId, input.clientRequestId])).rows[0];
  if (byKey) {
    if (byKey.ask_id !== askId) throw new AskAnswerError(409, 'Answer request key reused for another Ask');
    return receipt(byKey);
  }
  if ((await client.query('SELECT 1 FROM ask_answer_request WHERE ask_id=$1', [askId])).rowCount) throw new AskAnswerError(409, 'An answer was already requested for this Ask');

  const paused = (await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [scope.universeId])).rows[0]!.paused;
  if (paused) throw new AskAnswerError(409, 'Recording is paused');
  const route = (await client.query<Route>('SELECT * FROM ask_answer_route WHERE enabled')).rows[0];
  if (!route) throw new AskAnswerError(503, 'Answers are not enabled on this deployment');

  const ask = (await client.query<{ session_id: string }>(
    'SELECT session_id FROM explicit_ask WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3', [askId, scope.universeId, scope.privacyEpoch],
  )).rows[0];
  if (!ask) throw new AskAnswerError(404, 'No such Ask');
  // ADR-0017: the authority is the Ask's own original session; another valid session cannot substitute.
  if (ask.session_id !== scope.sessionId) throw new AskAnswerError(409, 'Only the session that asked can request its answer');

  const owner = (await client.query<{ bucket_id: string }>('SELECT bucket_id FROM ask_answer_owner_bucket WHERE policy_version=$1 AND universe_id=$2', [route.policy_version, scope.universeId])).rows[0]?.bucket_id
    ?? await (async () => {
      const id = randomUUID();
      await client.query("INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'owner_budget','tokens',$2)", [id, route.owner_capacity]);
      await client.query('INSERT INTO ask_answer_owner_bucket(policy_version,universe_id,bucket_id) VALUES($1,$2,$3)', [route.policy_version, scope.universeId, id]);
      return id;
    })();
  const jobId = randomUUID(), contextId = randomUUID(), stepId = randomUUID(), requestId = randomUUID(), rowId = randomUUID(), jobBucket = randomUUID();
  await client.query("INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'job_budget','tokens',$2)", [jobBucket, route.job_capacity]);
  const deadline = (await client.query<{ at: Date }>(`SELECT clock_timestamp() + ($1 * interval '1 second') AS at`, [route.answer_ttl_seconds])).rows[0]!.at;
  await client.query(
    `INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
     VALUES($1,$2,$3,'queued','interactive',$2,$4,$5,'direct',$6)`,
    [jobId, scope.universeId, scope.privacyEpoch, route.policy_version, deadline, askId],
  );
  // The request row first, so the policy resolver can see the Job's buckets while compiling.
  await client.query(
    `INSERT INTO ask_answer_request(id,ask_id,universe_id,privacy_epoch,session_id,client_request_id,policy_version,job_id,step_id,context_id,request_id,request_hash,input_bytes,job_bucket_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [rowId, askId, scope.universeId, scope.privacyEpoch, scope.sessionId, input.clientRequestId, route.policy_version, jobId, stepId, contextId,
      requestId, null, null, jobBucket],
  );
  await compileDirectAskContext(client, scope, { contextId, jobId, askId }, resolveAnswerPolicy);
  await client.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,$4,$5,1,'pending')`,
    [stepId, jobId, scope.universeId, scope.privacyEpoch, contextId]);

  const payload = (await client.query<{ canonical_payload: string }>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1', [contextId])).rows[0]!;
  const bytes = serializeAskAnswerRequest(sourceOf(payload.canonical_payload), { model: route.model, maxOutputTokens: route.max_output_tokens });
  if (bytes.byteLength > route.max_input_tokens) throw new AskAnswerError(409, 'This Scroll is too long to answer within the configured request bound');
  const requestHash = createHash('sha256').update(bytes).digest('hex');
  // The one permitted completion of the request row (migration 0028 refuses any other update).
  await client.query('UPDATE ask_answer_request SET request_hash=$2,input_bytes=$3 WHERE id=$1', [rowId, requestHash, bytes.byteLength]);

  await enqueueFairInTransaction(client, {
    universeId: scope.universeId, privacyEpoch: scope.privacyEpoch, jobId, stepId, contextId, requestId, requestHash,
    inputTokensUpperBound: bytes.byteLength, maxOutputTokens: route.max_output_tokens, costCeilingMicroUsd: null,
    deadline: deadline.toISOString(), permitTtlMs: 60_000, policyVersion: route.policy_version, class: 'interactive',
  });
  return { requestId: rowId, askId, jobId, status: 'queued' };
}

export type AnswerWork = {
  universeId: string; privacyEpoch: number; jobId: string; stepId: string; contextId: string; askId: string;
  requestId: string; requestHash: string; inputTokensUpperBound: number; maxOutputTokens: number;
  transport: 'fixture' | 'minimax'; model: string; body: Uint8Array;
};

/**
 * What the worker may send for an admitted answer attempt: the bytes rebuilt from the sealed
 * context with the same serializer, refused unless their hash equals the reserved one.
 */
export async function loadAnswerWork(db: pg.Pool | pg.PoolClient, jobId: string, attemptId: string): Promise<AnswerWork> {
  const request = (await db.query<RequestRow>('SELECT * FROM ask_answer_request WHERE job_id=$1', [jobId])).rows[0];
  if (!request || request.request_hash === null || request.input_bytes === null) throw new Error('No answer request for this Job');
  const route = await routeFor(db as pg.PoolClient, request.policy_version);
  const attempt = (await db.query<{ request_hash: string }>('SELECT request_hash FROM reasoning_attempt WHERE id=$1 AND job_id=$2', [attemptId, jobId])).rows[0];
  const payload = (await db.query<{ canonical_payload: string }>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1', [request.context_id])).rows[0];
  if (!route || !attempt || !payload) throw new Error('Answer work is incomplete');
  const body = serializeAskAnswerRequest(sourceOf(payload.canonical_payload), { model: route.model, maxOutputTokens: route.max_output_tokens });
  const hash = createHash('sha256').update(body).digest('hex');
  if (hash !== request.request_hash || hash !== attempt.request_hash) throw new Error('Rebuilt answer request does not match its reservation');
  return {
    universeId: request.universe_id, privacyEpoch: request.privacy_epoch, jobId, stepId: request.step_id, contextId: request.context_id, askId: request.ask_id,
    requestId: request.request_id, requestHash: hash, inputTokensUpperBound: request.input_bytes, maxOutputTokens: route.max_output_tokens,
    transport: route.transport, model: route.model, body,
  };
}

type Fence = { universeId: string; privacyEpoch: number; jobId: string; stepId: string; attemptId: string; owner: string; leaseFence: string };
export type AnswerOutcome = { kind: 'applied'; status: 'answered' | 'not_in_source' | 'rejected' } | { kind: 'failed'; status: 'failed' } | { kind: 'discarded'; reason: string };

/** Lock in ADR-0017 order and prove the caller still holds this Job's live lease in the current epoch. */
async function lockFence(client: pg.PoolClient, f: Fence): Promise<string | null> {
  const universe = (await client.query<{ privacy_epoch: number }>('SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE', [f.universeId])).rows[0];
  if (universe?.privacy_epoch !== f.privacyEpoch) return 'stale_epoch';
  await lockBoundContextSession(client, { universeId: f.universeId, privacyEpoch: f.privacyEpoch, jobId: f.jobId });
  const job = (await client.query<{ status: string; lease_owner: string | null; lease_fence: string; live: boolean }>(
    `SELECT status,lease_owner,lease_fence::text,lease_expires_at>clock_timestamp() AS live FROM reasoning_job
     WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3 FOR UPDATE`, [f.jobId, f.universeId, f.privacyEpoch])).rows[0];
  if (!job) return 'private_state_gone';
  if (!['running', 'waiting'].includes(job.status) || job.lease_owner !== f.owner || job.lease_fence !== f.leaseFence || !job.live) return 'lease_lost';
  await client.query('SELECT id FROM reasoning_step WHERE id=$1 AND job_id=$2 FOR UPDATE', [f.stepId, f.jobId]);
  return null;
}

/** Close the execution graph safely: output consumed, attempt inactive, Step and Job terminal (ADR-0019 guard). */
async function finish(client: pg.PoolClient, f: Fence, succeeded: boolean): Promise<void> {
  await client.query("UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1", [f.attemptId]);
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [f.attemptId]);
  await client.query('UPDATE reasoning_step SET status=$2 WHERE id=$1', [f.stepId, succeeded ? 'succeeded' : 'failed']);
  await client.query('UPDATE reasoning_job SET status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [f.jobId, succeeded ? 'completed' : 'failed']);
}

/**
 * ADR-0033 §4: apply provider text only through the answer validator (ask-answer-v2), under the current fence, epoch,
 * eligible output authority and a clean context recheck. Anything stale is discarded, not applied.
 */
export async function applyAskAnswer(client: pg.PoolClient, f: Fence, text: string, authority: ReasoningAuthority): Promise<AnswerOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const account = (await client.query<{ state: string; output_authority: string }>('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE', [f.attemptId])).rows[0];
  if (!account || account.state !== 'responded' || account.output_authority !== 'eligible') return { kind: 'discarded', reason: 'output_not_eligible' };
  const request = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE job_id=$1', [f.jobId])).rows[0]!;
  const check = { universeId: f.universeId, privacyEpoch: f.privacyEpoch, jobId: f.jobId, stepId: f.stepId, contextId: request.context_id, policyVersion: request.policy_version };
  if (!(await authority.validateContext(client, check, 'lock')) || !(await authority.validateContext(client, check, 'recheck'))) {
    await insertAnswer(client, request, f.attemptId, { status: 'failed', reasons: ['context_changed'] });
    await finish(client, f, false);
    return { kind: 'failed', status: 'failed' };
  }
  const payload = (await client.query<{ canonical_payload: string }>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1', [request.context_id])).rows[0]!;
  const verdict = validateAskAnswerProposal(text, sourceOf(payload.canonical_payload));
  if (!verdict.ok) {
    await insertAnswer(client, request, f.attemptId, { status: 'rejected', reasons: verdict.reasons, validatorVersion: verdict.validatorVersion });
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  const p = verdict.proposal;
  // The validator refuses everything the schema would; should they ever disagree, the reply is
  // rejected here rather than thrown, so no provider text travels in a database error.
  await client.query('SAVEPOINT ask_answer_insert');
  try {
    await insertAnswer(client, request, f.attemptId, p.kind === 'answered'
      ? { status: 'answered', answer: p.answer, basis: p.basis, limits: p.limits, validatorVersion: verdict.validatorVersion }
      : { status: 'not_in_source', limits: p.limits, validatorVersion: verdict.validatorVersion });
    await client.query('RELEASE SAVEPOINT ask_answer_insert');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT ask_answer_insert');
    await insertAnswer(client, request, f.attemptId, { status: 'rejected', reasons: ['storage_refused'], validatorVersion: verdict.validatorVersion });
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  await finish(client, f, true);
  return { kind: 'applied', status: p.kind };
}

/** A refused, failed or unconfirmed call ends the answer honestly; nothing the provider said is kept. */
export type AnswerFailure = 'outcome_unknown' | 'provider_error' | 'provider_refusal' | 'apply_failed';
export async function failAskAnswer(client: pg.PoolClient, f: Fence, reason: AnswerFailure): Promise<AnswerOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const request = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE job_id=$1', [f.jobId])).rows[0]!;
  await insertAnswer(client, request, f.attemptId, { status: 'failed', reasons: [reason] });
  await finish(client, f, false);
  return { kind: 'failed', status: 'failed' };
}

/**
 * #132 review B2: an admitted attempt that was never sent is given back while this worker still holds
 * the lease — every reservation released, the Job cancelled — and the answer fails as `not_sent`.
 */
export async function giveBackUnsentAnswer(pool: pg.Pool, admission: ReasoningAdmission, f: Fence): Promise<AnswerOutcome> {
  await admission.withdrawJob({ universeId: f.universeId, privacyEpoch: f.privacyEpoch, jobId: f.jobId, owner: f.owner, leaseFence: f.leaseFence, reason: 'cancelled' });
  const closed = await inTransaction(pool, client => closeTerminalAnswer(client, f.jobId, 'not_sent'));
  return closed ? { kind: 'failed', status: 'failed' } : { kind: 'discarded', reason: 'already_settled' };
}

/** A terminal answer Job with no answer gets its honest failure: unknown if anything may have been sent. */
async function closeTerminalAnswer(client: pg.PoolClient, jobId: string, fallback: 'not_sent' | 'worker_stopped'): Promise<boolean> {
  const request = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE job_id=$1', [jobId])).rows[0];
  if (!request) return false;
  await client.query('SELECT id FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE', [request.universe_id, request.privacy_epoch]);
  const job = (await client.query<{ status: string }>('SELECT status FROM reasoning_job WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
  if (!job || !['cancelled', 'expired', 'failed', 'completed'].includes(job.status)) return false;
  if ((await client.query('SELECT 1 FROM ask_answer WHERE ask_id=$1', [request.ask_id])).rowCount) return false;
  const attempt = (await client.query<{ id: string; state: string }>(
    `SELECT at.id, ac.state FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.job_id=$1 ORDER BY at.id DESC LIMIT 1`, [jobId])).rows[0];
  // Possibly sent → unknown; a reply received but never applied → apply_failed; admitted but never
  // sent → the caller's reason; never admitted and past its deadline → expired.
  const reason = !attempt ? (job.status === 'expired' ? 'expired' : fallback)
    : ['dispatch_committed', 'unknown'].includes(attempt.state) ? 'outcome_unknown'
    : attempt.state === 'responded' ? 'apply_failed' : fallback;
  await insertAnswer(client, request, attempt?.id ?? null, { status: 'failed', reasons: [reason] });
  return true;
}

async function inTransaction<T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await body(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/**
 * A reply that was recorded but never applied (it arrived after the lease expired, or the worker
 * died between recording and applying) has no text left to apply. Its output is withdrawn, its
 * attempt and Step closed, and the Job left leaseless `waiting`, like `recoverAttempt` does for the
 * other states, so the idle withdrawal can end it. Locks universe → Job → Step → attempt.
 */
async function recoverRespondedAnswer(client: pg.PoolClient, row: { job_id: string; universe_id: string; privacy_epoch: number; step_id: string; attempt_id: string }): Promise<void> {
  const universe = (await client.query('SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE', [row.universe_id, row.privacy_epoch])).rowCount;
  if (!universe) return;
  const job = (await client.query<{ expired: boolean }>(
    `SELECT lease_expires_at <= clock_timestamp() AS expired FROM reasoning_job WHERE id=$1 AND status='running' FOR UPDATE`, [row.job_id])).rows[0];
  if (!job?.expired) return;
  await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE', [row.step_id]);
  const accounting = (await client.query<{ state: string }>(
    `SELECT ac.state FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id
     WHERE at.id=$1 AND at.active FOR UPDATE OF at, ac`, [row.attempt_id])).rows[0];
  if (accounting?.state !== 'responded') return;
  await client.query("UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1", [row.attempt_id]);
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [row.attempt_id]);
  await client.query("UPDATE reasoning_step SET status='failed' WHERE id=$1", [row.step_id]);
  await client.query(
    `UPDATE reasoning_job SET status='waiting',lease_owner=NULL,lease_expires_at=NULL,lease_fence=lease_fence+1 WHERE id=$1 AND lease_fence<9223372036854775807`,
    [row.job_id]);
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
export async function settleAbandonedAnswers(pool: pg.Pool, input: { owner: string; limit?: number }): Promise<number> {
  const limit = input.limit ?? 10;
  const admission = createReasoningAdmission(pool, answerAuthority());
  const expiredLeases = (await pool.query<{ job_id: string; universe_id: string; privacy_epoch: number; step_id: string; attempt_id: string; state: string }>(
    `SELECT j.id AS job_id, j.universe_id, j.privacy_epoch, at.step_id, at.id AS attempt_id, ac.state FROM ask_answer_request r
     JOIN reasoning_job j ON j.id = r.job_id JOIN reasoning_attempt at ON at.job_id = j.id AND at.active
     JOIN reasoning_accounting ac ON ac.attempt_id = at.id
     WHERE j.status = 'running' AND j.lease_expires_at <= clock_timestamp()
       AND ac.state IN ('reserved','dispatch_committed','unknown','responded')
       AND NOT EXISTS (SELECT 1 FROM ask_answer a WHERE a.ask_id = r.ask_id)
     ORDER BY j.id LIMIT $1`, [limit])).rows;
  for (const row of expiredLeases) {
    try {
      if (row.state === 'responded') await inTransaction(pool, client => recoverRespondedAnswer(client, row));
      else await admission.recoverAttempt({ universeId: row.universe_id, privacyEpoch: row.privacy_epoch, jobId: row.job_id, stepId: row.step_id, attemptId: row.attempt_id, owner: input.owner });
    } catch { /* another worker moved it, or it changed meanwhile; the next sweep sees its new state */ }
  }
  const leaseless = (await pool.query<{ job_id: string; universe_id: string; privacy_epoch: number; past: boolean }>(
    `SELECT j.id AS job_id, j.universe_id, j.privacy_epoch, j.deadline <= clock_timestamp() AS past FROM ask_answer_request r
     JOIN reasoning_job j ON j.id = r.job_id
     WHERE j.status = 'waiting' AND j.lease_owner IS NULL AND EXISTS (SELECT 1 FROM reasoning_attempt at WHERE at.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM reasoning_attempt at WHERE at.job_id = j.id AND at.active)
       AND NOT EXISTS (SELECT 1 FROM ask_answer a WHERE a.ask_id = r.ask_id)
     ORDER BY j.deadline, j.id LIMIT $1`, [limit])).rows;
  for (const row of leaseless) {
    const scope = { jobId: row.job_id, universeId: row.universe_id, privacyEpoch: row.privacy_epoch };
    try {
      await inTransaction(pool, client => (row.past ? expireIdleDirectJob(client, scope) : withdrawRecoveredDirectJob(client, scope)));
    } catch { /* e.g. a signed-out reader before the deadline: left for a later sweep */ }
  }
  const terminal = (await pool.query<{ job_id: string }>(
    `SELECT j.id AS job_id FROM ask_answer_request r JOIN reasoning_job j ON j.id = r.job_id
     WHERE j.status IN ('cancelled','expired','failed','completed') AND NOT EXISTS (SELECT 1 FROM ask_answer a WHERE a.ask_id = r.ask_id)
     ORDER BY j.id LIMIT $1`, [limit])).rows;
  let settled = 0;
  for (const row of terminal) {
    try { if (await inTransaction(pool, client => closeTerminalAnswer(client, row.job_id, 'worker_stopped'))) settled += 1; }
    catch { /* left for a later sweep */ }
  }
  return settled;
}

async function insertAnswer(client: pg.PoolClient, request: RequestRow, attemptId: string | null, a: {
  status: 'answered' | 'not_in_source' | 'rejected' | 'failed' | 'cancelled'; answer?: string; basis?: { quote: string }[]; limits?: string; reasons?: string[]; validatorVersion?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO ask_answer(ask_id,universe_id,privacy_epoch,attempt_id,status,answer,basis,limits,reasons,validator_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [request.ask_id, request.universe_id, request.privacy_epoch, attemptId, a.status, a.answer ?? null, JSON.stringify(a.basis ?? []), a.limits ?? null,
      JSON.stringify(a.reasons ?? []), a.validatorVersion ?? null],
  );
}

export type AskAnswerView = {
  askId: string; status: 'queued' | 'running' | 'answered' | 'not_in_source' | 'rejected' | 'failed' | 'cancelled' | 'unavailable';
  answer: string | null; basis: { quote: string }[]; limits: string | null; reasons: string[]; requestedAt: string; answeredAt: string | null;
};

/** The reader's view of an answer request, from this universe only. */
export async function readAskAnswer(client: pg.PoolClient, scope: AuthScope, askId: string): Promise<AskAnswerView | null> {
  if (!z.string().uuid().safeParse(askId).success) return null;
  const request = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE ask_id=$1 AND universe_id=$2 AND privacy_epoch=$3', [askId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!request) return null;
  const answer = (await client.query<{ status: AskAnswerView['status']; answer: string | null; basis: { quote: string }[]; limits: string | null; reasons: string[]; created_at: Date }>(
    'SELECT status,answer,basis,limits,reasons,created_at FROM ask_answer WHERE ask_id=$1', [askId])).rows[0];
  const base = { askId, requestedAt: request.requested_at.toISOString() };
  if (answer) return { ...base, status: answer.status, answer: answer.answer, basis: answer.basis, limits: answer.limits, reasons: answer.reasons, answeredAt: answer.created_at.toISOString() };
  const job = (await client.query<{ status: string; past: boolean }>('SELECT status, deadline <= clock_timestamp() AS past FROM reasoning_job WHERE id=$1', [request.job_id])).rows[0];
  // Past its deadline an unfinished answer will not arrive (a worker may have stopped mid-call, and a
  // possibly-sent request is never repeated): say so instead of "running" forever.
  const status: AskAnswerView['status'] = !job || job.past ? (job?.status === 'cancelled' ? 'cancelled' : 'unavailable')
    : job.status === 'queued' ? 'queued' : ['running', 'waiting'].includes(job.status) ? 'running' : job.status === 'cancelled' ? 'cancelled' : 'unavailable';
  return { ...base, status, answer: null, basis: [], limits: null, reasons: [], answeredAt: null };
}

/**
 * Withdraw an answer that has not started (ADR-0018 idle withdrawal, original session only). A
 * running answer ends by its own outcome or deadline; asking to cancel it is a 409, not a hidden race.
 */
export async function cancelAskAnswer(client: pg.PoolClient, scope: AuthScope, askId: string, raw: unknown): Promise<AskAnswerView> {
  const parsed = z.object({ expectedPrivacyEpoch: z.number().int().min(0).max(2147483647) }).strict().safeParse(raw);
  if (!parsed.success || !z.string().uuid().safeParse(askId).success) throw new AskAnswerError(400, 'Invalid cancel request');
  if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch) throw new AskAnswerError(409, 'Cancel privacy epoch is stale');
  const request = (await client.query<RequestRow>('SELECT * FROM ask_answer_request WHERE ask_id=$1 AND universe_id=$2 AND privacy_epoch=$3', [askId, scope.universeId, scope.privacyEpoch])).rows[0];
  if (!request) throw new AskAnswerError(404, 'No answer was requested for this Ask');
  const settled = (await client.query('SELECT 1 FROM ask_answer WHERE ask_id=$1', [askId])).rowCount;
  if (!settled) {
    try {
      const result = await cancelIdleDirectJob(client, scope, { jobId: request.job_id });
      if (result.status !== 'cancelled') throw new AskAnswerError(409, 'This answer is no longer waiting');
      await insertAnswer(client, request, null, { status: 'cancelled', reasons: ['cancelled_by_reader'] });
    } catch (error) {
      if (isIdleWithdrawalIneligible(error)) throw new AskAnswerError(409, 'This answer has already started');
      throw error;
    }
  }
  return (await readAskAnswer(client, scope, askId))!;
}

/** Clear/Reset: answers and requests go before the Ask facts they reference (ADR-0033 §6). */
export async function eraseAskAnswers(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM ask_answer WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM ask_answer_request WHERE universe_id=$1', [universeId]);
}

export async function exportAskAnswers(client: pg.PoolClient, universeId: string) {
  return (await client.query(
    `SELECT r.ask_id, r.requested_at, a.status, a.answer, a.basis, a.limits, a.reasons, a.validator_version, a.created_at AS answered_at
     FROM ask_answer_request r LEFT JOIN ask_answer a ON a.ask_id = r.ask_id WHERE r.universe_id=$1 ORDER BY r.requested_at`, [universeId])).rows;
}
