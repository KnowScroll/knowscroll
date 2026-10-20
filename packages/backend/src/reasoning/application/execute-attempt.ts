import type { PersonalAuthority } from '../../modules/identity/public.js';
import { OUTCOME_NOT_RECORDED, decideOnDelivery, type AttemptState } from '../domain/attempts.js';
import {
  NO_USAGE,
  decideReservation,
  type BudgetCaps,
  type BudgetDimension,
  type ReportedUsage,
} from '../domain/budgets.js';
import type { OutputIssue } from '../domain/output.js';
import {
  ModelNotSentError,
  ModelOutcomeUnknownError,
  ModelRejectedError,
  type AttemptRow,
  type HarnessPorts,
  type ModelPort,
  type ModelReply,
  type QuotaObservation,
  type RunDescriptor,
  type SettlementDetails,
  type StoredModelOutput,
  type StoredOutputIssues,
} from './ports.js';

/** Outcome codes the harness writes itself; a provider's own codes are recorded as the adapter maps them. */
export const outcomeCodes = {
  succeeded: 'SUCCEEDED',
  notRecorded: OUTCOME_NOT_RECORDED,
  transportUnknown: 'TRANSPORT_OUTCOME_UNKNOWN',
  authorityRefused: 'AUTHORITY_REFUSED',
  quotaUnavailable: 'QUOTA_UNAVAILABLE',
  rejected: 'REJECTED',
} as const;

/** At most this many attempts per logical step, and only while every earlier one was `not_sent`. */
export const MAX_STEP_SEQUENCE = 4;

/** One planned external attempt: everything the ledger records and the exact bytes to send. */
export interface AttemptPlan {
  readonly authority: PersonalAuthority;
  readonly run: RunDescriptor;
  /** Logical step: `primary`, or `repair` (a repair is a new attempt, never a silent retry). */
  readonly step: 'primary' | 'repair';
  readonly roleId: string;
  readonly roleVersion: string;
  readonly promptVersion: string;
  readonly body: Uint8Array;
  readonly requestHash: string;
  readonly maxOutputTokens: number;
  readonly reservedTokens: number;
  readonly caps: BudgetCaps;
  readonly causationAttemptId?: string;
}

/** How the role's validator judged a conclusive answer. Pure; supplied by the harness. */
export type Judgement =
  | { readonly valid: true; readonly stored: StoredModelOutput }
  | { readonly valid: false; readonly reason: string; readonly issues: readonly OutputIssue[] };

export type AttemptResult =
  /** A usable answer (on this delivery, or kept by the ledger from an earlier one) for an authority that still holds. */
  | {
      readonly kind: 'answered';
      readonly attemptId: string;
      readonly stored: StoredModelOutput;
      readonly usage: ReportedUsage;
      readonly reconciled: boolean;
    }
  /** A conclusive answer the validator rejected. */
  | {
      readonly kind: 'answered_invalid';
      readonly attemptId: string;
      readonly reason: string;
      readonly issues: readonly OutputIssue[];
      readonly usage: ReportedUsage;
    }
  | { readonly kind: 'failed'; readonly attemptId: string; readonly code: string }
  | { readonly kind: 'unknown'; readonly attemptId: string }
  | { readonly kind: 'quota_unavailable'; readonly attemptId: string }
  | { readonly kind: 'budget_exhausted'; readonly dimension: BudgetDimension; readonly limit: 'requests' | 'tokens' }
  /** A usable answer whose authority no longer holds: recorded, never to be applied. */
  | { readonly kind: 'ineligible'; readonly attemptId: string }
  | { readonly kind: 'written_off'; readonly attemptId: string }
  | {
      readonly kind: 'refused';
      readonly reason:
        'scope_refused' | 'request_mismatch' | 'dispatch_lost' | 'run_mismatch' | 'run_closed' | 'attempts_exhausted';
    };

/** The step name of the next attempt of a logical step, after `current` (or the first). */
function nextStepName(logical: string, current: string | undefined): string | undefined {
  if (current === undefined) return logical;
  const sequence = current === logical ? 1 : Number(current.slice(logical.length + 1));
  return Number.isInteger(sequence) && sequence < MAX_STEP_SEQUENCE ? `${logical}.${sequence + 1}` : undefined;
}

type Admission =
  | { readonly kind: 'dispatch'; readonly attemptId: string; readonly step: string; readonly reused: boolean }
  | { readonly kind: 'current'; readonly row: AttemptRow }
  | { readonly kind: 'exhausted_sequences'; readonly row: AttemptRow }
  | { readonly kind: 'budget'; readonly dimension: BudgetDimension; readonly limit: 'requests' | 'tokens' }
  | { readonly kind: 'refused'; readonly reason: 'request_mismatch' | 'run_mismatch' | 'run_closed' };

/** The transition a settled transport invocation records. */
interface Settlement {
  readonly to: 'succeeded' | 'failed' | 'unknown';
  readonly details: SettlementDetails;
  readonly judgement?: Judgement;
}

/** Maps a transport failure to the ledger: conclusive (`failed`) or uncertain (`unknown`). */
function settlementForError(error: unknown): Settlement {
  if (error instanceof ModelRejectedError)
    return {
      to: 'failed',
      details: { outcomeCode: error.code, ...(error.usage === undefined ? {} : { usage: error.usage }) },
    };
  if (error instanceof ModelNotSentError) return { to: 'failed', details: { outcomeCode: error.code } };
  if (error instanceof ModelOutcomeUnknownError) return { to: 'unknown', details: { outcomeCode: error.code } };
  return { to: 'unknown', details: { outcomeCode: outcomeCodes.transportUnknown } };
}

/**
 * Judges a conclusive answer. A validator that throws is a defect, but the answer was paid for and
 * must still be recorded: it is settled as an unusable answer (`VALIDATOR_FAILED`), never left
 * `dispatched` (which a later delivery would have to treat as unknown).
 */
function judgeSafely(judge: (reply: ModelReply) => Judgement, reply: ModelReply): Judgement {
  try {
    return judge(reply);
  } catch {
    return { valid: false, reason: 'VALIDATOR_FAILED', issues: [{ path: '(root)', code: 'validator_failed' }] };
  }
}

/** The settlement of a conclusive answer, as judged by the role's validator. */
function settlementForReply(reply: ModelReply, judgement: Judgement): Settlement {
  const issues: StoredOutputIssues | undefined = judgement.valid
    ? undefined
    : { v: 1, reason: judgement.reason, issues: judgement.issues };
  return {
    to: 'succeeded',
    judgement,
    details: {
      outcomeCode: judgement.valid ? outcomeCodes.succeeded : judgement.reason,
      usage: reply.usage,
      ...(reply.remoteId === undefined ? {} : { remoteId: reply.remoteId }),
      ...(judgement.valid ? { output: judgement.stored } : {}),
      ...(issues === undefined ? {} : { issues }),
    },
  };
}

/**
 * `executeAttempt`: one admitted external call with attempt accounting (blueprint §15, §19). Every
 * delivery consults the ledger first, whatever the queue's retry settings.
 *
 * Purpose: carry out at most one transport invocation for one logical step of a run, and record
 * exactly what is known about it. Inputs: the plan (authority, run descriptor, step, exact request
 * bytes and hash, budget caps), the role's judge for a conclusive answer, and an abort signal.
 * Output: a typed `AttemptResult`. Authority: admission and dispatch intent run under
 * `withPersonalScope` (rechecked after the lock wait); settlement does not depend on authority.
 *
 * 1. Ledger inspection (no lock): a recorded attempt of a run admitted at another privacy epoch
 *    is refused (`run_mismatch`) and one of a closed run answers `run_closed`; a recorded attempt
 *    with another request hash is refused; one left
 *    `dispatched` by an earlier delivery becomes `unknown` and is never resent; a settled one is
 *    answered from the ledger (a stored usable output is returned again after the eligibility
 *    check). `not_sent` lets a new attempt of the same logical step be reserved (bounded).
 * 2. Admission (personal scope): admit or compare the run; re-read the step under the lock
 *    (concurrent deliveries serialise here); check the three budgets under the budget lock;
 *    reserve the attempt, its protected request bytes and its usage receipt together.
 * 3. Quota preflight (no transaction): an observation; anything but `available`/`not_applicable`
 *    settles the attempt `not_sent` (`QUOTA_UNAVAILABLE`), releasing its reservation.
 * 4. Dispatch intent (personal scope, authority rechecked): `reserved → dispatched` with a new
 *    dispatch identity and the quota observation. A refusal settles `not_sent`; losing the race to
 *    a concurrent delivery sends nothing (`dispatch_lost`).
 * 5. No transaction: exactly one `send` of the stored bytes (the port refuses to run inside one).
 * 6. Ledger settlement (own short transaction, with the receipt): `succeeded` with usage and the
 *    output or the validator's issues, `failed` with the provider's code, or `unknown`. If another
 *    delivery meanwhile marked the attempt `unknown`, a conclusive answer becomes `reconciled`; if
 *    it was written off, only the late usage is recorded on its receipt.
 * 7. Output eligibility (lock-free read): a usable output for an authority that no longer holds is
 *    `ineligible`. If the read fails the error propagates; the output stays stored for the next
 *    delivery, so a paid answer is never lost and never paid for twice.
 *
 * Side effects: ledger rows, protected request bytes, usage receipt, diagnostics (after commits,
 * IDs/codes/counts only). Failure/retry: an exception before dispatch intent leaves at most a
 * `reserved` attempt (safe to dispatch on the next delivery); after it, at most a `dispatched`
 * attempt (the next delivery marks it `unknown`). Invariants: never more than one transport
 * invocation per attempt; never a resend after dispatch intent; no transaction spans the network.
 */
export function makeExecuteAttempt(ports: HarnessPorts) {
  const { ledger, logEvent } = ports;

  return async function executeAttempt(
    model: ModelPort,
    plan: AttemptPlan,
    judge: (reply: ModelReply) => Judgement,
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    const { authority, run } = plan;
    const ref = (attemptId: string) => ({ universeId: authority.universeId, attemptId });
    const tags = {
      runId: run.id,
      provider: model.provider,
      model: model.model,
      role: plan.roleId,
      promptVersion: plan.promptVersion,
    };

    /** What a recorded attempt means for this delivery. */
    async function fromLedger(row: AttemptRow): Promise<AttemptResult> {
      switch (row.state) {
        case 'succeeded':
        case 'reconciled':
          if (row.output !== null) {
            if (!(await ports.authorityHolds(authority))) return { kind: 'ineligible', attemptId: row.id };
            return {
              kind: 'answered',
              attemptId: row.id,
              stored: row.output,
              usage: row.usage,
              reconciled: row.state === 'reconciled',
            };
          }
          if (row.issues !== null)
            return {
              kind: 'answered_invalid',
              attemptId: row.id,
              reason: row.issues.reason,
              issues: row.issues.issues,
              usage: row.usage,
            };
          // A reconciled late rejection has nothing to apply.
          return { kind: 'failed', attemptId: row.id, code: row.outcomeCode ?? outcomeCodes.rejected };
        case 'failed':
          return { kind: 'failed', attemptId: row.id, code: row.outcomeCode ?? outcomeCodes.rejected };
        // `dispatched` is seen here only when another delivery holds the call in flight.
        case 'dispatched':
        case 'unknown':
          return { kind: 'unknown', attemptId: row.id };
        case 'written_off':
          return { kind: 'written_off', attemptId: row.id };
        case 'not_sent':
          return row.outcomeCode === outcomeCodes.quotaUnavailable
            ? { kind: 'quota_unavailable', attemptId: row.id }
            : { kind: 'refused', reason: 'scope_refused' };
        case 'reserved':
          // Reserved by a concurrent delivery that has not dispatched yet: this one sends nothing.
          return { kind: 'refused', reason: 'dispatch_lost' };
      }
    }

    /** Re-reads the step after another delivery changed it, and answers from the ledger. */
    async function fromCurrentLedger(): Promise<AttemptResult> {
      const current = await ledger.find(authority.universeId, run.id, plan.step);
      return current === undefined ? { kind: 'refused', reason: 'dispatch_lost' } : fromLedger(current);
    }

    function logSettled(
      attemptId: string,
      state: AttemptState,
      outcomeCode: string | undefined,
      extra: {
        readonly usage?: ReportedUsage;
        readonly durationMs?: number;
      } = {},
    ): void {
      const usage = extra.usage ?? NO_USAGE;
      logEvent('reasoning.attempt_settled', {
        ...tags,
        attemptId,
        outcome: state,
        ...(outcomeCode === undefined ? {} : { reasonCode: outcomeCode }),
        ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
        ...(usage.inputTokens === null ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === null ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.reasoningTokens === null ? {} : { reasoningTokens: usage.reasoningTokens }),
        ...(usage.cachedTokens === null ? {} : { cachedTokens: usage.cachedTokens }),
      });
    }

    // 1. Ledger inspection.
    const recorded = await ledger.find(authority.universeId, run.id, plan.step);
    if (recorded !== undefined) {
      // A run admitted at epoch N never continues, and never returns output, at another epoch; and
      // a closed run answers `run_closed` even when its kept answer is still in the ledger.
      if (recorded.runPrivacyEpoch !== authority.privacyEpoch) return { kind: 'refused', reason: 'run_mismatch' };
      if (recorded.runState !== 'admitted') return { kind: 'refused', reason: 'run_closed' };
      if (recorded.requestHash !== plan.requestHash) return { kind: 'refused', reason: 'request_mismatch' };
      switch (decideOnDelivery(recorded.state)) {
        case 'mark_unknown': {
          const marked = await ledger.settle(ref(recorded.id), 'dispatched', 'unknown', {
            outcomeCode: outcomeCodes.notRecorded,
          });
          if (!marked) return fromCurrentLedger();
          logSettled(recorded.id, 'unknown', outcomeCodes.notRecorded);
          return { kind: 'unknown', attemptId: recorded.id };
        }
        case 'settled':
          if (recorded.state !== 'not_sent') return fromLedger(recorded);
          break;
        case 'dispatch':
          break;
      }
    }

    // 2. Admission.
    const admitted = await ports.withPersonalScope(authority, async (scope): Promise<Admission> => {
      const runAdmission = await ledger.admitRun(scope, run);
      if (runAdmission.kind !== 'admitted')
        return { kind: 'refused', reason: runAdmission.kind === 'mismatch' ? 'run_mismatch' : 'run_closed' };
      const locked = await ledger.findLocked(scope, run.id, plan.step);
      if (locked !== undefined) {
        if (locked.requestHash !== plan.requestHash) return { kind: 'refused', reason: 'request_mismatch' };
        if (locked.state === 'reserved')
          return { kind: 'dispatch', attemptId: locked.id, step: locked.step, reused: true };
        if (locked.state !== 'not_sent') return { kind: 'current', row: locked };
      }
      const step = nextStepName(plan.step, locked?.step);
      if (step === undefined) {
        if (locked === undefined) throw new Error('unreachable: a first attempt always has a step name');
        return { kind: 'exhausted_sequences', row: locked };
      }
      const usage = await ledger.budgetUsage(scope, plan.roleId);
      const decision = decideReservation(plan.caps, usage, plan.reservedTokens);
      if (decision.kind === 'exhausted')
        return { kind: 'budget', dimension: decision.dimension, limit: decision.limit };
      const attemptId = ports.newId();
      await ledger.reserve(scope, {
        id: attemptId,
        runId: run.id,
        step,
        provider: model.provider,
        model: model.model,
        roleId: plan.roleId,
        roleVersion: plan.roleVersion,
        promptVersion: plan.promptVersion,
        requestHash: plan.requestHash,
        requestBody: plan.body,
        maxOutputTokens: plan.maxOutputTokens,
        reservedTokens: plan.reservedTokens,
        requestRetentionSeconds: ports.settings.requestRetentionSeconds,
        ...(plan.causationAttemptId === undefined ? {} : { causationAttemptId: plan.causationAttemptId }),
      });
      return { kind: 'dispatch', attemptId, step, reused: false };
    });
    if (admitted.kind === 'refused') {
      if (recorded?.state === 'reserved') {
        const released = await ledger.settle(ref(recorded.id), 'reserved', 'not_sent', {
          outcomeCode: outcomeCodes.authorityRefused,
        });
        if (released) logSettled(recorded.id, 'not_sent', outcomeCodes.authorityRefused);
      }
      logEvent('reasoning.admission_refused', { ...tags, reasonCode: `scope_${admitted.refusal.kind}` });
      return { kind: 'refused', reason: 'scope_refused' };
    }
    const admission = admitted.value;
    switch (admission.kind) {
      case 'refused':
        logEvent('reasoning.admission_refused', { ...tags, reasonCode: admission.reason });
        return { kind: 'refused', reason: admission.reason };
      case 'budget':
        logEvent('reasoning.admission_refused', {
          ...tags,
          reasonCode: `budget_${admission.dimension}_${admission.limit}`,
        });
        return { kind: 'budget_exhausted', dimension: admission.dimension, limit: admission.limit };
      case 'current':
        // Dispatched by a concurrent delivery after this one's first read: it holds the call in
        // flight, and this delivery sends nothing (the attempt is not unknown).
        return admission.row.state === 'dispatched'
          ? { kind: 'refused', reason: 'dispatch_lost' }
          : fromLedger(admission.row);
      case 'exhausted_sequences':
        return admission.row.outcomeCode === outcomeCodes.quotaUnavailable
          ? { kind: 'quota_unavailable', attemptId: admission.row.id }
          : { kind: 'refused', reason: 'attempts_exhausted' };
      case 'dispatch':
        break;
    }
    const { attemptId } = admission;
    if (!admission.reused) logEvent('reasoning.attempt_reserved', { ...tags, attemptId, count: plan.reservedTokens });

    // The bytes this attempt sends: the protected copy written at reservation (identical by hash).
    let body = plan.body;
    if (admission.reused) {
      const stored = await ledger.readProtectedRequest(ref(attemptId));
      if (stored !== undefined && ports.hashBytes(stored) === plan.requestHash) body = stored;
    }

    // 3. Quota preflight: an observation recorded on the attempt, never a reservation.
    const quota: QuotaObservation = await model.observeQuota(signal);
    logEvent('reasoning.quota_observed', {
      ...tags,
      attemptId,
      outcome: quota.verdict,
      ...(quota.reasonCode === undefined ? {} : { reasonCode: quota.reasonCode }),
      ...(quota.intervalRemainingPercent === null ? {} : { quotaIntervalPercent: quota.intervalRemainingPercent }),
      ...(quota.weeklyRemainingPercent === null ? {} : { quotaWeeklyPercent: quota.weeklyRemainingPercent }),
    });
    if (quota.verdict !== 'available' && quota.verdict !== 'not_applicable') {
      const released = await ledger.settle(ref(attemptId), 'reserved', 'not_sent', {
        outcomeCode: outcomeCodes.quotaUnavailable,
        quota,
      });
      if (!released) return fromCurrentLedger();
      logSettled(attemptId, 'not_sent', outcomeCodes.quotaUnavailable);
      return { kind: 'quota_unavailable', attemptId };
    }

    // 4. Dispatch intent.
    const dispatchId = ports.newId();
    const dispatched = await ports.withPersonalScope(authority, (scope) =>
      ledger.commitDispatch(scope, attemptId, { dispatchId, dispatchedBy: ports.settings.dispatchedBy, quota }),
    );
    if (dispatched.kind === 'refused') {
      const released = await ledger.settle(ref(attemptId), 'reserved', 'not_sent', {
        outcomeCode: outcomeCodes.authorityRefused,
      });
      if (released) logSettled(attemptId, 'not_sent', outcomeCodes.authorityRefused);
      logEvent('reasoning.admission_refused', { ...tags, reasonCode: `scope_${dispatched.refusal.kind}` });
      return { kind: 'refused', reason: 'scope_refused' };
    }
    if (!dispatched.value) return { kind: 'refused', reason: 'dispatch_lost' };
    logEvent('reasoning.attempt_dispatched', { ...tags, attemptId });

    // 5. Exactly one transport invocation, outside any transaction.
    const startedAt = ports.now();
    let sent: { readonly reply: ModelReply } | { readonly failure: Settlement };
    try {
      sent = { reply: await model.send(body, signal) };
    } catch (error) {
      sent = { failure: settlementForError(error) };
    }
    const durationMs = Math.max(0, ports.now() - startedAt);
    const settlement = 'reply' in sent ? settlementForReply(sent.reply, judgeSafely(judge, sent.reply)) : sent.failure;

    // 6. Ledger settlement.
    const settledAs = (state: AttemptState): AttemptRow => ({
      runPrivacyEpoch: authority.privacyEpoch,
      runState: 'admitted',
      id: attemptId,
      step: admission.step,
      state,
      requestHash: plan.requestHash,
      outcomeCode: settlement.details.outcomeCode ?? null,
      output: settlement.details.output ?? null,
      issues: settlement.details.issues ?? null,
      usage: settlement.details.usage ?? NO_USAGE,
    });
    if (await ledger.settle(ref(attemptId), 'dispatched', settlement.to, settlement.details)) {
      logSettled(attemptId, settlement.to, settlement.details.outcomeCode, {
        durationMs,
        ...(settlement.details.usage === undefined ? {} : { usage: settlement.details.usage }),
      });
      return fromLedger(settledAs(settlement.to));
    }
    // A concurrent delivery decided this attempt was lost and marked it `unknown`. A conclusive
    // answer is the evidence reconciliation needs; anything else leaves it `unknown`.
    if (settlement.to === 'unknown') return { kind: 'unknown', attemptId };
    if (await ledger.settle(ref(attemptId), 'unknown', 'reconciled', settlement.details)) {
      logSettled(attemptId, 'reconciled', settlement.details.outcomeCode, {
        durationMs,
        ...(settlement.details.usage === undefined ? {} : { usage: settlement.details.usage }),
      });
      return fromLedger(settledAs('reconciled'));
    }
    // Written off meanwhile: the late answer is not applied, but its usage settles the receipt.
    const current = await ledger.find(authority.universeId, run.id, plan.step);
    if (current?.state === 'written_off' && settlement.details.usage !== undefined)
      await ledger.recordLateUsage(attemptId, settlement.details.usage);
    return current === undefined ? { kind: 'unknown', attemptId } : fromLedger(current);
  };
}
