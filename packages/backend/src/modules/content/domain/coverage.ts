import { z } from 'zod';
import { CONCEPT_CATALOGUE_VERSION } from './catalogue/types.js';

export const COVERAGE_POLICY = 'scroll-static-coverage.v1' as const;
/**
 * The policy of a Reel's mapping (#674, slice 5.1). It is a different version from a Scroll's so the derived
 * region lookup, which keeps only `scroll-static-coverage.v1`, never lists a Reel as a Scroll of a place: a Reel
 * reaches a region only as the twin of a Scroll (D-404).
 */
export const REEL_COVERAGE_POLICY = 'reel-static-coverage.v1' as const;
/** Top-level reading prose is the only block kind a coverage locator of a v1 document may name. */
export const COVERAGE_LOCATOR_TYPES: readonly string[] = ['paragraph', 'quote', 'callout'];
/** The only unit a coverage locator of a v2 document may name: a read stop. A call is play, not explanation (D-127). */
export const COVERAGE_LOCATOR_TYPES_V2: readonly string[] = ['stop'];
/** The only unit a coverage locator of a Reel may name: a segment, one narration sentence (one shot) of its script. */
export const COVERAGE_LOCATOR_TYPES_REEL: readonly string[] = ['segment'];

/** The unit kinds a coverage locator may name, by the version of the reading facts the document has. */
export function coverageLocatorTypes(readingFactsVersion: number): readonly string[] {
  return readingFactsVersion === 3 ? COVERAGE_LOCATOR_TYPES_V2 : COVERAGE_LOCATOR_TYPES;
}
const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const Ref = z.string().min(1).max(160);
const Id = z.uuid().transform((value) => value.toLowerCase());
export const CoverageRefSchema = z.strictObject({
  assetId: Id,
  assetRevision: z.number().int().positive().max(2147483647),
});
/** The media window, in milliseconds, one segment of a Reel is estimated to occupy. */
const SpanSchema = z
  .tuple([z.number().int().min(0).max(60_000), z.number().int().min(1).max(60_000)])
  .refine(([from, to]) => to > from);
export const CoverageMappingSchema = z
  .strictObject({
    version: z.union([z.literal(COVERAGE_POLICY), z.literal(REEL_COVERAGE_POLICY)]),
    documentSha256: Hash,
    provenanceSha256: Hash,
    explanationUnitId: Ref,
    framing: z.literal('factual'),
    framingSha256: Hash,
    readingFactsVersion: z.union([z.literal(2), z.literal(3)]),
    readingFactsSha256: Hash,
    catalogueVersion: z.literal(CONCEPT_CATALOGUE_VERSION),
    catalogueSha256: Hash,
    bindings: z
      .array(
        z.strictObject({
          topicId: Ref,
          facetId: Ref,
          meaningSha256: Hash,
          requiredBlockIds: z.array(Ref).min(1).max(8),
          /** A Reel's binding names the media window of each required segment, in the order of `requiredBlockIds`. */
          requiredSpans: z.array(SpanSchema).min(1).max(8).optional(),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((mapping, context) => {
    const reel = mapping.version === REEL_COVERAGE_POLICY;
    const consistent = mapping.bindings.every((binding) =>
      reel ? binding.requiredSpans?.length === binding.requiredBlockIds.length : binding.requiredSpans === undefined,
    );
    if (!consistent || (reel && mapping.readingFactsVersion !== 2))
      context.addIssue({ code: 'custom', message: 'Inconsistent coverage mapping' });
  });
export const CoverageCommandSchema = CoverageRefSchema.extend({
  version: z.literal('content-coverage-command.v1'),
  expectedHeadRevision: z.number().int().min(0).max(2147483646),
  semanticReviewReference: z.string().min(1).max(240),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('admit'), mapping: CoverageMappingSchema }),
    z.strictObject({ kind: z.literal('retract') }),
  ]),
});
export const CoverageAuthoritySchema = CoverageRefSchema.extend({
  headRevision: z.number().int().positive().max(2147483647),
  mappingSha256: Hash,
});
export type CoverageRef = z.infer<typeof CoverageRefSchema>;
export type CoverageMapping = z.infer<typeof CoverageMappingSchema>;
export type CoverageCommand = z.infer<typeof CoverageCommandSchema>;
export type CoverageAuthority = z.infer<typeof CoverageAuthoritySchema>;
export interface CoverageTarget {
  /** `reel` for a Reel's segments; absent for a Scroll's blocks. */
  readonly format?: 'reel';
  readonly documentSha256: string;
  readonly provenanceSha256: string;
  readonly explanationUnitId: string;
  readonly framing: string;
  readonly framingSha256: string;
  readonly readingFactsVersion: number;
  readonly readingFactsSha256: string;
  readonly blocks: readonly {
    readonly id: string;
    readonly type: string;
    readonly nested: boolean;
    readonly truthSupported: boolean;
    /** A Reel's segment: the media window it is estimated to occupy. Absent for a Scroll's blocks. */
    readonly span?: readonly [number, number];
  }[];
}
/**
 * The catalogue a coverage decision is made or read against: one release of it (`catalogueSha256` is the release's digest). A binding
 * pins the exact meaning of its topic and facet; `meaningSha256` is the identity of today's wording and `acceptsMeaning` also accepts
 * an earlier wording a revision declared to mean the same, so a wording-only edit loses no one's reading (D-419).
 */
export interface CoverageCatalogue {
  readonly sha256: string;
  readonly meaningSha256: (topicId: string, facetId: string) => string | undefined;
  readonly acceptsMeaning: (topicId: string, facetId: string, sha256: string) => boolean;
}

function assertTargetIdentity(map: CoverageMapping, target: CoverageTarget): void {
  if (
    (map.version === REEL_COVERAGE_POLICY) !== (target.format === 'reel') ||
    map.documentSha256 !== target.documentSha256 ||
    map.provenanceSha256 !== target.provenanceSha256 ||
    map.explanationUnitId !== target.explanationUnitId ||
    map.framing !== target.framing ||
    map.framingSha256 !== target.framingSha256 ||
    map.readingFactsVersion !== target.readingFactsVersion ||
    map.readingFactsSha256 !== target.readingFactsSha256
  )
    throw new Error('CONTENT_COVERAGE_IDENTITY_MISMATCH');
}

/** The stored document never changes, so a locator that does not fit it means corrupt data. */
function assertLocators(binding: CoverageMapping['bindings'][number], target: CoverageTarget): void {
  if (new Set(binding.requiredBlockIds).size !== binding.requiredBlockIds.length)
    throw new Error('CONTENT_COVERAGE_BINDING_INVALID');
  const types =
    target.format === 'reel' ? COVERAGE_LOCATOR_TYPES_REEL : coverageLocatorTypes(target.readingFactsVersion);
  binding.requiredBlockIds.forEach((id, index) => {
    const block = target.blocks.find((entry) => entry.id === id);
    if (!block || block.nested || !block.truthSupported || !types.includes(block.type))
      throw new Error('CONTENT_COVERAGE_LOCATOR_INVALID');
    // A Reel's binding carries the window of each segment, and it must be the window the stored Reel gives it.
    if (target.format === 'reel') {
      const span = binding.requiredSpans?.[index];
      if (!span || span[0] !== block.span?.[0] || span[1] !== block.span[1])
        throw new Error('CONTENT_COVERAGE_LOCATOR_INVALID');
    }
  });
}

/**
 * Admission check of a mapping decided against the current catalogue. Strict: the catalogue digest,
 * every binding's meaning and every locator must match. No visibility, qualification or personal
 * state is inferred.
 */
export function validateCoverageMapping(
  map: CoverageMapping,
  target: CoverageTarget,
  catalogue: CoverageCatalogue,
): void {
  assertTargetIdentity(map, target);
  if (map.catalogueSha256 !== catalogue.sha256) throw new Error('CONTENT_COVERAGE_IDENTITY_MISMATCH');
  const bindings = new Set<string>();
  for (const binding of map.bindings) {
    const key = JSON.stringify([binding.topicId, binding.facetId]);
    if (bindings.has(key) || binding.meaningSha256 !== catalogue.meaningSha256(binding.topicId, binding.facetId))
      throw new Error('CONTENT_COVERAGE_BINDING_INVALID');
    bindings.add(key);
    assertLocators(binding, target);
  }
}

/**
 * Read-time view of a stored mapping. The catalogue digest is not compared, because the catalogue grows
 * and every release changes it. Each binding pins its own facet meaning instead: a binding whose facet
 * has vanished or changed meaning since admission is dropped, never thrown on, so the mapping stays
 * readable and that facet is simply unmapped until coverage is admitted again. A binding decided against an earlier
 * wording that a revision declared the same meaning is kept. Target identity and
 * locators still must match the immutable document: a mismatch there is corrupt data and throws.
 */
export function currentCoverageMapping(
  map: CoverageMapping,
  target: CoverageTarget,
  catalogue: Pick<CoverageCatalogue, 'acceptsMeaning'>,
): CoverageMapping {
  assertTargetIdentity(map, target);
  const seen = new Set<string>();
  const bindings = map.bindings.filter((binding) => {
    const key = JSON.stringify([binding.topicId, binding.facetId]);
    if (seen.has(key)) throw new Error('CONTENT_COVERAGE_BINDING_INVALID');
    seen.add(key);
    assertLocators(binding, target);
    return catalogue.acceptsMeaning(binding.topicId, binding.facetId, binding.meaningSha256);
  });
  return { ...map, bindings };
}
