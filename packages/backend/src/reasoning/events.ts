import { z } from 'zod';
import { defineQueue } from '../infrastructure/jobs/queues.js';

/** Payload of `reasoning.purge-expired-requests`: a schema version only; the purge reads what is due. */
export const PurgeExpiredRequestsPayloadSchema = z.object({ v: z.literal(1) });

export type PurgeExpiredRequestsPayload = z.infer<typeof PurgeExpiredRequestsPayloadSchema>;

/**
 * The protected-request expiry (blueprint §15): every 15 minutes the worker deletes the request
 * bytes of attempts whose retention ended, in small batches that skip rows another transaction
 * holds. The bytes are personal context, so expiry must not depend on new model traffic arriving;
 * the harness also purges opportunistically and an operator can purge on demand. The attempt, its
 * request hash and its usage receipt stay. Safe to run late, twice or concurrently.
 */
export const purgeExpiredRequestsQueue = defineQueue({
  name: 'reasoning.purge-expired-requests',
  purpose: 'Delete protected request bytes whose retention ended (reasoning retention).',
  payload: PurgeExpiredRequestsPayloadSchema,
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

/** Payload of `reasoning.sweep-dispatched-attempts`: a schema version only; the sweep reads what is due. */
export const SweepDispatchedAttemptsPayloadSchema = z.object({ v: z.literal(1) });

export type SweepDispatchedAttemptsPayload = z.infer<typeof SweepDispatchedAttemptsPayloadSchema>;

/**
 * The crash-recovery sweep (blueprint §15): every 5 minutes the worker moves attempts that have
 * been `dispatched` for longer than the provider request deadline plus a margin to `unknown`. A
 * crash after dispatch leaves such an attempt, and until a later delivery of the same step found
 * it nothing could see it: not the operator's `reasoning unknown`, not the write-off, and the
 * universe's erasure waited on it for ever. The sweep never resends anything and a late answer
 * still settles the attempt as `reconciled`. The same sweep closes personal runs a role left
 * `admitted` that have had no activity for hours and have no live attempt, so a run that ended
 * without being closed does not stay open for ever. Safe to run late, twice or concurrently.
 */
export const sweepDispatchedAttemptsQueue = defineQueue({
  name: 'reasoning.sweep-dispatched-attempts',
  purpose: 'Move attempts left dispatched past the request deadline to unknown (crash recovery).',
  payload: SweepDispatchedAttemptsPayloadSchema,
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
  schedule: { cron: '*/5 * * * *', payload: { v: 1 } },
});
