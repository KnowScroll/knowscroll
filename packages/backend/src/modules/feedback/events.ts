import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** Payload of `feedback.purge-reports`: a schema version only; the purge reads what is due. */
export const PurgeReportsPayloadSchema = z.object({ v: z.literal(1) });

export type PurgeReportsPayload = z.infer<typeof PurgeReportsPayloadSchema>;

/**
 * The report retention (D-055): once a day the worker deletes the reports about an account that was
 * deleted, 90 days after that deletion, in small batches that skip rows another transaction holds. The
 * reports outlive their subject on purpose and must not outlive the need, so expiry cannot wait for
 * traffic. Safe to run late, twice or concurrently.
 */
export const purgeReportsQueue = defineQueue({
  name: 'feedback.purge-reports',
  purpose: 'Delete reports about deleted accounts once their 90 days are over (feedback retention).',
  payload: PurgeReportsPayloadSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelaySeconds: 300,
    retryBackoff: false,
    retentionSeconds: 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 60 },
  schedule: { cron: '17 3 * * *', payload: { v: 1 } },
});
