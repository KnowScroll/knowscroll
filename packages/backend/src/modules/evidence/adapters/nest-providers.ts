import type { Kysely } from 'kysely';
import { READ_SCROLL_READING_FACTS, type ReadScrollReadingFacts } from '../../content/public.js';
import {
  READ_ACTION_FOR_EVIDENCE,
  READ_RECORDING_SEGMENT,
  type ReadRecordingSegment,
  READ_EXPOSURE_FOR_EVIDENCE,
  type ReadActionForEvidence,
  type ReadExposureForEvidence,
} from '../../experience/public.js';
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
  type WithPersonalScope,
} from '../../identity/public.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { findRecordedEvent, hasRecordingSession, readRecordingSession } from './recording-store.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { makeApplyActionEvidence } from '../application/apply-action-evidence.js';
import { makeIngestObservations } from '../application/ingest-observations.js';
import { makeProjectScrollReading } from '../application/project-scroll-reading.js';
import { makeReadEvidenceDiagnostics } from '../application/read-evidence-diagnostics.js';
import { projectEncounterActivityQueue, projectScrollReadingQueue } from '../events.js';
import {
  insertActionEvent,
  insertEvidence,
  insertObservation,
  makeReadDiagnostics,
  readIntakeState,
  readLatestEvidence,
  readObservations,
  nextEvidenceRevision,
} from './postgres-store.js';

/** Injection tokens of the evidence use cases. */
export const APPLY_ACTION_EVIDENCE = Symbol('evidence.applyActionEvidence');
export const PROJECT_SCROLL_READING = Symbol('evidence.projectScrollReading');
export const INGEST_OBSERVATIONS = Symbol('evidence.ingestObservations');
export const READ_EVIDENCE_DIAGNOSTICS = Symbol('evidence.readEvidenceDiagnostics');

/**
 * Reusable outer wiring for the worker's composition root (blueprint §22). Needs experience's read
 * ports (`READ_ACTION_FOR_EVIDENCE`, `READ_EXPOSURE_FOR_EVIDENCE`) and content's
 * `READ_SCROLL_READING_FACTS` in the same composition root.
 */
export function evidenceProviders(tokens: { readonly withPersonalScope: symbol; readonly enqueueJob?: symbol }) {
  return [
    {
      provide: APPLY_ACTION_EVIDENCE,
      inject: [tokens.withPersonalScope, READ_ACTION_FOR_EVIDENCE, FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        readAction: ReadActionForEvidence,
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
      ) =>
        makeApplyActionEvidence({
          withPersonalScope,
          fenceOwn,
          fenceRecording,
          loadAction: async (scope, actionId) => {
            const action = await readAction(scope, actionId);
            return action === undefined ? undefined : { ...action };
          },
          insertActionEvent,
          newId: () => uuidv7(),
        }),
    },
    {
      provide: PROJECT_SCROLL_READING,
      inject: [
        tokens.withPersonalScope,
        READ_EXPOSURE_FOR_EVIDENCE,
        READ_SCROLL_READING_FACTS,
        tokens.enqueueJob ?? MISSING_PROJECTION_ENQUEUE,
        FENCE_OWN_ACCOUNT,
        FENCE_PERSONAL_RECORDING,
        READ_RECORDING_SEGMENT,
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        readExposure: ReadExposureForEvidence,
        readReadingFacts: ReadScrollReadingFacts,
        enqueueJob: EnqueueJob,
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
        readSegment: ReadRecordingSegment,
      ) =>
        makeProjectScrollReading({
          readSegment,
          withPersonalScope,
          fenceOwn,
          fenceRecording,
          readExposure,
          readReadingFacts,
          readObservations,
          readLatestEvidence,
          nextEvidenceRevision,
          insertEvidence: async (scope, x) => {
            const inserted = await insertEvidence(scope, x);
            if (inserted)
              await enqueueJob(scope.personal, projectEncounterActivityQueue, {
                v: x.clockDomain === 'legacy' ? 1 : 2,
                ...(x.clockDomain === 'session' ? { recordingGeneration: scope.generation } : {}),
                universeId: scope.personal.authority.universeId,
                privacyEpoch: scope.personal.authority.privacyEpoch,
                exposureId: x.exposureId,
              });
            return inserted;
          },
          advanceRevision: advanceScopeRevision,
          notifyScopeChanged,
          newId: () => uuidv7(),
        }),
    },
  ];
}

/**
 * Wiring for the API's composition root: the observation intake and the dev diagnostics read. Needs
 * experience's `READ_EXPOSURE_FOR_EVIDENCE` and content's `READ_SCROLL_READING_FACTS` in the same
 * composition root.
 */
export function evidenceIntakeProviders(tokens: {
  readonly database: symbol;
  readonly withPersonalScope: symbol;
  readonly enqueueJob: symbol;
}) {
  return [
    {
      provide: INGEST_OBSERVATIONS,
      inject: [
        tokens.withPersonalScope,
        tokens.enqueueJob,
        READ_EXPOSURE_FOR_EVIDENCE,
        READ_SCROLL_READING_FACTS,
        FENCE_OWN_ACCOUNT,
        FENCE_PERSONAL_RECORDING,
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        enqueueJob: EnqueueJob,
        readExposure: ReadExposureForEvidence,
        readReadingFacts: ReadScrollReadingFacts,
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
      ) =>
        makeIngestObservations({
          withPersonalScope,
          fenceOwn,
          fenceRecording,
          readExposure,
          readReadingFacts,
          readIntakeState,
          insertObservation,
          findEvent: findRecordedEvent,
          hasRecordingSession,
          readRecordingSession,
          hashEvent: canonicalSha256,
          enqueueProjection: (scope, payload) => {
            recordingTransactionOf(scope);
            return enqueueJob(scope.personal, projectScrollReadingQueue, payload);
          },
          newId: () => uuidv7(),
          now: () => new Date(),
        }),
    },
    {
      provide: READ_EVIDENCE_DIAGNOSTICS,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeReadEvidenceDiagnostics({ readDiagnostics: makeReadDiagnostics(db) }),
    },
  ];
}

/** Partial test assemblies that only build action audit need no projection producer. */
const MISSING_PROJECTION_ENQUEUE = Symbol('evidence.projectionProducerRequired');
export { activityProviders, ACTIVITY_PORTS, makeExperienceRecordingEffects } from './activity-providers.js';
