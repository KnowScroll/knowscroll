/**
 * #132 — the worker's Ask-answer consumer (ADR-0033 §2–§4). One pass: fair scheduling admits one
 * answer attempt; the reserved bytes are rebuilt from the sealed context and proven; exactly one
 * provider call goes through `invokeReasoningOnce`; the reply is applied only through
 * ask-answer-v1, or the answer fails honestly. Nothing here is reachable from the API process.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createReasoningAdmission } from '../../../../packages/db/src/reasoning-admission.ts';
import { answerAuthority, applyAskAnswer, failAskAnswer, loadAnswerWork, type AnswerOutcome, type AnswerWork } from '../../../../packages/db/src/reasoning-answers.ts';
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

export async function runAnswerPass(deps: {
  pool: pg.Pool; owner: string; leaseMs: number; transports: Partial<Record<'fixture' | 'minimax', AnswerTransport>>; signal: AbortSignal;
}): Promise<AnswerPass> {
  const { pool, owner, leaseMs, transports, signal } = deps;
  const route = (await pool.query<{ policy_version: string; transport: 'fixture' | 'minimax' }>('SELECT policy_version,transport FROM ask_answer_route WHERE enabled')).rows[0];
  if (!route) return { kind: 'idle', reason: 'no_enabled_route' };
  const transport = transports[route.transport];
  if (!transport) return { kind: 'idle', reason: `transport_not_configured:${route.transport}` };

  const authority = answerAuthority();
  const scheduled = await createReasoningFairness(pool, authority).schedule({ owner, leaseMs, policyVersion: route.policy_version });
  if (scheduled.kind !== 'admitted') return { kind: 'idle', reason: scheduled.kind };
  const { claim, reserved } = scheduled;
  const work = await loadAnswerWork(pool, claim.jobId, reserved.attemptId);
  const fence = { universeId: claim.universeId, privacyEpoch: claim.privacyEpoch, jobId: claim.jobId, stepId: work.stepId, attemptId: reserved.attemptId, owner, leaseFence: claim.leaseFence };

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
  const invocation = await invokeReasoningOnce({
    admission: createReasoningAdmission(pool, authority), reconciliation: createReasoningReconciliation(pool),
    authorization: { ...fence, requestId: work.requestId, requestHash: work.requestHash, inputTokensUpperBound: work.inputTokensUpperBound, maxOutputTokens: work.maxOutputTokens, dispatchId: randomUUID() },
    body: work.body, transport: seam, signal,
  });

  const outcome = await inTransaction(pool, async client => {
    if (invocation.kind === 'recorded' && observed === 'success' && text !== null) return applyAskAnswer(client, fence, text, authority);
    if (invocation.kind === 'recorded') return failAskAnswer(client, fence, observed === 'refusal' ? 'provider_refusal' : 'provider_error');
    if (invocation.kind === 'unknown') return failAskAnswer(client, fence, 'outcome_unknown');
    return { kind: 'discarded', reason: 'not_invoked' } as AnswerOutcome;
  });
  return { kind: 'done', askId: work.askId, invocation: invocation.kind, outcome };
}
