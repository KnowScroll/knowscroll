import type { PersonalScopeTx } from '../../identity/public.js';
import type { PlannedDemandOutcome, PlannedIntent } from '../../supply/public.js';
import type { Opportunity } from '../domain/proposal.js';
import type { PlannerPorts } from './ports.js';

type Format = 'reel' | 'scroll' | 'either';

/** Both formats suit the opportunity means supply may be either; one format means that format. */
function requestedFormat(formats: Opportunity['formats']): Format {
  return formats.length === 2 ? 'either' : formats[0]!;
}

/** What the model wanted of a missing-supply opportunity, for the person's own demand row. Absent for any other target. */
export function plannedIntentOf(opportunity: Opportunity): PlannedIntent | undefined {
  return opportunity.target.kind === 'missing_supply'
    ? {
        version: 'planned-intent.v1',
        move: opportunity.move,
        explanationUnitId: opportunity.explanationUnitId,
        brief: opportunity.target.brief,
      }
    : undefined;
}

/**
 * Turns the missing-supply opportunities of an accepted plan into private demand (blueprint §3:
 * Planner → Quartermaster). Runs inside the accepting transaction, so a plan and its demand commit
 * or roll back together.
 *
 * Opportunities that name admitted content need no supply. Supply decides each one: Reuse when
 * admitted content the person has not met already fits, otherwise a deferred demand on the shared group. The slot is the
 * opportunity's position in the accepted plan, so one opportunity is never two demands. Each demand carries what the
 * model wanted (the move, the unit, its brief) on the person's own row, and every outcome is counted, whatever it was:
 * what Supply could not start is counted with its reason, not dropped.
 * Demand is not evidence, and nothing here commissions production.
 */
export async function recordMissingSupplyDemand(
  p: Pick<PlannerPorts, 'recordDemand' | 'countDemand' | 'capabilities'>,
  scope: PersonalScopeTx,
  plan: {
    readonly runId: string;
    readonly language: string;
    readonly alreadyMet: readonly string[];
    readonly opportunities: readonly Opportunity[];
  },
): Promise<readonly PlannedDemandOutcome[]> {
  const outcomes: PlannedDemandOutcome[] = [];
  for (const [slot, opportunity] of plan.opportunities.entries()) {
    const intent = plannedIntentOf(opportunity);
    if (intent === undefined) continue;
    outcomes.push(
      await p.recordDemand(scope, {
        plannerRunId: plan.runId,
        slot,
        topicIds: opportunity.topicIds,
        format: requestedFormat(opportunity.formats),
        language: plan.language,
        capabilities: p.capabilities,
        alreadyMet: plan.alreadyMet,
        intent,
      }),
    );
  }
  if (outcomes.length > 0) await p.countDemand(scope, outcomes);
  return outcomes;
}
