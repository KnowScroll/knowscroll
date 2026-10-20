import { READ_COVERAGE_INPUTS } from '../public.js';
import { readCoverageInputs } from './coverage-inputs.js';
import { CHECK_COVERAGE_EVIDENCE, type CheckCoverageEvidence } from '../../evidence/public.js';
import {
  READ_ADMITTED_COVERAGE_MAPPING,
  LOCK_CURRENT_COVERAGE_AUTHORITIES,
  type ReadAdmittedCoverageMapping,
  type LockCurrentCoverageAuthorities,
} from '../../content/public.js';
import { makeReadTrustedCoverage } from './read-coverage.js';
import { makeCoverageActivityContextEffect } from './activity-effect.js';
import { READ_TRUSTED_COVERAGE } from '../public.js';
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
import { makeReadComposerContext } from '../application/read-composer-context.js';
import type { ReadExplorationSnapshot } from '../application/ports.js';
import {
  APPLY_PROJECTED_ENCOUNTER,
  READ_EXPLORATION_SNAPSHOT,
  ACTIVITY_CONTEXT_EFFECT,
  READ_RECENT_CONTEXT_TOPICS,
  READ_COMPOSER_CONTEXT,
} from '../public.js';
import { applyProjectedEncounter, readContextRevision, readStructure } from './postgres-store.js';
export function personalContextProviders() {
  return [
    { provide: READ_COVERAGE_INPUTS, inject: [], useFactory: () => readCoverageInputs },
    {
      provide: READ_COMPOSER_CONTEXT,
      inject: [READ_EXPLORATION_SNAPSHOT],
      useFactory: (read: ReadExplorationSnapshot) => makeReadComposerContext(read),
    },
    {
      provide: READ_RECENT_CONTEXT_TOPICS,
      inject: [READ_RECENT_TOPIC_IDS],
      useFactory: (read: ReadRecentTopicIds) => read,
    },
    {
      provide: ACTIVITY_CONTEXT_EFFECT,
      inject: [CHECK_COVERAGE_EVIDENCE, READ_ADMITTED_COVERAGE_MAPPING, LOCK_CURRENT_COVERAGE_AUTHORITIES],
      useFactory: (
        checkEvidence: CheckCoverageEvidence,
        readMapping: ReadAdmittedCoverageMapping,
        lockAuthorities: LockCurrentCoverageAuthorities,
      ) => makeCoverageActivityContextEffect({ checkEvidence, readMapping, lockAuthorities }),
    },
    {
      provide: READ_TRUSTED_COVERAGE,
      inject: [CHECK_COVERAGE_EVIDENCE, READ_ADMITTED_COVERAGE_MAPPING, LOCK_CURRENT_COVERAGE_AUTHORITIES],
      useFactory: (
        checkEvidence: CheckCoverageEvidence,
        readMapping: ReadAdmittedCoverageMapping,
        lockAuthorities: LockCurrentCoverageAuthorities,
      ) => makeReadTrustedCoverage({ checkEvidence, readMapping, lockAuthorities }),
    },
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
