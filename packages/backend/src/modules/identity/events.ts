import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/** Payload of `identity.sweep-sign-in-records`: a schema version only; the sweep reads what is due. */
export const SweepSignInRecordsPayloadSchema = z.object({ v: z.literal(1) });

export type SweepSignInRecordsPayload = z.infer<typeof SweepSignInRecordsPayloadSchema>;

/**
 * The identity sweep (review m12): every 15 minutes the worker deletes sign-in links a day after
 * they expired (an unredeemed link holds an address, which is personal data) and sessions 30 days
 * after they ended, in small batches that skip rows another transaction holds. Nothing in the
 * request path deletes them. Safe to run late, twice or concurrently.
 */
export const sweepSignInRecordsQueue = defineQueue({
  name: 'identity.sweep-sign-in-records',
  purpose: 'Delete expired sign-in links and long-ended sessions (identity retention).',
  payload: SweepSignInRecordsPayloadSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
    deadLetter: false,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '*/15 * * * *', payload: { v: 1 } },
});

/** Opt-in only: the normal release registry does not install or consume this queue. */
export const ClearExplorationJobSchema = z.strictObject({ v: z.literal(1), accountId: z.uuid(), commandId: z.uuid() });
export type ClearExplorationJob = z.infer<typeof ClearExplorationJobSchema>;
export const clearExplorationQueue = defineQueue({
  name: 'identity.clear-exploration',
  purpose: 'Complete an existing account-owned Clear operation; no paid work.',
  payload: ClearExplorationJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retentionSeconds: 604800,
    deleteAfterSeconds: 172800,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 2 },
});

/** Fixed cron or a strictly advancing finite-pass continuation; neither selects user effects. */
export const ClearRecoveryJobSchema = z.union([
  z.strictObject({ v: z.literal(1) }),
  z.strictObject({
    v: z.literal(1),
    cursor: z
      .strictObject({ afterOperationId: z.uuid(), throughOperationId: z.uuid() })
      .refine((cursor) => cursor.afterOperationId < cursor.throughOperationId),
  }),
]);
export type ClearRecoveryJob = z.infer<typeof ClearRecoveryJobSchema>;
export const recoverClearOperationsQueue = defineQueue({
  name: 'identity.recover-clear-operations',
  purpose: 'Recover bounded missing Clear deliveries and due exact-set accounting cleanup.',
  payload: ClearRecoveryJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '*/5 * * * *', payload: { v: 1 } },
});

/** Payload of `identity.delete-account`: the deletion's id, which is also its receipt. */
export const DeleteAccountJobSchema = z.strictObject({ v: z.literal(1), deletionId: z.uuid() });
export type DeleteAccountJob = z.infer<typeof DeleteAccountJobSchema>;

/**
 * Erases an accepted account deletion (D-043). Enqueued in the transaction that fences the
 * account. The payload names the operation, never the person; the operation row loses its account
 * link when the work completes, so a retained job (up to a week, two weeks if dead-lettered)
 * names nothing. Idempotent: a second delivery after completion finds nothing to do.
 */
export const deleteAccountQueue = defineQueue({
  name: 'identity.delete-account',
  purpose: 'Erase one account across every registered store; no paid work.',
  payload: DeleteAccountJobSchema,
  policy: {
    expireInSeconds: 300,
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retentionSeconds: 7 * 24 * 60 * 60,
    deleteAfterSeconds: 2 * 24 * 60 * 60,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 2 },
});

/**
 * Every five minutes: hands back to `identity.delete-account` any deletion still pending after its
 * `next_attempt_at` (a lost or exhausted job, or accounting that has since settled). At most 25 per
 * pass, each pushed fifteen minutes out. Safe to run late or twice.
 */
export const recoverAccountDeletionsQueue = defineQueue({
  name: 'identity.recover-account-deletions',
  purpose: 'Re-enqueue account deletions that are still pending and due.',
  payload: SweepSignInRecordsPayloadSchema,
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
  schedule: { cron: '*/5 * * * *', payload: { v: 1 } },
});

/** Payload of `identity.build-export`: the export's id. */
export const BuildDataExportJobSchema = z.strictObject({ v: z.literal(1), exportId: z.uuid() });
export type BuildDataExportJob = z.infer<typeof BuildDataExportJobSchema>;

/**
 * Builds one person's export from every module's `export.read` inside their locked personal
 * scope and stores the file on the export row. Enqueued in the request's transaction. A retry
 * rebuilds from scratch; the final failure marks the export failed so Account shows Retry.
 */
export const buildDataExportQueue = defineQueue({
  name: 'identity.build-export',
  purpose: 'Build one personal data export file.',
  payload: BuildDataExportJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retentionSeconds: 24 * 60 * 60,
    deleteAfterSeconds: 24 * 60 * 60,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 2 },
});
