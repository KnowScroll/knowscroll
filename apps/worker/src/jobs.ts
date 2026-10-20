import type { Provider } from '@nestjs/common';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import {
  projectEncounterActivityQueue,
  PROJECT_ENCOUNTER_ACTIVITY,
  type ProjectEncounterActivity,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  type ApplyActionEvidence,
  type ProjectScrollReading,
} from '@knowscroll/backend/modules/evidence';
import {
  APPLY_ACTION_EVIDENCE,
  PROJECT_SCROLL_READING,
  evidenceProviders,
  activityProviders,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  SWEEP_SIGN_IN_RECORDS,
  sweepSignInRecordsQueue,
  type SweepSignInRecords,
} from '@knowscroll/backend/modules/identity';
import { identitySweepProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  PURGE_EXPIRED_REQUESTS,
  SWEEP_DISPATCHED_ATTEMPTS,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
  type PurgeExpiredRequests,
  type SweepDispatchedAttempts,
} from '@knowscroll/backend/reasoning';
import { reasoningPurgeProviders, reasoningSweepProviders } from '@knowscroll/backend/reasoning/nest-providers';
import { ENQUEUE_JOB, DATABASE, JOB_CONSUMERS, LOG_EVENT, WITH_PERSONAL_SCOPE, WORKER_CONFIG } from './tokens.js';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { ACTIVITY_CONTEXT_EFFECT } from '@knowscroll/backend/modules/personal-context';

/**
 * The worker's explicit consumer registry: every queue this process claims work from and the use
 * case that handles it. Nothing is discovered by decorators or scanning.
 */
export const jobWiring: Provider[] = [
  ...experienceEvidenceReadProviders(),
  ...contentProviders(),
  ...personalContextProviders(),
  ...evidenceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...activityProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
    derivedProjection: ACTIVITY_CONTEXT_EFFECT,
  }),
  ...identitySweepProviders({ database: DATABASE }),
  ...reasoningPurgeProviders({ database: DATABASE, logEvent: LOG_EVENT }),
  ...reasoningSweepProviders({ database: DATABASE, logEvent: LOG_EVENT, workerConfig: WORKER_CONFIG }),
  {
    provide: JOB_CONSUMERS,
    inject: [
      APPLY_ACTION_EVIDENCE,
      PROJECT_SCROLL_READING,
      PROJECT_ENCOUNTER_ACTIVITY,
      SWEEP_SIGN_IN_RECORDS,
      PURGE_EXPIRED_REQUESTS,
      SWEEP_DISPATCHED_ATTEMPTS,
      LOG_EVENT,
    ],
    useFactory: (
      applyActionEvidence: ApplyActionEvidence,
      projectScrollReading: ProjectScrollReading,
      projectActivity: ProjectEncounterActivity,
      sweepSignInRecords: SweepSignInRecords,
      purgeExpiredRequests: PurgeExpiredRequests,
      sweepDispatchedAttempts: SweepDispatchedAttempts,
      logEvent: LogEvent,
    ): readonly JobConsumer<unknown>[] => [
      jobConsumer(applyActionEvidenceQueue, async (payload) => {
        const result = await applyActionEvidence(payload);
        if (result.kind === 'skipped')
          logEvent('jobs.work_skipped', { queue: applyActionEvidenceQueue.name, reasonCode: result.reason });
      }),
      // After the evidence commit the use case has already sent its disposable hint; the event below
      // is logged after commit, with the outcome and a code, never the observations (D-017).
      jobConsumer(projectScrollReadingQueue, async (payload) => {
        const startedAt = performance.now();
        const result = await projectScrollReading(payload);
        logEvent('evidence.reading_projected', {
          exposureId: payload.exposureId,
          outcome: result.kind,
          durationMs: Math.round(performance.now() - startedAt),
          ...(result.kind === 'skipped' ? { reasonCode: result.reason } : {}),
        });
      }),
      jobConsumer(projectEncounterActivityQueue, async (payload) => {
        await projectActivity(payload);
      }),
      // Every 15 minutes (pg-boss cron, review m12): expired links and long-ended sessions.
      jobConsumer(sweepSignInRecordsQueue, async () => {
        const removed = await sweepSignInRecords();
        logEvent('identity.sign_in_records_swept', { count: removed.links + removed.sessions });
      }),
      // Every 15 minutes: protected request bytes past their retention (logs `reasoning.requests_purged`).
      jobConsumer(purgeExpiredRequestsQueue, async () => {
        await purgeExpiredRequests();
      }),
      // Every 5 minutes: attempts a crash left `dispatched` become `unknown` (logs `reasoning.dispatched_swept`).
      jobConsumer(sweepDispatchedAttemptsQueue, async () => {
        await sweepDispatchedAttempts();
      }),
    ],
  },
];
