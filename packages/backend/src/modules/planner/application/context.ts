import type { PersonalScopeTx } from '../../identity/public.js';
import { PLANNER_LIMITS, opportunityIssue } from '../domain/proposal.js';
import type { FrozenContext, PlannerPorts, PlannerState } from './ports.js';

/** No history reconstruction: union real plan/inventory/recent projection seeds under one cap. */
export async function prepareContext(
  p: PlannerPorts,
  scope: PersonalScopeTx,
  state: PlannerState,
): Promise<FrozenContext> {
  const evaluatedAt = p.now().toISOString();
  const recent = await p.readRecentTopics(scope, { limit: 100 });
  const memory = await p.store.revisions(scope, PLANNER_LIMITS.memory);
  const current = memory[0]?.opportunities ?? [];
  const inventory = await p.readInventory(scope, {
    languages: [state.intent?.language ?? 'en'],
    formats: ['scroll', 'reel'],
    capabilities: p.capabilities,
    topicIds: [
      ...new Set([...(state.intent?.topicIds ?? []), ...current.flatMap((x) => x.topicIds), ...recent.topicIds]),
    ].slice(0, 100),
    limit: 100,
  });
  const allTopics = [
    ...new Set([
      ...(state.intent?.topicIds ?? []),
      ...current.flatMap((x) => x.topicIds),
      ...inventory.flatMap((a) => a.topics.map((t) => t.topicId)),
      ...recent.topicIds,
    ]),
  ];
  const topicIds = allTopics.slice(0, 100);
  // First routing read supplies actual recent unit IDs even when their assets left inventory.
  const routing = await p.readSnapshot(scope, { evaluatedAt, topicIds: [], candidates: [], provisionalLimit: 0 });
  const units = [
    ...new Set([
      ...routing.routing.recent.map((r) => r.explanationUnitId),
      ...current.map((x) => x.explanationUnitId),
      ...inventory.map((a) => a.explanationUnitId),
    ]),
  ].slice(0, 100);
  const snapshot = await p.readSnapshot(scope, {
    evaluatedAt,
    topicIds,
    candidates: units.map((explanationUnitId) => ({ explanationUnitId, facets: [] })),
    candidateAssetIds: inventory.map((a) => a.assetId),
    provisionalLimit: 0,
  });
  const evidence = snapshot.supportingEvidence
    .filter((x) => x.qualified)
    .slice(0, PLANNER_LIMITS.evidence)
    .map((x) => ({
      ref: `e:${x.exposureId}:${p.hash(x)}`,
      explanationUnitId: x.explanationUnitId,
      topicIds: x.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId),
    }));
  const facts = {
    evaluatedAt,
    topics: topicIds,
    evidence,
    inventory: inventory.map((a) => ({
      title: a.metadata.title.slice(0, 160),
      summary: a.metadata.summary.slice(0, 400),
      assetId: a.assetId,
      assetRevision: a.assetRevision,
      catalogWatermark: a.catalogWatermark,
      explanationUnitId: a.explanationUnitId,
      kind: a.kind,
      topicIds: a.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId),
    })),
    hiddenAssetIds: snapshot.routing.hiddenAssetIds,
  };
  // Memory remains a fallible accepted proposal, never a fact. Corrections/expiry remove it.
  const validMemory = memory
    .map((m) => ({ ...m, opportunities: m.opportunities.filter((x) => !opportunityIssue(x, facts)) }))
    .filter((m) => m.opportunities.length > 0);
  return {
    version: 'planner-context.v0',
    evaluatedAt,
    desiredRevision: state.desiredRevision,
    contextRevision: snapshot.revision,
    scopeRevision: scope.revisionAtEntry,
    intent: {
      availability: state.intent ? 'explicit' : 'unavailable',
      language: state.intent?.language ?? 'en',
      topicIds: state.intent?.topicIds ?? [],
    },
    selection: {
      policy: 'plan_inventory_recent_union.v0',
      recentHasMore: recent.hasMore,
      topicsTruncated: allTopics.length > 100,
      inventoryBound: 100,
      completeness: 'not_asserted',
    },
    snapshot,
    facts,
    currentPlan: validMemory[0]?.opportunities ?? [],
    memory: validMemory,
  };
}
