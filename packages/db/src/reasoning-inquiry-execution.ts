/**
 * #132 — executing one background bridge inquiry (ADR-0038 §6–§8), mirroring the Ask-answer path.
 *
 * The worker rebuilds the reserved bytes from the sealed context (`loadInquiryWork`), sends them once
 * through `invokeReasoningOnce`, then finishes under its fence: `applyInquiryReply` rechecks the
 * sealed facts and turns a reply into a decided proposal only through `submitBridgeProposal`
 * (universe scope, proposer `model`, the Attempt id as its reference), or `failInquiry` ends it
 * honestly. When the validator refuses, the route may allow one continuation (ADR-0042 §1): the next
 * Step, carrying the refused turn and the validator's reasons, is recorded and queued fairly, never
 * sent from here. `settleInquiries` is the recovery sweep: expired leases, leaseless Jobs, stale or
 * expired queued Jobs and terminal Jobs whose inquiry is still open. Nothing here ever re-sends a request.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inquiryAssistantTurn, type InquiryContextPayload } from '../../contracts/src/reasoning-inquiry-context.ts';
import { parseBridgeInquiryReply, serializeBridgeInquiryRequest, type AssistantBlock, type ContinuationTurn } from '../../core/src/reasoning/bridge-inquiry.ts';
import { createReasoningAdmission, type ReasoningAdmission } from './reasoning-admission.ts';
import { enqueueFairInTransaction } from './reasoning-fairness.ts';
import { withdrawIdleBackgroundJob } from './reasoning-idle-lifecycle.ts';
import { inquiryAuthority, inquiryRouteFor, requestRoute, resolveInquiryPolicy, type InquiryRow } from './reasoning-inquiries.ts';
import { readInquiryPayload, validateInquiryContext } from './reasoning-inquiry-context.ts';
import { ReasoningDenied, type ReasoningAuthority } from './reasoning-runtime-policy.ts';
import { submitBridgeProposal } from './semantic/proposals.ts';

export type InquiryWork = {
  universeId: string; privacyEpoch: number; jobId: string; stepId: string; contextId: string; inquiryId: string;
  requestId: string; requestHash: string; inputTokensUpperBound: number; maxOutputTokens: number;
  transport: 'fixture' | 'minimax'; model: string; body: Uint8Array;
};

type ContinuationRow = { step_id: string; ordinal: number; request_id: string; request_hash: string; input_bytes: number; reasons: string[]; assistant_turn: unknown };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The refused turns a Step's request carries: none for the first, each earlier continuation's for the next (ADR-0042 §1). */
async function continuationTurns(db: pg.Pool | pg.PoolClient, jobId: string, throughOrdinal: number): Promise<{ rows: ContinuationRow[]; turns: ContinuationTurn[] }> {
  const rows = (await db.query<ContinuationRow>('SELECT * FROM background_inquiry_continuation WHERE job_id=$1 AND ordinal<=$2 ORDER BY ordinal', [jobId, throughOrdinal])).rows;
  return { rows, turns: rows.map(r => ({ assistant: inquiryAssistantTurn.parse(r.assistant_turn), reasons: r.reasons })) };
}

/** What the worker may send for an admitted inquiry attempt: the bytes rebuilt from the sealed context
 * (and, for a continuation Step, the protected refused turns) with the same serializer, refused unless
 * their hash equals the one reserved for that Step. */
export async function loadInquiryWork(db: pg.Pool | pg.PoolClient, jobId: string, attemptId: string): Promise<InquiryWork> {
  const inquiry = (await db.query<InquiryRow>('SELECT * FROM background_inquiry WHERE job_id=$1', [jobId])).rows[0];
  if (!inquiry?.policy_version || !inquiry.context_id || !inquiry.request_hash || inquiry.input_bytes === null) throw new Error('No inquiry request for this Job');
  const route = await inquiryRouteFor(db, inquiry.policy_version);
  const attempt = (await db.query<{ request_hash: string; step_id: string; ordinal: number }>(
    'SELECT a.request_hash, a.step_id, s.ordinal FROM reasoning_attempt a JOIN reasoning_step s ON s.id = a.step_id WHERE a.id=$1 AND a.job_id=$2', [attemptId, jobId])).rows[0];
  if (!route || !attempt) throw new Error('Inquiry work is incomplete');
  const { rows, turns } = await continuationTurns(db, jobId, attempt.ordinal);
  const continuation = rows.find(r => r.step_id === attempt.step_id);
  if (!continuation && attempt.step_id !== inquiry.step_id) throw new Error('Inquiry work is incomplete');
  const request = continuation ? { id: continuation.request_id, hash: continuation.request_hash, bytes: continuation.input_bytes }
    : { id: inquiry.request_id!, hash: inquiry.request_hash, bytes: inquiry.input_bytes };
  const payload = await readInquiryPayload(db, inquiry.context_id);
  const body = serializeBridgeInquiryRequest(payload.pairs, requestRoute(route), turns);
  const hash = sha(body);
  if (hash !== request.hash || hash !== attempt.request_hash) throw new Error('Rebuilt inquiry request does not match its reservation');
  return {
    universeId: inquiry.universe_id, privacyEpoch: inquiry.privacy_epoch, jobId, stepId: attempt.step_id, contextId: inquiry.context_id, inquiryId: inquiry.id,
    requestId: request.id, requestHash: hash, inputTokensUpperBound: request.bytes, maxOutputTokens: route.max_output_tokens,
    transport: route.transport, model: route.model, body,
  };
}

export type InquiryFence = { universeId: string; privacyEpoch: number; jobId: string; stepId: string; attemptId: string; owner: string; leaseFence: string };
/** What the provider returned for the validator: its text, and the whole turn and stop reason (ADR-0042 §1–§2). */
export type InquiryReply = { text: string; content: readonly AssistantBlock[]; stopReason: string | null };
export type InquiryOutcome =
  | { kind: 'applied'; status: 'admitted' | 'rejected' | 'none' }
  /** The validator refused; the next Step waits in the fair queue (ADR-0042 §1). */
  | { kind: 'continued'; ordinal: number }
  | { kind: 'withdrawn'; reason: 'consent_off' | 'recording_paused' }
  | { kind: 'failed'; reason: string }
  | { kind: 'discarded'; reason: string };

/** Lock in ADR-0017 order (universe → Job → Step) and prove the caller still holds this Job's live lease. */
async function lockFence(client: pg.PoolClient, f: InquiryFence): Promise<string | null> {
  const universe = (await client.query<{ privacy_epoch: number }>('SELECT privacy_epoch FROM universe WHERE id=$1 FOR UPDATE', [f.universeId])).rows[0];
  if (universe?.privacy_epoch !== f.privacyEpoch) return 'stale_epoch';
  const job = (await client.query<{ status: string; lease_owner: string | null; lease_fence: string; live: boolean }>(
    `SELECT status,lease_owner,lease_fence::text,lease_expires_at>clock_timestamp() AS live FROM reasoning_job
     WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3 FOR UPDATE`, [f.jobId, f.universeId, f.privacyEpoch])).rows[0];
  if (!job) return 'private_state_gone';
  if (!['running', 'waiting'].includes(job.status) || job.lease_owner !== f.owner || job.lease_fence !== f.leaseFence || !job.live) return 'lease_lost';
  await client.query('SELECT id FROM reasoning_step WHERE id=$1 AND job_id=$2 FOR UPDATE', [f.stepId, f.jobId]);
  return null;
}

/** Close the execution graph safely: output consumed, attempt inactive, Step and Job terminal (ADR-0019 guard). */
async function finish(client: pg.PoolClient, f: InquiryFence, succeeded: boolean): Promise<void> {
  await client.query("UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1", [f.attemptId]);
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [f.attemptId]);
  await client.query('UPDATE reasoning_step SET status=$2 WHERE id=$1', [f.stepId, succeeded ? 'succeeded' : 'failed']);
  await client.query('UPDATE reasoning_job SET status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [f.jobId, succeeded ? 'completed' : 'failed']);
}

async function closeInquiry(client: pg.PoolClient, inquiryId: string, status: string, fields: { attemptId?: string | null; proposalId?: string | null; reasons?: string[] }): Promise<void> {
  const closed = await client.query(`UPDATE background_inquiry SET status=$2, attempt_id=$3, proposal_id=$4, reasons=$5 WHERE id=$1 AND status='queued'`,
    [inquiryId, status, fields.attemptId ?? null, fields.proposalId ?? null, JSON.stringify(fields.reasons ?? [])]);
  if (closed.rowCount !== 1) throw new Error('Inquiry is no longer open');
}

/** A sealed fact that no longer holds: consent off or a pause withdraw it, a passed deadline expires it; anything else is stale. */
function staleOutcome(refusal: string): { status: 'withdrawn' | 'failed'; reasons: string[]; outcome: InquiryOutcome } {
  if (refusal === 'consent_inactive') return { status: 'withdrawn', reasons: ['consent_off'], outcome: { kind: 'withdrawn', reason: 'consent_off' } };
  if (refusal === 'recording_paused') return { status: 'withdrawn', reasons: ['recording_paused'], outcome: { kind: 'withdrawn', reason: 'recording_paused' } };
  if (refusal === 'expired') return { status: 'failed', reasons: ['expired'], outcome: { kind: 'failed', reason: 'expired' } };
  return { status: 'failed', reasons: ['stale_context', refusal], outcome: { kind: 'failed', reason: 'stale_context' } };
}

/**
 * ADR-0038 §7: under the current fence, epoch and eligible output authority, recheck the sealed
 * context, then let the reply become at most one proposal that bridge-validator-v1 decides. A shape
 * failure stores only its reasons; "none" stores nothing; stale context discards the reply; a reply
 * that did not finish its turn is `truncated` (ADR-0042 §2). A refusal may continue (ADR-0042 §1).
 */
export async function applyInquiryReply(client: pg.PoolClient, f: InquiryFence, reply: InquiryReply, authority: ReasoningAuthority): Promise<InquiryOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const account = (await client.query<{ state: string; output_authority: string }>('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE', [f.attemptId])).rows[0];
  if (!account || account.state !== 'responded' || account.output_authority !== 'eligible') {
    // A reply that lands after the Job's deadline has no output authority (ADR-0012). Say so now,
    // rather than leaving the inquiry "looking" until the lease-expiry sweep calls it apply_failed.
    const late = account?.state === 'responded'
      && (await client.query<{ past: boolean }>('SELECT deadline <= clock_timestamp() AS past FROM reasoning_job WHERE id=$1', [f.jobId])).rows[0]?.past;
    const open = late ? (await client.query<InquiryRow>(`SELECT * FROM background_inquiry WHERE job_id=$1 AND status='queued' FOR UPDATE`, [f.jobId])).rows[0] : undefined;
    if (!open) return { kind: 'discarded', reason: 'output_not_eligible' };
    await closeInquiry(client, open.id, 'failed', { attemptId: f.attemptId, reasons: ['expired'] });
    await finish(client, f, false);
    return { kind: 'failed', reason: 'expired' };
  }
  const inquiry = (await client.query<InquiryRow>('SELECT * FROM background_inquiry WHERE job_id=$1 FOR UPDATE', [f.jobId])).rows[0];
  if (!inquiry || inquiry.status !== 'queued') return { kind: 'discarded', reason: 'inquiry_closed' };
  const check = { universeId: f.universeId, privacyEpoch: f.privacyEpoch, jobId: f.jobId, stepId: f.stepId, contextId: inquiry.context_id!, policyVersion: inquiry.policy_version! };
  let refusal: string | null = null;
  try { await authority.validateContext(client, check, 'lock'); await authority.validateContext(client, check, 'recheck'); }
  catch (error) { if (!(error instanceof ReasoningDenied)) throw error; refusal = error.code.replace(/^context_/, ''); }
  if (refusal) {
    const end = staleOutcome(refusal);
    await closeInquiry(client, inquiry.id, end.status, { attemptId: f.attemptId, reasons: end.reasons });
    await finish(client, f, false);
    return end.outcome;
  }
  if (reply.stopReason === 'max_tokens') {
    await closeInquiry(client, inquiry.id, 'failed', { attemptId: f.attemptId, reasons: ['truncated'] });
    await finish(client, f, false);
    return { kind: 'failed', reason: 'truncated' };
  }
  const payload = await readInquiryPayload(client, inquiry.context_id!);
  const parsed = parseBridgeInquiryReply(reply.text, payload.pairs);
  if (parsed.kind === 'shape') {
    await closeInquiry(client, inquiry.id, 'rejected', { attemptId: f.attemptId, reasons: parsed.reasons });
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  if (parsed.kind === 'none') {
    await closeInquiry(client, inquiry.id, 'none', { attemptId: f.attemptId });
    await finish(client, f, true);
    return { kind: 'applied', status: 'none' };
  }
  // The validator's decision is the outcome. Should storage refuse what the schema already parsed,
  // the reply is rejected here rather than thrown, so no provider text travels in a database error.
  await client.query('SAVEPOINT inquiry_proposal');
  let decided: Awaited<ReturnType<typeof submitBridgeProposal>>;
  try {
    decided = await submitBridgeProposal(client, {
      scope: { kind: 'universe', universeId: f.universeId, privacyEpoch: f.privacyEpoch }, proposerKind: 'model', proposerRef: f.attemptId, payload: parsed.payload,
    });
    await client.query('RELEASE SAVEPOINT inquiry_proposal');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT inquiry_proposal');
    await closeInquiry(client, inquiry.id, 'rejected', { attemptId: f.attemptId, reasons: ['storage_refused'] });
    await finish(client, f, false);
    return { kind: 'applied', status: 'rejected' };
  }
  if (decided.decision.outcome === 'rejected') {
    const ordinal = await continueInquiry(client, f, inquiry, payload, { assistant: reply.content, reasons: decided.decision.reasons });
    if (ordinal !== null) return { kind: 'continued', ordinal };
  }
  const admitted = decided.status === 'admitted';
  await closeInquiry(client, inquiry.id, admitted ? 'admitted' : 'rejected', {
    attemptId: f.attemptId, proposalId: decided.proposalId, reasons: decided.decision.outcome === 'rejected' ? decided.decision.reasons : [],
  });
  await finish(client, f, admitted);
  return { kind: 'applied', status: admitted ? 'admitted' : 'rejected' };
}

/**
 * ADR-0042 §1: the validator refused this Step's proposal (already recorded). Within the route's bound,
 * and only if the next request still fits it, the refused Step is superseded, the next Step is created on
 * the same sealed context with its exact request (the refused turn is kept as protected runtime data),
 * the lease is released and the Step is queued fairly. Returns its ordinal, or null: the refusal stands.
 */
async function continueInquiry(client: pg.PoolClient, f: InquiryFence, inquiry: InquiryRow, payload: InquiryContextPayload, refused: ContinuationTurn): Promise<number | null> {
  const route = await inquiryRouteFor(client, inquiry.policy_version!);
  const step = (await client.query<{ ordinal: number; deadline: Date }>(
    'SELECT s.ordinal, j.deadline FROM reasoning_step s JOIN reasoning_job j ON j.id = s.job_id WHERE s.id=$1', [f.stepId])).rows[0]!;
  const turn = inquiryAssistantTurn.safeParse(refused.assistant);
  if (!route || step.ordinal > route.max_continuation_steps || !turn.success) return null;
  const { turns } = await continuationTurns(client, f.jobId, step.ordinal);
  const body = serializeBridgeInquiryRequest(payload.pairs, requestRoute(route), [...turns, { assistant: turn.data, reasons: refused.reasons }]);
  if (body.byteLength > route.max_input_tokens) return null;
  const next = { stepId: randomUUID(), requestId: randomUUID(), ordinal: step.ordinal + 1, requestHash: sha(body) };
  await client.query("UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1", [f.attemptId]);
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [f.attemptId]);
  await client.query("UPDATE reasoning_step SET status='superseded' WHERE id=$1", [f.stepId]);
  await client.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,$4,$5,$6,'pending')`,
    [next.stepId, f.jobId, f.universeId, f.privacyEpoch, inquiry.context_id, next.ordinal]);
  await client.query(
    `INSERT INTO background_inquiry_continuation(step_id,job_id,context_id,universe_id,privacy_epoch,inquiry_id,ordinal,previous_attempt_id,request_id,request_hash,input_bytes,reasons,assistant_turn)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [next.stepId, f.jobId, inquiry.context_id, f.universeId, f.privacyEpoch, inquiry.id, next.ordinal, f.attemptId, next.requestId, next.requestHash,
      body.byteLength, JSON.stringify(refused.reasons), JSON.stringify(turn.data)]);
  await client.query(`UPDATE reasoning_job SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [f.jobId]);
  await enqueueFairInTransaction(client, {
    universeId: f.universeId, privacyEpoch: f.privacyEpoch, jobId: f.jobId, stepId: next.stepId, contextId: inquiry.context_id!, requestId: next.requestId,
    requestHash: next.requestHash, inputTokensUpperBound: body.byteLength, maxOutputTokens: route.max_output_tokens, costCeilingMicroUsd: null,
    deadline: step.deadline.toISOString(), permitTtlMs: 60_000, policyVersion: route.policy_version, class: 'background_inquiry',
  });
  return next.ordinal;
}

/** A refused, failed or unconfirmed call ends the inquiry honestly; nothing the provider said is kept. */
export type InquiryFailure = 'outcome_unknown' | 'provider_error' | 'provider_refusal' | 'apply_failed';
export async function failInquiry(client: pg.PoolClient, f: InquiryFence, reason: InquiryFailure): Promise<InquiryOutcome> {
  const stale = await lockFence(client, f);
  if (stale) return { kind: 'discarded', reason: stale };
  const inquiry = (await client.query<{ id: string; status: string }>('SELECT id, status FROM background_inquiry WHERE job_id=$1 FOR UPDATE', [f.jobId])).rows[0];
  if (!inquiry || inquiry.status !== 'queued') return { kind: 'discarded', reason: 'inquiry_closed' };
  await closeInquiry(client, inquiry.id, 'failed', { attemptId: f.attemptId, reasons: [reason] });
  await finish(client, f, false);
  return { kind: 'failed', reason };
}

async function inTransaction<T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await body(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** The Job's last Attempt: that of its latest Step (a continuation adds Steps, ADR-0042 §1). */
async function latestAttempt(client: pg.PoolClient, jobId: string): Promise<{ id: string; state: string } | undefined> {
  return (await client.query<{ id: string; state: string }>(
    `SELECT at.id, ac.state FROM reasoning_attempt at JOIN reasoning_step s ON s.id = at.step_id JOIN reasoning_accounting ac ON ac.attempt_id = at.id
     WHERE at.job_id=$1 ORDER BY s.ordinal DESC LIMIT 1`, [jobId])).rows[0];
}

/** Why an inquiry whose Job ended without an outcome ended: unknown if anything may have been sent. */
async function closeTerminalInquiry(client: pg.PoolClient, jobId: string, fallback: string[]): Promise<boolean> {
  const inquiry = (await client.query<InquiryRow>('SELECT * FROM background_inquiry WHERE job_id=$1', [jobId])).rows[0];
  if (!inquiry) return false;
  await client.query('SELECT id FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE', [inquiry.universe_id, inquiry.privacy_epoch]);
  const job = (await client.query<{ status: string }>('SELECT status FROM reasoning_job WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
  if (!job || !['cancelled', 'expired', 'failed', 'completed'].includes(job.status)) return false;
  const open = (await client.query<{ status: string }>('SELECT status FROM background_inquiry WHERE id=$1 FOR UPDATE', [inquiry.id])).rows[0];
  if (open?.status !== 'queued') return false;
  const attempt = await latestAttempt(client, jobId);
  const reasons = !attempt ? (job.status === 'expired' ? ['expired'] : fallback)
    : ['dispatch_committed', 'unknown'].includes(attempt.state) ? ['outcome_unknown']
    : attempt.state === 'responded' ? ['apply_failed'] : fallback;
  const withdrawn = reasons[0] === 'consent_off' || reasons[0] === 'recording_paused';
  await closeInquiry(client, inquiry.id, withdrawn ? 'withdrawn' : 'failed', { attemptId: attempt?.id ?? null, reasons });
  return true;
}

/**
 * An admitted attempt that was never sent (the worker stopped, or the sealed facts no longer held at
 * dispatch) is given back while this worker still holds the lease: every reservation released, the
 * Job cancelled; the inquiry then records why.
 */
export async function giveBackUnsentInquiry(pool: pg.Pool, admission: ReasoningAdmission, f: InquiryFence, refusal: string | null): Promise<InquiryOutcome> {
  await admission.withdrawJob({ universeId: f.universeId, privacyEpoch: f.privacyEpoch, jobId: f.jobId, owner: f.owner, leaseFence: f.leaseFence, reason: 'cancelled' });
  const end = refusal ? staleOutcome(refusal) : { reasons: ['not_sent'], outcome: { kind: 'failed', reason: 'not_sent' } as InquiryOutcome };
  const closed = await inTransaction(pool, client => closeTerminalInquiry(client, f.jobId, end.reasons));
  return closed ? end.outcome : { kind: 'discarded', reason: 'already_settled' };
}

/** A reply recorded but never applied has no text left: withdraw its output and leave the Job
 * leaseless `waiting` (as `recoverAttempt` does for the other states), so the sweep can close it. */
async function recoverRespondedInquiry(client: pg.PoolClient, row: { job_id: string; universe_id: string; privacy_epoch: number; step_id: string; attempt_id: string }): Promise<void> {
  if (!(await client.query('SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE', [row.universe_id, row.privacy_epoch])).rowCount) return;
  const job = (await client.query<{ expired: boolean }>(
    `SELECT lease_expires_at <= clock_timestamp() AS expired FROM reasoning_job WHERE id=$1 AND status='running' FOR UPDATE`, [row.job_id])).rows[0];
  if (!job?.expired) return;
  await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE', [row.step_id]);
  const accounting = (await client.query<{ state: string }>(
    `SELECT ac.state FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.id=$1 AND at.active FOR UPDATE OF at, ac`, [row.attempt_id])).rows[0];
  if (accounting?.state !== 'responded') return;
  await client.query("UPDATE reasoning_accounting SET output_authority='withdrawn' WHERE attempt_id=$1", [row.attempt_id]);
  await client.query('UPDATE reasoning_attempt SET active=false WHERE id=$1', [row.attempt_id]);
  await client.query("UPDATE reasoning_step SET status='failed' WHERE id=$1", [row.step_id]);
  await client.query(`UPDATE reasoning_job SET status='waiting',lease_owner=NULL,lease_expires_at=NULL,lease_fence=lease_fence+1 WHERE id=$1 AND lease_fence<9223372036854775807`, [row.job_id]);
}

/** Close an idle inquiry Job: the inquiry records why first (the schema requires it), then the Job is
 * withdrawn (ADR-0018 background branch). One transaction; the universe lock first. */
async function withdrawIdleInquiry(client: pg.PoolClient, row: { job_id: string; universe_id: string; privacy_epoch: number }, decide: (inquiry: InquiryRow) => Promise<{ status: string; reasons: string[]; expire: boolean } | null>): Promise<boolean> {
  if (!(await client.query('SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=$2 FOR UPDATE', [row.universe_id, row.privacy_epoch])).rowCount) return false;
  const job = (await client.query<{ status: string; idle: boolean }>(
    `SELECT status, (lease_owner IS NULL OR lease_expires_at <= clock_timestamp()) AS idle FROM reasoning_job WHERE id=$1 FOR UPDATE`, [row.job_id])).rows[0];
  const inquiry = (await client.query<InquiryRow>('SELECT * FROM background_inquiry WHERE job_id=$1 FOR UPDATE', [row.job_id])).rows[0];
  if (!job?.idle || !['queued', 'waiting'].includes(job.status) || inquiry?.status !== 'queued') return false;
  const verdict = await decide(inquiry);
  if (!verdict) return false;
  const attempt = await latestAttempt(client, row.job_id);
  await closeInquiry(client, inquiry.id, verdict.status, { attemptId: attempt?.id ?? null, reasons: verdict.reasons });
  await withdrawIdleBackgroundJob(client, { jobId: row.job_id, universeId: row.universe_id, privacyEpoch: row.privacy_epoch }, verdict.expire ? 'expired' : 'cancelled');
  return true;
}

/**
 * The recovery sweep (ADR-0019 primitives, as for answers). Every row is handled on its own; one that
 * cannot move now is left for a later sweep. Returns how many inquiries it closed.
 *  1. a running Job whose lease expired has its attempt recovered, or its recorded reply withdrawn;
 *  2. a leaseless Job after recovery closes as unknown/apply_failed/not_sent and is withdrawn;
 *  3. a queued Job whose sealed facts no longer hold (consent, pause, a claim, the pair, a place) or
 *     whose deadline passed is withdrawn before anything is admitted — never sent;
 *  4. a terminal Job whose inquiry is still open gets its honest failure.
 */
export async function settleInquiries(pool: pg.Pool, input: { owner: string; limit?: number }): Promise<number> {
  const limit = input.limit ?? 10;
  const admission = createReasoningAdmission(pool, inquiryAuthority());
  const expiredLeases = (await pool.query<{ job_id: string; universe_id: string; privacy_epoch: number; step_id: string; attempt_id: string; state: string }>(
    `SELECT j.id AS job_id, j.universe_id, j.privacy_epoch, at.step_id, at.id AS attempt_id, ac.state FROM background_inquiry i
     JOIN reasoning_job j ON j.id = i.job_id JOIN reasoning_attempt at ON at.job_id = j.id AND at.active JOIN reasoning_accounting ac ON ac.attempt_id = at.id
     WHERE i.status = 'queued' AND j.status = 'running' AND j.lease_expires_at <= clock_timestamp()
       AND ac.state IN ('reserved','dispatch_committed','unknown','responded') ORDER BY j.id LIMIT $1`, [limit])).rows;
  for (const row of expiredLeases) {
    try {
      if (row.state === 'responded') await inTransaction(pool, client => recoverRespondedInquiry(client, row));
      else await admission.recoverAttempt({ universeId: row.universe_id, privacyEpoch: row.privacy_epoch, jobId: row.job_id, stepId: row.step_id, attemptId: row.attempt_id, owner: input.owner });
    } catch { /* another worker moved it; the next sweep sees its new state */ }
  }
  let settled = 0;
  const idle = (await pool.query<{ job_id: string; universe_id: string; privacy_epoch: number; queued: boolean }>(
    `SELECT j.id AS job_id, j.universe_id, j.privacy_epoch, j.status = 'queued' AS queued
     FROM background_inquiry i JOIN reasoning_job j ON j.id = i.job_id
     WHERE i.status = 'queued' AND j.status IN ('queued','waiting') AND (j.lease_owner IS NULL OR j.lease_expires_at <= clock_timestamp())
       AND NOT EXISTS (SELECT 1 FROM reasoning_attempt at WHERE at.job_id = j.id AND at.active)
     ORDER BY j.deadline, j.id LIMIT $1`, [limit])).rows;
  for (const row of idle) {
    try {
      const closed = await inTransaction(pool, client => withdrawIdleInquiry(client, row, async inquiry => {
        const past = (await client.query<{ past: boolean }>('SELECT deadline <= clock_timestamp() AS past FROM reasoning_job WHERE id=$1', [row.job_id])).rows[0]!.past;
        // A leaseless waiting Job was recovered after its worker's lease expired; a queued one waits for
        // admission, of its first Step or of a continuation (ADR-0042 §1).
        if (!row.queued) {
          const state = (await latestAttempt(client, row.job_id))?.state;
          const reason = state === 'unknown' || state === 'dispatch_committed' ? 'outcome_unknown' : state === 'responded' ? 'apply_failed' : 'worker_stopped';
          return { status: 'failed', reasons: [reason], expire: past };
        }
        if (past) return { status: 'failed', reasons: ['expired'], expire: true };
        const pending = (await client.query<{ id: string }>(`SELECT id FROM reasoning_step WHERE job_id=$1 AND status='pending'`, [row.job_id])).rows[0]!;
        const check = await validateInquiryContext(client, { universeId: row.universe_id, privacyEpoch: row.privacy_epoch, jobId: row.job_id,
          stepId: pending.id, contextId: inquiry.context_id!, policyVersion: inquiry.policy_version! }, resolveInquiryPolicy, 'lock');
        if (check.valid) return null;
        const end = staleOutcome(check.reason);
        return { status: end.status, reasons: end.reasons, expire: false };
      }));
      if (closed) settled += 1;
    } catch { /* e.g. the worker took it meanwhile: left for a later sweep */ }
  }
  const terminal = (await pool.query<{ job_id: string }>(
    `SELECT j.id AS job_id FROM background_inquiry i JOIN reasoning_job j ON j.id = i.job_id
     WHERE i.status = 'queued' AND j.status IN ('cancelled','expired','failed','completed') ORDER BY j.id LIMIT $1`, [limit])).rows;
  for (const row of terminal) {
    try { if (await inTransaction(pool, client => closeTerminalInquiry(client, row.job_id, ['worker_stopped']))) settled += 1; }
    catch { /* left for a later sweep */ }
  }
  return settled;
}
