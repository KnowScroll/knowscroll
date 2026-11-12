import { z } from 'zod';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';
import { claimSecondsFor, productionPolicy } from './events.js';
import { LIBRARY_SUPPORT_CHECK_VERSION, LIBRARY_SUPPORT_REQUEST_BOUND } from './library-support.js';

/**
 * One request to check the sentences of one stored library Scroll revision (D-415). IDs only: the revision names stored,
 * shared content, so no sentence, passage or person is in the payload. `checkerVersion` is the version the sender knew; a worker
 * running another version drops the job instead of checking under it.
 */
export const CheckLibrarySupportJobSchema = z.strictObject({
  v: z.literal(1),
  assetId: z.uuid(),
  revision: z.number().int().min(1).max(1_000_000),
  checkerVersion: z.string().min(1).max(64),
});
export type CheckLibrarySupportJob = z.infer<typeof CheckLibrarySupportJobSchema>;

/**
 * A check of a revision sends up to eleven requests, one for each batch and one more for the harness's repair of an unusable reply,
 * and each may run to the largest request timeout the transport accepts plus the waits around it (reasoning README, "Queue settings
 * for a job that calls `propose`"): 11 x 320 s + 180 s = 3,700 s. A shorter claim would be lost while the check was still working.
 */
export const CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS = claimSecondsFor(LIBRARY_SUPPORT_REQUEST_BOUND);

/**
 * Shared, nonpersonal, background work. Paid attempts consult the ledger on every delivery, so a retry after a lost claim asks the
 * ledger for the answers it holds and an attempt of unknown outcome is never resent. One job for a revision and checker version at a time.
 */
export const checkLibrarySupportQueue = defineQueue({
  name: 'content.check-library-support',
  purpose:
    'Check the sentences of one stored library Scroll revision against the passages it cites; informs review, decides nothing.',
  payload: CheckLibrarySupportJobSchema,
  policy: productionPolicy(CHECK_LIBRARY_SUPPORT_CLAIM_SECONDS),
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 5 },
  exclusive: true,
});

/** The key that keeps one check per revision and checker version in flight: every sender that asks for the same check reaches that job. */
export const checkLibrarySupportSingletonKey = (job: CheckLibrarySupportJob): string =>
  `${job.assetId}:${String(job.revision)}:${job.checkerVersion}`;

/** The job a sender enqueues for a revision under the current checker version. */
export const checkLibrarySupportJob = (assetId: string, revision: number): CheckLibrarySupportJob => ({
  v: 1,
  assetId,
  revision,
  checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
});

/** The payload of the sweep: its version only. It names no revision: which ones are due is read from the rows. */
export const SweepLibrarySupportJobSchema = z.strictObject({ v: z.literal(1) });

/**
 * Every ten minutes: hands each held revision that has no result of the current checker version (and each whose check ended on a
 * provider failure an hour ago) to `content.check-library-support`, a bounded number a pass. This is how a revision a direct operator
 * run held, a check a spent budget paused and a revision held before the check existed get theirs. Names no revision; safe to run late
 * or twice, because the check queue holds one job per revision and version.
 */
export const sweepLibrarySupportQueue = defineQueue({
  name: 'content.sweep-library-support',
  purpose: 'Find held library Scroll revisions with no support check and enqueue one check job for each; no model.',
  payload: SweepLibrarySupportJobSchema,
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
  schedule: { cron: '*/10 * * * *', payload: { v: 1 } },
});
