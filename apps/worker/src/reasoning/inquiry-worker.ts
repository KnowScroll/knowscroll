/**
 * The worker's background bridge inquiry consumer (ADR-0038 §4–§8). One pass: open the due
 * inquiries (fresh authority; `nothing_to_ask` never reaches a provider), then fair scheduling
 * admits one attempt; the reserved bytes are rebuilt from the sealed context and proven; exactly one
 * call goes through `invokeReasoningOnce`; the reply changes state only as a proposal that
 * bridge-validator-v1 decides, or the inquiry ends honestly. When the inquiry route shares the answer
 * route's scheduler, the admitted claim may be a direct Ask's: the answer path runs it, so the
 * class-aware fairness — not this loop's order — decides between them.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createReasoningAdmission } from '@knowscroll/db/reasoning/admission';
import {
  createReasoningFairness,
  type FairnessScheduled,
} from '@knowscroll/db/reasoning/fairness';
import {
  inquiryAuthority,
  jobFamily,
  mailRevokedConnections,
  openDueInquiries,
  sharedReasoningAuthority,
  type OpenResult,
} from '@knowscroll/db/reasoning/inquiries';
import {
  applyInquiryReply,
  failInquiry,
  giveBackUnsentInquiry,
  loadInquiryWork,
  type InquiryOutcome,
  type InquiryWork,
  type ProviderReply,
} from '@knowscroll/db/reasoning/inquiry-execution';
import { createReasoningReconciliation } from '@knowscroll/db/reasoning/reconciliation';
import {
  ReasoningDenied,
  type ReasoningAuthority,
} from '@knowscroll/db/reasoning/runtime-policy';
import {
  attemptAccountingState,
  enabledAnswerRouteTransport,
  enabledInquiryRoute,
  hasWaitingReasoningJob,
  inquiryAttemptStep,
} from '@knowscroll/db/reasoning/worker-reads';
import { inTransaction } from '@knowscroll/db/sql/transactions';
import type {
  AnswerObservation,
  AnswerTransport,
  InquiryObservation,
  InquiryTransport,
} from '../providers/transports.ts';
import { executeAnswerClaim, type AnswerPass } from './answer-worker.ts';
import { createReadinessGate, type ReadinessGate } from './readiness-gate.ts';
import {
  invokeReasoningOnce,
  type SingleInvocationTransport,
} from './invoke.ts';

type Transports<T> = Partial<Record<'fixture' | 'minimax', T>>;
type Gates = Partial<Record<'fixture' | 'minimax', ReadinessGate>>;

export type InquiryDone = {
  kind: 'done';
  inquiryId: string;
  invocation: 'recorded' | 'unknown' | 'not_invoked';
  outcome: InquiryOutcome;
};
export type InquiryPass =
  | { kind: 'idle'; reason: string; opened: Record<OpenResult, number> }
  | (InquiryDone & { opened: Record<OpenResult, number> })
  /** The shared scheduler admitted a direct Ask here; the answer path ran it. */
  | { kind: 'answer'; pass: AnswerPass; opened: Record<OpenResult, number> };

export async function runInquiryPass(deps: {
  pool: pg.Pool;
  owner: string;
  leaseMs: number;
  transports: Transports<InquiryTransport>;
  signal: AbortSignal;
  readiness?: Gates;
  /** Needed when the inquiry route shares the answer route's scheduler: a direct Ask may be admitted here. */
  answers?: { transports: Transports<AnswerTransport>; readiness?: Gates };
}): Promise<InquiryPass> {
  const { pool, owner, leaseMs, transports, signal } = deps;
  // A correction's revocations are mailed here, under each reader's lock (ADR-0042 §5.3), before the intake.
  await mailRevokedConnections(pool);
  const opened = await openDueInquiries(pool);
  const idle = (reason: string): InquiryPass => ({
    kind: 'idle',
    reason,
    opened,
  });
  const route = await enabledInquiryRoute(pool);
  if (!route) return idle('no_enabled_route');
  const transport = transports[route.transport];
  if (!transport) return idle(`transport_not_configured:${route.transport}`);
  const answerRoute = await enabledAnswerRouteTransport(
    pool,
    route.policy_version,
  );
  const answerTransport = answerRoute
    ? deps.answers?.transports[answerRoute.transport]
    : undefined;
  // A shared scheduler may admit a direct Ask: never schedule it without a way to answer.
  if (answerRoute && !answerTransport)
    return idle('shared_scheduler_needs_answer_transport');
  // Readiness is asked only when something is actually waiting to be scheduled.
  if (!(await hasWaitingReasoningJob(pool, route.policy_version)))
    return idle('no_inquiry_waiting');
  const gate = (
    t: InquiryTransport | AnswerTransport,
    gates: Gates | undefined,
  ) => gates?.[t.kind] ?? createReadinessGate(t, { okMs: 0, failMs: 0 });
  const inquiryGate = gate(transport, deps.readiness);
  const answerGate = answerTransport
    ? gate(answerTransport, deps.answers?.readiness)
    : undefined;
  for (const check of [inquiryGate, ...(answerGate ? [answerGate] : [])]) {
    const ready = await check(signal);
    if (!ready.ok) return idle(ready.reason);
  }
  const authority = answerRoute
    ? sharedReasoningAuthority()
    : inquiryAuthority();
  const scheduled = await createReasoningFairness(pool, authority).schedule({
    owner,
    leaseMs,
    policyVersion: route.policy_version,
  });
  if (scheduled.kind !== 'admitted') return idle(scheduled.kind);
  // Whatever was dispatched spent its transport's quota check: the next request asks again (ADR-0042 §3).
  if ((await jobFamily(pool, scheduled.claim.jobId)) === 'answer') {
    const pass = await executeAnswerClaim(
      { pool, owner, transport: answerTransport!, signal, authority },
      scheduled,
    );
    if (pass.kind === 'done' && pass.invocation !== 'not_invoked')
      answerGate!.spend();
    return { kind: 'answer', pass, opened };
  }
  const done = await executeInquiryClaim(
    { pool, owner, transport, signal, authority },
    scheduled,
  );
  if (done.invocation !== 'not_invoked') inquiryGate.spend();
  return { ...done, opened };
}

/** The admitted inquiry attempt, from rebuilding its bytes to its applied, failed or withdrawn end. */
export async function executeInquiryClaim(
  deps: {
    pool: pg.Pool;
    owner: string;
    transport: InquiryTransport;
    signal: AbortSignal;
    authority: ReasoningAuthority;
  },
  scheduled: FairnessScheduled,
): Promise<InquiryDone> {
  const { pool, owner, transport, signal, authority } = deps;
  const admission = createReasoningAdmission(pool, authority);
  const { claim, reserved } = scheduled;
  // The admitted Step: the inquiry's first, or a continuation (ADR-0042 §1).
  const inquiry = await inquiryAttemptStep(
    pool,
    claim.jobId,
    reserved.attemptId,
  );
  const fence = {
    universeId: claim.universeId,
    privacyEpoch: claim.privacyEpoch,
    jobId: claim.jobId,
    stepId: inquiry.step_id,
    attemptId: reserved.attemptId,
    owner,
    leaseFence: claim.leaseFence,
  };
  const done = (
    invocation: InquiryDone['invocation'],
    outcome: InquiryOutcome,
  ): InquiryDone => ({
    kind: 'done',
    inquiryId: inquiry.id,
    invocation,
    outcome,
  });

  // From here on every exit closes the attempt. Never sent → given back at once (everything it held
  // released) with the reason it was not sent; possibly sent or answered-but-unapplied → failed
  // honestly under the lease. If even that fails, the recovery sweep closes it after the lease expires.
  const close = async (
    refusal: string | null = null,
  ): Promise<InquiryOutcome> => {
    try {
      const state = await attemptAccountingState(pool, reserved.attemptId);
      if (state === 'reserved')
        return await giveBackUnsentInquiry(pool, admission, fence, refusal);
      return await inTransaction(pool, (client) =>
        failInquiry(
          client,
          fence,
          state === 'responded' ? 'apply_failed' : 'outcome_unknown',
        ),
      );
    } catch {
      return { kind: 'discarded', reason: 'left_for_recovery' };
    }
  };

  let work: InquiryWork;
  try {
    work = await loadInquiryWork(pool, claim.jobId, reserved.attemptId);
  } catch {
    return done('not_invoked', await close());
  }

  // The minimal receipt never carries content (ADR-0012); the reply waits here for the parser.
  let reply: ProviderReply | null = null;
  let observed: AnswerObservation['outcome'] | null = null;
  const seam: SingleInvocationTransport = {
    async invoke({ body, maxOutputTokens, signal: callSignal }) {
      const o = await transport.send({
        body,
        maxOutputTokens,
        signal: callSignal,
      });
      reply =
        o.text === null
          ? null
          : { text: o.text, content: o.content, stopReason: o.stopReason };
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
  } catch (error) {
    // The dispatch was refused before sending when a sealed fact no longer held (consent off, a
    // pause, a claim that lost its support, a pair now connected): it is discarded, never re-sent.
    const refusal =
      error instanceof ReasoningDenied && error.code.startsWith('context_')
        ? error.code.slice('context_'.length)
        : null;
    return done(refusal ? 'not_invoked' : 'unknown', await close(refusal));
  }
  if (invocation.kind === 'not_invoked')
    return done('not_invoked', await close());

  let outcome: InquiryOutcome;
  try {
    outcome = await inTransaction(pool, async (client) => {
      if (
        invocation.kind === 'recorded' &&
        observed === 'success' &&
        reply !== null
      )
        return applyInquiryReply(client, fence, reply, authority);
      if (invocation.kind === 'recorded')
        return failInquiry(
          client,
          fence,
          observed === 'refusal' ? 'provider_refusal' : 'provider_error',
        );
      return failInquiry(client, fence, 'outcome_unknown');
    });
  } catch {
    outcome = await close();
  }
  return done(invocation.kind, outcome);
}
