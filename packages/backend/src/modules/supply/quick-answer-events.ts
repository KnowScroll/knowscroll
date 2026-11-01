import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** IDs only: neither the words a person selected nor their question is a queue payload. */
export const AnswerQuickAnswerJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  quickAnswerId: z.uuid(),
});
export type AnswerQuickAnswerJobPayload = z.infer<typeof AnswerQuickAnswerJobSchema>;

/**
 * Writes one Quick answer (D-253). The wait limit is three minutes, so a delivery that expires after four never produces an
 * answer anybody sees; one retry covers a worker that stopped mid-call (the run is the answer's ID, so a redelivery never
 * pays twice).
 */
export const answerQuickAnswerQueue = defineQueue({
  name: 'supply.answer-quick-answer',
  purpose: 'Write one Quick answer about words a person selected in a Scroll, through the personal reasoning harness.',
  payload: AnswerQuickAnswerJobSchema,
  policy: {
    expireInSeconds: 240,
    retryLimit: 1,
    retryDelaySeconds: 10,
    retryBackoff: false,
    retentionSeconds: 86_400,
    deleteAfterSeconds: 86_400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 4, pollingIntervalSeconds: 1 },
});

/** Payload of `supply.purge-quick-answers`: a schema version only; the purge reads what is due. */
export const PurgeQuickAnswersPayloadSchema = z.object({ v: z.literal(1) });

/**
 * Erases the Quick answers whose day is over (D-253). Every row is kept for a day (migration 0092) and must not outlive
 * it, so expiry cannot wait for traffic: it runs every ten minutes in small batches that skip rows another transaction
 * holds. Safe to run late, twice or concurrently.
 */
export const purgeQuickAnswersQueue = defineQueue({
  name: 'supply.purge-quick-answers',
  purpose: 'Delete the Quick answers whose day is over, so no question or answer is kept longer than a day.',
  payload: PurgeQuickAnswersPayloadSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86_400,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 60 },
  schedule: { cron: '*/10 * * * *', payload: { v: 1 } },
});
