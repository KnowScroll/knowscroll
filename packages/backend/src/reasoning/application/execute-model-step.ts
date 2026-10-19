import type { PersonalAuthority } from '../../modules/identity/public.js';
import { decideOnDelivery } from '../domain/attempts.js';
import { ModelRejectedError, type ExecuteModelStepPorts, type ModelRequest } from './ports.js';

export interface ModelStep {
  readonly runId: string;
  readonly ownerModule: string;
  readonly purpose: string;
  /** Unique within the run; a repair is a new step, never a silent retry of this one. */
  readonly step: string;
  readonly request: ModelRequest;
}

export type ModelStepResult =
  /** The call succeeded and the caller may still apply its output. */
  | { readonly kind: 'succeeded'; readonly attemptId: string; readonly output: string }
  /** A late conclusive answer after the attempt was marked `unknown`; recorded as `reconciled`. */
  | { readonly kind: 'reconciled'; readonly attemptId: string; readonly output: string }
  /** The outcome is recorded, but authority changed during the call: the output must not be applied. */
  | { readonly kind: 'ineligible'; readonly attemptId: string }
  | { readonly kind: 'failed'; readonly attemptId: string; readonly code: string }
  | { readonly kind: 'unknown'; readonly attemptId: string }
  | { readonly kind: 'settled'; readonly attemptId: string }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'dispatch_lost' | 'request_mismatch' };

/**
 * `executeModelStep`: one admitted external call with attempt accounting (blueprint §15, §19).
 * Every delivery of a job consults the ledger first, whatever the queue's retry settings.
 *
 * 1. Ledger inspection (no authority needed): an attempt recorded with another request hash is
 *    refused; one left `dispatched` by an earlier delivery (crash, lost claim) becomes `unknown`
 *    and is never resent; a settled one is returned as such.
 * 2. Admission (personal scope; authority checked): admit the business run, re-read the attempt
 *    under the lock (concurrent deliveries serialise here) and reserve it if absent. If authority
 *    is refused, a reserved attempt becomes `not_sent`.
 * 3. Dispatch intent (personal scope; authority rechecked): `reserved → dispatched`. Refused →
 *    `not_sent`; lost to a concurrent delivery → `dispatch_lost` (nothing sent by this one).
 * 4. No transaction: the model call (the port refuses to run inside one).
 * 5. Ledger settlement (no authority): `succeeded`, `failed` (conclusive rejection) or `unknown`
 *    (any other error). If a concurrent delivery already marked it `unknown`, a conclusive answer
 *    is recorded as `reconciled`.
 * 6. Output eligibility (personal scope; authority rechecked, nothing written): an output produced
 *    for an authority that no longer holds is reported `ineligible` and must not be applied.
 */
export function makeExecuteModelStep(ports: ExecuteModelStepPorts) {
  const { ledger } = ports;
  return async function executeModelStep(
    authority: PersonalAuthority,
    step: ModelStep,
    signal: AbortSignal,
  ): Promise<ModelStepResult> {
    const requestHash = ports.hashRequest(step.request);
    const ref = (attemptId: string) => ({ universeId: authority.universeId, attemptId });

    const recorded = await ledger.find(authority.universeId, step.runId, step.step);
    if (recorded !== undefined) {
      if (recorded.requestHash !== requestHash) return { kind: 'refused', reason: 'request_mismatch' };
      switch (decideOnDelivery(recorded.state)) {
        case 'mark_unknown': {
          const marked = await ledger.settle(ref(recorded.id), 'dispatched', 'unknown', {
            outcomeCode: 'OUTCOME_NOT_RECORDED',
          });
          return marked ? { kind: 'unknown', attemptId: recorded.id } : { kind: 'settled', attemptId: recorded.id };
        }
        case 'settled':
          return { kind: 'settled', attemptId: recorded.id };
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
        await ledger.settle(ref(recorded.id), 'reserved', 'not_sent', { outcomeCode: 'AUTHORITY_REFUSED' });
      return { kind: 'refused', reason: 'scope_refused' };
    }
    if (!('dispatch' in admitted.value)) return admitted.value;
    const attemptId = admitted.value.dispatch;

    const dispatched = await ports.withPersonalScope(authority, (scope) => ledger.commitDispatch(scope, attemptId));
    if (dispatched.kind === 'refused') {
      await ledger.settle(ref(attemptId), 'reserved', 'not_sent', { outcomeCode: 'AUTHORITY_REFUSED' });
      return { kind: 'refused', reason: 'scope_refused' };
    }
    if (!dispatched.value) return { kind: 'refused', reason: 'dispatch_lost' };

    let answer: {
      readonly to: 'succeeded' | 'failed' | 'unknown';
      readonly remoteId?: string;
      readonly outcomeCode?: string;
      readonly output?: string;
    };
    try {
      const response = await ports.model.invoke(step.request, signal);
      answer = {
        to: 'succeeded',
        output: response.output,
        ...(response.remoteId === undefined ? {} : { remoteId: response.remoteId }),
      };
    } catch (error) {
      answer =
        error instanceof ModelRejectedError
          ? { to: 'failed', outcomeCode: error.code }
          : { to: 'unknown', outcomeCode: 'TRANSPORT_OUTCOME_UNKNOWN' };
    }
    const details = {
      ...(answer.remoteId === undefined ? {} : { remoteId: answer.remoteId }),
      ...(answer.outcomeCode === undefined ? {} : { outcomeCode: answer.outcomeCode }),
    };

    let reconciled = false;
    if (!(await ledger.settle(ref(attemptId), 'dispatched', answer.to, details))) {
      // A concurrent delivery decided this attempt was lost and marked it `unknown`. A conclusive
      // answer is the evidence reconciliation needs; anything else leaves it `unknown`.
      if (answer.to === 'unknown') return { kind: 'unknown', attemptId };
      reconciled = await ledger.settle(ref(attemptId), 'unknown', 'reconciled', details);
      if (!reconciled) return { kind: 'settled', attemptId };
    }
    switch (answer.to) {
      case 'failed':
        return { kind: 'failed', attemptId, code: answer.outcomeCode ?? 'REJECTED' };
      case 'unknown':
        return { kind: 'unknown', attemptId };
      case 'succeeded': {
        const eligible = await ports.withPersonalScope(authority, () => Promise.resolve(true));
        if (eligible.kind === 'refused') return { kind: 'ineligible', attemptId };
        return reconciled
          ? { kind: 'reconciled', attemptId, output: answer.output ?? '' }
          : { kind: 'succeeded', attemptId, output: answer.output ?? '' };
      }
    }
  };
}

export type ExecuteModelStep = ReturnType<typeof makeExecuteModelStep>;
