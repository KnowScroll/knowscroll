import { canTransition, decideOnDelivery, type AttemptState, type DeliveryDecision } from './attempts.js';

/** A Cutroom invocation is not a model role, token allocation or queue delivery. */
export interface CutroomAttemptIdentity {
  readonly attemptId: string;
  readonly businessRunId: string;
  readonly requestId: string;
  readonly worldId: string;
  readonly scriptSha256: string;
  readonly requestSha256: string;
  readonly contractVersion: 1;
  readonly take: number;
}

/** Protected bytes have separate access/expiry policy; never place them in accounting or logs. */
export interface CutroomProtectedRequest {
  readonly ref: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly expiresAt: string;
}

/** A confirmed pool claim is the money authority, in a database separate from the world. */
export interface CutroomCentsReservation {
  readonly identity: CutroomAttemptIdentity;
  readonly poolOrderId: string;
  readonly claimReceiptId: string;
  readonly ceilingCents: number;
  readonly grantRef: string;
  readonly approvalRef: string;
}

export interface CutroomAttemptSnapshot {
  readonly identity: CutroomAttemptIdentity;
  readonly state: AttemptState;
  readonly protectedRequest: CutroomProtectedRequest;
  readonly reservation: CutroomCentsReservation;
}

/** Pure ledger advice only. `dispatch` still needs actual authority, preflight and durable intent. */
export function decideCutroomDelivery(state: AttemptState): DeliveryDecision {
  return decideOnDelivery(state);
}

export function canTransitionCutroomAttempt(from: AttemptState, to: AttemptState): boolean {
  return canTransition(from, to);
}

/**
 * HTTP acceptance is not remote completion, publication, or proof of the final chain cost.
 * A refused/conflict response describes this response only: it cannot establish that the original
 * request was never accepted or charged. Unknown original liability remains held; neither this
 * response nor its code authorizes pool release, another POST or a new paid attempt.
 */
export type CutroomDispatchOutcome =
  | { readonly kind: 'accepted'; readonly requestId: string; readonly remoteRunId: string }
  | { readonly kind: 'not_sent'; readonly code: 'cancelled_before_intent' | 'preflight_refused' }
  | { readonly kind: 'refused'; readonly code: 'version' | 'invalid' | 'conflict' | 'unsupported' }
  | { readonly kind: 'unknown'; readonly code: 'transport' | 'commit_ack_lost' | 'outcome_missing' };

/** Cost uncertainty is liability. Never silently clamp actual overage to a reservation. */
export type CutroomCentsReceipt =
  | {
      readonly kind: 'settled';
      readonly identity: CutroomAttemptIdentity;
      readonly poolOrderId: string;
      readonly settlementReceiptId: string;
      readonly actualCents: number;
      readonly accountingEvidenceRef: string;
    }
  | {
      readonly kind: 'held';
      readonly identity: CutroomAttemptIdentity;
      readonly poolOrderId: string;
      readonly ceilingCents: number;
      readonly reason:
        'dispatch_unknown' | 'chain_incomplete' | 'upstream_cost_semantics_unverified' | 'pool_reconciliation';
    };
