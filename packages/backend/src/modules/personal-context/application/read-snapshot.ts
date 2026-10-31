import { CONTEXT_POLICY, ContextQuerySchema } from '../domain/context.js';
import type { ContextPorts, ReadExplorationSnapshot } from './ports.js';

export function makeReadExplorationSnapshot(p: ContextPorts): ReadExplorationSnapshot {
  return async (scope, query) => {
    const q = ContextQuerySchema.parse(query);
    const state = await p.readRevision(scope);
    const topics = await p.readTopics(scope, q.topicIds, q.evaluatedAt);
    const structure = await p.readStructure(scope, q);
    // Sequential bounded reads share the caller's existing personal lock and epoch.
    const routing = await p.readRouting(scope, q);
    const provisional = await p.readProvisional(scope, {
      limit: q.provisionalLimit,
      exposureIds: routing.recent.map((x) => x.exposureId),
    });
    return {
      version: 'exploration-snapshot.v0',
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      evaluatedAt: q.evaluatedAt,
      policyVersion: CONTEXT_POLICY,
      revision: state.revision,
      watermarks: { scope: scope.revisionAtEntry, projected: state.projected },
      completeness: 'not_asserted',
      coverageAvailability: 'unavailable',
      proofAvailability: structure.proofAvailability,
      proofReason: structure.proofReason,
      topics: q.topicIds.map((topicId) => ({
        topicId,
        statisticsAvailability: 'not_observed' as const,
        activity: 0,
        interest: 0,
        channels: { q: 0, L: 0, B: 0, S: 0, H: 0, R: 0 },
        formats: [
          { kind: 'reel' as const, measured: 0, qualified: 0, fit: 0.5 },
          { kind: 'scroll' as const, measured: 0, qualified: 0, fit: 0.5 },
        ],
        cells: [],
        ...topics.find((t) => t.topicId === topicId),
        qualifiedExplanationUnits: 0,
        coveredFacets: 0,
        ...structure.topics.find((t) => t.topicId === topicId),
      })),
      qualified: structure.qualified,
      supportingEvidence: structure.supportingEvidence,
      routing,
      provisional: { purpose: 'routing_only', ...provisional },
    };
  };
}
