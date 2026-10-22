import { z } from 'zod';
import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import { makePrepareObservedCoverage } from '../application/prepare-coverage.js';
import { readCoverageEvidence, checkCoverageEvidence, checkRecordingCoverageEvidence } from './coverage-store.js';
import { CHECK_COVERAGE_EVIDENCE, CHECK_RECORDING_COVERAGE_EVIDENCE } from '../public.js';
import {
  READ_ADMITTED_COVERAGE_MAPPING,
  READ_SCROLL_READING_FACTS,
  type ReadAdmittedCoverageMapping,
  type ReadScrollReadingFacts,
} from '../../content/public.js';
import { READ_ENCOUNTER_ATTRIBUTION, type ReadEncounterAttribution } from '../../content/public.js';
import {
  READ_ACTIVITY_LINEAGE,
  READ_RECORDING_SEGMENT,
  EXPERIENCE_RECORDING_EFFECTS,
  READ_ACTION_FOR_EVIDENCE,
  type ReadRecordingSegment,
  type ExperienceRecordingEffects,
  type ReadActionForEvidence,
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
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
  type WithPersonalScope,
} from '../../identity/public.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { legacyExposureCredit, readExposureCredit, startRecordingSession } from './recording-store.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { projectEncounterActivityQueue, applyActionEvidenceQueue } from '../events.js';
import { PROJECT_ENCOUNTER_ACTIVITY, RECONCILE_ENCOUNTER_ACTIVITY, READ_PREPARED_ACTIVITY } from '../public.js';
import { READ_ACTIVITY_STATISTICS, READ_OBSERVATION_TAIL, READ_RECENT_TOPIC_IDS } from '../public.js';
import { readActivityStatistics, readObservationTail, readRecentTopicIds } from './context-store.js';
import {
  makeProjectEncounterActivity,
  applyRecordingActivity,
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
    {
      provide: EXPERIENCE_RECORDING_EFFECTS,
      inject: [ACTIVITY_PORTS, t.enqueueJob, READ_ACTION_FOR_EVIDENCE],
      useFactory: makeExperienceRecordingEffects,
    },
    { provide: CHECK_RECORDING_COVERAGE_EVIDENCE, inject: [], useFactory: () => checkRecordingCoverageEvidence },
    { provide: CHECK_COVERAGE_EVIDENCE, inject: [], useFactory: () => checkCoverageEvidence },
    { provide: READ_RECENT_TOPIC_IDS, inject: [], useFactory: () => readRecentTopicIds },
    { provide: READ_ACTIVITY_STATISTICS, inject: [], useFactory: () => readActivityStatistics },
    { provide: READ_OBSERVATION_TAIL, inject: [], useFactory: () => readObservationTail },
    {
      provide: ACTIVITY_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        FENCE_OWN_ACCOUNT,
        FENCE_PERSONAL_RECORDING,
        READ_RECORDING_SEGMENT,
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
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
        readSegment: ReadRecordingSegment,
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
        fenceOwn,
        fenceRecording,
        readSegment,
        readCredit: readExposureCredit,
        legacyCredit: legacyExposureCredit,
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
        enqueue: (s, id) => {
          recordingTransactionOf(s);
          return enqueue(s.personal, projectEncounterActivityQueue, {
            v: 2,
            recordingGeneration: s.generation,
            universeId: s.personal.authority.universeId,
            privacyEpoch: s.personal.authority.privacyEpoch,
            exposureId: id,
          });
        },
        advance: advanceScopeRevision,
        notify: notifyScopeChanged,
        hash: (v) => requestHash('evidence.recording-activity.v1', v),
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

const ChannelEffectInput = z.strictObject({
  commandId: z.uuid(),
  actionId: z.uuid(),
  assetId: z.uuid(),
  channel: z.enum(['saved', 'liked']),
  pointerRevision: z.number().int().positive().max(2147483647),
  changes: z
    .array(
      z.strictObject({
        exposureId: z.uuid(),
        value: z.boolean(),
        originActionId: z.uuid(),
        originGeneration: z
          .number()
          .int()
          .positive()
          .max(2147483647)
          .refine((g) => g % 2 === 1),
      }),
    )
    .max(2),
});
/** The Experience producer and these four effects share one genuine recording transaction. */
export function makeExperienceRecordingEffects(
  p: ActivityPorts,
  enqueue: EnqueueJob,
  readAction: ReadActionForEvidence,
): ExperienceRecordingEffects {
  if (
    !p.derived ||
    typeof p.derived.apply !== 'function' ||
    typeof p.derived.isCurrent !== 'function' ||
    typeof p.derived.applyRecording !== 'function' ||
    typeof p.derived.isRecordingCurrent !== 'function' ||
    !p.materialChange
  )
    throw new Error('EXPERIENCE_RECORDING_EFFECTS_REQUIRED');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    async startSession(cap, input) {
      recordingTransactionOf(cap);
      const segment = await p.readSegment(cap, input.exposureId);
      const serverStartedAt = p.now();
      const started = serverStartedAt.getTime();
      if (
        !segment ||
        segment.recordingGeneration !== cap.generation ||
        !segment.firstEligibleActivationAt ||
        !Number.isFinite(started) ||
        Date.parse(segment.firstEligibleActivationAt) > started ||
        Date.parse(segment.initializedAt) > started
      )
        throw new Error('RECORDING_SESSION_ACTIVATION_REQUIRED');
      // Sample our own clock in the accepted transaction; never accept a backdated source clock.
      await startRecordingSession(cap, { ...input, serverStartedAt });
    },
    async enqueueActivity(cap, exposureId) {
      recordingTransactionOf(cap);
      await enqueue(cap.personal, projectEncounterActivityQueue, {
        v: 2,
        recordingGeneration: cap.generation,
        universeId: cap.personal.authority.universeId,
        privacyEpoch: cap.personal.authority.privacyEpoch,
        exposureId,
      });
    },
    async enqueueActionEvidence(cap, actionId) {
      recordingTransactionOf(cap);
      await enqueue(cap.personal, applyActionEvidenceQueue, {
        v: 2,
        recordingGeneration: cap.generation,
        universeId: cap.personal.authority.universeId,
        privacyEpoch: cap.personal.authority.privacyEpoch,
        actionId,
      });
    },
    async applyChannels(cap, input) {
      recordingTransactionOf(cap);
      input = ChannelEffectInput.parse(input);
      if (
        input.changes.length > 2 ||
        new Set(input.changes.map((x) => x.exposureId.toLowerCase())).size !== input.changes.length ||
        !Number.isSafeInteger(input.pointerRevision) ||
        input.pointerRevision < 1
      )
        throw new Error('RECORDING_CHANNEL_INPUT_INVALID');
      const action = await readAction(cap.personal, input.actionId);
      if (
        !action ||
        !same(action.id, input.actionId) ||
        !same(action.assetId, input.assetId) ||
        !action.commandId ||
        !same(action.commandId, input.commandId) ||
        !(input.channel === 'saved' ? ['save', 'unsave'] : ['like', 'unlike']).includes(action.kind)
      )
        throw new Error('RECORDING_CHANNEL_ACTION_INVALID');
      if (
        action.recordingOrigin?.kind !== 'recorded' ||
        action.recordingOrigin.eligibleGeneration !== cap.generation ||
        (action.recordingOrigin.originalGeneration ?? 1) !== cap.generation
      )
        throw new Error('RECORDING_CHANNEL_ORIGIN_INVALID');
      // Validate all sources before any derived write; the producer has already persisted decisions.
      for (const change of input.changes) {
        const segment = await p.readSegment(cap, change.exposureId);
        const decision = input.channel === 'saved' ? segment?.savedDecision : segment?.likedDecision;
        const override = input.channel === 'saved' ? segment?.savedOverride : segment?.likedOverride;
        if (
          !segment ||
          segment.recordingGeneration !== cap.generation ||
          !same(segment.exposure.assetId, input.assetId) ||
          !decision ||
          override !== change.value ||
          decision.value !== change.value ||
          !same(decision.decisionActionId, input.actionId) ||
          !same(decision.originActionId, change.originActionId) ||
          decision.originGeneration !== change.originGeneration
        )
          throw new Error('RECORDING_CHANNEL_SOURCE_MISMATCH');
      }
      let changed = false;
      const at = p.now().toISOString();
      for (const change of input.changes) {
        const result = await applyRecordingActivity(p, cap, change.exposureId, 'session', at);
        if (!result) throw new Error('RECORDING_CHANNEL_SEGMENT_MISSING');
        changed ||= result.changed;
      }
      if (!changed) return { changed: false };
      const revision = await p.advance(cap.personal);
      await p.materialChange!(cap, { sourceRevision: revision, recordingGeneration: cap.generation });
      return { changed: true, revision };
    },
  };
}
