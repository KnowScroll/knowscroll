import type { ProductionSubject } from './subject.js';

/** The receipt code a job records when its Scroll was stored held for review instead of served (D-138). */
export const HELD_FOR_REVIEW_CODE = 'held_for_review';

/**
 * Whether a produced Scroll goes through the operator review gate (D-138): a document v3 library
 * recipe does, whoever sent the job (Quartermaster, the operator's library run or a direct run), because
 * the rule is applied where the revision is stored. A v1 recipe and a Scroll ordered from code publish as
 * they always have. Pure.
 */
export function isHeldForReview(subject: Pick<ProductionSubject, 'attribution' | 'scrollV3'>): boolean {
  return subject.attribution === 'library' && subject.scrollV3 !== undefined;
}

/**
 * Whether a produced Scroll's calls go through the answer check (D-198): exactly the Scrolls that go
 * through the review gate, because the check only informs the operator's read and the Scroll is never
 * served without it. A v1 recipe and a Scroll ordered from code have no calls to check. A document v3
 * has no calls either (decision I1 on #756), so its check is recorded as passed with no request; the
 * release policy still reads that record. Pure.
 */
export function hasAnswerCheck(subject: Pick<ProductionSubject, 'attribution' | 'scrollV3'>): boolean {
  return isHeldForReview(subject);
}
