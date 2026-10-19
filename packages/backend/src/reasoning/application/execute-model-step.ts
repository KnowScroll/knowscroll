import type { PersonalAuthority } from '../../modules/identity/public.js';
import { decideOnDelivery } from '../domain/attempts.js';
import {
  MAX_STORED_OUTPUT_BYTES,
  ModelRejectedError,
  type AttemptRow,
  type ExecuteModelStepPorts,
  type ModelRequest,
  type SettlementDetails,
  type StoredModelOutput,
} from './ports.js';

export interface ModelStep {
  readonly runId: string;
  readonly ownerModule: string;
  readonly purpose: string;
  /** Unique within the run; a repair is a new step, never a silent retry of this one. */
  readonly step: string;
  readonly request: ModelRequest;
}

export type ModelStepResult =
  /**
   * The call succeeded (on this delivery, or on an earlier one whose output the ledger kept) and
   * the authority it ran for still holds: the caller may apply the output, rechecking under the
   * lock in the transaction that applies it.
   */
  | { readonly kind: 'succeeded'; readonly attemptId: string; readonly output: string }
  /** A late successful answer after the attempt was marked `unknown`; recorded as `reconciled`. */
  | { readonly kind: 'reconciled'; readonly attemptId: string; readonly output: string }
  /** The output is recorded, but the authority it was produced for no longer holds: do not apply it. */
  | { readonly kind: 'ineligible'; readonly attemptId: string }
  | { readonly kind: 'failed'; readonly attemptId: string; readonly code: string }
  | { readonly kind: 'unknown'; readonly attemptId: string }
  /** Settled with nothing to apply (`not_sent`, `written_off`). */
  | { readonly kind: 'settled'; readonly attemptId: string }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'dispatch_lost' | 'request_mismatch' };

/** Outcome codes the engine writes itself; a provider's rejection code is recorded as it comes. */
const outcomeCodes = {
  succeeded: 'SUCCEEDED',
  outputTooLarge: 'OUTPUT_TOO_LARGE',
  notRecorded: 'OUTCOME_NOT_RECORDED',
  transportUnknown: 'TRANSPORT_OUTCOME_UNKNOWN',
  authorityRefused: 'AUTHORITY_REFUSED',
  rejected: 'REJECTED',
} as const;

/**
 * `executeModelStep`: one admitted external call with attempt accounting (blueprint §15, §19).
 * Every delivery of a job consults the ledger first, whatever the queue's retry settings.
 *
 * 1. Ledger inspection (no authority needed): an attempt recorded with another request hash is
 *    refused; one left `dispatched` by an earlier delivery (crash, lost claim) becomes `unknown`
 *    and is never resent; a settled one is answered from the ledger, including a stored output.
 * 2. Admission (personal scope; authority checked): admit the business run, re-read the attempt
 *    under the lock (concurrent deliveries serialise here) and reserve it if absent. If authority
 *    is refused, a reserved attempt becomes `not_sent`.
 * 3. Dispatch intent (personal scope; authority rechecked): `reserved → dispatched`. Refused →
 *    `not_sent`; lost to a concurrent delivery → `dispatch_lost` (nothing sent by this one).
 * 4. No transaction: the model call (the port refuses to run inside one).
 * 5. Ledger settlement (no authority): `succeeded` with the output stored (outcome `SUCCEEDED`,
 *    or `OUTPUT_TOO_LARGE` when it exceeds the bound and is not kept), `failed` with the provider's
 *    rejection code, or `unknown` (any other error). If a concurrent delivery already marked the
 *    attempt `unknown`, a conclusive answer is recorded as `reconciled` with its real outcome code.
 * 6. Output eligibility (lock-free read, nothing written): an output produced for an authority
 *    that no longer holds is reported `ineligible`. A failure of this read propagates; the output
 *    stays stored, so the next delivery answers from the ledger without calling the model again.
 */
export function makeExecuteModelStep(ports: ExecuteModelStepPorts) {
  const { ledger } = ports;

  /** What an attempt recorded in the ledger means for this delivery. */
  async function fromLedger(authority: PersonalAuthority, attempt: AttemptRow): Promise<ModelStepResult> {
    switch (attempt.state) {
      case 'succeeded':
      case 'reconciled':
        // A reconciled late rejection, or a success too large to keep, has no output to apply.
        if (attempt.output === null)
          return { kind: 'failed', attemptId: attempt.id, code: attempt.outcomeCode ?? outcomeCodes.rejected };
        if (!(await ports.authorityHolds(authority))) return { kind: 'ineligible', attemptId: attempt.id };
        return attempt.state === 'reconciled'
          ? { kind: 'reconciled', attemptId: attempt.id, output: attempt.output.text }
          : { kind: 'succeeded', attemptId: attempt.id, output: attempt.output.text };
      case 'failed':
        return { kind: 'failed', attemptId: attempt.id, code: attempt.outcomeCode ?? outcomeCodes.rejected };
      // `dispatched` is seen here only when another delivery holds the call in flight.
      case 'dispatched':
      case 'unknown':
        return { kind: 'unknown', attemptId: attempt.id };
      case 'reserved':
      case 'not_sent':
      case 'written_off':
        return { kind: 'settled', attemptId: attempt.id };
    }
  }

  return async function executeModelStep(
    authority: PersonalAuthority,
    step: ModelStep,
    signal: AbortSignal,
  ): Promise<ModelStepResult> {
    const requestHash = ports.hashRequest(step.request);
    const ref = (attemptId: string) => ({ universeId: authority.universeId, attemptId });
    /** Re-reads the attempt after another delivery changed it, and answers from the ledger. */
    const fromCurrentLedger = async (attemptId: string): Promise<ModelStepResult> => {
      const current = await ledger.find(authority.universeId, step.runId, step.step);
      return current === undefined ? { kind: 'settled', attemptId } : fromLedger(authority, current);
    };

    const recorded = await ledger.find(authority.universeId, step.runId, step.step);
    if (recorded !== undefined) {
      if (recorded.requestHash !== requestHash) return { kind: 'refused', reason: 'request_mismatch' };
      switch (decideOnDelivery(recorded.state)) {
        case 'mark_unknown': {
          const marked = await ledger.settle(ref(recorded.id), 'dispatched', 'unknown', {
            outcomeCode: outcomeCodes.notRecorded,
          });
          return marked ? { kind: 'unknown', attemptId: recorded.id } : fromCurrentLedger(recorded.id);
        }
        case 'settled':
          return fromLedger(authority, recorded);
        case 'dispatch':
          break;
      }
    }

    const admitted = await ports.withPersonalScope(
      authority,
      async (scope): Promise<{ readonly dispatch: string } | ModelStepResult> => {
        await ledger.admitRun(scope, { id: step.runId, ownerModule: step.ownerModule, purpose: step.purpose });
        const locked = await ledger.findLocked(scope, step.runId, step.step);
        if (locked !== undefined) {
          if (locked.requestHash !== requestHash) return { kind: 'refused', reason: 'request_mismatch' };
          return locked.state === 'reserved' ? { dispatch: locked.id } : { kind: 'refused', reason: 'dispatch_lost' };
        }
        const attemptId = ports.newId();
        await ledger.reserve(scope, {
          id: attemptId,
          runId: step.runId,
          step: step.step,
          provider: ports.model.provider,
          model: ports.model.model,
          requestHash,
        });
        return { dispatch: attemptId };
      },
    );
    if (admitted.kind === 'refused') {
      if (recorded?.state === 'reserved')
        await ledger.settle(ref(recorded.id), 'reserved', 'not_sent', { outcomeCode: outcomeCodes.authorityRefused });
      return { kind: 'refused', reason: 'scope_refused' };
    }
    if (!('dispatch' in admitted.value)) return admitted.value;
    const attemptId = admitted.value.dispatch;

    const dispatched = await ports.withPersonalScope(authority, (scope) => ledger.commitDispatch(scope, attemptId));
    if (dispatched.kind === 'refused') {
      await ledger.settle(ref(attemptId), 'reserved', 'not_sent', { outcomeCode: outcomeCodes.authorityRefused });
      return { kind: 'refused', reason: 'scope_refused' };
    }
    if (!dispatched.value) return { kind: 'refused', reason: 'dispatch_lost' };

    let answer: { readonly to: 'succeeded' | 'failed' | 'unknown'; readonly details: SettlementDetails };
    try {
      const response = await ports.model.invoke(step.request, signal);
      const output: StoredModelOutput = { v: 1, text: response.output };
      const fits = new TextEncoder().encode(JSON.stringify(output)).length <= MAX_STORED_OUTPUT_BYTES;
      answer = {
        to: 'succeeded',
        details: {
          outcomeCode: fits ? outcomeCodes.succeeded : outcomeCodes.outputTooLarge,
          ...(response.remoteId === undefined ? {} : { remoteId: response.remoteId }),
          ...(fits ? { output } : {}),
        },
      };
    } catch (error) {
      answer =
        error instanceof ModelRejectedError
          ? { to: 'failed', details: { outcomeCode: error.code } }
          : { to: 'unknown', details: { outcomeCode: outcomeCodes.transportUnknown } };
    }
    const settledAs = (state: AttemptRow['state']): AttemptRow => ({
      id: attemptId,
      state,
      requestHash,
      outcomeCode: answer.details.outcomeCode ?? null,
      output: answer.details.output ?? null,
    });

    if (await ledger.settle(ref(attemptId), 'dispatched', answer.to, answer.details))
      return fromLedger(authority, settledAs(answer.to));
    // A concurrent delivery decided this attempt was lost and marked it `unknown`. A conclusive
    // answer is the evidence reconciliation needs; anything else leaves it `unknown`.
    if (answer.to === 'unknown') return { kind: 'unknown', attemptId };
    if (await ledger.settle(ref(attemptId), 'unknown', 'reconciled', answer.details))
      return fromLedger(authority, settledAs('reconciled'));
    return fromCurrentLedger(attemptId);
  };
}

export type ExecuteModelStep = ReturnType<typeof makeExecuteModelStep>;
