import { z } from 'zod';
import { defineQueue, queueRegistry } from '@knowscroll/backend/infrastructure/jobs';

/** A queue that exists only in the integration template, labelled as a test fixture. */
export const fixtureQueue = defineQueue({
  name: 'fixture.slow-task',
  purpose: 'CI fixture: exercises consumer registration and graceful drain.',
  payload: z.object({ v: z.literal(1), taskId: z.string(), holdMs: z.number().int().min(0).max(10_000) }),
  policy: {
    expireInSeconds: 60,
    retryLimit: 1,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retentionSeconds: 3_600,
    deleteAfterSeconds: 3_600,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
});

/** Queues the template database declares, in addition to the release's own (none yet). */
export const testQueues = queueRegistry([fixtureQueue]);
