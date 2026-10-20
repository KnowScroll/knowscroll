import { z } from 'zod';
import { defineQueue } from '../infrastructure/jobs/queues.js';

/** Payload of `reasoning.purge-expired-requests`: a schema version only; the purge reads what is due. */
export const PurgeExpiredRequestsPayloadSchema = z.object({ v: z.literal(1) });

export type PurgeExpiredRequestsPayload = z.infer<typeof PurgeExpiredRequestsPayloadSchema>;

/**
 * The protected-request expiry (blueprint §15): every 15 minutes the worker deletes the request
 * bytes of attempts whose retention ended, in small batches that skip rows another transaction
 * holds. The bytes are personal context, so expiry must not depend on new model traffic arriving;
 * the harness also purges opportunistically and an operator can purge on demand. The attempt, its
 * request hash and its usage receipt stay. Safe to run late, twice or concurrently.
 */
export const purgeExpiredRequestsQueue = defineQueue({
  name: 'reasoning.purge-expired-requests',
  purpose: 'Delete protected request bytes whose retention ended (reasoning retention).',
  payload: PurgeExpiredRequestsPayloadSchema,
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
