import { z } from 'zod';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../infrastructure/config/index.js';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
import { MAX_PAID_ATTEMPTS } from './domain/quick-answer.js';

/** IDs only: neither the words a person selected nor their question is a queue payload. */
export const AnswerQuickAnswerJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  quickAnswerId: z.uuid(),
});
export type AnswerQuickAnswerJobPayload = z.infer<typeof AnswerQuickAnswerJobSchema>;

/** Per paid attempt: the quota preflight (10 s) and the two personal-scope lock waits (5 s each), as the reasoning README counts them. */
const ATTEMPT_OVERHEAD_SECONDS = 20;
/** What a delivery needs beyond its attempts: the reads before the call and the settle after it. */
const DELIVERY_MARGIN_SECONDS = 30;

/**
 * The seconds a delivery may hold its claim: every paid attempt at the largest request deadline the provider adapter allows
 * (300 s, whatever `KS_MINIMAX_REQUEST_TIMEOUT_MS` is), plus the waits around it, plus a margin (reasoning README, "Queue
 * settings for a job that calls `propose`"). Below it pg-boss would expire a delivery that is still waiting on the provider,
 * and the next delivery would find the attempt `dispatched` and write it off as unknown.
 */
export const ANSWER_QUICK_ANSWER_CLAIM_SECONDS =
  MAX_PAID_ATTEMPTS * (MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000 + ATTEMPT_OVERHEAD_SECONDS) + DELIVERY_MARGIN_SECONDS;

/**
 * Writes one Quick answer (D-253). The claim covers every paid attempt of a delivery, so it is far longer than the wait the
 * person is given (`QUICK_ANSWER_WAIT_LIMIT_MS`): a late answer is dropped when it arrives, never shown. One retry covers a
 * worker that stopped mid-call: the run is the answer's ID, so a redelivery answers from the ledger and never pays twice.
 */
export const answerQuickAnswerQueue = defineQueue({
  name: 'supply.answer-quick-answer',
  purpose: 'Write one Quick answer about words a person selected in a Scroll, through the personal reasoning harness.',
  payload: AnswerQuickAnswerJobSchema,
  policy: {
    expireInSeconds: ANSWER_QUICK_ANSWER_CLAIM_SECONDS,
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
