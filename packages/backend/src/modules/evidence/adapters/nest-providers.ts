import type { Kysely } from 'kysely';
import { READ_SCROLL_READING_FACTS, type ReadScrollReadingFacts } from '../../content/public.js';
import {
  READ_ACTION_FOR_EVIDENCE,
  READ_EXPOSURE_FOR_EVIDENCE,
  type ReadActionForEvidence,
  type ReadExposureForEvidence,
} from '../../experience/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
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
      inject: [tokens.withPersonalScope, READ_ACTION_FOR_EVIDENCE],
      useFactory: (withPersonalScope: WithPersonalScope, readAction: ReadActionForEvidence) =>
        makeApplyActionEvidence({
          withPersonalScope,
          loadAction: async (scope, actionId) => {
            const action = await readAction(scope, actionId);
            return action === undefined
              ? undefined
              : { id: action.id, kind: action.kind, assetId: action.assetId, assetRevision: action.assetRevision };
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
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        readExposure: ReadExposureForEvidence,
        readReadingFacts: ReadScrollReadingFacts,
        enqueueJob: EnqueueJob,
      ) =>
        makeProjectScrollReading({
          withPersonalScope,
          readExposure,
          readReadingFacts,
          readObservations,
          readLatestEvidence,
          insertEvidence: async (scope, x) => {
            const inserted = await insertEvidence(scope, x);
            if (inserted)
              await enqueueJob(scope, projectEncounterActivityQueue, {
                v: 1,
                universeId: scope.authority.universeId,
                privacyEpoch: scope.authority.privacyEpoch,
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
      inject: [tokens.withPersonalScope, tokens.enqueueJob, READ_EXPOSURE_FOR_EVIDENCE, READ_SCROLL_READING_FACTS],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        enqueueJob: EnqueueJob,
        readExposure: ReadExposureForEvidence,
        readReadingFacts: ReadScrollReadingFacts,
      ) =>
        makeIngestObservations({
          withPersonalScope,
          readExposure,
          readReadingFacts,
          readIntakeState,
          insertObservation,
          enqueueProjection: (scope, payload) => enqueueJob(scope, projectScrollReadingQueue, payload),
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
export { activityProviders, ACTIVITY_PORTS } from './activity-providers.js';
