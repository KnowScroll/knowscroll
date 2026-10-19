import type { PersonalScopeTx, WithPersonalScope } from '../../modules/identity/public.js';
import type { AttemptState } from '../domain/attempts.js';

/** A bounded model request. Real role inputs (context bundles) arrive with the harness in S2.2. */
export interface ModelRequest {
  readonly purpose: string;
  readonly input: string;
}

export interface ModelResponse {
  readonly remoteId?: string;
  readonly output: string;
}

/** A conclusive provider refusal (the request was received and rejected): safe to record `failed`. */
export class ModelRejectedError extends Error {
  override readonly name = 'ModelRejectedError';
  constructor(readonly code: string) {
    super(`Model request rejected: ${code}`);
  }
}

/**
 * One hosted-model transport (blueprint §15). Implementations run only in workers, never inside a
 * transaction (`assertOutsideTransaction`), and disable SDK-level retries: the attempt ledger, not
 * the transport, decides whether anything is sent again. Throwing `ModelRejectedError` means the
 * provider conclusively rejected the request; any other error leaves the outcome unknown.
 */
export interface ModelPort {
  readonly provider: string;
  readonly model: string;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface AttemptRow {
  readonly id: string;
  readonly state: AttemptState;
  readonly outcomeCode: string | null;
}

/** Ledger and transport capabilities of `executeModelStep`. */
export interface ExecuteModelStepPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly model: ModelPort;
  readonly hashRequest: (request: ModelRequest) => string;
  readonly admitRun: (
    scope: PersonalScopeTx,
    run: { readonly id: string; readonly ownerModule: string; readonly purpose: string },
  ) => Promise<void>;
  readonly findAttempt: (scope: PersonalScopeTx, runId: string, step: string) => Promise<AttemptRow | undefined>;
  readonly reserveAttempt: (
    scope: PersonalScopeTx,
    attempt: {
      readonly id: string;
      readonly runId: string;
      readonly step: string;
      readonly provider: string;
      readonly model: string;
      readonly requestHash: string;
    },
  ) => Promise<void>;
  /** Conditional transition; `false` when the attempt was not in `from` any more. */
  readonly transitionAttempt: (
    scope: PersonalScopeTx,
    attemptId: string,
    from: AttemptState,
    to: AttemptState,
    details?: { readonly remoteId?: string; readonly outcomeCode?: string },
  ) => Promise<boolean>;
  readonly newId: () => string;
}
