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
  purpose: 'Resolve one private waiter against current admitted inventory; no provider dispatch.',
  payload: ResolveSupplyJobSchema,
  policy: {
    expireInSeconds: 180,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});
