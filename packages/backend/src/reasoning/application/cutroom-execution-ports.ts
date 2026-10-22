import type {
  CutroomAuthority,
  CutroomPoolIdentity,
  CutroomPoolReceipt,
  CutroomScopeTx,
  WithCutroomScope,
} from './cutroom-ports.js';
import type { AttemptState } from '../domain/attempts.js';
declare const accountingScope: unique symbol;
/** Historical accounting only. No request bytes or B dispatch scope can be obtained from this capability. */
export interface CutroomAccountingScopeTx {
  readonly [accountingScope]: true;
  readonly worldId: 'dev' | 'stage';
  readonly currentGeneration: number;
  readonly attemptGeneration: number;
  readonly businessRunId: string;
  readonly attemptId: string;
  readonly fence: number;
  readonly identity: CutroomPoolIdentity;
}
export interface CutroomAccountingTarget {
  readonly worldId: 'dev' | 'stage';
  readonly businessRunId: string;
  readonly attemptId: string;
}
export type WithCutroomAccountingScope = <T>(
  target: CutroomAccountingTarget,
  work: (scope: CutroomAccountingScopeTx) => Promise<T>,
) => Promise<
  { readonly kind: 'entered'; readonly value: T } | { readonly kind: 'refused'; readonly code: 'disabled' | 'identity' }
>;
export interface CutroomAccountingWork {
  readonly v: 1;
  readonly worldId: 'dev' | 'stage';
  readonly attemptId: string;
  readonly businessRunId: string;
  readonly observationId: string;
}
/** Allowlisted metadata only: never raw remote bodies, URLs, errors, headers or provider messages. */
export interface CutroomRemoteObservation {
  readonly requestId: string;
  readonly runId: string | null;
  readonly evidenceSha256: string;
  readonly outcome: 'pending' | 'unknown' | 'terminal_unvalidated';
}
export interface CutroomReviewBinding {
  readonly reviewSha256: string;
  readonly corpusSha256: string;
  readonly humanEvidenceRef: string;
}
/** Trusted composition input, NOT a request parameter or a live funds observation. C2 supplies actual attestation later. */
export interface CutroomDispatchPreflight {
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly fence: number;
  readonly profileSha256: string;
  readonly soleWriterEvidenceSha256: string;
  readonly fundsEvidenceSha256: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly availableCents: number;
  readonly poolReceipt: CutroomPoolReceipt;
}
export interface CutroomIntentRecord {
  readonly dispatchId: string;
  readonly requestUtf8: string;
  readonly requestSha256: string;
}
declare const permit: unique symbol;
/** Single use, in-memory only, minted after an unequivocally acknowledged world COMMIT. */
export interface CutroomDispatchPermit {
  readonly [permit]: true;
}
export type CutroomIntentResult =
  | { readonly kind: 'prepared'; readonly permit: CutroomDispatchPermit }
  | {
      readonly kind: 'held';
      readonly code: 'disabled' | 'identity' | 'review' | 'preflight' | 'expired' | 'unknown' | 'settled';
    };
/** Immutable C1 metadata only, read under the existing live accounting scope. */
export interface CutroomExecutionBinding {
  readonly dispatchId: string;
  readonly fence: number;
  readonly requestSha256: string;
  readonly reviewSha256: string;
  readonly corpusSha256: string;
  readonly humanEvidenceRef: string;
  readonly profileSha256: string;
  readonly soleWriterEvidenceSha256: string;
  readonly fundsEvidenceSha256: string;
  readonly poolReceipt: CutroomPoolReceipt;
}
export interface CutroomExecutionStore {
  /** Connected follow adds an expiry read; old evidence-only compositions remain unchanged. */
  followUntil?(scope: CutroomAccountingScopeTx): Promise<string | undefined>;
  readAccountingBinding(scope: CutroomAccountingScopeTx): Promise<CutroomExecutionBinding | undefined>;
  matchesAccountingObservation(
    scope: CutroomAccountingScopeTx,
    observationId: string,
    snapshotSha256: string,
    runId: string,
  ): Promise<boolean>;
  identify(
    scope: CutroomScopeTx,
    attemptId: string,
  ): Promise<{ readonly businessRunId: string; readonly state: AttemptState } | undefined>;
  lock(
    scope: CutroomScopeTx,
    attemptId: string,
  ): Promise<
    | {
        readonly attemptId: string;
        readonly businessRunId: string;
        readonly requestSha256: string;
        readonly state: AttemptState;
        readonly fence: number;
        readonly ceilingCents: number;
        readonly poolReceipt: CutroomPoolReceipt | null;
      }
    | undefined
  >;
  intent(
    scope: CutroomScopeTx,
    attemptId: string,
    review: CutroomReviewBinding,
    preflight: CutroomDispatchPreflight,
  ): Promise<CutroomIntentRecord | undefined>;
  markUnknown(scope: CutroomScopeTx, attemptId: string): Promise<void>;
  observe(
    scope: CutroomAccountingScopeTx,
    observation: CutroomRemoteObservation,
  ): Promise<{ readonly observationId: string; readonly kind: 'pending' }>;
}
export type CutroomReviewRecheck = (
  scope: CutroomScopeTx,
  businessRunId: string,
) => Promise<CutroomReviewBinding | undefined>;
export interface CutroomExecutionPorts {
  readonly enabled: boolean;
  readonly withScope: WithCutroomScope;
  readonly withAccountingScope: WithCutroomAccountingScope;
  readonly store: CutroomExecutionStore;
  readonly recheckReview: CutroomReviewRecheck;
  readonly preflights: readonly CutroomDispatchPreflight[];
  readonly now: () => Date;
}
export interface CutroomExecutionFoundation {
  readFollowTarget(target: CutroomAccountingTarget): Promise<CutroomFollowBinding | undefined>;
  readAccountingBinding(scope: CutroomAccountingScopeTx): Promise<CutroomExecutionBinding | undefined>;
  matchesAccountingObservation(
    scope: CutroomAccountingScopeTx,
    observationId: string,
    snapshotSha256: string,
    runId: string,
  ): Promise<boolean>;
  recordObservationInScope(
    scope: CutroomAccountingScopeTx,
    observation: unknown,
  ): Promise<
    | { readonly kind: 'pending'; readonly observationId: string }
    | { readonly kind: 'refused'; readonly code: 'disabled' | 'identity' | 'invalid' }
  >;

  prepareIntent(authority: CutroomAuthority, attemptId: string): Promise<CutroomIntentResult>;
  recordObservation(
    target: CutroomAccountingTarget,
    observation: unknown,
  ): Promise<
    | { readonly kind: 'pending'; readonly observationId: string }
    | { readonly kind: 'refused'; readonly code: 'disabled' | 'identity' | 'invalid' }
  >;
}

export interface CutroomFollowBinding {
  readonly target: CutroomAccountingTarget;
  readonly generation: number;
  readonly identity: CutroomPoolIdentity;
  readonly execution: CutroomExecutionBinding;
  readonly followUntil: string;
}

declare const preparationScope: unique symbol;
/** Consistent public metadata snapshot only. Never a B/accounting/dispatch capability. */
export interface CutroomPreparationScopeTx {
  readonly [preparationScope]: true;
  readonly authority: CutroomAuthority;
  readonly rootEnabledAtSnapshot: boolean;
}
/** Preparation may inspect an existing disabled root; absence/generation mismatch still refuse. */
export type WithCutroomPreparationScope = <T>(
  authority: CutroomAuthority,
  work: (scope: CutroomPreparationScopeTx) => Promise<T>,
) => Promise<
  | { readonly kind: 'entered'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: 'disabled' | 'identity' | 'generation' }
>;
