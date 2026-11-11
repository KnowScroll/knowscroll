import { z } from 'zod';
import { SCROLL_QUALIFICATION_POLICY_V0, SCROLL_RECORDING_QUALIFICATION_POLICY } from './policy.js';
import { intervalsLength, intersectIntervals, mergeIntervals, type Interval } from './intervals.js';
import {
  REEL_QUALIFICATION_POLICY_V0,
  REEL_RECORDING_QUALIFICATION_POLICY,
  REEL_SUMMARY_VERSION,
  REEL_WATCHED_POLICY,
} from './reel-summary.js';

export const OBSERVED_COVERAGE_POLICY = 'observed-static-coverage.v1' as const;
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Ref = z.string().min(1).max(160);
/**
 * The policy version of a Reel's coverage mapping in Content (`REEL_COVERAGE_POLICY`), which a test keeps equal.
 * A Reel exposure is judged only against a mapping of this version, and a Scroll exposure never is.
 */
export const REEL_MAPPING_POLICY = 'reel-static-coverage.v1' as const;
const Span = z.tuple([z.number().int().min(0).max(60_000), z.number().int().min(1).max(60_000)]);
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
      'segments_unavailable',
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
        readingFactsVersion: z.union([z.literal(2), z.literal(3)]),
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
          /** A Reel's binding: the media window of each required segment, in the order of `requiredBlockIds`. */
          requiredSpans: z.array(Span).min(1).max(8).optional(),
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
      readonly requiredSpans?: readonly (readonly [number, number])[] | undefined;
    }[];
  };
}
/**
 * The unit kinds a coverage locator may name, by reading-facts version: prose blocks of a v1 document,
 * read stops of a v2 document. Content's `coverageLocatorTypes` is the rule; a test keeps the two equal.
 */
export const ELIGIBLE_BY_FACTS_VERSION: Readonly<Record<number, readonly string[]>> = {
  2: ['paragraph', 'quote', 'callout'],
  3: ['stop'],
};
export function observedBindings(
  evidence: CoverageEvidence,
  facts: CoverageFacts,
  head: CoverageHeadInput,
  hash: (value: unknown) => string,
) {
  const summary = ReadingCoverageSummarySchema.safeParse(evidence.summary);
  const policy =
    evidence.policyVersion === SCROLL_RECORDING_QUALIFICATION_POLICY.version
      ? SCROLL_RECORDING_QUALIFICATION_POLICY
      : SCROLL_QUALIFICATION_POLICY_V0;
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
    ELIGIBLE_BY_FACTS_VERSION[facts.v] === undefined ||
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
        ELIGIBLE_BY_FACTS_VERSION[facts.v]?.includes(block.type) === true &&
        !facts.nested.some((b) => b.id === id)
      );
    }),
  );
}

export const ReelCoverageSummarySchema = z.strictObject({
  v: z.literal(REEL_SUMMARY_VERSION),
  uniqueMediaMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  instrumentationVersion: z.number().int().nonnegative(),
  sequenceGaps: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative(),
  watched: z.array(Span).max(REEL_WATCHED_POLICY.maxIntervals),
});

/**
 * When a segment of a Reel counts as watched (#674, slice 5.1). Cutroom reports no shot times, so a segment's
 * window is an estimate from its narration. The viewer must therefore have watched that window widened by
 * `marginMs` each way (within the Reel), and the unwatched part may be at most `1 - minShare` of it: watching
 * the neighbours of a segment is what shows the segment itself was met. Values are policy; a new value is a new
 * version.
 */
export const REEL_SEGMENT_SEEN_POLICY = { version: 'reel-segment-seen.v1', marginMs: 1000, minShare: 0.95 } as const;

/** Whether the watched media covers a segment's estimated window under `REEL_SEGMENT_SEEN_POLICY`. Pure. */
export function reelSegmentSeen(
  watched: readonly Interval[],
  span: readonly [number, number],
  durationMs: number,
): boolean {
  const from = Math.max(0, span[0] - REEL_SEGMENT_SEEN_POLICY.marginMs);
  const to = Math.min(durationMs, span[1] + REEL_SEGMENT_SEEN_POLICY.marginMs);
  if (to <= from) return false;
  const covered = intervalsLength(intersectIntervals(mergeIntervals(watched), [[from, to]]));
  return covered >= (to - from) * REEL_SEGMENT_SEEN_POLICY.minShare;
}

/** Whether every required segment of a Reel binding was watched; a binding without windows never was. */
export function reelBindingWatched(
  binding: {
    readonly requiredBlockIds: readonly string[];
    readonly requiredSpans?: readonly (readonly [number, number])[] | undefined;
  },
  watched: readonly Interval[],
  durationMs: number,
): boolean {
  const spans = binding.requiredSpans;
  return (
    spans !== undefined &&
    spans.length === binding.requiredBlockIds.length &&
    spans.every((span) => reelSegmentSeen(watched, span, durationMs))
  );
}

/**
 * The bindings of a Reel's mapping whose every required segment the qualified watching covers. Like
 * `observedBindings`, it returns nothing unless the evidence is a qualified, fully lineage-checked Reel
 * summary of the facts the mapping was decided against. An unqualified, unknown or position-less summary (one
 * written before positions were recorded) binds nothing. Partial watching credits only the segments it covered.
 */
export function observedReelBindings(
  evidence: CoverageEvidence,
  facts: CoverageFacts,
  head: CoverageHeadInput,
  hash: (value: unknown) => string,
) {
  const summary = ReelCoverageSummarySchema.safeParse(evidence.summary);
  const policy =
    evidence.policyVersion === REEL_RECORDING_QUALIFICATION_POLICY.version
      ? REEL_RECORDING_QUALIFICATION_POLICY
      : REEL_QUALIFICATION_POLICY_V0;
  if (
    !summary.success ||
    evidence.policyVersion !== policy.version ||
    evidence.qualification !== 'qualified' ||
    evidence.q < policy.minQ ||
    summary.data.instrumentationVersion < policy.minInstrumentationVersion ||
    !summary.data.watched.length ||
    facts.reelDurationMs === undefined ||
    summary.data.durationMs !== facts.reelDurationMs ||
    evidence.estimatedReadingMs !== facts.estimatedReadingMs ||
    facts.blocks.length > 0 ||
    hash(facts) !== head.mapping.readingFactsSha256
  )
    return undefined;
  return head.mapping.bindings.filter((binding) =>
    reelBindingWatched(binding, summary.data.watched, summary.data.durationMs),
  );
}
