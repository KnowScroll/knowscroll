/**
 * The review gate's rules for a library v2 Scroll (D-138): a produced revision is stored held, and an
 * operator releases or rejects it. Pure; the adapter reads the facts and applies the decision.
 */

/** Where a revision stands at the gate. A revision that never went through the gate has no state. */
export type ReviewState = 'held' | 'released' | 'rejected';

/** The facts a release is decided from. */
export interface ReleaseFacts {
  /** The revision's state at the gate; `undefined` when it never went through it. */
  readonly review: ReviewState | undefined;
  readonly assetStatus: 'admitted' | 'held' | 'withdrawn';
  /** The revision the asset serves now. Meaningless while the asset is `held`. */
  readonly servedRevision: number;
  readonly revision: number;
}

export type ReleaseRefusal =
  /** The revision never went through the gate, so there is nothing to release. */
  | 'not_under_review'
  /** An operator rejected the revision; it is never released. Regenerate instead. */
  | 'revision_rejected'
  | 'asset_withdrawn'
  /** The asset already serves this revision or a newer one; a release never moves it backwards. */
  | 'not_newer_than_served';

export type ReleaseDecision =
  | { readonly kind: 'release' }
  | { readonly kind: 'already_released' }
  | { readonly kind: 'refused'; readonly reason: ReleaseRefusal };

/**
 * Whether the revision may be served now. Releasing twice is a no-op, so an operator who repeats the
 * command after a dropped connection does no harm.
 */
export function decideRelease(facts: ReleaseFacts): ReleaseDecision {
  if (facts.review === undefined) return { kind: 'refused', reason: 'not_under_review' };
  if (facts.review === 'released') return { kind: 'already_released' };
  if (facts.review === 'rejected') return { kind: 'refused', reason: 'revision_rejected' };
  if (facts.assetStatus === 'withdrawn') return { kind: 'refused', reason: 'asset_withdrawn' };
  if (facts.assetStatus === 'admitted' && facts.revision <= facts.servedRevision)
    return { kind: 'refused', reason: 'not_newer_than_served' };
  return { kind: 'release' };
}

export type RejectRefusal =
  | 'not_under_review'
  /** The revision is served; correcting a served Scroll is a new revision, not a rejection. */
  | 'revision_released';

export type RejectDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'already_rejected' }
  | { readonly kind: 'refused'; readonly reason: RejectRefusal };

/** Whether the revision may be rejected now. Rejecting twice is a no-op and keeps the first reason. */
export function decideReject(review: ReviewState | undefined): RejectDecision {
  if (review === undefined) return { kind: 'refused', reason: 'not_under_review' };
  if (review === 'released') return { kind: 'refused', reason: 'revision_released' };
  return review === 'rejected' ? { kind: 'already_rejected' } : { kind: 'reject' };
}

/** The longest reason an operator may give for a rejection. */
export const MAX_REJECT_REASON_CHARS = 500;

/** A rejection reason as stored: trimmed, one to {@link MAX_REJECT_REASON_CHARS} characters, or `undefined`. */
export function parseRejectReason(raw: string | undefined): string | undefined {
  const reason = raw?.trim();
  return reason === undefined || reason.length < 1 || reason.length > MAX_REJECT_REASON_CHARS ? undefined : reason;
}
