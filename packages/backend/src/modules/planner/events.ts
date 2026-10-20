import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
export const PlannerJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  runId: z.uuid(),
});
export const plannerQueue = defineQueue({
  name: 'planner.run',
  purpose: 'Prepare and validate one bounded personal exploration plan; never commission supply.',
  payload: PlannerJobSchema,
  // Covers two attempts at max300s transport +10s quota +2×60s scope lock, plus two application-scope waits and margin.
  policy: {
    expireInSeconds: 1200,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});
