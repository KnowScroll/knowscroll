import { z } from 'zod';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';
import { SCROLL_PRODUCTION_VERSION } from './topics.js';

/**
 * One request to produce the Scroll of a library recipe. IDs only: the recipe key names code-owned
 * data, so no brief, research or person is in the payload. `policyVersion` is the recipe version the
 * sender knew; a worker running another version drops the job instead of producing under it.
 */
export const ProduceScrollJobSchema = z.strictObject({
  v: z.literal(1),
  recipe: z
    .string()
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    .max(64),
  policyVersion: z.string().min(1).max(64),
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
  purpose: 'Produce the Scroll of one library recipe through research, the writer and publication.',
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

/** The job a sender enqueues for `recipe` under the current recipe version. */
export function produceScrollJob(recipe: string): ProduceScrollJob {
  return { v: 1, recipe, policyVersion: SCROLL_PRODUCTION_VERSION };
}

/**
 * The key that keeps one production job per recipe and version in flight (the queue is `exclusive`):
 * every sender that asks for the same Scroll reaches that job while it is queued or running, and a
 * finished or failed one never blocks a new send, which resumes the same business run.
 */
export function produceScrollSingletonKey(job: ProduceScrollJob): string {
  return `${job.recipe}:${job.policyVersion}`;
}
