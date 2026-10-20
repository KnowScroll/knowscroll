import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import { makePrepareObservedCoverage } from '../application/prepare-coverage.js';
import { readCoverageEvidence, checkCoverageEvidence } from './coverage-store.js';
import { CHECK_COVERAGE_EVIDENCE } from '../public.js';
import {
  READ_ADMITTED_COVERAGE_MAPPING,
  READ_SCROLL_READING_FACTS,
  type ReadAdmittedCoverageMapping,
  type ReadScrollReadingFacts,
} from '../../content/public.js';
import { READ_ENCOUNTER_ATTRIBUTION, type ReadEncounterAttribution } from '../../content/public.js';
import {
  READ_ACTIVITY_LINEAGE,
  READ_EXPOSURE_FOR_EVIDENCE,
  ENSURE_ACTIVITY_LINEAGE,
  READ_ROUTING_HISTORY,
  READ_ACTIVITY_RECONCILE_PAGE,
  type ReadActivityLineage,
  type ReadExposureForEvidence,
  type EnsureActivityLineage,
  type ReadRoutingHistory,
  type ReadActivityReconcilePage,
} from '../../experience/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { projectEncounterActivityQueue } from '../events.js';
import { PROJECT_ENCOUNTER_ACTIVITY, RECONCILE_ENCOUNTER_ACTIVITY, READ_PREPARED_ACTIVITY } from '../public.js';
import { READ_ACTIVITY_STATISTICS, READ_OBSERVATION_TAIL, READ_RECENT_TOPIC_IDS } from '../public.js';
import { readActivityStatistics, readObservationTail, readRecentTopicIds } from './context-store.js';
import {
  makeProjectEncounterActivity,
  makeReconcileEncounterActivity,
  makeReadPreparedActivity,
  type ActivityPorts,
} from '../application/activity.js';
import {
  currentActivity,
  pendingActivity,
  persistActivity,
  readQualification,
  readTopicContext,
} from './activity-store.js';
export const ACTIVITY_PORTS = Symbol('evidence.activityPorts');
export function activityProviders(t: {
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
  readonly derivedProjection?: symbol;
  readonly materialChange?: symbol;
  /** Direct compatibility fixtures only; shipped navigation must read the context owner. */
  readonly legacyPreparedRead?: true;
}) {
  if (t.materialChange && !t.derivedProjection) throw new Error('ACTIVITY_MATERIAL_CHANGE_REQUIRES_DERIVED_PROJECTION');
  return [
    { provide: CHECK_COVERAGE_EVIDENCE, inject: [], useFactory: () => checkCoverageEvidence },
    { provide: READ_RECENT_TOPIC_IDS, inject: [], useFactory: () => readRecentTopicIds },
    { provide: READ_ACTIVITY_STATISTICS, inject: [], useFactory: () => readActivityStatistics },
    { provide: READ_OBSERVATION_TAIL, inject: [], useFactory: () => readObservationTail },
    {
      provide: ACTIVITY_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        READ_EXPOSURE_FOR_EVIDENCE,
        READ_ACTIVITY_LINEAGE,
        ENSURE_ACTIVITY_LINEAGE,
        READ_ENCOUNTER_ATTRIBUTION,
        READ_ROUTING_HISTORY,
        READ_ACTIVITY_RECONCILE_PAGE,
        READ_ADMITTED_COVERAGE_MAPPING,
        READ_SCROLL_READING_FACTS,
        ...(t.derivedProjection ? [t.derivedProjection] : []),
        ...(t.materialChange ? [t.materialChange] : []),
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        enqueue: EnqueueJob,
        readExposure: ReadExposureForEvidence,
        readLineage: ReadActivityLineage,
        ensureLineage: EnsureActivityLineage,
        readAttribution: ReadEncounterAttribution,
        readHistory: ReadRoutingHistory,
        readReconcilePage: ReadActivityReconcilePage,
        readMapping: ReadAdmittedCoverageMapping,
        readFacts: ReadScrollReadingFacts,
        derived?: ActivityPorts['derived'],
        materialChange?: ActivityPorts['materialChange'],
      ): ActivityPorts => ({
        prepareCoverage: makePrepareObservedCoverage({
          readEvidence: readCoverageEvidence,
          readMapping,
          readFacts,
          hash: canonicalSha256,
          bytes: (value) => utf8ByteLength(canonicalJson(value)),
        }),
        ...(derived ? { derived } : {}),
        ...(materialChange ? { materialChange } : {}),
        withPersonalScope,
        readExposure,
        readLineage,
        ensureLineage,
        readAttribution,
        readHistory,
        readReconcilePage,
        currentActivity,
        persist: persistActivity,
        readQualification,
        readTopicContext,
        pending: pendingActivity,
        enqueue: (s, id) =>
          enqueue(s, projectEncounterActivityQueue, {
            v: 1,
            universeId: s.authority.universeId,
            privacyEpoch: s.authority.privacyEpoch,
            exposureId: id,
          }),
        advance: advanceScopeRevision,
        notify: notifyScopeChanged,
        hash: (v) => requestHash('activity.v0', v),
        newId: () => uuidv7(),
        now: () => new Date(),
      }),
    },
    {
      provide: PROJECT_ENCOUNTER_ACTIVITY,
      inject: [ACTIVITY_PORTS],
      useFactory: (p: ActivityPorts) => makeProjectEncounterActivity(p),
    },
    {
      provide: RECONCILE_ENCOUNTER_ACTIVITY,
      inject: [ACTIVITY_PORTS],
      useFactory: (p: ActivityPorts) => makeReconcileEncounterActivity(p),
    },
    ...(t.legacyPreparedRead
      ? [
          {
            provide: READ_PREPARED_ACTIVITY,
            inject: [ACTIVITY_PORTS],
            useFactory: (p: ActivityPorts) => makeReadPreparedActivity(p),
          },
        ]
      : []),
  ];
}
