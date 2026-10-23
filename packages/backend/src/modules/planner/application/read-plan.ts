import type { ReadCurrentPlan } from '../../personal-context/public.js';
import type { Opportunity } from '../domain/proposal.js';
import type { PlannerStore } from './ports.js';

/** Only what Composer ranks on. Titles, purposes and supply briefs never leave the Planner. */
function toPlannedOpportunity(opportunity: Opportunity) {
  return {
    move: opportunity.move,
    topicIds: opportunity.topicIds,
    explanationUnitId: opportunity.explanationUnitId,
    eligibility: opportunity.eligibility,
    formats: opportunity.formats,
    expiresAt: opportunity.expiresAt,
    target: opportunity.target.kind,
  };
}

/**
 * The person's latest accepted plan with its unexpired opportunities, for Composer.
 *
 * This is a stored read of at most three small rows, safe on the navigation path. It does not
 * wait for a newer plan: a plan stays useful until it expires, and Composer only ever reorders
 * candidates it has already admitted, so an older plan cannot add content or evidence.
 * Plans are erased with the rest of the person's exploration, so none survives a reset.
 */
export function makeReadCurrentPlan(p: { readonly store: Pick<PlannerStore, 'revisions'> }): ReadCurrentPlan {
  return async (scope, { evaluatedAt }) => {
    const [latest] = await p.store.revisions(scope, 1);
    if (!latest) return undefined;
    const opportunities = latest.opportunities
      .filter((opportunity) => Date.parse(opportunity.expiresAt) > Date.parse(evaluatedAt))
      .map(toPlannedOpportunity);
    return opportunities.length > 0 ? { revision: latest.revision, opportunities } : undefined;
  };
}
