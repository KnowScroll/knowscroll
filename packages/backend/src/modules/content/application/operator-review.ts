import type { ReviewListItem, ReviewReleaseResult, ReviewRejectResult, ReviewShow } from '@knowscroll/contracts';

/**
 * Who may use the operator's review screen: the check the API composition root binds to `KS_OPERATOR_ACCOUNTS` (D-044). It
 * is a port because the content module does not know the operator module; it must read the account's address on every call.
 */
export type IsOperatorAccount = (accountId: string) => Promise<boolean>;

/** Why a review call found nothing. Callers answer both the same, so a revision's existence never leaks; the code is for the log. */
export type ReviewNotFound = { readonly kind: 'not_found'; readonly why: 'not_operator' | 'not_held' };

/** What a decision made on the review screen is logged with: the recipe key, never the Scroll or the reason given. */
export interface OperatorDecisionLog {
  readonly recipe: string | null;
}

export type OperatorReviewList = { readonly kind: 'listed'; readonly revisions: readonly ReviewListItem[] };
export type OperatorReviewShow =
  | { readonly kind: 'shown'; readonly review: ReviewShow }
  /** The stored document does not parse as the schema it says it has; there is nothing to read and the operator can still reject it from the CLI. */
  | { readonly kind: 'unreadable' };
export type OperatorRelease = { readonly kind: 'decided'; readonly result: ReviewReleaseResult } & OperatorDecisionLog;
export type OperatorReject =
  | ({ readonly kind: 'decided'; readonly result: ReviewRejectResult } & OperatorDecisionLog)
  | { readonly kind: 'reason_invalid' };

/**
 * The operator's review of held library Scrolls on the app's screen (#780, owner decision 7 on #771): the held revisions, one to
 * read as a reader would, and the same two decisions the CLI has. Every call is for the signed-in `accountId` and answers `not_found`
 * unless that account is an operator, and, for one revision, unless the revision is held. Shared content only: no provider, no personal root.
 */
export interface OperatorReview {
  list(accountId: string): Promise<OperatorReviewList | ReviewNotFound>;
  show(accountId: string, target: ReviewTarget): Promise<OperatorReviewShow | ReviewNotFound>;
  /** Releases exactly this held revision through the review gate, as `content release` does. Idempotent. */
  release(accountId: string, target: ReviewTarget): Promise<OperatorRelease | ReviewNotFound>;
  /** Rejects exactly this held revision through the review gate, as `content reject` does. Idempotent; the first reason is kept. */
  reject(accountId: string, target: ReviewTarget, reason: string): Promise<OperatorReject | ReviewNotFound>;
}

export interface ReviewTarget {
  readonly assetId: string;
  readonly revision: number;
}
