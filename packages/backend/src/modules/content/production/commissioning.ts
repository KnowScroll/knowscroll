import {
  CutroomPoolWorkSchema,
  CutroomFollowWorkSchema,
  CutroomAccountingWorkSchema,
  CutroomSettleWorkSchema,
} from '../../../reasoning/public.js';
import { makeCommission } from './commission.js';
import { parseCommissionReviewPacket } from './commission-review.js';
import { financialReportOfSnapshot } from './commission-publication.js';
import type { Commissioning, CommissioningPorts, CommissioningDelivery } from './commissioning-ports.js';
import type { CutroomAccountingTarget } from '../../../reasoning/public.js';
import type { ChainSnapshotSelector } from './commission-chain-store-ports.js';
/** Operator-driven orchestration. Each network step is outside the short existing root
 * transactions. A lost C1 commit/send acknowledgement is reconciled by GET, never resent. */
export function makeCommissioning(p: CommissioningPorts): Commissioning {
  const enabled = p.enabled === true;
  async function admit(
    target: CutroomAccountingTarget,
    selector: ChainSnapshotSelector,
  ): Promise<CommissioningDelivery> {
    const snapshot = await p.snapshots.readSnapshot(target, selector);
    if (snapshot.kind !== 'snapshot') return 'held';
    const binding = await p.execution.readFollowTarget(target);
    // Old accounting still records honest liability when current admission/profile is unavailable.
    const report = financialReportOfSnapshot(snapshot);
    let published = false;
    if (binding && !snapshot.report.cost.overCeiling && snapshot.report.video.kind === 'candidate') {
      const result = await p.publication.publish({ worldId: target.worldId, generation: binding.generation }, target, {
        snapshotId: snapshot.snapshotId,
        snapshotSha256: snapshot.snapshotSha256,
      });
      published = result.kind === 'published';
    }
    if (published) return 'published';
    return (await p.financial.recordHold(target, snapshot.snapshotId, report)) ? 'accounting_pending' : 'held';
  }
  async function leased(
    target: CutroomAccountingTarget,
    work: () => Promise<CommissioningDelivery>,
  ): Promise<CommissioningDelivery> {
    const lease = await p.maintenance.begin(target);
    if (!lease) return 'held';
    try {
      return await work();
    } finally {
      await p.maintenance.end(target, lease);
    }
  }
  return {
    async commission(command, packetInput) {
      if (!enabled) return { kind: 'refused', code: 'disabled' };
      const packet = parseCommissionReviewPacket(packetInput);
      if (!packet || packet.worldId !== p.worldId) return { kind: 'refused', code: 'invalid' };
      // Packet is captured per invocation; concurrent operators cannot swap another script in.
      return makeCommission({
        ...p.commission,
        admitReview: async (scope, candidate, attemptId) => {
          if (
            packet.businessRunId !== candidate.businessRunId ||
            packet.worldId !== candidate.worldId ||
            packet.generation !== candidate.generation ||
            packet.scriptSha256 !== candidate.scriptSha256 ||
            packet.evidenceSha256 !== candidate.evidenceSha256 ||
            packet.requestSha256 !== candidate.requestSha256 ||
            packet.requestId !== candidate.requestId ||
            packet.take !== candidate.take ||
            packet.ceilingCents !== candidate.ceilingCents ||
            packet.byteLength !== candidate.byteLength
          )
            return false;
          if ((await p.review.admit(scope, packet)).kind !== 'reviewed') return false;
          await p.maintenance.trackInScope(scope, attemptId);
          return true;
        },
      })(command);
    },
    async pool(input) {
      if (!enabled) return 'disabled';
      const work = await p.readPoolWork(input);
      if (!work || work.target.worldId !== p.worldId) return 'held';
      return leased(work.target, async () => {
        // The evidence-only function/ACL is a hard prerequisite before a new financial claim.
        if (!(await p.pool.available(work.identity))) return 'held';
        const claimed = work.claimPending
          ? await p.reasoning.claim(work.authority, work.target.attemptId)
          : await p.reasoning.reconcile(work.authority, work.target.attemptId);
        if (claimed.kind !== 'pending' || claimed.poolState !== 'claimed') return 'held';
        if (!(await p.pool.available(work.identity))) return 'held';
        const prepared = await p.execution.prepareIntent(work.authority, work.target.attemptId);
        if (prepared.kind !== 'prepared') return 'held';
        const observed = await p.submit.submit(prepared.permit);
        if (observed.kind !== 'observed') return 'held';
        const saved = await p.execution.recordObservation(work.target, {
          requestId: observed.requestId,
          runId: observed.runId,
          outcome: observed.outcome,
          evidenceSha256: observed.evidenceSha256,
        });
        return saved.kind === 'pending' ? (observed.outcome === 'unknown' ? 'post_unknown' : 'post_observed') : 'held';
      });
    },
    async follow(input) {
      const parsed = CutroomFollowWorkSchema.safeParse(input);
      if (!enabled) return 'disabled';
      if (!parsed.success || parsed.data.worldId !== p.worldId) return 'held';
      const target = {
        worldId: parsed.data.worldId,
        businessRunId: parsed.data.businessRunId,
        attemptId: parsed.data.attemptId,
      };
      return leased(target, async () => {
        const binding = await p.execution.readFollowTarget(target);
        if (!binding || binding.execution.dispatchId !== parsed.data.dispatchId) return 'held';
        const i = binding.identity;
        const collected = await p.collector.collect({
          ...target,
          requestId: i.requestId,
          scriptSha256: i.scriptSha256,
          requestSha256: i.requestSha256,
          contractVersion: 1,
          take: i.take,
          ceilingCents: i.ceilingCents,
        });
        if (collected.kind !== 'collected') return 'held';
        const stored = await p.snapshots.recordCollectedChain(target, collected.snapshot);
        if (stored.kind === 'recorded' || stored.kind === 'replayed')
          return admit(target, { snapshotId: stored.snapshotId, snapshotSha256: stored.snapshotSha256 });
        return 'held';
      });
    },
    async accounting(input) {
      const parsed = CutroomAccountingWorkSchema.safeParse(input);
      if (!enabled) return 'disabled';
      if (!parsed.success || parsed.data.worldId !== p.worldId) return 'held';
      const target = {
        worldId: parsed.data.worldId,
        businessRunId: parsed.data.businessRunId,
        attemptId: parsed.data.attemptId,
      };
      // A retained immutable observation can report late truthful accounting after GET
      // maintenance has stopped; it has no claim or POST authority.
      return admit(target, { observationId: parsed.data.observationId });
    },
    async settle(input) {
      const parsed = CutroomSettleWorkSchema.safeParse(input);
      if (!enabled) return 'disabled';
      if (!parsed.success || parsed.data.worldId !== p.worldId) return 'held';
      const target = {
        worldId: parsed.data.worldId,
        businessRunId: parsed.data.businessRunId,
        attemptId: parsed.data.attemptId,
      };
      // Exact immutable accounting is independently idempotent; it remains reachable for a
      // contradictory late report after normal GET maintenance has permanently stopped.
      const result = await p.financial.process(target, parsed.data.operationId);
      return result === 'confirmed' ? 'accounting_confirmed' : result;
    },
    recover: (input) => (enabled ? p.maintenance.recover(input) : Promise.resolve({ scanned: 0, woken: 0 })),
  };
}

import { z } from 'zod';
import {
  CommissionHumanApprovalSchema,
  ReelCorpusManifestSchema,
  ReelCorpusRecordSchema,
} from './commission-review.js';
/** Trusted root-file envelope, never an API request/approval mint. Fresh profile/funds
 * timestamps are supplied by external installed preflight and are never renewed here. */
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const receipt = z.strictObject({ bindingId: z.uuid(), claimedAt: utc, boundAt: utc });
const ownerApproval = z.strictObject({
  grantRef: z.literal('knowscroll-v2-d018'),
  requestId: z.string().min(1).max(128),
  scriptSha256: digest,
  take: z.number().int().min(1).max(999),
  until: z.literal('video'),
  requestSha256: digest,
  worldId: z.enum(['dev', 'stage']),
  ceilingCents: z.number().int().min(1).max(75),
  approvalRef: z.string().min(1).max(512),
  principalOid: z.string().regex(/^[1-9][0-9]{0,9}$/),
  principalName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  businessRunId: z.uuid(),
  generation: z.number().int().positive(),
  evidenceSha256: digest,
  policyVersion: z.literal('cutroom-commission.v1'),
});
const setupSchema = z
  .strictObject({
    version: z.literal('cutroom-commissioning-setup.v1'),
    worldId: z.enum(['dev', 'stage']),
    generation: z.number().int().positive().max(2147483647),
    approvals: z.array(ownerApproval).max(1000),
    humanApprovals: z.array(CommissionHumanApprovalSchema).max(1000),
    manifests: z.array(ReelCorpusManifestSchema).length(1),
    preflights: z
      .array(
        z.strictObject({
          attemptId: z.uuid(),
          requestSha256: digest,
          fence: z.number().int().positive(),
          profileSha256: digest,
          soleWriterEvidenceSha256: digest,
          fundsEvidenceSha256: digest,
          observedAt: z.iso.datetime(),
          expiresAt: z.iso.datetime(),
          availableCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          poolReceipt: receipt,
        }),
      )
      .max(16),
    profile: z
      .strictObject({
        upstreamRevision: z.string().min(1).max(128),
        soleWriterEvidenceSha256: digest,
        observedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        expiresAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .optional(),
    poolWork: CutroomPoolWorkSchema.optional(),
    followWork: CutroomFollowWorkSchema.optional(),
    settleWork: CutroomSettleWorkSchema.optional(),
    reviewProposal: z.unknown().optional(),
    command: z.unknown().optional(),
    reviewPacket: z.unknown().optional(),
    corpusRecords: z.array(ReelCorpusRecordSchema).max(1000).optional(),
    corpusDraft: z.unknown().optional(),
  })
  .refine(
    (v) =>
      v.approvals.every((a) => a.worldId === v.worldId) &&
      v.humanApprovals.every((a) => a.worldId === v.worldId) &&
      [v.poolWork, v.followWork, v.settleWork].every((w) => !w || w.worldId === v.worldId),
  );
export type CommissioningSetup = z.infer<typeof setupSchema>;
export function parseCommissioningSetup(input: unknown): CommissioningSetup | undefined {
  const p = setupSchema.safeParse(input);
  return p.success ? p.data : undefined;
}
