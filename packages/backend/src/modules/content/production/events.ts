import { z } from 'zod';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../../infrastructure/config/index.js';
import {
  MAX_TAKES_PER_RECIPE,
  productionVersionOf,
  REQUEST_BOUND_ASK_ORDER,
  REQUEST_BOUND_V2_PER_TOPIC,
} from './topics.js';

/**
 * One request to produce the Scroll of a library recipe, or of an order placed from code (`order-…`).
 * IDs only: the recipe key names code-owned or stored data, so no brief, research or person is in
 * the payload. `policyVersion` is the recipe version the
 * sender knew; a worker running another version drops the job instead of producing under it. `take`
 * says which attempt at the recipe this is: 1, or the next after every earlier one was rejected.
 */
export const ProduceScrollJobSchema = z.strictObject({
  v: z.literal(1),
  recipe: z
    .string()
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    .max(64),
  policyVersion: z.string().min(1).max(64),
  take: z.number().int().min(1).max(MAX_TAKES_PER_RECIPE),
});
export type ProduceScrollJob = z.infer<typeof ProduceScrollJobSchema>;

/** Per paid request: the quota preflight (10 s) and the two personal-scope lock waits (5 s each), as the reasoning README counts them. */
const REQUEST_OVERHEAD_SECONDS = 20;

/** Time for the research fetch and the short database steps of a take, besides its model requests. */
const TAKE_MARGIN_SECONDS = 180;

/**
 * How long a delivery may hold its claim for a take that sends at most `requests` paid requests: every one of them, one
 * after the other, each running to the largest request timeout the transport accepts plus the waits around it (reasoning
 * README, "Queue settings for a job that calls `propose`"), plus a margin for the research and the database steps (D-198).
 * A shorter claim would be lost while the take was still working, and the redelivery would then wait on the same ledger.
 */
const claimSecondsFor = (requests: number): number =>
  requests * (MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000 + REQUEST_OVERHEAD_SECONDS) + TAKE_MARGIN_SECONDS;

/** A library recipe's worst case is six requests: 6 x 320 s + 180 s = 2,100 s. */
export const PRODUCE_SCROLL_CLAIM_SECONDS = claimSecondsFor(REQUEST_BOUND_V2_PER_TOPIC);

/** The answer to a question sends up to twelve requests, its support check in batches (D-267): 12 x 320 s + 180 s = 4,020 s. */
export const PRODUCE_ANSWER_CLAIM_SECONDS = claimSecondsFor(REQUEST_BOUND_ASK_ORDER);

const productionPolicy = (expireInSeconds: number) =>
  ({
    expireInSeconds,
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  }) as const;

/**
 * Shared, nonpersonal work. A take of a library recipe or of a what-if or another perspective chains up to six model requests
 * (a writer, its repair and the answer check, D-198) and also fetches research, so a claim runs as long as the worst case
 * before pg-boss treats it as lost. Retries cover an unavailable database or a lost claim; every delivery resumes the
 * same business run, and an attempt whose outcome is unknown is never resent.
 */
export const produceScrollQueue = defineQueue({
  name: 'content.produce-scroll',
  purpose: 'Produce the Scroll of one library recipe or order through research, the writer and publication.',
  payload: ProduceScrollJobSchema,
  policy: productionPolicy(PRODUCE_SCROLL_CLAIM_SECONDS),
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 2 },
  exclusive: true,
});

/**
 * The same job for the answer to a person's question (an ask order, D-218), on a queue of its own because its claim is
 * longer: the support check of the answer runs in batches, so a take may send twelve requests (D-267). Library recipes keep
 * the shorter claim of `content.produce-scroll`, so a worker that dies in the middle of one is retried sooner. The payload,
 * the singleton key and the consumer are the same.
 */
export const produceAnswerQueue = defineQueue({
  name: 'content.produce-answer',
  purpose:
    "Produce the answer to one person's question through research, the writer, the support check and publication.",
  payload: ProduceScrollJobSchema,
  policy: productionPolicy(PRODUCE_ANSWER_CLAIM_SECONDS),
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 2 },
  exclusive: true,
});

/** The job a sender enqueues for `take` of `recipe` under the current recipe version. */
export function produceScrollJob(recipe: string, take = 1): ProduceScrollJob {
  return { v: 1, recipe, policyVersion: productionVersionOf(recipe), take };
}

/**
 * The key that keeps one production job per recipe, version and take in flight (each queue is
 * `exclusive`): every sender that asks for the same take reaches that job while it is queued or
 * running, and a finished or failed one never blocks a new send, which resumes the same business run.
 */
export function produceScrollSingletonKey(job: ProduceScrollJob): string {
  return `${job.recipe}:${job.policyVersion}:${job.take}`;
}
