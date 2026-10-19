import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { applyActionEvidenceQueue, type ApplyActionEvidence } from '@knowscroll/backend/modules/evidence';
import { APPLY_ACTION_EVIDENCE, evidenceProviders } from '@knowscroll/backend/modules/evidence/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { JOB_CONSUMERS, LOG_EVENT, WITH_PERSONAL_SCOPE } from './tokens.js';

/**
 * The worker's explicit consumer registry: every queue this process claims work from and the use
 * case that handles it. Nothing is discovered by decorators or scanning.
 */
export const jobWiring = [
  ...experienceEvidenceReadProviders(),
  ...evidenceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
  {
    provide: JOB_CONSUMERS,
    inject: [APPLY_ACTION_EVIDENCE, LOG_EVENT],
    useFactory: (applyActionEvidence: ApplyActionEvidence, logEvent: LogEvent): readonly JobConsumer<unknown>[] => [
      jobConsumer(applyActionEvidenceQueue, async (payload) => {
        const result = await applyActionEvidence(payload);
        if (result.kind === 'skipped')
          logEvent('jobs.work_skipped', { queue: applyActionEvidenceQueue.name, reasonCode: result.reason });
      }),
    ],
  },
];
