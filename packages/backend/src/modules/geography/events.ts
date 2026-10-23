import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
const Scope = { v: z.literal(1), universeId: z.uuid(), privacyEpoch: z.number().int().positive() };
export const CartographyJobSchema = z
  .strictObject({
    v: z.union([z.literal(1), z.literal(2)]),
    universeId: z.uuid(),
    privacyEpoch: z.number().int().positive(),
    runId: z.uuid(),
    kind: z.literal('retire').optional(),
    recordingGeneration: z.number().int().min(1).max(2147483647).nullable().optional(),
    wakeId: z.uuid().optional(),
    expectedClaimId: z.uuid().optional(),
  })
  .superRefine((r, c) => {
    const own = (k: 'kind' | 'recordingGeneration' | 'wakeId' | 'expectedClaimId') => Object.hasOwn(r, k);
    const invalid =
      r.v === 1
        ? own('kind') ||
          own('recordingGeneration') ||
          own('wakeId') ||
          (own('expectedClaimId') && r.expectedClaimId === undefined)
        : r.kind === 'retire'
          ? r.recordingGeneration === undefined ||
            (r.recordingGeneration !== null && r.recordingGeneration % 2 !== 1) ||
            !r.wakeId ||
            own('expectedClaimId')
          : own('kind') ||
            r.recordingGeneration === null ||
            r.recordingGeneration === undefined ||
            r.recordingGeneration % 2 !== 1 ||
            own('wakeId') === own('expectedClaimId') ||
            (own('wakeId') && r.wakeId === undefined) ||
            (own('expectedClaimId') && r.expectedClaimId === undefined);
    if (invalid) c.addIssue({ code: 'custom', message: 'Invalid original recording wake' });
  });
export const PublishDeltaJobSchema = z.strictObject({
  ...Scope,
  transitionId: z.uuid(),
  geographyRevision: z.number().int().positive(),
});
export type CartographyJob = z.infer<typeof CartographyJobSchema>;
export type PublishDeltaJob = z.infer<typeof PublishDeltaJobSchema>;
export const cartographyQueue = defineQueue({
  name: 'geography.cartograph',
  purpose: 'Prepare one bounded current-coverage Cartographer proposal; no supply or scene generation.',
  payload: CartographyJobSchema,
  policy: {
    expireInSeconds: 1200,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});
export const publishDeltaQueue = defineQueue({
  name: 'geography.publish-delta',
  purpose: 'Publish a disposable hint for an already committed durable geography delta; no scene projection.',
  payload: PublishDeltaJobSchema,
  policy: {
    expireInSeconds: 180,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});
