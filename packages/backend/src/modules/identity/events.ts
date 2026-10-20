import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** Payload of `identity.sweep-sign-in-records`: a schema version only; the sweep reads what is due. */
export const SweepSignInRecordsPayloadSchema = z.object({ v: z.literal(1) });

export type SweepSignInRecordsPayload = z.infer<typeof SweepSignInRecordsPayloadSchema>;

/**
 * The identity sweep (review m12): every 15 minutes the worker deletes sign-in links a day after
 * they expired (an unredeemed link holds an address, which is personal data) and sessions 30 days
 * after they ended, in small batches that skip rows another transaction holds. Nothing in the
 * request path deletes them. Safe to run late, twice or concurrently.
 */
export const sweepSignInRecordsQueue = defineQueue({
  name: 'identity.sweep-sign-in-records',
  purpose: 'Delete expired sign-in links and long-ended sessions (identity retention).',
  payload: SweepSignInRecordsPayloadSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '*/15 * * * *', payload: { v: 1 } },
});
