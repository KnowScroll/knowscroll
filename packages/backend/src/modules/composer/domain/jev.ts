import type { JevCriteria } from './types.js';

/** Most candidates one Jev call assesses. Blueprint §9 suggests 15–25 optionally assessed. */
export const JEV_SHORTLIST_LIMIT = 20;

/**
 * Weights that turn Jev's atomic criteria into one SemanticFit. Redundancy counts against the
 * candidate, so its complement is weighted. Code owns this combination (blueprint §9).
 */
export const JEV_WEIGHTS = Object.freeze({ relevance: 0.4, appropriateness: 0.4, nonRedundancy: 0.2 } as const);

/** SemanticFit in [0,1] from criteria that are each in [0,1]. */
export function semanticFitOf(criteria: JevCriteria): number {
  return (
    JEV_WEIGHTS.relevance * criteria.relevance +
    JEV_WEIGHTS.appropriateness * criteria.appropriateness +
    JEV_WEIGHTS.nonRedundancy * (1 - criteria.redundancy)
  );
}
