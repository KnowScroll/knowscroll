import { z } from 'zod';
import { CONCEPT_CATALOGUE_VERSION, conceptMeaning } from './concepts.js';

export const COVERAGE_POLICY = 'scroll-static-coverage.v1' as const;
/** Top-level reading prose is the only block kind a coverage locator may name. */
export const COVERAGE_LOCATOR_TYPES: readonly string[] = ['paragraph', 'quote', 'callout'];
const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const Ref = z.string().min(1).max(160);
const Id = z.uuid().transform((value) => value.toLowerCase());
export const CoverageRefSchema = z.strictObject({
  assetId: Id,
  assetRevision: z.number().int().positive().max(2147483647),
});
export const CoverageMappingSchema = z.strictObject({
  version: z.literal(COVERAGE_POLICY),
  documentSha256: Hash,
  provenanceSha256: Hash,
  explanationUnitId: Ref,
  framing: z.literal('factual'),
  framingSha256: Hash,
  readingFactsVersion: z.literal(2),
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
      }),
    )
    .min(1)
    .max(16),
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
  }[];
}
export interface CoverageCatalogue {
  readonly sha256: string;
  readonly meaningSha256: (topicId: string, facetId: string) => string | undefined;
}

/** No visibility, qualification or personal state is inferred by this admission validator. */
export function validateCoverageMapping(
  map: CoverageMapping,
  target: CoverageTarget,
  catalogue: CoverageCatalogue,
): void {
  if (
    map.documentSha256 !== target.documentSha256 ||
    map.provenanceSha256 !== target.provenanceSha256 ||
    map.explanationUnitId !== target.explanationUnitId ||
    map.framing !== target.framing ||
    map.framingSha256 !== target.framingSha256 ||
    map.readingFactsVersion !== target.readingFactsVersion ||
    map.readingFactsSha256 !== target.readingFactsSha256 ||
    map.catalogueSha256 !== catalogue.sha256
  )
    throw new Error('CONTENT_COVERAGE_IDENTITY_MISMATCH');
  const bindings = new Set<string>();
  for (const binding of map.bindings) {
    const key = JSON.stringify([binding.topicId, binding.facetId]);
    if (
      bindings.has(key) ||
      !conceptMeaning(binding.topicId, binding.facetId) ||
      binding.meaningSha256 !== catalogue.meaningSha256(binding.topicId, binding.facetId) ||
      new Set(binding.requiredBlockIds).size !== binding.requiredBlockIds.length
    )
      throw new Error('CONTENT_COVERAGE_BINDING_INVALID');
    bindings.add(key);
    for (const id of binding.requiredBlockIds) {
      const block = target.blocks.find((entry) => entry.id === id);
      if (!block || block.nested || !block.truthSupported || !COVERAGE_LOCATOR_TYPES.includes(block.type))
        throw new Error('CONTENT_COVERAGE_LOCATOR_INVALID');
    }
  }
}
