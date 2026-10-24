import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/**
 * One member's ask of an AI inhabitant. IDs only: the worker rechecks the asker's universe and epoch,
 * that they are still a member of an open room and that the ask is still queued before it reads the
 * discussion, so a late or duplicate delivery changes nothing.
 */
export const ContributeJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  requestId: z.uuid(),
});
export type ContributeJob = z.infer<typeof ContributeJobSchema>;

export const contributeQueue = defineQueue({
  name: 'rooms.contribute',
  purpose: 'Let one labelled AI inhabitant answer a member who asked, within the room and daily bounds.',
  payload: ContributeJobSchema,
  policy: {
    // Two attempts at the largest configurable provider deadline (300 s) plus quota and lock waits
    // (reasoning/README: 2 x (10 + 300 + 10) + 30), rounded up.
    expireInSeconds: 700,
    retryLimit: 2,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});
