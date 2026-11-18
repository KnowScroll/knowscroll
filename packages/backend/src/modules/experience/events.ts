import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** Payload of the scheduled cover-outcome prune: nothing to name, it finds the work itself. */
export const PruneCoverOutcomesJobSchema = z.strictObject({ v: z.literal(1) });

/**
 * Every thirty minutes (a different minute from Composer's decision prune): deletes `experience.cover_outcomes` rows past
 * their 30-day life, a bounded batch for each of a bounded number of universes (`application/prune-cover-outcomes.ts`). Names
 * no person. Safe to run late or twice: a second pass finds nothing left to delete.
 */
export const pruneCoverOutcomesQueue = defineQueue({
  name: 'experience.prune-cover-outcomes',
  purpose: 'Physically delete expired cover outcomes in bounded batches; no model.',
  payload: PruneCoverOutcomesJobSchema,
  policy: {
    expireInSeconds: 600,
    retryLimit: 1,
    retryDelaySeconds: 120,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86_400,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 60 },
  schedule: { cron: '22,52 * * * *', payload: { v: 1 } },
});
