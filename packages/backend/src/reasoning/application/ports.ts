import type { LogEvent } from '../../infrastructure/observability/index.js';
import type {
  AuthorityHolds,
  PersonalAuthority,
  PersonalScopeTx,
  RecordingScopeTx,
  WithPersonalScope,
} from '../../modules/identity/public.js';
import type { AttemptState } from '../domain/attempts.js';
import type { BudgetCap, BudgetClass, BudgetUsage, ReportedUsage } from '../domain/budgets.js';
import type { OutputIssue } from '../domain/output.js';

/**
 * A request as the harness frames it: system text (preamble + role instructions), user text
 * (escaped context items, and validator feedback for a repair) and the output ceiling. Adapters
 * turn it into exact wire bytes with `ModelPort.encode`.
 */
export interface ModelRequest {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  /** How hard a model that thinks should think; models that do not think ignore it. */
  readonly effort?: ReasoningEffort;
}

/** The thinking effort a role asks for. Thinking tokens count against the role's output ceiling. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** How a provider ended its answer. `max_tokens` means it was cut off. */
export type StopReason = 'end' | 'max_tokens' | 'other';

/**
 * A conclusive provider answer. `answer` is the answer text with provider framing (thinking blocks,
 * a leading `<think>…</think>`) already removed by the adapter. An `unreadable` marker means the
 * provider answered but the reply could not be read (too large, not JSON, no text); its optional
 * `detail` is the bounded raw reply body, kept only for nonpersonal production diagnostics. Usage
 * counts are what the provider reported; `null` means not reported.
 */
export interface ModelReply {
  readonly remoteId?: string;
  readonly usage: ReportedUsage;
  readonly answer:
    | { readonly kind: 'text'; readonly text: string; readonly stop: StopReason }
    | { readonly kind: 'unreadable'; readonly code: string; readonly detail?: string };
}

/**
 * A quota preflight result (blueprint §15; providers-and-secrets.md): an observation, never a
 * reservation. `not_applicable` for a provider without a quota endpoint. Only `available` and
 * `not_applicable` let an attempt be dispatched; anything ambiguous fails closed.
 */
export interface QuotaObservation {
  readonly verdict: 'available' | 'insufficient' | 'unavailable' | 'not_applicable';
  readonly intervalRemainingPercent: number | null;
  readonly weeklyRemainingPercent: number | null;
  /** Why the observation is not `available` (`HTTP_401`, `QUOTA_RESPONSE_INVALID`, …). */
  readonly reasonCode?: string;
}

/** The provider conclusively rejected the request (it was received and refused): record `failed`. */
export class ModelRejectedError extends Error {
  override readonly name = 'ModelRejectedError';
  constructor(
    readonly code: string,
    readonly usage?: ReportedUsage,
  ) {
    super(`Model request rejected: ${code}`);
  }
}

/** The request certainly never reached the provider (connection refused, DNS, TLS): record `failed`. */
export class ModelNotSentError extends Error {
  override readonly name = 'ModelNotSentError';
  constructor(readonly code: string) {
    super(`Model request not sent: ${code}`);
  }
}

/** The request may have reached the provider and no conclusive answer came back: record `unknown`. */
export class ModelOutcomeUnknownError extends Error {
  override readonly name = 'ModelOutcomeUnknownError';
  constructor(readonly code: string) {
    super(`Model outcome unknown: ${code}`);
  }
}

/**
 * One hosted-model transport (blueprint §15). Implementations run only in workers, never inside a
 * transaction (`guardedModelPort` wraps every port), and make exactly one transport invocation per
 * `send` with SDK/HTTP retries off: the attempt ledger, not the transport, decides whether anything
 * is ever sent again.
 *
 * - `encode` is pure and deterministic: the same request always gives the same bytes, and the bytes
 *   never contain a credential (keys travel in headers). They are stored, hashed and sent as is.
 * - `observeQuota` never throws; a failure is an `unavailable` observation.
 * - `send` resolves with a conclusive answer or throws `ModelRejectedError` / `ModelNotSentError`
 *   (conclusive failure) or `ModelOutcomeUnknownError` (may have been sent). Any other thrown value
 *   is treated as unknown.
 */
export interface ModelPort {
  readonly provider: string;
  readonly model: string;
  encode(request: ModelRequest): Uint8Array;
  observeQuota(signal: AbortSignal): Promise<QuotaObservation>;
  send(body: Uint8Array, signal: AbortSignal): Promise<ModelReply>;
}

declare const guardedBrand: unique symbol;

/**
 * A `ModelPort` wrapped by `guardedModelPort`, which makes its network operations refuse to run
 * inside a database transaction (blueprint §19). Only that function creates the brand, and the
 * harness accepts nothing else: a composition root that forgets the guard gets a type error.
 */
export type GuardedModelPort = ModelPort & { readonly [guardedBrand]: true };

/**
 * A usable answer kept on its attempt, so a later delivery can still apply it without a second
 * paid call: the validated, redacted JSON object as text. Bounded by `MAX_STORED_OUTPUT_BYTES`.
 */
export interface StoredModelOutput {
  readonly v: 1;
  readonly text: string;
}

/** The validator's result for an answer that was not usable, kept so a repair is reproducible. */
export interface StoredOutputIssues {
  readonly v: 1;
  readonly reason: string;
  readonly issues: readonly OutputIssue[];
}

/** Largest stored output, as serialised JSON in UTF-8 bytes. */
export const MAX_STORED_OUTPUT_BYTES = 65_536;

/**
 * An attempt as the harness reads it back from the ledger, with the two facts of its run that
 * decide whether it may be served at all: the privacy epoch the run was admitted at and the run's
 * state (a run admitted at epoch N never continues or returns output at epoch N+1; a closed run
 * answers `run_closed`).
 */
export interface AttemptRow {
  /** Personal payload was erased. Internal read-model fence, never an accounting state. */
  readonly privacyErased?: boolean;
  /** Privacy epoch for personal work; production generation for nonpersonal work. */
  readonly runGeneration: number;
  readonly runState: string;
  readonly id: string;
  readonly step: string;
  readonly state: AttemptState;
  readonly requestHash: string;
  readonly outcomeCode: string | null;
  readonly output: StoredModelOutput | null;
  readonly issues: StoredOutputIssues | null;
  readonly usage: ReportedUsage;
}

/** What a business run records about itself at admission (blueprint §15 "business run"). */
export interface RecordingRunProof {
  readonly accountId: string;
  readonly generation: number;
  readonly contextSha256: string;
  readonly modelContextSha256: string;
}

/** Immutable private proof; claim is checked by the owner, never stored as run identity. */
export interface PersonalRecordingPurpose {
  readonly version: 'personal-role-purpose.v1';
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly ownerModule: 'planner' | 'geography';
  readonly purpose: 'personal-planner' | 'personal-cartographer';
  readonly businessRunId: string;
  readonly recordingGeneration: number;
  readonly contextSha256: string;
  readonly modelContextSha256: string;
  readonly claimId: string;
}
export type CheckPersonalRecordingRun = (
  scope: RecordingScopeTx,
  purpose: PersonalRecordingPurpose,
) => Promise<'current' | 'unavailable'>;

export interface PersonalRunAccountingBinding {
  readonly ownerModule: 'planner' | 'geography';
  readonly purpose: 'personal-planner' | 'personal-cartographer';
  readonly accountId: string;
  readonly privacyEpoch: number;
  readonly recordingGeneration: number | null;
}
/** Invoked once after the actual own-account gate; owner reads minimal header only. */
export type ReadPersonalRunAccountingBinding = (
  scope: PersonalScopeTx,
  /** Actual current owner read after the gate. Payload-free data, not historical provenance or a capability. */
  own: Readonly<{ accountId: string; universeId: string; privacyEpoch: number }>,
) => Promise<PersonalRunAccountingBinding | 'unavailable'>;

export interface PersonalAttemptAccounting {
  readonly attemptId: string;
  readonly step: string;
  readonly state: AttemptState;
}
export type PersonalRunAccounting =
  | {
      readonly kind: 'accounted';
      readonly disposition: 'conclusive' | 'unresolved';
      readonly attempts: readonly PersonalAttemptAccounting[];
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly reason: 'authority' | 'limit' | 'unproved' };

/** Real adapter gates every private read; no open capability leaves its callback. */
export interface PersonalHarnessAccess {
  enter<T>(
    authority: PersonalAuthority,
    descriptor: RunDescriptor,
    purpose: PersonalRecordingPurpose | undefined,
    work: (scope: PersonalScopeTx) => Promise<T>,
  ): Promise<
    | { readonly kind: 'entered'; readonly value: T }
    | { readonly kind: 'refused'; readonly refusal: { readonly kind: string; readonly accountingRevoked?: true } }
  >;
  check(
    scope: PersonalScopeTx,
    descriptor: RunDescriptor,
    purpose: PersonalRecordingPurpose | undefined,
  ): Promise<void>;
  checkAttempt(
    scope: PersonalScopeTx,
    descriptor: RunDescriptor,
    step: 'primary' | 'repair',
    requestHash: string,
  ): Promise<void>;
  readProtected(
    scope: PersonalScopeTx,
    descriptor: RunDescriptor,
    attempt: AttemptRef,
    step: 'primary' | 'repair',
    requestHash: string,
  ): Promise<Uint8Array | undefined>;
  apply<T>(
    authority: PersonalAuthority,
    purpose: PersonalRecordingPurpose,
    work: (scope: RecordingScopeTx) => Promise<T>,
  ): Promise<
    | { readonly kind: 'entered'; readonly value: T }
    | { readonly kind: 'refused'; readonly refusal: { readonly kind: string } }
  >;
  close(
    scope: RecordingScopeTx,
    purpose: PersonalRecordingPurpose,
    run: { readonly runId: string; readonly state: 'completed' | 'failed' | 'cancelled' },
  ): Promise<'closed' | 'not_open'>;
  closeLegacy(
    scope: PersonalScopeTx,
    run: { readonly runId: string; readonly state: 'completed' | 'failed' | 'cancelled' },
  ): Promise<'closed' | 'not_open'>;
  readAccounting(
    scope: PersonalScopeTx,
    runId: string,
    readExpectedBinding: ReadPersonalRunAccountingBinding,
  ): Promise<PersonalRunAccounting>;
}

/** Fixed refusal, with no private values or exception-derived diagnostic text. */
export class PersonalReasoningRefused extends Error {
  constructor(
    readonly reason: 'scope_refused' | 'run_mismatch' | 'run_closed' | 'output_ineligible' | 'request_mismatch',
    readonly accountingRevoked = false,
  ) {
    super('PERSONAL_REASONING_AUTHORITY_REFUSED');
  }
}

export interface RunDescriptor {
  readonly id: string;
  readonly ownerModule: string;
  readonly purpose: string;
  readonly roleId: string;
  readonly roleVersion: string;
  readonly policyVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly contextBundleRef: string;
  readonly contextRefs: readonly string[];
  readonly recording?: RecordingRunProof;
}

export type RunAdmission =
  | { readonly kind: 'admitted'; readonly fence: number }
  /**
   * A run with this ID exists with a different descriptor (role, policy, model, bundle, owner) or
   * was admitted at another privacy epoch than the caller's authority.
   */
  | { readonly kind: 'mismatch' }
  /** The run was closed (completed, failed or cancelled): it starts no new attempt. */
  | { readonly kind: 'closed' };

/** A new attempt: the ledger row, its protected request bytes and its usage receipt, written together. */
export interface Reservation {
  readonly id: string;
  readonly runId: string;
  readonly step: string;
  readonly provider: string;
  readonly model: string;
  readonly roleId: string;
  readonly roleVersion: string;
  readonly promptVersion: string;
  readonly requestHash: string;
  readonly requestBody: Uint8Array;
  readonly maxOutputTokens: number;
  readonly reservedTokens: number;
  /** Which share of the daily caps the attempt counts against; omitted means `interactive`. */
  readonly budgetClass?: BudgetClass;
  readonly causationAttemptId?: string;
  /** How long the protected request bytes are kept. */
  readonly requestRetentionSeconds: number;
}

/** What a settlement records besides the new state. */
export interface SettlementDetails {
  readonly remoteId?: string;
  readonly outcomeCode?: string;
  readonly output?: StoredModelOutput;
  readonly issues?: StoredOutputIssues;
  readonly usage?: ReportedUsage;
  readonly quota?: QuotaObservation;
}

/** Identifies an attempt for ledger bookkeeping: its storage scope and its own ID, nothing else. */
export interface AttemptRef {
  readonly scopeId: string;
  readonly attemptId: string;
}

/**
 * A refused answer of a nonpersonal production attempt, kept for diagnosis. `text` is the model's
 * answer (`kind: 'answer'`) or the bounded raw reply body when the reply could not be read as an
 * answer (`kind: 'raw_reply'`, for the operator only: it can carry the provider's envelope and
 * thinking). The ledger redacts and bounds it before storing. `issues` are the validator's own findings.
 */
export interface RejectedAnswer {
  readonly attempt: AttemptRef;
  readonly reason: string;
  readonly issues: readonly OutputIssue[];
  /** `answer`: the model's text. `raw_reply`: the provider's body of a reply that was not readable as one. */
  readonly kind: 'answer' | 'raw_reply';
  readonly text: string;
}

/** One kept refused answer as the operator `show` command prints it. */
export interface RejectedAnswerRecord {
  readonly attemptId: string;
  readonly runId: string;
  readonly step: string;
  readonly roleId: string | null;
  readonly roleVersion: string | null;
  readonly model: string;
  readonly reason: string;
  readonly issues: readonly OutputIssue[];
  readonly answerKind: RejectedAnswer['kind'];
  readonly answerText: string;
  readonly answerChars: number;
  readonly truncated: boolean;
  readonly recordedAt: Date;
  readonly expiresAt: Date;
}

/** A kept refused answer without its text, as the operator `list` command prints it. */
export type RejectedAnswerSummary = Omit<RejectedAnswerRecord, 'answerText' | 'issues'> & {
  readonly issueCount: number;
};

/** Operator reads of the kept refused answers (nonpersonal production only). */
export interface RejectedAnswerReader {
  readonly list: (limit: number) => Promise<readonly RejectedAnswerSummary[]>;
  readonly read: (attemptId: string) => Promise<RejectedAnswerRecord | undefined>;
}

/** An attempt awaiting reconciliation or write-off, as an operator sees it (no personal context). */
export interface UnknownAttempt {
  readonly attemptId: string;
  readonly provider: string;
  readonly model: string;
  readonly roleId: string | null;
  readonly outcomeCode: string | null;
  readonly dispatchedAt: Date | null;
}

export type WriteOffResult =
  | { readonly kind: 'written_off'; readonly attemptId: string }
  | { readonly kind: 'not_unknown'; readonly attemptId: string; readonly state: AttemptState }
  | { readonly kind: 'missing' };

/**
 * The attempt ledger (blueprint §15 "Three execution records"). Admission, reservation and
 * dispatch intent run inside the caller's personal scope (authority is checked there); every other
 * transition is ledger-owned bookkeeping in its own short marked transaction and never depends on
 * current authority, so an outcome is always recorded, even after an epoch change.
 *
 * A *logical* step (`primary`, `repair`) may hold several attempts only when each earlier one was
 * `not_sent` (nothing reached the provider): their steps are `primary`, `primary.2`, … The reads
 * return the latest attempt of the logical step.
 */
export interface AttemptLedger<S = PersonalScopeTx> {
  /** Ledger read, no authority: the latest attempt of a logical run step, if any. */
  readonly find: (scopeId: string, runId: string, step: string) => Promise<AttemptRow | undefined>;
  /** Admits the run (insert-or-compare) under the personal lock. */
  readonly admitRun: (scope: S, run: RunDescriptor) => Promise<RunAdmission>;
  /** The latest attempt of a logical run step, read under the personal lock. */
  readonly findLocked: (scope: S, runId: string, step: string) => Promise<AttemptRow | undefined>;
  /**
   * Today's spend in the three budget dimensions, and the part of the global and the scope spend
   * that background roles made. Takes the budget lock (a transaction advisory lock after the
   * personal root, always in that order) so concurrent reservations in different universes
   * serialise on all of these counts until this transaction ends.
   */
  readonly budgetUsage: (scope: S, roleId: string) => Promise<BudgetUsage>;
  /** Under the budget advisory lock, bound unresolved and conclusive-failed new role/day runs. */
  readonly canStartRun: (scope: S, roleId: string) => Promise<boolean>;
  /** Writes the attempt (`reserved`), its protected request bytes and its usage receipt. */
  readonly reserve: (scope: S, reservation: Reservation) => Promise<void>;
  /**
   * `reserved → dispatched` under personal authority, recording the quota observation and a new
   * dispatch identity; `false` when the attempt was not reserved any more.
   */
  readonly commitDispatch: (
    scope: S,
    attemptId: string,
    dispatch: { readonly dispatchId: string; readonly dispatchedBy: string; readonly quota: QuotaObservation },
  ) => Promise<boolean>;
  /**
   * Ledger-owned conditional transition, with the usage receipt in the same transaction; `false`
   * when the attempt was not in `from` any more. Records the settlement time only for settled
   * outcomes (not for `unknown`).
   */
  readonly settle: (
    attempt: AttemptRef,
    from: AttemptState,
    to: AttemptState,
    details?: SettlementDetails,
  ) => Promise<boolean>;
  /** Personal-only necessary cancellation after protected access refuses. No private rows escape.
   * Optional on the shared production ledger: absent capability leaves the liability held.
   * Locks exact run → bounded raw attempts → matching held receipt; refuses any dispatch proof.
   */
  readonly releaseUndispatchedPersonal?: (input: {
    readonly scopeId: string;
    readonly privacyEpoch: number;
    readonly run: RunDescriptor;
    readonly step: 'primary' | 'repair';
    readonly requestHash: string;
    readonly attemptId?: string;
  }) => Promise<'released' | 'unavailable'>;
  /**
   * Keeps a refused answer for diagnosis. Implemented by the nonpersonal production ledger only:
   * a personal ledger leaves it undefined, so no personal answer text is ever kept. Called after
   * the attempt settled; a failure is logged and never changes the attempt's outcome.
   */
  readonly recordRejectedAnswer?: (answer: RejectedAnswer) => Promise<void>;
  /**
   * The kept text of a refused answer, if it is the model's own answer (never a raw provider reply),
   * was kept whole (not cut at the bound) and has not expired: what a role that asks for it gets to
   * revise in its one repair. Production ledger only.
   */
  readonly readRejectedAnswerText?: (attempt: AttemptRef) => Promise<string | undefined>;
  /** Usage that arrived for an attempt already written off: recorded on its receipt only. */
  readonly recordLateUsage: (attemptId: string, usage: ReportedUsage) => Promise<void>;
  /** The protected request bytes of an attempt, if still kept (not expired or erased). Harness-only. */
  readonly readProtectedRequest: (attempt: AttemptRef) => Promise<Uint8Array | undefined>;
  /**
   * Closes an admitted run inside the caller's personal scope (fence + 1, `closed_at`); `not_open`
   * when it was already closed or is missing. Idempotent; a rollback of the caller's transaction
   * leaves the run open.
   */
  readonly closeRun: (
    scope: S,
    run: { readonly runId: string; readonly state: 'completed' | 'failed' | 'cancelled' },
  ) => Promise<'closed' | 'not_open'>;
  /**
   * Operator write-off: `unknown → written_off` with the reason and who ran the command
   * (`cli:<name>`), across universes by attempt ID.
   */
  readonly writeOff: (attemptId: string, reason: string, source: string) => Promise<WriteOffResult>;
  /** Attempts awaiting reconciliation or write-off, oldest first. */
  readonly listUnknown: (limit: number) => Promise<readonly UnknownAttempt[]>;
  /**
   * Deletes up to `limit` protected requests past their expiry; returns how many were deleted.
   * Never deletes the bytes of a `dispatched` attempt (the sweep resolves it first); an expired
   * `reserved` attempt is first settled `not_sent` (`REQUEST_EXPIRED`, reservation released), so no
   * attempt is left waiting for bytes that no longer exist.
   */
  readonly purgeExpiredRequests: (limit: number) => Promise<number>;
  /**
   * Crash recovery: moves up to `limit` attempts that have been `dispatched` for longer than
   * `olderThanSeconds` to `unknown` (outcome `OUTCOME_NOT_RECORDED`, receipt `unknown`), so an
   * operator can see and write them off and erasure can finish even when no delivery ever comes
   * back. Conditional on the attempt still being `dispatched`; returns how many moved. A late
   * conclusive answer still settles such an attempt as `reconciled`.
   */
  readonly sweepStaleDispatched: (olderThanSeconds: number, limit: number) => Promise<number>;
  /**
   * Personal-only hygiene: closes up to `limit` runs still `admitted` that nobody has touched for
   * `olderThanSeconds` and that have no live attempt (`reserved`, `dispatched` or `unknown`) and no
   * attempt settled within that time, as `cancelled`. Such a run is a leftover of a role that ended
   * without closing it; its owner starts a new run when it next needs one. Returns how many closed.
   * Optional on the shared production ledger, whose runs their producers close.
   */
  readonly closeIdleRuns?: (olderThanSeconds: number, limit: number) => Promise<number>;
}

/** Process-wide settings of the harness (from configuration). */
export interface HarnessSettings {
  /** Caps for every role unless the role declares its own. */
  readonly caps: { readonly global: BudgetCap; readonly scope: BudgetCap; readonly roleDefault: BudgetCap };
  /**
   * The part of the global cap and of the scope cap, in whole percent (0 to 100), that background
   * roles may use together. 100 keeps nothing back for roles a person asks for.
   */
  readonly backgroundSharePercent: number;
  /** Largest request body, in bytes (the protected store's limit). */
  readonly maxRequestBytes: number;
  /** How long protected request bytes are kept. */
  readonly requestRetentionSeconds: number;
  /** How often (at most) a propose call also purges expired protected requests. */
  readonly purgeIntervalMs: number;
  /** Identifies the dispatching process on each attempt (`worker:<pid>`). */
  readonly dispatchedBy: string;
}

/** Capabilities of the harness (blueprint §22: framework-free, everything through ports). */
export interface HarnessPorts {
  readonly personalAccess: PersonalHarnessAccess;
  readonly withPersonalScope: WithPersonalScope;
  /** Lock-free authority read for the output-eligibility check (nothing is written there). */
  readonly authorityHolds: AuthorityHolds;
  /** The configured provider, or `undefined` when no provider is configured (every propose refuses). */
  readonly model: GuardedModelPort | undefined;
  readonly ledger: AttemptLedger;
  /** SHA-256 (lowercase hex) of request bytes. */
  readonly hashBytes: (bytes: Uint8Array) => string;
  /**
   * The recording boundary for provider-returned values (CF-10): drops credential-bearing URL query
   * strings and masks key-shaped strings anywhere in a JSON value. Applied before anything from a
   * provider answer is stored or returned.
   */
  readonly redactRecorded: (value: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  readonly newId: () => string;
  readonly now: () => number;
  readonly logEvent: LogEvent;
  readonly settings: HarnessSettings;
}

/** Internal shared execution machinery: the two concrete boundaries supply their own authority protocol. */
export interface ExecutionPorts<A, S> extends Omit<
  HarnessPorts,
  'withPersonalScope' | 'authorityHolds' | 'ledger' | 'personalAccess'
> {
  /** Pure plan binding for the personal private-read adapter; absent in nonpersonal production. */
  readonly beforeAttempt?: (step: 'primary' | 'repair', requestHash: string) => void;
  readonly withScope: <T>(
    authority: A,
    work: (scope: S) => Promise<T>,
  ) => Promise<
    | { readonly kind: 'entered'; readonly value: T }
    | { readonly kind: 'refused'; readonly refusal: { readonly kind: string } }
  >;
  readonly authorityHolds: (authority: A) => Promise<boolean>;
  readonly scopeId: (authority: A) => string;
  readonly generation: (authority: A) => number;
  readonly ledger: AttemptLedger<S>;
}
