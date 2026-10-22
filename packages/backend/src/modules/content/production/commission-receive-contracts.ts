import { z } from 'zod';
import { ReelDocumentSchema } from '@knowscroll/contracts';
import { defineQueue } from '../../../infrastructure/jobs/queues.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reference = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const world = z.enum(['dev', 'stage']);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString().slice(0, 23) === v.slice(0, 23),
  );
const money = z.number().int().min(0).max(75);
export const RECEIVE_MAX_BYTES = 100_000;
export const RECEIVE_LIFETIME_MS = 30 * 86400_000;
/** Internal Root-file transport only. The SHA256 is external to these exact UTF8 bytes. */
export const CommissionReceivePayloadSchema = z
  .strictObject({
    version: z.literal('cutroom-receive.v1'),
    handoffId: z.uuid(),
    originWorld: world,
    targetWorld: world,
    publicationId: z.uuid(),
    publicationSha256: digest,
    businessRunId: z.uuid(),
    attemptId: z.uuid(),
    snapshotId: z.uuid(),
    snapshotSha256: digest,
    source: z.strictObject({
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      artifactSha256: digest,
      schemaVersion: z.number().int().min(36).max(10000),
    }),
    policyVersion: z.literal('cutroom-commission.v1'),
    scriptSha256: digest,
    evidenceSha256: digest,
    requestId: reference,
    requestSha256: digest,
    reviewSha256: digest,
    humanApprovalRef: reference,
    corpusSnapshotSha256: digest,
    rightsReviewRef: reference,
    framingReviewRef: reference,
    targetReviewRef: reference,
    settlement: z.strictObject({
      operationId: z.uuid(),
      receiptSha256: digest,
      financialReportSha256: digest,
      poolEvidenceId: digest,
      dispatchId: z.uuid(),
      bindingId: z.uuid(),
      claimedAt: instant,
      boundAt: instant,
      runs: z
        .array(
          z.strictObject({
            runId: reference,
            status: z.enum(['completed', 'refused', 'stopped', 'failed', 'cancelled']),
            ownCostCents: money,
            resultSha256: digest,
            recordSha256: digest,
          }),
        )
        .min(1)
        .max(2),
      finalRunId: reference,
      actualCents: money,
    }),
    document: ReelDocumentSchema,
    documentSha256: digest,
    media: z.strictObject({
      sha256: digest,
      sizeBytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024 * 1024),
      key: z.string().regex(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/),
      profile: z.literal('h264-aac-reel.v1'),
    }),
    receiverChargeCents: z.literal(0),
  })
  .superRefine((p, ctx) => {
    const s = p.settlement;
    if (
      p.originWorld === p.targetWorld ||
      p.document.revision !== 1 ||
      p.document.assetId !== p.businessRunId ||
      p.document.mediaKey !== p.media.key ||
      p.media.key !== `sha256/${p.media.sha256.slice(0, 2)}/${p.media.sha256}.mp4` ||
      s.runs.at(-1)?.runId !== s.finalRunId ||
      s.runs.at(-1)?.status !== 'completed' ||
      new Set(s.runs.map((r) => r.runId)).size !== s.runs.length ||
      s.runs.reduce((n, r) => n + BigInt(r.ownCostCents), 0n) !== BigInt(s.actualCents) ||
      !Number.isFinite(Date.parse(s.claimedAt)) ||
      !Number.isFinite(Date.parse(s.boundAt)) ||
      s.boundAt < s.claimedAt
    )
      ctx.addIssue({ code: 'custom', message: 'receive_identity' });
  });
export type CommissionReceivePayload = z.infer<typeof CommissionReceivePayloadSchema>;
/** A separately reviewed, short current-policy/nonwithdrawal attestation, not a script approval mint. */
export const CommissionReceiveBindingSchema = z
  .strictObject({
    handoffId: z.uuid(),
    payloadSha256: digest,
    targetWorld: world,
    generation: z.number().int().min(1).max(2147483647),
    observedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expiresAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    provenanceReviewSha256: digest,
    currentPolicyReviewSha256: digest,
  })
  .refine((v) => v.expiresAtMs > v.observedAtMs && v.expiresAtMs - v.observedAtMs <= 300_000);
export type CommissionReceiveBinding = z.infer<typeof CommissionReceiveBindingSchema>;
export const CommissionReceiveSetupSchema = z
  .strictObject({
    version: z.literal('cutroom-receiving-setup.v1'),
    worldId: world,
    generation: z.number().int().min(1).max(2147483647),
    bindings: z.array(CommissionReceiveBindingSchema).max(100),
    envelope: z
      .strictObject({ payloadUtf8: z.string().min(1).max(RECEIVE_MAX_BYTES), payloadSha256: digest })
      .optional(),
  })
  .refine(
    (v) =>
      v.bindings.every((b) => b.targetWorld === v.worldId && b.generation === v.generation) &&
      new Set(v.bindings.map((b) => b.handoffId)).size === v.bindings.length,
  );
export type CommissionReceiveSetup = z.infer<typeof CommissionReceiveSetupSchema>;
export const ReceiveWorkSchema = z.strictObject({ v: z.literal(1), worldId: world, handoffId: z.uuid() });
export const ReceiveRecoveryWorkSchema = z
  .strictObject({
    v: z.literal(1),
    worldId: world.optional(),
    afterId: z.uuid().optional(),
    throughId: z.uuid().optional(),
  })
  .refine(
    (v) => (!v.afterId && !v.throughId) || (!!v.worldId && !!v.afterId && !!v.throughId && v.afterId < v.throughId),
  );
const policy = {
  expireInSeconds: 120,
  retryLimit: 0,
  retryDelaySeconds: 0,
  retryBackoff: false,
  retentionSeconds: 86400,
  deleteAfterSeconds: 86400,
  deadLetter: true,
} as const;
export const receiveCutroomQueue = defineQueue({
  name: 'content.receive-cutroom',
  purpose: 'Verify one retained public handoff; no paid capability',
  payload: ReceiveWorkSchema,
  policy,
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 2 },
});
export const recoverReceiveCutroomQueue = defineQueue({
  name: 'content.recover-receive-cutroom',
  purpose: 'Finite keyset discovery of retained handoffs',
  payload: ReceiveRecoveryWorkSchema,
  policy,
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '*/15 * * * *', payload: { v: 1 as const } },
});
