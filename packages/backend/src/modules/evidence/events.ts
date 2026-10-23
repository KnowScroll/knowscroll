import { z } from 'zod';
import { RecordingGenerationSchema } from '@knowscroll/contracts';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

/**
 * Payload of `evidence.apply-action`: schema version and IDs only (blueprint §19). The job reads
 * the action itself, so an erased action is never resurrected from a queue payload.
 */
export const ApplyActionEvidencePayloadSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    recordingGeneration: RecordingGenerationSchema.optional(),
    universeId: z.uuid(),
    privacyEpoch: z.number().int().min(1),
    actionId: z.uuid(),
  })
  .refine(originalJobGeneration);

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

/**
 * Payload of `evidence.project-scroll-reading`: schema version and IDs only (blueprint §19). The job
 * reads the exposure's observations itself, so erased observations are never resurrected from a
 * queue payload.
 */
export const ProjectScrollReadingPayloadSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    recordingGeneration: RecordingGenerationSchema.optional(),
    universeId: z.uuid(),
    privacyEpoch: z.number().int().min(1),
    exposureId: z.uuid(),
  })
  .refine(originalJobGeneration);

export type ProjectScrollReadingPayload = z.infer<typeof ProjectScrollReadingPayloadSchema>;

/**
 * Projects one exposure's observations into its reading summary and qualification, and commits an
 * evidence revision. Enqueued in the same transaction as the observations it follows (pg-boss is the
 * only outbox); idempotent per (exposure, input watermark, policy version), so a redelivery, or two
 * jobs for one watermark, store one revision. The job always projects the exposure's *current*
 * watermark, so a job that runs late still reflects every observation committed before it.
 */
export const projectScrollReadingQueue = defineQueue({
  name: 'evidence.project-scroll-reading',
  purpose: "Project an exposure's Scroll observations into a reading summary and an evidence revision.",
  payload: ProjectScrollReadingPayloadSchema,
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

/** Latest-state activity projection: IDs only; never copied observations or action claims. */
export const projectEncounterActivityQueue = defineQueue({
  name: 'evidence.project-encounter-activity',
  purpose: 'Project actual encounter qualification/action/navigation lineage into bounded routing context.',
  payload: ProjectScrollReadingPayloadSchema,
  policy: {
    expireInSeconds: 60,
    retryLimit: 8,
    retryDelaySeconds: 2,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});

/** Preserve the object shape required by erasure inventory. No legacy generation stripping. */
function originalJobGeneration(value: { readonly v: 1 | 2; readonly recordingGeneration?: number }): boolean {
  return value.v === 1 ? !Object.hasOwn(value, 'recordingGeneration') : value.recordingGeneration !== undefined;
}
