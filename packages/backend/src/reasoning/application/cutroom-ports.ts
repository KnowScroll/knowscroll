import type { AttemptState } from '../domain/attempts.js';

declare const cutroomScope: unique symbol;
/** Only infrastructure's live transaction map creates this capability. Not serializable authority. */
export interface CutroomScopeTx {
  readonly [cutroomScope]: true;
  readonly authority: CutroomAuthority;
  readonly mode: 'admit' | 'recover';
  readonly enabled: boolean;
}
export interface CutroomAuthority {
  readonly worldId: 'dev' | 'stage';
  readonly generation: number;
}
export type CutroomScopeOutcome<T> =
  | { readonly kind: 'entered'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: 'disabled' | 'generation' };
export type WithCutroomScope = <T>(
  authority: CutroomAuthority,
  mode: 'admit' | 'recover',
  work: (scope: CutroomScopeTx) => Promise<T>,
) => Promise<CutroomScopeOutcome<T>>;
/** Complete immutable expectation, including an independently reviewed pool SESSION identity. */
export interface CutroomPoolIdentity {
  readonly grantRef: 'knowscroll-v2-d018';
  readonly requestId: string;
  readonly scriptSha256: string;
  readonly take: number;
  readonly until: 'video';
  readonly requestSha256: string;
  readonly worldId: 'dev' | 'stage';
  readonly ceilingCents: number;
  readonly approvalRef: string;
  readonly principalOid: string;
  readonly principalName: string;
}
export interface CutroomCandidate extends CutroomPoolIdentity {
  readonly businessRunId: string;
  readonly generation: number;
  readonly evidenceSha256: string;
  readonly policyVersion: 'cutroom-commission.v1';
  readonly requestUtf8: string;
  readonly byteLength: number;
  readonly contractVersion: 1;
}
/** Trusted composition data, never a caller capability. Empty by default. */
export type CutroomOwnerApproval = Omit<CutroomCandidate, 'requestUtf8' | 'byteLength' | 'contractVersion'>;
/** Server UTC timestamps with exactly six fractional digits; never rounded through Date. */
export interface CutroomPoolReceipt {
  readonly bindingId: string;
  readonly claimedAt: string;
  readonly boundAt: string;
}
export interface CutroomAttemptRecord {
  readonly attemptId: string;
  readonly candidate: Omit<CutroomCandidate, 'requestUtf8'>;
  readonly state: AttemptState;
  readonly fence: number;
  readonly dispatchIntentAt: string | null;
  readonly expiresAt: string;
  readonly purged: boolean;
  readonly poolReceipt: CutroomPoolReceipt | null;
  readonly poolState: 'pending' | 'claimed' | 'released' | 'held';
}
export interface CutroomPoolOperation {
  readonly operationId: string;
  readonly attemptId: string;
  readonly kind: 'claim' | 'release';
  readonly fence: number;
  readonly state: 'pending' | 'in_flight' | 'confirmed' | 'held';
}
declare const notSent: unique symbol;
/** Closed ephemeral proof: runtime provenance is checked and consumed by the pool adapter. */
export interface CutroomNotSent {
  readonly [notSent]: true;
}
export type CutroomPoolObservation =
  | { readonly kind: 'exact'; readonly receipt: CutroomPoolReceipt; readonly state: 'claimed' | 'released' }
  | {
      readonly kind: 'held';
      readonly reason: 'pool_refused' | 'identity' | 'accounting_hold' | 'unknown' | 'needs_operator';
    };
export interface CutroomPool {
  claim(identity: CutroomPoolIdentity): Promise<CutroomPoolObservation>;
  read(identity: CutroomPoolIdentity): Promise<CutroomPoolObservation>;
  release(
    identity: CutroomPoolIdentity,
    operation: CutroomPoolOperation,
    proof: CutroomNotSent,
  ): Promise<CutroomPoolObservation>;
}
export interface CutroomLedger {
  identify(scope: CutroomScopeTx, attemptId: string): Promise<string | undefined>;
  findBusiness(scope: CutroomScopeTx, businessRunId: string): Promise<CutroomAttemptRecord | undefined>;
  find(scope: CutroomScopeTx, attemptId: string): Promise<CutroomAttemptRecord | undefined>;
  reserve(scope: CutroomScopeTx, candidate: CutroomCandidate): Promise<CutroomAttemptRecord>;
  request(scope: CutroomScopeTx, attempt: CutroomAttemptRecord): Promise<string | undefined>;
  operation(
    scope: CutroomScopeTx,
    attempt: CutroomAttemptRecord,
    kind: 'claim' | 'release',
  ): Promise<CutroomPoolOperation | undefined>;
  start(scope: CutroomScopeTx, operation: CutroomPoolOperation): Promise<void>;
  observe(
    scope: CutroomScopeTx,
    attempt: CutroomAttemptRecord,
    operation: CutroomPoolOperation,
    result: CutroomPoolObservation,
  ): Promise<void>;
  cancel(scope: CutroomScopeTx, attempt: CutroomAttemptRecord): Promise<CutroomAttemptRecord>;
  releaseIntent(scope: CutroomScopeTx, attempt: CutroomAttemptRecord): Promise<CutroomPoolOperation>;
  expired(
    scope: CutroomScopeTx,
    limit: number,
  ): Promise<readonly { readonly attemptId: string; readonly businessRunId: string }[]>;
  purge(scope: CutroomScopeTx, attempt: CutroomAttemptRecord): Promise<void>;
}
export interface CutroomReservationPort {
  (scope: CutroomScopeTx, candidate: CutroomCandidate): Promise<CutroomBResult>;
}
export type CutroomBResult =
  | {
      readonly kind: 'pending';
      readonly attemptId: string;
      readonly state: AttemptState;
      readonly poolState: CutroomAttemptRecord['poolState'];
    }
  | { readonly kind: 'held'; readonly code: 'identity' | 'expired' | 'pending' | 'unknown' | 'needs_operator' }
  | { readonly kind: 'refused'; readonly code: 'authority' | 'invalid' | 'disabled' | 'generation' };
export interface CutroomB {
  readonly withScope: WithCutroomScope;
  readonly reserve: CutroomReservationPort;
  admitted(scope: CutroomScopeTx, candidate: CutroomCandidate): boolean;
  readScoped(scope: CutroomScopeTx, attemptId: string): Promise<CutroomBResult>;
  read(authority: CutroomAuthority, attemptId: string): Promise<CutroomBResult>;
  claim(authority: CutroomAuthority, attemptId: string): Promise<CutroomBResult>;
  reconcile(authority: CutroomAuthority, attemptId: string): Promise<CutroomBResult>;
  cancel(authority: CutroomAuthority, attemptId: string): Promise<CutroomBResult>;
  releaseNotSent(authority: CutroomAuthority, attemptId: string): Promise<CutroomBResult>;
  purge(authority: CutroomAuthority, limit?: number): Promise<number>;
}
export type CutroomBusinessLock = (scope: CutroomScopeTx, businessRunId: string) => Promise<boolean>;
export interface CutroomBPorts {
  readonly withScope: WithCutroomScope;
  readonly ledger: CutroomLedger;
  readonly lockBusiness: CutroomBusinessLock;
  readonly pool: CutroomPool;
  readonly approvals: readonly CutroomOwnerApproval[];
  readonly enabled: boolean;
  readonly now: () => Date;
  readonly sha256: (text: string) => string;
  readonly byteLength: (text: string) => number;
}
