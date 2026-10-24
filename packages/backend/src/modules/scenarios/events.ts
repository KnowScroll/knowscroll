import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** IDs only: neither the member's words nor the thread's messages are queue payloads. */
export const SuggestDraftJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  draftId: z.uuid(),
});
export type SuggestDraftJob = z.infer<typeof SuggestDraftJobSchema>;

/**
 * One bounded model step for one draft. It waits on the provider, so a delivery may run as long as
 * a primary and a repair attempt can (the reasoning README gives 670 s at the largest request
 * deadline). The run is the draft's ID: a redelivery answers from the ledger and never pays twice.
 */
export const suggestDraftQueue = defineQueue({
  name: 'scenarios.suggest-draft',
  purpose:
    "Ask the Scenario Planner for a few directions for one member's request and store them on the draft; commissions nothing.",
  payload: SuggestDraftJobSchema,
  policy: {
    expireInSeconds: 670,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 4, pollingIntervalSeconds: 1 },
});

export const ResolveBranchesJobSchema = z.strictObject({ v: z.literal(1) });
export type ResolveBranchesJob = z.infer<typeof ResolveBranchesJobSchema>;

/**
 * Every minute: binds each preparing branch to its admitted Scroll, sends the next take of a
 * rejected one, and closes the branches that cannot be prepared. Idempotent and safe to run late,
 * twice or concurrently: it works on rows another transaction holds only after they are free.
 */
export const resolveBranchesQueue = defineQueue({
  name: 'scenarios.resolve-branches',
  purpose:
    'Bind preparing branches to their admitted Scrolls, retry rejected takes and close branches that cannot be prepared.',
  payload: ResolveBranchesJobSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: false,
    retentionSeconds: 60 * 60,
    deleteAfterSeconds: 60 * 60,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 10 },
  schedule: { cron: '* * * * *', payload: { v: 1 } },
});
