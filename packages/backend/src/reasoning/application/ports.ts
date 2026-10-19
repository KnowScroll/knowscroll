import type { AuthorityHolds, PersonalScopeTx, WithPersonalScope } from '../../modules/identity/public.js';
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
 * transaction (`guardedModelPort`), and disable SDK-level retries: the attempt ledger, not the
 * transport, decides whether anything is sent again. Throwing `ModelRejectedError` means the
 * provider conclusively rejected the request; any other error leaves the outcome unknown.
 */
export interface ModelPort {
  readonly provider: string;
  readonly model: string;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

/**
 * The usable result of a successful call, kept on the attempt so a later delivery can still apply
 * it (a provider call is never paid for twice, and its answer is never lost to a crash or a busy
 * lock between settlement and use). Bounded by `MAX_STORED_OUTPUT_BYTES`; S2.2 moves large or
 * sensitive outputs to protected storage and keeps a reference here instead.
 */
export interface StoredModelOutput {
  readonly v: 1;
  readonly text: string;
}

/** Largest stored output, as serialised JSON in UTF-8 bytes. */
export const MAX_STORED_OUTPUT_BYTES = 65_536;

export interface AttemptRow {
  readonly id: string;
  readonly state: AttemptState;
  readonly requestHash: string;
  readonly outcomeCode: string | null;
  readonly output: StoredModelOutput | null;
}

/** What a settlement records besides the new state. */
export interface SettlementDetails {
  readonly remoteId?: string;
  readonly outcomeCode?: string;
  readonly output?: StoredModelOutput;
}

/** Identifies an attempt for ledger bookkeeping: its universe and its own ID, nothing else. */
export interface AttemptRef {
  readonly universeId: string;
  readonly attemptId: string;
}

/**
 * The attempt ledger. Admission and dispatch intent run inside the personal scope (authority is
 * checked there); every other transition is ledger-owned bookkeeping that runs in its own short
 * transaction and never depends on the person's current authority, so an outcome is always
 * recorded even after an epoch change or suspension.
 */
export interface AttemptLedger {
  /** Ledger read, no authority: the attempt for a run step, if any. */
  readonly find: (universeId: string, runId: string, step: string) => Promise<AttemptRow | undefined>;
  readonly admitRun: (
    scope: PersonalScopeTx,
    run: { readonly id: string; readonly ownerModule: string; readonly purpose: string },
  ) => Promise<void>;
  /** The attempt for a run step, read under the personal lock. */
  readonly findLocked: (scope: PersonalScopeTx, runId: string, step: string) => Promise<AttemptRow | undefined>;
  readonly reserve: (
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
  /** `reserved → dispatched` under personal authority; `false` when the attempt was not reserved any more. */
  readonly commitDispatch: (scope: PersonalScopeTx, attemptId: string) => Promise<boolean>;
  /**
   * Ledger-owned conditional transition; `false` when the attempt was not in `from` any more.
   * Records the settlement time only when `to` is a settled outcome (not for `unknown`).
   */
  readonly settle: (
    attempt: AttemptRef,
    from: AttemptState,
    to: AttemptState,
    details?: SettlementDetails,
  ) => Promise<boolean>;
}

/** Ledger and transport capabilities of `executeModelStep`. */
export interface ExecuteModelStepPorts {
  readonly withPersonalScope: WithPersonalScope;
  /** Lock-free authority read for the output-eligibility check (nothing is written there). */
  readonly authorityHolds: AuthorityHolds;
  readonly model: ModelPort;
  readonly ledger: AttemptLedger;
  readonly hashRequest: (request: ModelRequest) => string;
  readonly newId: () => string;
}
