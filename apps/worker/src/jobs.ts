import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import {
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  type ApplyActionEvidence,
  type ProjectScrollReading,
} from '@knowscroll/backend/modules/evidence';
import {
  APPLY_ACTION_EVIDENCE,
  PROJECT_SCROLL_READING,
  evidenceProviders,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  SWEEP_SIGN_IN_RECORDS,
  sweepSignInRecordsQueue,
  type SweepSignInRecords,
} from '@knowscroll/backend/modules/identity';
import { identitySweepProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { DATABASE, JOB_CONSUMERS, LOG_EVENT, WITH_PERSONAL_SCOPE } from './tokens.js';

/**
 * The worker's explicit consumer registry: every queue this process claims work from and the use
 * case that handles it. Nothing is discovered by decorators or scanning.
 */
export const jobWiring = [
  ...experienceEvidenceReadProviders(),
  ...contentProviders(),
  ...evidenceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
  ...identitySweepProviders({ database: DATABASE }),
  {
    provide: JOB_CONSUMERS,
    inject: [APPLY_ACTION_EVIDENCE, PROJECT_SCROLL_READING, SWEEP_SIGN_IN_RECORDS, LOG_EVENT],
    useFactory: (
      applyActionEvidence: ApplyActionEvidence,
      projectScrollReading: ProjectScrollReading,
      sweepSignInRecords: SweepSignInRecords,
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
      // Every 15 minutes (pg-boss cron, review m12): expired links and long-ended sessions.
      jobConsumer(sweepSignInRecordsQueue, async () => {
        const removed = await sweepSignInRecords();
        logEvent('identity.sign_in_records_swept', { count: removed.links + removed.sessions });
      }),
    ],
  },
];
