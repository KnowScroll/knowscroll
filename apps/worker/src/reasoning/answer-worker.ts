/**
 * #132 — the worker's Ask-answer consumer (ADR-0033 §2–§4). One pass: fair scheduling admits one
 * answer attempt; the reserved bytes are rebuilt from the sealed context and proven; exactly one
 * provider call goes through `invokeReasoningOnce`; the reply is applied only through
 * the answer validator (ask-answer-v2), or the answer fails honestly. Nothing here is reachable from the API process.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createReasoningAdmission } from '../../../../packages/db/src/reasoning-admission.ts';
import { answerAuthority, applyAskAnswer, failAskAnswer, giveBackUnsentAnswer, loadAnswerWork, type AnswerOutcome, type AnswerWork } from '../../../../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../../../../packages/db/src/reasoning-fairness.ts';
import { createReasoningReconciliation } from '../../../../packages/db/src/reasoning-reconciliation.ts';
import { invokeReasoningOnce, type SingleInvocationTransport } from './invoke.ts';
import type { z } from 'zod';
import type { reasoningUsage } from '../../../../packages/contracts/src/reasoning.ts';

type ReasoningUsage = z.infer<typeof reasoningUsage>;

/** What a provider transport observed: the minimal receipt fields, plus the reply text for the validator only. */
export type AnswerObservation = {
  remoteDisposition: 'terminal' | 'unconfirmed'; outcome: 'success' | 'refusal' | 'error' | 'unclassified';
  httpStatus: number | null; usage: ReasoningUsage;
  text: string | null;
};
export interface AnswerTransport {
  readonly kind: 'fixture' | 'minimax';
  /** Checked before anything is scheduled or reserved (e.g. provider quota); false leaves the queue untouched. */
  ready?(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  send(input: { body: Uint8Array; maxOutputTokens: number; signal: AbortSignal; work: AnswerWork }): Promise<AnswerObservation>;
}

export type AnswerPass =
  | { kind: 'idle'; reason: string }
  | { kind: 'done'; askId: string; invocation: 'recorded' | 'unknown' | 'not_invoked'; outcome: AnswerOutcome };

async function inTransaction<T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await body(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/**
 * Provider readiness (a quota request that carries the key) is asked at most once per window, not
 * on every loop: a success is trusted for `okMs`, a refusal backs off for `failMs` (#132 review I2).
 */
export function createReadinessGate(transport: AnswerTransport, options: { okMs?: number; failMs?: number; now?: () => number } = {}) {
  const okMs = options.okMs ?? 30_000, failMs = options.failMs ?? 60_000, now = options.now ?? Date.now;
  let until = 0, last: { ok: true } | { ok: false; reason: string } = { ok: true };
  return async (signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!transport.ready) return { ok: true };
    if (now() < until) return last;
    last = await transport.ready(signal);
    until = now() + (last.ok ? okMs : failMs);
    return last;
  };
}

export async function runAnswerPass(deps: {
  pool: pg.Pool; owner: string; leaseMs: number; transports: Partial<Record<'fixture' | 'minimax', AnswerTransport>>; signal: AbortSignal;
  /** Cached readiness per transport; without one, readiness is asked on this pass. */
  readiness?: Partial<Record<'fixture' | 'minimax', ReturnType<typeof createReadinessGate>>>;
}): Promise<AnswerPass> {
  const { pool, owner, leaseMs, transports, signal } = deps;
  const route = (await pool.query<{ policy_version: string; transport: 'fixture' | 'minimax' }>('SELECT policy_version,transport FROM ask_answer_route WHERE enabled')).rows[0];
  if (!route) return { kind: 'idle', reason: 'no_enabled_route' };
  const transport = transports[route.transport];
  if (!transport) return { kind: 'idle', reason: `transport_not_configured:${route.transport}` };
  // Readiness is asked only when an answer for this route is actually waiting to be scheduled.
  const waiting = (await pool.query(
    'SELECT 1 FROM reasoning_fairness_ready r JOIN ask_answer_request a ON a.job_id = r.job_id WHERE a.policy_version = $1 LIMIT 1', [route.policy_version])).rowCount;
  if (!waiting) return { kind: 'idle', reason: 'no_answer_waiting' };
  const gate = deps.readiness?.[route.transport] ?? createReadinessGate(transport, { okMs: 0, failMs: 0 });
  const readiness = await gate(signal);
  if (!readiness.ok) return { kind: 'idle', reason: readiness.reason };

  const authority = answerAuthority();
  const admission = createReasoningAdmission(pool, authority);
  const scheduled = await createReasoningFairness(pool, authority).schedule({ owner, leaseMs, policyVersion: route.policy_version });
  if (scheduled.kind !== 'admitted') return { kind: 'idle', reason: scheduled.kind };
  const { claim, reserved } = scheduled;
  const request = (await pool.query<{ ask_id: string; step_id: string }>('SELECT ask_id, step_id FROM ask_answer_request WHERE job_id=$1', [claim.jobId])).rows[0]!;
  const fence = { universeId: claim.universeId, privacyEpoch: claim.privacyEpoch, jobId: claim.jobId, stepId: request.step_id, attemptId: reserved.attemptId, owner, leaseFence: claim.leaseFence };

  // #132 review B2: from here on every exit closes the attempt. Never sent → given back at once (all
  // reservations released); possibly sent or answered-but-unapplied → failed honestly under the
  // lease. If even that fails, the recovery sweep closes it after the lease expires.
  const close = async (): Promise<AnswerOutcome> => {
    try {
      const state = (await pool.query<{ state: string }>('SELECT state FROM reasoning_accounting WHERE attempt_id=$1', [reserved.attemptId])).rows[0]?.state;
      if (state === 'reserved') return await giveBackUnsentAnswer(pool, admission, fence);
      return await inTransaction(pool, client => failAskAnswer(client, fence, state === 'responded' ? 'apply_failed' : 'outcome_unknown'));
    } catch { return { kind: 'discarded', reason: 'left_for_recovery' }; }
  };

  let work: AnswerWork;
  try { work = await loadAnswerWork(pool, claim.jobId, reserved.attemptId); }
  catch { return { kind: 'done', askId: request.ask_id, invocation: 'not_invoked', outcome: await close() }; }

  // The minimal receipt never carries content (ADR-0012); the text waits here for the validator.
  let text: string | null = null;
  let observed: AnswerObservation['outcome'] | null = null;
  const seam: SingleInvocationTransport = {
    async invoke({ body, maxOutputTokens, signal: callSignal }) {
      const o = await transport.send({ body, maxOutputTokens, signal: callSignal, work });
      text = o.text; observed = o.outcome;
      return { remoteDisposition: o.remoteDisposition, outcome: o.outcome, httpStatus: o.httpStatus, usage: o.usage };
    },
  };
  let invocation: Awaited<ReturnType<typeof invokeReasoningOnce>>;
  try {
    invocation = await invokeReasoningOnce({
      admission, reconciliation: createReasoningReconciliation(pool),
      authorization: { ...fence, requestId: work.requestId, requestHash: work.requestHash, inputTokensUpperBound: work.inputTokensUpperBound, maxOutputTokens: work.maxOutputTokens, dispatchId: randomUUID() },
      body: work.body, transport: seam, signal,
    });
  } catch {
    return { kind: 'done', askId: work.askId, invocation: 'unknown', outcome: await close() };
  }
  if (invocation.kind === 'not_invoked') return { kind: 'done', askId: work.askId, invocation: 'not_invoked', outcome: await close() };

  let outcome: AnswerOutcome;
  try {
    outcome = await inTransaction(pool, async client => {
      if (invocation.kind === 'recorded' && observed === 'success' && text !== null) return applyAskAnswer(client, fence, text, authority);
      if (invocation.kind === 'recorded') return failAskAnswer(client, fence, observed === 'refusal' ? 'provider_refusal' : 'provider_error');
      return failAskAnswer(client, fence, 'outcome_unknown');
    });
  } catch { outcome = await close(); }
  return { kind: 'done', askId: work.askId, invocation: invocation.kind, outcome };
}
