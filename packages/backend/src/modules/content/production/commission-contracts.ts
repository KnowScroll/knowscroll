import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CutroomAttemptIdentity, CutroomProtectedRequest } from '../../../reasoning/public.js';

export const CUTROOM_COMMISSION_POLICY = 'cutroom-commission.v1';
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const criterion = z.strictObject({
  id,
  text: text(500),
  type: z.enum(['presence', 'event']),
  claimId: id.optional(),
});

/** Internal evidence, never sent to Cutroom or exposed as consumer sources/coverage authority. */
export const CutroomCommissionScriptSchema = z.strictObject({
  policyVersion: z.literal(CUTROOM_COMMISSION_POLICY),
  scriptVersion: id,
  title: text(200),
  evidence: z.strictObject({
    version: z.literal('cutroom-public-evidence.v1'),
    sources: z
      .array(
        z.strictObject({
          id,
          url: z
            .url()
            .max(2048)
            .refine((url) => {
              if (!URL.canParse(url)) return false;
              const parsed = new URL(url);
              return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
            }),
          retrievedAt: z.iso.datetime(),
          excerpt: text(8000),
          excerptSha256: digest,
        }),
      )
      .min(1)
      .max(8),
    /** Review reference is data; review correctness and owner authority are separate checks. */
    reviewRef: id,
  }),
  claims: z
    .array(
      z.strictObject({
        id,
        role: z.enum(['main', 'supporting']),
        statement: text(1000),
        support: z
          .array(z.strictObject({ sourceId: id, excerptSha256: digest }))
          .min(1)
          .max(8),
      }),
    )
    .min(1)
    .max(16),
  narration: z
    .array(z.strictObject({ text: text(500), claimIds: z.array(id).min(1).max(16) }))
    .min(6)
    .max(12),
  criteria: z.strictObject({
    mustShow: z.array(criterion).min(1).max(32),
    mustNotShow: z.array(criterion).max(32),
    depictionPolicyVersion: id,
  }),
  style: z.strictObject({ id, version: z.number().int().nonnegative().max(10000), text: text(2000) }),
});

export type CutroomCommissionScript = z.infer<typeof CutroomCommissionScriptSchema>;

/** A reference to a review, never a dispatch capability or proof that the owner approved it. */
export const CutroomApprovalReferenceSchema = z.strictObject({
  ref: id,
  scriptSha256: digest,
});

export type CutroomCommissionRefusal =
  | 'structure'
  | 'package_too_large'
  | 'duplicate_identity'
  | 'evidence_mismatch'
  | 'claim_binding'
  | 'criterion_binding'
  | 'sentence_boundary'
  | 'ending_sun'
  | 'shot_estimate'
  | 'approval_mismatch';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Bounded structural lint; no assertion of truth, rights, originality, approval or real TTS length. */
export function lintCutroomCommission(input: unknown):
  | {
      readonly kind: 'valid';
      readonly script: CutroomCommissionScript;
      readonly scriptSha256: string;
      readonly evidenceSha256: string;
    }
  | { readonly kind: 'refused'; readonly code: CutroomCommissionRefusal } {
  const parsed = CutroomCommissionScriptSchema.safeParse(input);
  if (!parsed.success) return { kind: 'refused', code: 'structure' };
  const script = parsed.data;
  const canonical = JSON.stringify(script);
  if (Buffer.byteLength(canonical, 'utf8') > 65536) return { kind: 'refused', code: 'package_too_large' };
  const sourceIds = new Set(script.evidence.sources.map((source) => source.id));
  const claimIds = new Set(script.claims.map((claim) => claim.id));
  const criteria = [...script.criteria.mustShow, ...script.criteria.mustNotShow];
  if (
    sourceIds.size !== script.evidence.sources.length ||
    claimIds.size !== script.claims.length ||
    new Set(criteria.map((item) => item.id)).size !== criteria.length
  )
    return { kind: 'refused', code: 'duplicate_identity' };
  if (
    script.evidence.sources.some((source) => sha256(source.excerpt) !== source.excerptSha256) ||
    script.claims.some((claim) =>
      claim.support.some(
        (support) =>
          !script.evidence.sources.some(
            (source) => source.id === support.sourceId && source.excerptSha256 === support.excerptSha256,
          ),
      ),
    )
  )
    return { kind: 'refused', code: 'evidence_mismatch' };
  const referenced = new Set(script.narration.flatMap((sentence) => sentence.claimIds));
  if (
    script.narration.some(
      (sentence) =>
        new Set(sentence.claimIds).size !== sentence.claimIds.length ||
        sentence.claimIds.some((claimId) => !claimIds.has(claimId)),
    ) ||
    script.claims.some((claim) => !referenced.has(claim.id))
  )
    return { kind: 'refused', code: 'claim_binding' };
  if (
    criteria.some((item) => item.claimId !== undefined && !claimIds.has(item.claimId)) ||
    script.criteria.mustNotShow.some((item) => item.type !== 'presence')
  )
    return { kind: 'refused', code: 'criterion_binding' };
  for (const sentence of script.narration) {
    if (!/[.!?]["'”’]*$/u.test(sentence.text) || /[.!?]["'”’]*\s+\S/u.test(sentence.text))
      return { kind: 'refused', code: 'sentence_boundary' };
    if (/\bSun[.!?]["'”’]*$/iu.test(sentence.text)) return { kind: 'refused', code: 'ending_sun' };
    // Conservative planning heuristic from CF-63, not an upstream media/witness guarantee.
    if (sentence.text.split(/\s+/u).length / 2.5 > 9) return { kind: 'refused', code: 'shot_estimate' };
  }
  return {
    kind: 'valid',
    script,
    scriptSha256: sha256(canonical),
    evidenceSha256: sha256(JSON.stringify(script.evidence)),
  };
}

/**
 * Compile once for protected storage. The digest is canonical parsed script+evidence, with a named
 * policy; the wire body contains only Cutroom labels/criteria. Approval refs remain untrusted data.
 * No caller resume, plan rehearsal, network, money reservation or permission is created here.
 */
export function prepareCutroomCommission(
  input: unknown,
  approvalReference: unknown,
  identity: { readonly take: number; readonly worldId: string; readonly ceilingCents: number },
):
  | {
      readonly kind: 'prepared';
      readonly policyVersion: typeof CUTROOM_COMMISSION_POLICY;
      readonly scriptSha256: string;
      readonly evidenceSha256: string;
      readonly approvalRef: string;
      readonly contractVersion: 1;
      /** Exact UTF-8 bytes for the future protected store ONLY; never log or queue this string. */
      readonly requestUtf8: string;
      readonly requestSha256: string;
      readonly byteLength: number;
      readonly requestId: string;
      readonly worldId: string;
    }
  | { readonly kind: 'refused'; readonly code: CutroomCommissionRefusal } {
  const lint = lintCutroomCommission(input);
  if (lint.kind === 'refused') return lint;
  const approval = CutroomApprovalReferenceSchema.safeParse(approvalReference);
  if (!approval.success || approval.data.scriptSha256 !== lint.scriptSha256)
    return { kind: 'refused', code: 'approval_mismatch' };
  const parsedIdentity = z
    .strictObject({
      take: z.number().int().min(1).max(999),
      worldId: id,
      ceilingCents: z.number().int().min(1).max(75),
    })
    .safeParse(identity);
  if (!parsedIdentity.success) return { kind: 'refused', code: 'structure' };
  const script = lint.script;
  // `take` must later come from the shared pool's allocation; this pure function allocates nothing.
  const requestId = `ks-reel-${lint.scriptSha256.slice(0, 32)}-${parsedIdentity.data.take}`;
  const requestUtf8 = JSON.stringify({
    contractVersion: 1,
    requestId,
    worldId: parsedIdentity.data.worldId,
    narration: script.narration,
    claims: script.claims.map(({ id: claimId, role }) => ({ id: claimId, role })),
    criteria: script.criteria,
    style: script.style,
    options: { until: 'video', budgetCents: parsedIdentity.data.ceilingCents },
  });
  return Object.freeze({
    kind: 'prepared',
    policyVersion: CUTROOM_COMMISSION_POLICY,
    scriptSha256: lint.scriptSha256,
    evidenceSha256: lint.evidenceSha256,
    approvalRef: approval.data.ref,
    contractVersion: 1,
    requestUtf8,
    requestSha256: sha256(requestUtf8),
    byteLength: Buffer.byteLength(requestUtf8, 'utf8'),
    requestId,
    worldId: parsedIdentity.data.worldId,
  });
}

/** Content business identity survives queue redelivery; actual outbound attempts belong to Reasoning. */
export interface CutroomCommissionRun {
  readonly businessRunId: string;
  readonly scriptSha256: string;
  readonly evidenceSha256: string;
  readonly approvalReference: z.infer<typeof CutroomApprovalReferenceSchema>;
  readonly attempt: CutroomAttemptIdentity;
  readonly protectedRequest: CutroomProtectedRequest;
}

/** A validated observed remote run, not a caller POST or a new paid-attempt allocation. */
export interface CutroomObservedRun {
  readonly runId: string;
  readonly requestId: string;
  readonly resumes: string | undefined;
  /** Read freshly from status: terminal result alone cannot prove there is no child. */
  readonly resumedBy: string | undefined;
  readonly statusSha256: string;
  readonly resultSha256: string | undefined;
  readonly recordSha256: string | undefined;
}

/**
 * Future Content record validator, DECLARATION ONLY. At most 16 distinct runs; reject cycles,
 * foreign request IDs, broken parent/child links, missing fresh status, unverified keptFrom ancestry,
 * result/record mismatch and missing/failed chosen-picture/used-take gates. Preserve label outcomes.
 * Never infer terminality from a failed parent or transfer old single-run import authority here.
 */
export interface ValidateCutroomRemoteChain {
  (input: {
    readonly attempt: CutroomAttemptIdentity;
    readonly observations: readonly CutroomObservedRun[];
    readonly protectedRecordRefs: readonly string[];
  }): Promise<
    | {
        readonly kind: 'validated';
        readonly orderedRuns: readonly CutroomObservedRun[];
        readonly evidenceRef: string;
        readonly cost:
          | { readonly kind: 'unverified'; readonly reason: 'upstream_chain_cost_semantics' }
          | { readonly kind: 'verified'; readonly actualCents: number; readonly accountingEvidenceRef: string };
      }
    | { readonly kind: 'refused'; readonly code: 'bounds' | 'identity' | 'chain' | 'record' | 'gates' | 'incomplete' }
  >;
}
