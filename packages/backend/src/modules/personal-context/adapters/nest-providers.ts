import {
  READ_ACTIVITY_STATISTICS,
  READ_OBSERVATION_TAIL,
  READ_RECENT_TOPIC_IDS,
  type ReadRecentTopicIds,
  type ReadActivityStatistics,
  type ReadObservationTail,
} from '../../evidence/public.js';
import { READ_ROUTING_HISTORY, type ReadRoutingHistory } from '../../experience/public.js';
import { formatFit, interest } from '../domain/context.js';
import { makeReadExplorationSnapshot } from '../application/read-snapshot.js';
import {
  APPLY_PROJECTED_ENCOUNTER,
  READ_EXPLORATION_SNAPSHOT,
  ACTIVITY_CONTEXT_EFFECT,
  READ_RECENT_CONTEXT_TOPICS,
} from '../public.js';
import { applyProjectedEncounter, readContextRevision, readStructure } from './postgres-store.js';
import { activityContextEffect } from './activity-effect.js';
export function personalContextProviders() {
  return [
    {
      provide: READ_RECENT_CONTEXT_TOPICS,
      inject: [READ_RECENT_TOPIC_IDS],
      useFactory: (read: ReadRecentTopicIds) => read,
    },
    { provide: ACTIVITY_CONTEXT_EFFECT, inject: [], useFactory: () => activityContextEffect },
    { provide: APPLY_PROJECTED_ENCOUNTER, inject: [], useFactory: () => applyProjectedEncounter },
    {
      provide: READ_EXPLORATION_SNAPSHOT,
      inject: [READ_ACTIVITY_STATISTICS, READ_ROUTING_HISTORY, READ_OBSERVATION_TAIL],
      useFactory: (
        readStatistics: ReadActivityStatistics,
        readHistory: ReadRoutingHistory,
        readTail: ReadObservationTail,
      ) =>
        makeReadExplorationSnapshot({
          apply: applyProjectedEncounter,
          readRevision: readContextRevision,
          readStructure,
          readTopics: async (scope, topicIds, evaluatedAt) =>
            (await readStatistics(scope, { topicIds, evaluatedAt })).map((t) => ({
              ...t,
              statisticsAvailability: 'available' as const,
              interest: interest(t.activity),
              formats: t.formats.map((f) => ({ ...f, fit: formatFit(f.qualified, f.measured) })),
            })),
          readRouting: async (scope, q) => {
            const r = await readHistory(scope, {
              evaluatedAt: q.evaluatedAt,
              candidates: q.candidates,
              candidateAssetIds: q.candidateAssetIds ?? [],
            });
            return r;
          },
          readProvisional: readTail,
        }),
    },
  ];
}
export { applyProjectedEncounter, readContextRevision, readStructure } from './postgres-store.js';
export { activityContextEffect } from './activity-effect.js';
