import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
/** IDs only: neither private asks/context nor canonical production bytes are queue payloads. */
export const ResolveSupplyJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  requestId: z.uuid(),
});
export type ResolveSupplyJob = z.infer<typeof ResolveSupplyJobSchema>;
export const resolveSupplyQueue = defineQueue({
  name: 'supply.resolve-request',
  purpose:
    'Advance one private waiter: match a free-text ask to the catalogue, wait for the production that serves it, then bind admitted content or close the request.',
  payload: ResolveSupplyJobSchema,
  policy: {
    expireInSeconds: 360,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  // A free-text match waits on a model call, so several waiters advance at once.
  consumer: { localConcurrency: 4, pollingIntervalSeconds: 1 },
});
