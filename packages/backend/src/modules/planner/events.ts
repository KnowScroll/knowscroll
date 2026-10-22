import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
const Shared = z.object({
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  runId: z.uuid(),
  expectedClaimId: z.uuid().optional(),
});
export const PlannerJobSchema = Shared.extend({
  v: z.union([z.literal(1), z.literal(2)]),
  wakeId: z.uuid().optional(),
  recordingGeneration: z.number().int().min(1).max(2147483647).optional(),
})
  .strict()
  .superRefine((x, c) => {
    if (
      (x.v === 1 && (Object.hasOwn(x, 'recordingGeneration') || Object.hasOwn(x, 'wakeId'))) ||
      (x.v === 2 &&
        (x.recordingGeneration === undefined ||
          (x.expectedClaimId === undefined ? x.wakeId === undefined : Object.hasOwn(x, 'wakeId'))))
    )
      c.addIssue({ code: 'custom', message: 'Exact original recording generation required' });
  });
export type PlannerJob = z.infer<typeof PlannerJobSchema>;
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
