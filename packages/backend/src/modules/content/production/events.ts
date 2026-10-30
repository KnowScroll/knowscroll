import { z } from 'zod';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';
import { MAX_TAKES_PER_RECIPE, productionVersionOf } from './topics.js';

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

/**
 * Shared, nonpersonal work. A writer call takes up to a couple of minutes and the job also fetches
 * research, so a claim may run 15 minutes before pg-boss treats it as lost. Retries cover an
 * unavailable database or a lost claim; every delivery resumes the same business run, and an attempt
 * whose outcome is unknown is never resent.
 */
export const produceScrollQueue = defineQueue({
  name: 'content.produce-scroll',
  purpose: 'Produce the Scroll of one library recipe or order through research, the writer and publication.',
  payload: ProduceScrollJobSchema,
  policy: {
    expireInSeconds: 900,
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
