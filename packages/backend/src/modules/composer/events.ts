import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/**
 * Prepare the next vertical buffer for one activated offer. IDs only: the worker rechecks the
 * epoch, the session's intent revision and that the offer was really activated before it reads
 * or ranks anything, so a late or duplicate delivery changes nothing.
 */
export const PrepareBufferJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  sessionId: z.uuid(),
  intentRevision: z.number().int().min(0),
  sourceOfferId: z.uuid(),
  sourceExposureId: z.uuid(),
});
export type PrepareBufferJob = z.infer<typeof PrepareBufferJobSchema>;

export const prepareBufferQueue = defineQueue({
  name: 'composer.prepare-buffer',
  purpose: 'Rank and store the next vertical offers for an activated encounter, with optional Jev assessments.',
  payload: PrepareBufferJobSchema,
  policy: {
    // Two attempts at the largest configurable provider deadline (300 s) plus quota and lock waits
    // (reasoning/README: 2 x (10 + 300 + 10) + 30), rounded up.
    expireInSeconds: 700,
    retryLimit: 2,
    retryDelaySeconds: 20,
    retryBackoff: true,
    // A buffer older than its lifetime is useless, so stale jobs expire instead of waiting.
    retentionSeconds: 15 * 60,
    deleteAfterSeconds: 60 * 60,
    deadLetter: false,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});
