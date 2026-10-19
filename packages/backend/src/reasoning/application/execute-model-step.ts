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
  | { readonly kind: 'succeeded'; readonly attemptId: string; readonly output: string }
  | { readonly kind: 'failed'; readonly attemptId: string; readonly code: string }
  | { readonly kind: 'unknown'; readonly attemptId: string }
  | { readonly kind: 'settled'; readonly attemptId: string }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'dispatch_lost' };

/**
 * `executeModelStep`: one admitted external call with attempt accounting (blueprint §15, §19).
 * Every delivery of a job consults the ledger first, whatever the queue's retry settings.
 *
 * 1. Tx 1 (personal scope): admit the business run (idempotent), then reserve an attempt for the
 *    step — or, if one exists, decide from its state: never-dispatched → continue; dispatched
 *    without outcome → record `unknown` and stop (never resend); settled → stop.
 * 2. Tx 2 (fresh lock and authority recheck): commit dispatch intent (`reserved → dispatched`).
 * 3. No transaction: call the model. The port refuses to run inside a transaction.
 * 4. Tx 3: record `succeeded`, conclusive `failed`, or `unknown` for any other error.
 * A crash between 2 and 4 leaves `dispatched`; the next delivery turns it into `unknown`.
 */
export function makeExecuteModelStep(ports: ExecuteModelStepPorts) {
  return async function executeModelStep(
    authority: PersonalAuthority,
    step: ModelStep,
    signal: AbortSignal,
  ): Promise<ModelStepResult> {
    const requestHash = ports.hashRequest(step.request);
    const admitted = await ports.withPersonalScope(
      authority,
      async (scope): Promise<{ readonly next: 'dispatch'; readonly attemptId: string } | ModelStepResult> => {
        await ports.admitRun(scope, { id: step.runId, ownerModule: step.ownerModule, purpose: step.purpose });
        const existing = await ports.findAttempt(scope, step.runId, step.step);
        if (existing !== undefined) {
          switch (decideOnDelivery(existing.state)) {
            case 'dispatch':
              return { next: 'dispatch', attemptId: existing.id };
            case 'mark_unknown':
              await ports.transitionAttempt(scope, existing.id, 'dispatched', 'unknown', {
                outcomeCode: 'OUTCOME_NOT_RECORDED',
              });
              return { kind: 'unknown', attemptId: existing.id };
            case 'settled':
              return { kind: 'settled', attemptId: existing.id };
          }
        }
        const attemptId = ports.newId();
        await ports.reserveAttempt(scope, {
          id: attemptId,
          runId: step.runId,
          step: step.step,
          provider: ports.model.provider,
          model: ports.model.model,
          requestHash,
        });
        return { next: 'dispatch', attemptId };
      },
    );
    if (admitted.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' };
    if (!('next' in admitted.value)) return admitted.value;
    const { attemptId } = admitted.value;

    const dispatched = await ports.withPersonalScope(authority, (scope) =>
      ports.transitionAttempt(scope, attemptId, 'reserved', 'dispatched'),
    );
    if (dispatched.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' };
    if (!dispatched.value) return { kind: 'refused', reason: 'dispatch_lost' };

    let settlement: {
      readonly to: 'succeeded' | 'failed' | 'unknown';
      readonly remoteId?: string;
      readonly outcomeCode?: string;
      readonly output?: string;
    };
    try {
      const response = await ports.model.invoke(step.request, signal);
      settlement = {
        to: 'succeeded',
        output: response.output,
        ...(response.remoteId === undefined ? {} : { remoteId: response.remoteId }),
      };
    } catch (error) {
      settlement =
        error instanceof ModelRejectedError
          ? { to: 'failed', outcomeCode: error.code }
          : { to: 'unknown', outcomeCode: 'TRANSPORT_OUTCOME_UNKNOWN' };
    }

    await ports.withPersonalScope(authority, (scope) =>
      ports.transitionAttempt(scope, attemptId, 'dispatched', settlement.to, {
        ...(settlement.remoteId === undefined ? {} : { remoteId: settlement.remoteId }),
        ...(settlement.outcomeCode === undefined ? {} : { outcomeCode: settlement.outcomeCode }),
      }),
    );
    switch (settlement.to) {
      case 'succeeded':
        return { kind: 'succeeded', attemptId, output: settlement.output ?? '' };
      case 'failed':
        return { kind: 'failed', attemptId, code: settlement.outcomeCode ?? 'REJECTED' };
      case 'unknown':
        return { kind: 'unknown', attemptId };
    }
  };
}

export type ExecuteModelStep = ReturnType<typeof makeExecuteModelStep>;
