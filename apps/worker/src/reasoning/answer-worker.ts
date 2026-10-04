/**
 * The worker's Ask-answer consumer (ADR-0033 §2–§4). One pass: fair scheduling admits one
 * answer attempt; the reserved bytes are rebuilt from the sealed context and proven; exactly one
 * provider call goes through `invokeReasoningOnce`; the reply is applied only through
 * the answer validator (ask-answer-v2), or the answer fails honestly. Nothing here is reachable from the API process.
 * When background inquiries share this route's scheduler (ADR-0038 §4), the class-aware fairness may
 * admit one of theirs here; it is handed to the inquiry executor the caller supplies, and nothing is
 * scheduled without one, or before the inquiry transport's quota check too (#153).
 */
import { randomUUID } from 'node:crypto';
import { createReasoningAdmission } from '@knowscroll/db/reasoning/admission';
import {
  type AnswerOutcome,
  type AnswerWork,
  applyAskAnswer,
  failAskAnswer,
  giveBackUnsentAnswer,
  loadAnswerWork,
} from '@knowscroll/db/reasoning/answers';
import {
  createReasoningFairness,
  type FairnessScheduled,
} from '@knowscroll/db/reasoning/fairness';
import {
  jobFamily,
  sharedReasoningAuthority,
} from '@knowscroll/db/reasoning/inquiries';
import { createReasoningReconciliation } from '@knowscroll/db/reasoning/reconciliation';
import type { ReasoningAuthority } from '@knowscroll/db/reasoning/runtime-policy';
import {
  answerRequestStep,
  attemptAccountingState,
  enabledAnswerRoute,
  enabledInquiryRouteTransport,
  hasWaitingAnswer,
} from '@knowscroll/db/reasoning/worker-reads';
import { inTransaction } from '@knowscroll/db/sql/transactions';
import type pg from 'pg';
import type {
  AnswerObservation,
  AnswerTransport,
  InquiryTransport,
} from '../providers/transports.ts';
import {
  invokeReasoningOnce,
  type SingleInvocationTransport,
} from './invoke.ts';
import { createReadinessGate, type ReadinessGate } from './readiness-gate.ts';

export type AnswerPass =
  | { kind: 'idle'; reason: string }
  | {
      kind: 'done';
      askId: string;
      invocation: 'recorded' | 'unknown' | 'not_invoked';
      outcome: AnswerOutcome;
    }
  /** ADR-0038 §4: the shared scheduler admitted a background inquiry; its own executor ran it. */
  | { kind: 'other_family'; jobId: string; result: unknown };
/** Runs a background inquiry a shared scheduler admitted on this pass: the inquiry path's own executor,
 * handed in so this module never depends on it. */
export type InquiryExecutor = (
  deps: {
    pool: pg.Pool;
    owner: string;
    transport: InquiryTransport;
    signal: AbortSignal;
    authority: ReasoningAuthority;
  },
  scheduled: FairnessScheduled,
) => Promise<{ invocation: 'recorded' | 'unknown' | 'not_invoked' }>;

export async function runAnswerPass(deps: {
  pool: pg.Pool;
  owner: string;
  leaseMs: number;
  transports: Partial<Record<'fixture' | 'minimax', AnswerTransport>>;
  signal: AbortSignal;
  /** Cached readiness per transport; without one, readiness is asked on this pass. */
  readiness?: Partial<Record<'fixture' | 'minimax', ReadinessGate>>;
  /** Needed when background inquiries share this route's scheduler (ADR-0038 §4): the pass may admit one of theirs. */
  inquiries?: {
    transports: Partial<Record<'fixture' | 'minimax', InquiryTransport>>;
    readiness?: Partial<Record<'fixture' | 'minimax', ReadinessGate>>;
    execute: InquiryExecutor;
  };
}): Promise<AnswerPass> {
  const { pool, owner, leaseMs, transports, signal } = deps;
  const route = await enabledAnswerRoute(pool);
  if (!route) return { kind: 'idle', reason: 'no_enabled_route' };
  const transport = transports[route.transport];
  if (!transport)
    return {
      kind: 'idle',
      reason: `transport_not_configured:${route.transport}`,
    };
  const inquiryRoute = await enabledInquiryRouteTransport(
    pool,
    route.policy_version,
  );
  const inquiryTransport = inquiryRoute
    ? deps.inquiries?.transports[inquiryRoute.transport]
    : undefined;
  // A shared scheduler may admit a background inquiry: never schedule it without a way to run it (#153).
  if (inquiryRoute && !inquiryTransport)
    return { kind: 'idle', reason: 'shared_scheduler_needs_inquiry_transport' };
  // Readiness is asked only when an answer for this route is actually waiting to be scheduled.
  const waiting = await hasWaitingAnswer(pool, route.policy_version);
  if (!waiting) return { kind: 'idle', reason: 'no_answer_waiting' };
  const gate =
    deps.readiness?.[route.transport] ??
    createReadinessGate(transport, { okMs: 0, failMs: 0 });
  const inquiryGate = inquiryTransport
    ? (deps.inquiries!.readiness?.[inquiryTransport.kind] ??
      createReadinessGate(inquiryTransport, { okMs: 0, failMs: 0 }))
    : undefined;
  // Either family's request may be admitted here, so both quota checks come first (#153).
  for (const check of [gate, ...(inquiryGate ? [inquiryGate] : [])]) {
    const readiness = await check(signal);
    if (!readiness.ok) return { kind: 'idle', reason: readiness.reason };
  }

  // Resolves either family: a scheduler shared with background inquiries may admit one of theirs.
  const authority = sharedReasoningAuthority();
  const scheduled = await createReasoningFairness(pool, authority).schedule({
    owner,
    leaseMs,
    policyVersion: route.policy_version,
  });
  if (scheduled.kind !== 'admitted')
    return { kind: 'idle', reason: scheduled.kind };
  if ((await jobFamily(pool, scheduled.claim.jobId)) !== 'answer') {
    if (inquiryTransport) {
      const result = await deps.inquiries!.execute(
        { pool, owner, transport: inquiryTransport, signal, authority },
        scheduled,
      );
      if (result.invocation !== 'not_invoked') inquiryGate!.spend();
      return { kind: 'other_family', jobId: scheduled.claim.jobId, result };
    }
    // The inquiry route became shared after the check above: never strand the admitted attempt; give
    // it back unsent at once (its sweep closes it).
    const { claim } = scheduled;
    await createReasoningAdmission(pool, authority)
      .withdrawJob({
        universeId: claim.universeId,
        privacyEpoch: claim.privacyEpoch,
        jobId: claim.jobId,
        owner,
        leaseFence: claim.leaseFence,
        reason: 'cancelled',
      })
      .catch(() => undefined);
    return { kind: 'idle', reason: 'other_family_returned' };
  }
  const pass = await executeAnswerClaim(
    { pool, owner, transport, signal, authority },
    scheduled,
  );
  // A dispatch spent the quota check: the next request asks again (ADR-0033 §2, ADR-0042 §3).
  if (pass.kind === 'done' && pass.invocation !== 'not_invoked') gate.spend();
  return pass;
}

/** The admitted answer attempt, from rebuilding its bytes to its applied or failed outcome. */
export async function executeAnswerClaim(
  deps: {
    pool: pg.Pool;
    owner: string;
    transport: AnswerTransport;
    signal: AbortSignal;
    authority: ReasoningAuthority;
  },
  scheduled: FairnessScheduled,
): Promise<AnswerPass> {
  const { pool, owner, transport, signal, authority } = deps;
  const admission = createReasoningAdmission(pool, authority);
  const { claim, reserved } = scheduled;
  const request = await answerRequestStep(pool, claim.jobId);
  const fence = {
    universeId: claim.universeId,
    privacyEpoch: claim.privacyEpoch,
    jobId: claim.jobId,
    stepId: request.step_id,
    attemptId: reserved.attemptId,
    owner,
    leaseFence: claim.leaseFence,
  };

  // From here on every exit closes the attempt. Never sent → given back at once (all
  // reservations released); possibly sent or answered-but-unapplied → failed honestly under the
  // lease. If even that fails, the recovery sweep closes it after the lease expires.
  const close = async (): Promise<AnswerOutcome> => {
    try {
      const state = await attemptAccountingState(pool, reserved.attemptId);
      if (state === 'reserved')
        return await giveBackUnsentAnswer(pool, admission, fence);
      return await inTransaction(pool, (client) =>
        failAskAnswer(
          client,
          fence,
          state === 'responded' ? 'apply_failed' : 'outcome_unknown',
        ),
      );
    } catch {
      return { kind: 'discarded', reason: 'left_for_recovery' };
    }
  };

  let work: AnswerWork;
  try {
    work = await loadAnswerWork(pool, claim.jobId, reserved.attemptId);
  } catch {
    return {
      kind: 'done',
      askId: request.ask_id,
      invocation: 'not_invoked',
      outcome: await close(),
    };
  }

  // The minimal receipt never carries content (ADR-0012); the text waits here for the validator.
  let text: string | null = null;
  let observed: AnswerObservation['outcome'] | null = null;
  const seam: SingleInvocationTransport = {
    async invoke({ body, maxOutputTokens, signal: callSignal }) {
      const o = await transport.send({
        body,
        maxOutputTokens,
        signal: callSignal,
        work,
      });
      text = o.text;
      observed = o.outcome;
      return {
        remoteDisposition: o.remoteDisposition,
        outcome: o.outcome,
        httpStatus: o.httpStatus,
        usage: o.usage,
      };
    },
  };
  let invocation: Awaited<ReturnType<typeof invokeReasoningOnce>>;
  try {
    invocation = await invokeReasoningOnce({
      admission,
      reconciliation: createReasoningReconciliation(pool),
      authorization: {
        ...fence,
        requestId: work.requestId,
        requestHash: work.requestHash,
        inputTokensUpperBound: work.inputTokensUpperBound,
        maxOutputTokens: work.maxOutputTokens,
        dispatchId: randomUUID(),
      },
      body: work.body,
      transport: seam,
      signal,
    });
  } catch {
    return {
      kind: 'done',
      askId: work.askId,
      invocation: 'unknown',
      outcome: await close(),
    };
  }
  if (invocation.kind === 'not_invoked')
    return {
      kind: 'done',
      askId: work.askId,
      invocation: 'not_invoked',
      outcome: await close(),
    };

  let outcome: AnswerOutcome;
  try {
    outcome = await inTransaction(pool, async (client) => {
      if (
        invocation.kind === 'recorded' &&
        observed === 'success' &&
        text !== null
      )
        return applyAskAnswer(client, fence, text, authority);
      if (invocation.kind === 'recorded')
        return failAskAnswer(
          client,
          fence,
          observed === 'refusal' ? 'provider_refusal' : 'provider_error',
        );
      return failAskAnswer(client, fence, 'outcome_unknown');
    });
  } catch {
    outcome = await close();
  }
  return {
    kind: 'done',
    askId: work.askId,
    invocation: invocation.kind,
    outcome,
  };
}
