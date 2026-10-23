import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  lintCutroomCommission,
  prepareCutroomCommission,
  CutroomCommissionScriptSchema,
} from './commission-contracts.js';
import type {
  CommissionReviewPacket,
  CommissionReviewDraft,
  CommissionHumanApproval,
  ReelCorpusManifest,
  ReelCorpusRecord,
  ReelTemplateDescriptor,
  CommissionReviewStore,
  CommissionPreparationStore,
  CommissionReviewPreparation,
} from './commission-review-ports.js';
import type { CutroomScopeTx, CutroomAuthority, WithCutroomPreparationScope } from '../../../reasoning/public.js';
const digest = z.string().regex(/^[0-9a-f]{64}$/),
  ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
/** Exact legacy key sorting / JSON scalar encoding. Projection IDs live OUTSIDE the hashed payload. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const reelFingerprint = (value: unknown): string =>
  createHash('sha256').update(canonical(value), 'utf8').digest('hex');
export const normalizeReelNarration = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();
const criterionType = z.enum(['presence', 'event']);
export const ReelTemplateDescriptorSchema = z.strictObject({
  narrationClaimCounts: z.array(z.number().int().min(1).max(64)).min(1).max(64),
  claimRoles: z
    .array(z.enum(['main', 'supporting']))
    .min(1)
    .max(64),
  mustShowTypes: z.array(criterionType).min(1).max(64),
  mustNotShowTypes: z.array(criterionType).max(64),
  depictionPolicyVersion: ref,
  styleId: ref,
  styleVersion: z.number().int().min(0).max(10000),
  planVaryOn: z.enum(['shotCount', 'order', 'canonicalSubject', 'angle']).nullable(),
});
const argumentSchema = z.strictObject({
  worldId: ref,
  sources: z
    .array(
      z
        .string()
        .regex(/^[a-zA-Z0-9._:-]+@[1-9][0-9]*$/)
        .max(160),
    )
    .max(128),
  narrationText: z.array(z.string().min(1).max(500)).min(1).max(64),
});
export const ReelCorpusRecordSchema = z.strictObject({
  sourceNamespace: ref,
  generatedReelId: ref,
  sourceSnapshotRevision: ref,
  originalTemplateSha256: digest.nullable(),
  originalArgumentSha256: digest.nullable(),
  briefSha256: digest,
  descriptorSourceRef: ref,
  algorithmEvidenceRef: ref,
  template: ReelTemplateDescriptorSchema,
  argument: argumentSchema,
  bridgeSha256: digest,
});
export const ReelCorpusManifestSchema = z.strictObject({
  version: z.literal('reel-corpus-completeness.v1'),
  snapshotId: ref,
  sourceScopesAndRevisions: z.array(ref).min(1).max(128),
  totalCount: z.number().int().min(0).max(1000),
  allPagesDigest: digest,
  descriptorMappingDigest: digest,
  requiredProjectionIds: z.tuple([
    z.literal('legacy-template-v1'),
    z.literal('legacy-argument-v1'),
    z.literal('narration-bridge-v1'),
  ]),
  trustedReviewCommandSha256: digest,
});
export const CommissionHumanApprovalSchema = z.strictObject({
  businessRunId: z.uuid(),
  worldId: z.enum(['dev', 'stage']),
  generation: z.number().int().min(1).max(2147483647),
  reviewSha256: digest,
  scriptSha256: digest,
  evidenceSha256: digest,
  requestSha256: digest,
  ceilingCents: z.number().int().min(1).max(75),
  humanEvidenceRef: ref,
});
export const CommissionReviewProposalSchema = z.strictObject({
  businessRunId: z.uuid(),
  worldId: z.enum(['dev', 'stage']),
  generation: z.number().int().min(1).max(2147483647),
  take: z.number().int().min(1).max(999),
  ceilingCents: z.number().int().min(1).max(75),
  rightsReviewRef: ref,
  framingReviewRef: ref,
  targetReviewRef: ref,
  script: CutroomCommissionScriptSchema,
});
/** Pure DRAFT only: no corpus-clear verdict, approval, claim or reservation. Trusted scoped preparation must seal actual metadata before owner review. */
export function prepareCommissionReview(
  input: unknown,
):
  | { readonly kind: 'draft'; readonly draft: CommissionReviewDraft }
  | { readonly kind: 'refused'; readonly code: 'invalid' } {
  const parsed = CommissionReviewProposalSchema.safeParse(input);
  if (!parsed.success) return { kind: 'refused', code: 'invalid' };
  const v = parsed.data,
    lint = lintCutroomCommission(v.script);
  if (lint.kind !== 'valid') return { kind: 'refused', code: 'invalid' };
  const c = prepareCutroomCommission(
    v.script,
    { ref: 'proposed-not-approved', scriptSha256: lint.scriptSha256 },
    { worldId: v.worldId, take: v.take, ceilingCents: v.ceilingCents },
  );
  if (c.kind !== 'prepared' || c.byteLength > 100000) return { kind: 'refused', code: 'invalid' };
  const template: ReelTemplateDescriptor = {
    narrationClaimCounts: v.script.narration.map((n) => n.claimIds.length),
    claimRoles: v.script.claims.map((c) => c.role).sort(),
    mustShowTypes: v.script.criteria.mustShow.map((c) => c.type).sort(),
    mustNotShowTypes: v.script.criteria.mustNotShow.map((c) => c.type).sort(),
    depictionPolicyVersion: v.script.criteria.depictionPolicyVersion,
    styleId: v.script.style.id,
    styleVersion: v.script.style.version,
    planVaryOn: null,
  };
  const bridge = { narrationText: v.script.narration.map((n) => normalizeReelNarration(n.text)).sort() };
  const packet = {
    version: 'cutroom-review.v1' as const,
    ...v,
    grantRef: 'knowscroll-v2-d018' as const,
    grantCeilingCents: 200 as const,
    scriptSha256: lint.scriptSha256,
    evidenceSha256: lint.evidenceSha256,
    requestId: c.requestId,
    requestSha256: c.requestSha256,
    byteLength: c.byteLength,
    template,
    templateSha256: reelFingerprint(template),
    bridge,
    bridgeSha256: reelFingerprint(bridge),
  };
  return { kind: 'draft', draft: packet };
}
/** Verify every mapped row, including unavailable/refused/withdrawn history. No DB corpus is inferred from the 14 retained input files. */
export function checkReelCorpus(
  input: readonly unknown[],
  manifest: ReelCorpusManifest,
  packet: CommissionReviewDraft,
): 'clear' | 'repetition' | 'corpus_unavailable' {
  const m = ReelCorpusManifestSchema.safeParse(manifest);
  if (!m.success || input.length !== m.data.totalCount || input.length > 1000) return 'corpus_unavailable';
  const records: ReelCorpusRecord[] = [];
  for (const item of input) {
    const p = ReelCorpusRecordSchema.safeParse(item);
    if (!p.success || Buffer.byteLength(JSON.stringify(item), 'utf8') > 16384) return 'corpus_unavailable';
    const r = p.data;
    if (
      (r.originalTemplateSha256 === null && r.originalArgumentSha256 === null) ||
      (r.originalTemplateSha256 !== null && reelFingerprint(r.template) !== r.originalTemplateSha256) ||
      (r.originalArgumentSha256 !== null && reelFingerprint(r.argument) !== r.originalArgumentSha256) ||
      reelFingerprint({ narrationText: r.argument.narrationText }) !== r.bridgeSha256 ||
      JSON.stringify(r.argument.narrationText) !==
        JSON.stringify(r.argument.narrationText.map(normalizeReelNarration).sort()) ||
      JSON.stringify(r.argument.sources) !== JSON.stringify([...new Set(r.argument.sources)].sort()) ||
      !m.data.sourceScopesAndRevisions.includes(`${r.sourceNamespace}:${r.sourceSnapshotRevision}`)
    )
      return 'corpus_unavailable';
    records.push(r);
  }
  const sorted = records.sort((a, b) =>
    `${a.sourceNamespace}:${a.generatedReelId}` < `${b.sourceNamespace}:${b.generatedReelId}` ? -1 : 1,
  );
  if (
    new Set(sorted.map((r) => `${r.sourceNamespace}:${r.generatedReelId}`)).size !== sorted.length ||
    reelFingerprint(sorted) !== m.data.allPagesDigest ||
    reelFingerprint(
      sorted.map((r) => ({
        sourceNamespace: r.sourceNamespace,
        generatedReelId: r.generatedReelId,
        briefSha256: r.briefSha256,
        descriptorSourceRef: r.descriptorSourceRef,
        algorithmEvidenceRef: r.algorithmEvidenceRef,
      })),
    ) !== m.data.descriptorMappingDigest
  )
    return 'corpus_unavailable';
  return sorted.some(
    (r) => reelFingerprint(r.template) === packet.templateSha256 || r.bridgeSha256 === packet.bridgeSha256,
  )
    ? 'repetition'
    : 'clear';
}
export function matchesHumanApproval(a: CommissionHumanApproval, p: CommissionReviewPacket): boolean {
  return (
    a.businessRunId === p.businessRunId &&
    a.worldId === p.worldId &&
    a.generation === p.generation &&
    a.reviewSha256 === p.reviewSha256 &&
    a.scriptSha256 === p.scriptSha256 &&
    a.evidenceSha256 === p.evidenceSha256 &&
    a.requestSha256 === p.requestSha256 &&
    a.ceilingCents === p.ceilingCents
  );
}
/** Empty trusted registries and absent completeness refuse. Registry bytes are copied at composition, never accepted from a command. */
export function makeCommissionReview(
  store: CommissionReviewStore,
  options: {
    readonly enabled?: boolean;
    readonly approvals?: readonly CommissionHumanApproval[];
    readonly manifests?: readonly ReelCorpusManifest[];
  } = {},
) {
  const enabled = options.enabled ?? false,
    approvals = z
      .array(CommissionHumanApprovalSchema)
      .max(1000)
      .parse(structuredClone(options.approvals ?? [])),
    manifests = z
      .array(ReelCorpusManifestSchema)
      .max(1)
      .parse(structuredClone(options.manifests ?? []));
  return {
    prepare: (scope: CutroomScopeTx, input: unknown) =>
      enabled
        ? store.prepare(scope, input, manifests)
        : Promise.resolve({ kind: 'refused', code: 'corpus_unavailable' } as const),
    async admit(scope: CutroomScopeTx, input: unknown) {
      if (!enabled) return { kind: 'refused', code: 'approval' } as const;
      const packet = parseCommissionReviewPacket(input);
      if (!packet) return { kind: 'refused', code: 'invalid' } as const;
      const human = approvals.filter((a) => matchesHumanApproval(a, packet));
      if (human.length !== 1) return { kind: 'refused', code: 'approval' } as const;
      return store.gate(scope, packet, manifests, human[0]!.humanEvidenceRef);
    },
    recheck: (scope: CutroomScopeTx, businessRunId: string) =>
      enabled ? store.recheck(scope, businessRunId, approvals, manifests) : Promise.resolve(undefined),
  };
}

/** Hydration validates bounded immutable metadata WITHOUT recompiling/reconstructing protected bytes. */
const draftSchema = CommissionReviewProposalSchema.extend({
  version: z.literal('cutroom-review.v1'),
  grantRef: z.literal('knowscroll-v2-d018'),
  grantCeilingCents: z.literal(200),
  scriptSha256: digest,
  evidenceSha256: digest,
  requestId: ref,
  requestSha256: digest,
  byteLength: z.number().int().min(1).max(100000),
  template: ReelTemplateDescriptorSchema,
  templateSha256: digest,
  bridge: z.strictObject({ narrationText: z.array(z.string().min(1).max(500)).min(6).max(12) }),
  bridgeSha256: digest,
});
export function parseCommissionReviewDraft(value: unknown): CommissionReviewDraft | undefined {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 100000) return undefined;
  const p = parsed.data,
    lint = lintCutroomCommission(p.script);
  if (
    lint.kind !== 'valid' ||
    lint.scriptSha256 !== p.scriptSha256 ||
    lint.evidenceSha256 !== p.evidenceSha256 ||
    p.requestId !== `ks-reel-${p.scriptSha256.slice(0, 32)}-${p.take}`
  )
    return undefined;
  const expectedTemplate: ReelTemplateDescriptor = {
    narrationClaimCounts: p.script.narration.map((n) => n.claimIds.length),
    claimRoles: p.script.claims.map((c) => c.role).sort(),
    mustShowTypes: p.script.criteria.mustShow.map((c) => c.type).sort(),
    mustNotShowTypes: p.script.criteria.mustNotShow.map((c) => c.type).sort(),
    depictionPolicyVersion: p.script.criteria.depictionPolicyVersion,
    styleId: p.script.style.id,
    styleVersion: p.script.style.version,
    planVaryOn: null,
  };
  const expectedBridge = { narrationText: p.script.narration.map((n) => normalizeReelNarration(n.text)).sort() };
  return reelFingerprint(p.template) === p.templateSha256 &&
    reelFingerprint(expectedTemplate) === p.templateSha256 &&
    reelFingerprint(p.bridge) === p.bridgeSha256 &&
    reelFingerprint(expectedBridge) === p.bridgeSha256
    ? p
    : undefined;
}

const packetSchema = draftSchema.extend({
  corpusSnapshotSha256: digest,
  corpusGate: z.literal('clear'),
  reviewSha256: digest,
});
export function draftOfPacket(packet: CommissionReviewPacket): CommissionReviewDraft {
  const { corpusSnapshotSha256: _snapshot, corpusGate: _gate, reviewSha256: _review, ...draft } = packet;
  return draft;
}
export function parseCommissionReviewPacket(value: unknown): CommissionReviewPacket | undefined {
  const p = packetSchema.safeParse(value);
  if (!p.success || !parseCommissionReviewDraft(draftOfPacket(p.data))) return undefined;
  const { reviewSha256, ...payload } = p.data;
  return reelFingerprint(payload) === reviewSha256 ? p.data : undefined;
}
/** Module-internal sealing seam: invoked ONLY after the store validates complete metadata in its locked or read-only snapshot. */
export function sealCommissionReviewDraft(
  draft: CommissionReviewDraft,
  corpusSnapshotSha256: string,
): CommissionReviewPacket {
  const payload = { ...draft, corpusSnapshotSha256, corpusGate: 'clear' as const };
  return { ...payload, reviewSha256: reelFingerprint(payload) };
}

/** Consistent snapshot preparation only; clear metadata is neither a reservation nor human approval.
 * No normal composition binds this factory. Final locked C1 admission/recheck remains mandatory. */
export function makeCommissionPreparation(
  store: CommissionPreparationStore,
  withScope: WithCutroomPreparationScope,
  options: { readonly enabled?: boolean; readonly manifests?: readonly ReelCorpusManifest[] } = {},
) {
  const enabled = options.enabled ?? false;
  const manifests = z
    .array(ReelCorpusManifestSchema)
    .max(1)
    .parse(structuredClone(options.manifests ?? []));
  return {
    async prepare(authority: CutroomAuthority, input: unknown): Promise<CommissionReviewPreparation> {
      if (!enabled) return { kind: 'refused', code: 'corpus_unavailable' };
      const result = await withScope(authority, (scope) => store.prepareReadOnly(scope, input, manifests));
      return result.kind === 'entered' ? result.value : { kind: 'refused', code: 'identity' };
    },
  };
}
