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
import {
  makeProjectEncounterActivity,
  makeReconcileEncounterActivity,
  makeReadPreparedActivity,
  type ActivityPorts,
} from '../application/activity.js';
import {
  currentHash,
  pendingActivity,
  persistActivity,
  readQualification,
  readTopicContext,
} from './activity-store.js';
export const ACTIVITY_PORTS = Symbol('evidence.activityPorts');
export function activityProviders(t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
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
      ): ActivityPorts => ({
        withPersonalScope,
        readExposure,
        readLineage,
        ensureLineage,
        readAttribution,
        readHistory,
        readReconcilePage,
        currentHash,
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
    {
      provide: READ_PREPARED_ACTIVITY,
      inject: [ACTIVITY_PORTS],
      useFactory: (p: ActivityPorts) => makeReadPreparedActivity(p),
    },
  ];
}
