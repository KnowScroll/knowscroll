import type { PlannerProposal } from '@knowscroll/backend/modules/planner';
import type { FrozenContext } from '@knowscroll/backend/modules/planner/nest-providers';

/**
 * The labelled Planner fixture's answer: what a sensible planner could say about the frozen context
 * it was handed, built by code from that context and never from a provider.
 *
 * It proposes at most two opportunities from the person's qualified evidence: the next unmet
 * explanation of a topic they read (an `existing` target, so Composer has something to lift) and a
 * depth gap on the topic they just read (a `missing_supply` target, which feeds Supply's planned
 * demand). Both pass the module's own authority checks, so a fixture reply never decides what a
 * Planner crash looks like: those come from the real context preparation that runs before it.
 */
export function plannerProposalFor(context: FrozenContext): PlannerProposal {
  const { facts } = context;
  const expiresAt = new Date(Date.parse(facts.evaluatedAt) + 24 * 60 * 60 * 1000).toISOString();
  const opportunities: PlannerProposal['opportunities'][number][] = [];
  const evidence = facts.evidence[0];
  if (evidence === undefined || evidence.topicIds.length === 0)
    return { version: 'planner-proposal.v0', opportunities };
  const topicId = evidence.topicIds[0]!;
  const unmet = facts.inventory.find(
    (asset) =>
      asset.topicIds.includes(topicId) &&
      !facts.encounteredUnitIds.includes(asset.explanationUnitId) &&
      !facts.hiddenAssetIds.includes(asset.assetId),
  );
  if (unmet !== undefined)
    opportunities.push({
      move: 'mechanism',
      title: 'CI simulation: the next unmet explanation',
      purpose: 'A future possibility, never evidence.',
      topicIds: [topicId],
      explanationUnitId: unmet.explanationUnitId,
      evidenceRefs: [evidence.ref],
      eligibility: ['vertical'],
      formats: [unmet.kind],
      expiresAt,
      target: {
        kind: 'existing',
        assetId: unmet.assetId,
        assetRevision: unmet.assetRevision,
        catalogWatermark: unmet.catalogWatermark,
      },
    });
  opportunities.push({
    move: 'limitation',
    title: 'CI simulation: a depth gap',
    purpose: 'Content that may not exist yet.',
    topicIds: [topicId],
    explanationUnitId: evidence.explanationUnitId,
    evidenceRefs: [evidence.ref],
    eligibility: ['vertical', 'related'],
    formats: ['scroll'],
    expiresAt,
    target: { kind: 'missing_supply', brief: 'CI simulation brief. Nothing is produced from it.' },
  });
  return { version: 'planner-proposal.v0', opportunities };
}
