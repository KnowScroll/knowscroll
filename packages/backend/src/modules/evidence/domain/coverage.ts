import { z } from 'zod';
import { SCROLL_QUALIFICATION_POLICY_V0 } from './policy.js';

export const OBSERVED_COVERAGE_POLICY = 'observed-static-coverage.v1' as const;
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Ref = z.string().min(1).max(160);
export const CoverageEvidenceIdentitySchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  inputWatermark: z.number().int().nonnegative(),
  policyVersion: z.string().min(1).max(80),
  summarySha256: Hash,
});
export const ObservedCoverageSchema = z
  .strictObject({
    version: z.literal(OBSERVED_COVERAGE_POLICY),
    universeId: z.uuid(),
    privacyEpoch: z.number().int().positive(),
    exposureId: z.uuid(),
    assetId: z.uuid(),
    assetRevision: z.number().int().positive(),
    activatedAt: z.iso.datetime(),
    explanationUnitId: Ref,
    availability: z.enum(['available', 'unavailable']),
    reason: z.enum([
      'observed',
      'unsupported_format',
      'qualification_missing',
      'unqualified',
      'evidence_invalid',
      'facts_unavailable',
      'mapping_unavailable',
      'mapping_unmapped',
      'mapping_retracted',
      'identity_mismatch',
      'limit',
    ]),
    evidence: CoverageEvidenceIdentitySchema.nullable(),
    factsSha256: Hash.nullable(),
    mapping: z
      .strictObject({
        authority: z.strictObject({
          assetId: z.uuid(),
          assetRevision: z.number().int().positive(),
          headRevision: z.number().int().positive(),
          mappingSha256: Hash,
        }),
        documentSha256: Hash,
        provenanceSha256: Hash,
        explanationUnitId: Ref,
        framing: z.literal('factual'),
        framingSha256: Hash,
        readingFactsVersion: z.literal(2),
        readingFactsSha256: Hash,
        catalogueVersion: z.literal('content-concepts.v1'),
        catalogueSha256: Hash,
      })
      .nullable(),
    bindings: z
      .array(
        z.strictObject({
          topicId: Ref,
          facetId: Ref,
          meaningSha256: Hash,
          requiredBlockIds: z.array(Ref).min(1).max(8),
        }),
      )
      .max(16),
  })
  .superRefine((x, c) => {
    if (
      (x.availability === 'available') !== (x.reason === 'observed') ||
      (x.availability === 'available' && (!x.evidence || !x.mapping || !x.factsSha256)) ||
      (x.availability !== 'available' && x.bindings.length > 0) ||
      new Set(x.bindings.map((b) => JSON.stringify([b.topicId, b.facetId]))).size !== x.bindings.length ||
      (x.mapping &&
        (x.mapping.authority.assetId !== x.assetId ||
          x.mapping.authority.assetRevision !== x.assetRevision ||
          x.mapping.explanationUnitId !== x.explanationUnitId))
    )
      c.addIssue({ code: 'custom', message: 'Inconsistent observed coverage' });
  });
export type ObservedCoverage = z.infer<typeof ObservedCoverageSchema>;
export const ReadingCoverageSummarySchema = z.strictObject({
  v: z.literal(1),
  seenBlocks: z.array(Ref).max(80),
  seenWeight: z.number().nonnegative(),
  totalWeight: z.number().positive(),
  dwellRatio: z.number().min(0).max(1),
  interactions: z.array(z.strictObject({ blockId: Ref, interaction: Ref })).max(480),
  coverageEvents: z.number().int().nonnegative(),
  dwellEvents: z.number().int().nonnegative(),
  instrumentationVersion: z.number().int().nonnegative(),
  sequenceGaps: z.number().int().nonnegative(),
  reasons: z.array(Ref).max(16),
});
export interface CoverageEvidence {
  readonly id: string;
  readonly revision: number;
  readonly inputWatermark: number;
  readonly policyVersion: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly qualification: string;
  readonly q: number;
  readonly coverage: number;
  readonly estimatedReadingMs: number;
  readonly summary: unknown;
}
/** Stored positive observations, never understanding or a replacement qualification algorithm. */
interface CoverageFacts {
  readonly v: number;
  readonly reelDurationMs?: number;
  readonly totalWeight: number;
  readonly estimatedReadingMs: number;
  readonly blocks: readonly { readonly id: string; readonly type: string }[];
  readonly nested: readonly { readonly id: string }[];
}
interface CoverageHeadInput {
  readonly mapping: {
    readonly readingFactsSha256: string;
    readonly bindings: readonly {
      readonly topicId: string;
      readonly facetId: string;
      readonly meaningSha256: string;
      readonly requiredBlockIds: readonly string[];
    }[];
  };
}
export function observedBindings(
  evidence: CoverageEvidence,
  facts: CoverageFacts,
  head: CoverageHeadInput,
  hash: (value: unknown) => string,
) {
  const summary = ReadingCoverageSummarySchema.safeParse(evidence.summary);
  const policy = SCROLL_QUALIFICATION_POLICY_V0;
  if (
    !summary.success ||
    evidence.policyVersion !== policy.version ||
    evidence.qualification !== 'qualified' ||
    evidence.q < policy.minQ ||
    evidence.coverage < policy.minCoverage ||
    summary.data.instrumentationVersion < policy.minInstrumentationVersion ||
    !summary.data.coverageEvents ||
    !summary.data.dwellEvents ||
    !summary.data.seenBlocks.length ||
    new Set(summary.data.seenBlocks).size !== summary.data.seenBlocks.length ||
    summary.data.seenBlocks.some((id) => !facts.blocks.some((b) => b.id === id)) ||
    summary.data.totalWeight !== facts.totalWeight ||
    evidence.estimatedReadingMs !== facts.estimatedReadingMs ||
    facts.v !== 2 ||
    facts.reelDurationMs !== undefined ||
    hash(facts) !== head.mapping.readingFactsSha256
  )
    return undefined;
  const seen = new Set(summary.data.seenBlocks);
  return head.mapping.bindings.filter((binding) =>
    binding.requiredBlockIds.every((id) => {
      const block = facts.blocks.find((b) => b.id === id);
      return (
        seen.has(id) &&
        block !== undefined &&
        ['paragraph', 'quote', 'callout'].includes(block.type) &&
        !facts.nested.some((b) => b.id === id)
      );
    }),
  );
}
