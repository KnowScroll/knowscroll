import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/**
 * Payload of `evidence.apply-action`: schema version and IDs only (blueprint §19). The job reads
 * the action itself, so an erased action is never resurrected from a queue payload.
 */
export const ApplyActionEvidencePayloadSchema = z.object({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().min(1),
  actionId: z.uuid(),
});

export type ApplyActionEvidencePayload = z.infer<typeof ApplyActionEvidencePayloadSchema>;

/**
 * Records an accepted explicit action as evidence, advances the universe revision and hints
 * subscribers. Enqueued in the same transaction as the action; idempotent per action.
 */
export const applyActionEvidenceQueue = defineQueue({
  name: 'evidence.apply-action',
  purpose: 'Record an accepted save/unsave as an evidence action event and hint the universe scope.',
  payload: ApplyActionEvidencePayloadSchema,
  policy: {
    expireInSeconds: 60,
    retryLimit: 8,
    retryDelaySeconds: 2,
    retryBackoff: true,
    retentionSeconds: 7 * 24 * 60 * 60,
    deleteAfterSeconds: 2 * 24 * 60 * 60,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});
