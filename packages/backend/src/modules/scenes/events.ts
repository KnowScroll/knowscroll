import { z } from 'zod';
import { GeographyRevisionsSchema } from '@knowscroll/contracts';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
export const ProjectSceneJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  transitionId: z.uuid(),
  geography: GeographyRevisionsSchema,
  personalRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type ProjectSceneJob = z.infer<typeof ProjectSceneJobSchema>;
export const projectSceneQueue = defineQueue({
  name: 'scenes.project',
  purpose: 'Project current committed Geography into bounded persisted appearance; no evidence or model work.',
  payload: ProjectSceneJobSchema,
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

export const BackfillLooksJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
});
export type BackfillLooksJob = z.infer<typeof BackfillLooksJobSchema>;
/** Sent by the operator command for a world that was projected before looks existed (D-102). */
export const backfillLooksQueue = defineQueue({
  name: 'scenes.backfill-looks',
  purpose: 'Give already projected places their look without moving any slot, seed, family or anchor; no model work.',
  payload: BackfillLooksJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});

export const ExpireFormationJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  transitionId: z.uuid(),
  claimId: z.uuid(),
});
const RecoveryKey = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
export const RecoverFormationJobSchema = z.union([
  z.strictObject({ v: z.literal(1) }),
  z
    .strictObject({ v: z.literal(1), afterKey: RecoveryKey, throughKey: RecoveryKey })
    .refine((p) => BigInt(p.afterKey) < BigInt(p.throughKey)),
]);
export const expireFormationQueue = defineQueue({
  name: 'scenes.expire-formation',
  purpose: 'Finalize the exact expired presentation claim without showing or recreating formation.',
  payload: ExpireFormationJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
});
/** Global ordinal watermarks only; no personal UUID, label, fact, nonce or dispatch authority. */
export const recoverFormationQueue = defineQueue({
  name: 'scenes.recover-formation',
  purpose: 'Finite100-key captured-ceiling recovery of durable overdue claims; fixed global continuation only.',
  payload: RecoverFormationJobSchema,
  policy: {
    expireInSeconds: 180,
    retryLimit: 3,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retentionSeconds: 7 * 86400,
    deleteAfterSeconds: 2 * 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 1 },
  schedule: { cron: '*/5 * * * *', payload: { v: 1 } },
});
