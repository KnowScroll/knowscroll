import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { applyActionEvidenceQueue, type ApplyActionEvidence } from '@knowscroll/backend/modules/evidence';
import { APPLY_ACTION_EVIDENCE, evidenceProviders } from '@knowscroll/backend/modules/evidence/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  SWEEP_SIGN_IN_RECORDS,
  sweepSignInRecordsQueue,
  type SweepSignInRecords,
} from '@knowscroll/backend/modules/identity';
import { identitySweepProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  PURGE_EXPIRED_REQUESTS,
  purgeExpiredRequestsQueue,
  type PurgeExpiredRequests,
} from '@knowscroll/backend/reasoning';
import { reasoningPurgeProviders } from '@knowscroll/backend/reasoning/nest-providers';
import { DATABASE, JOB_CONSUMERS, LOG_EVENT, WITH_PERSONAL_SCOPE } from './tokens.js';

/**
 * The worker's explicit consumer registry: every queue this process claims work from and the use
 * case that handles it. Nothing is discovered by decorators or scanning.
 */
export const jobWiring = [
  ...experienceEvidenceReadProviders(),
  ...evidenceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
  ...identitySweepProviders({ database: DATABASE }),
  ...reasoningPurgeProviders({ database: DATABASE, logEvent: LOG_EVENT }),
  {
    provide: JOB_CONSUMERS,
    inject: [APPLY_ACTION_EVIDENCE, SWEEP_SIGN_IN_RECORDS, PURGE_EXPIRED_REQUESTS, LOG_EVENT],
    useFactory: (
      applyActionEvidence: ApplyActionEvidence,
      sweepSignInRecords: SweepSignInRecords,
      purgeExpiredRequests: PurgeExpiredRequests,
      logEvent: LogEvent,
    ): readonly JobConsumer<unknown>[] => [
      jobConsumer(applyActionEvidenceQueue, async (payload) => {
        const result = await applyActionEvidence(payload);
        if (result.kind === 'skipped')
          logEvent('jobs.work_skipped', { queue: applyActionEvidenceQueue.name, reasonCode: result.reason });
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
    ],
  },
];
