import type { PersonalScopeTx } from '../../identity/public.js';
import type { PlannedDemandOutcome } from '../../supply/public.js';
import type { Opportunity } from '../domain/proposal.js';
import type { PlannerPorts } from './ports.js';

type Format = 'reel' | 'scroll' | 'either';

/** Both formats suit the opportunity means supply may be either; one format means that format. */
function requestedFormat(formats: Opportunity['formats']): Format {
  return formats.length === 2 ? 'either' : formats[0]!;
}

/**
 * Turns the missing-supply opportunities of an accepted plan into private demand (blueprint §3:
 * Planner → Quartermaster). Runs inside the accepting transaction, so a plan and its demand commit
 * or roll back together.
 *
 * Opportunities that name admitted content need no supply. Supply decides each one: Reuse when
 * admitted content already fits, otherwise a deferred demand on the shared group. The slot is the
 * opportunity's position in the accepted plan, so one opportunity is never two demands.
 * Demand is not evidence, and nothing here commissions production.
 */
export async function recordMissingSupplyDemand(
  p: Pick<PlannerPorts, 'recordDemand' | 'capabilities'>,
  scope: PersonalScopeTx,
  plan: { readonly runId: string; readonly language: string; readonly opportunities: readonly Opportunity[] },
): Promise<readonly PlannedDemandOutcome[]> {
  const outcomes: PlannedDemandOutcome[] = [];
  for (const [slot, opportunity] of plan.opportunities.entries()) {
    if (opportunity.target.kind !== 'missing_supply') continue;
    outcomes.push(
      await p.recordDemand(scope, {
        plannerRunId: plan.runId,
        slot,
        topicIds: opportunity.topicIds,
        format: requestedFormat(opportunity.formats),
        language: plan.language,
        capabilities: p.capabilities,
      }),
    );
  }
  return outcomes;
}
