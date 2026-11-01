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

/** The most paid requests any take sends: a v2 library recipe's, or the answer to a question with its support check (D-267). */
const WORST_CASE_REQUESTS = Math.max(REQUEST_BOUND_V2_PER_TOPIC, REQUEST_BOUND_ASK_ORDER);

/**
 * How long a delivery may hold its claim: a take's worst case, which is every request it may send, one after the other,
 * each running to the largest request timeout the transport accepts plus the waits around it (reasoning README, "Queue
 * settings for a job that calls `propose`"), plus a margin for the research and the database steps (D-198). The most is
 * the answer to a question: twelve requests at 300 s and 20 s of waits, and 180 s of margin, 4,020 s. A shorter claim would
 * be lost while the take was still working, and the redelivery would then wait on the same ledger.
 */
export const PRODUCE_SCROLL_CLAIM_SECONDS =
  WORST_CASE_REQUESTS * (MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000 + REQUEST_OVERHEAD_SECONDS) + TAKE_MARGIN_SECONDS;

/**
 * Shared, nonpersonal work. A take chains up to twelve model requests (a writer, its repair and the support check of
 * an answer in batches, D-198, D-267) and also fetches research, so a claim runs as long as the worst case before pg-boss
 * treats it as lost. Retries cover an unavailable database or a lost claim; every delivery resumes the
 * same business run, and an attempt whose outcome is unknown is never resent.
 */
export const produceScrollQueue = defineQueue({
  name: 'content.produce-scroll',
  purpose: 'Produce the Scroll of one library recipe or order through research, the writer and publication.',
  payload: ProduceScrollJobSchema,
  policy: {
    expireInSeconds: PRODUCE_SCROLL_CLAIM_SECONDS,
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 2 },
  exclusive: true,
});

/** The job a sender enqueues for `take` of `recipe` under the current recipe version. */
export function produceScrollJob(recipe: string, take = 1): ProduceScrollJob {
  return { v: 1, recipe, policyVersion: productionVersionOf(recipe), take };
}

/**
 * The key that keeps one production job per recipe, version and take in flight (the queue is
 * `exclusive`): every sender that asks for the same take reaches that job while it is queued or
 * running, and a finished or failed one never blocks a new send, which resumes the same business run.
 */
export function produceScrollSingletonKey(job: ProduceScrollJob): string {
  return `${job.recipe}:${job.policyVersion}:${job.take}`;
}
