import { z } from 'zod';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';

/** The payload of the release step: its version only. It names no revision: which Scrolls the policy may release is read from the rows. */
export const SweepReleasePolicyJobSchema = z.strictObject({ v: z.literal(1) });

/**
 * Every ten minutes: releases a held library Scroll that the release policy allows (#674, D-418), a bounded number a pass and never above the
 * day's cap. Shared content only; no model and no network. Switched off in every world until the owner sets `KS_CONTENT_AUTO_RELEASE_ENABLED=1`:
 * a worker with the switch off takes the job and finishes it having read nothing. Safe to run late or twice: every release is one transaction
 * under the asset's lock and the cap is counted under a lock of its own.
 */
export const sweepReleasePolicyQueue = defineQueue({
  name: 'content.sweep-release-policy',
  purpose:
    'Release held library Scrolls the release policy allows (an approved topic, a passed support check, nothing sensitive, within the daily cap); off until switched on.',
  payload: SweepReleasePolicyJobSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86400,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '*/10 * * * *', payload: { v: 1 } },
});
