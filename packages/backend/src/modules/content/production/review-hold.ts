import type { ProductionSubject } from './subject.js';

/** The receipt code a job records when its Scroll was stored held for review instead of served (D-138). */
export const HELD_FOR_REVIEW_CODE = 'held_for_review';

/**
 * Whether a produced Scroll goes through the operator review gate (D-138): a v2 library recipe does,
 * whoever sent the job (Quartermaster, the operator's library run or a direct run), because the rule
 * is applied where the revision is stored. A v1 recipe and a Scroll ordered from code publish as they
 * always have. Pure.
 */
export function isHeldForReview(subject: Pick<ProductionSubject, 'attribution' | 'scrollV2'>): boolean {
  return subject.attribution === 'library' && subject.scrollV2 !== undefined;
}
