import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** Payload of the scheduled pass: nothing to name, it finds the work itself. */
export const WatchdogJobSchema = z.strictObject({ v: z.literal(1) });

/**
 * Every hour: evaluates the code-only health rules over `ops.watchdog` and logs an alert for each that fires
 * (D-411). Reads only, repairs nothing, names no person. Safe to run late or twice.
 */
export const watchdogQueue = defineQueue({
  name: 'operator.watchdog',
  purpose: 'Evaluate the hourly code-only health rules and log an alert for each that fires; reads only, no repair.',
  payload: WatchdogJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86400,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '7 * * * *', payload: { v: 1 } },
});
