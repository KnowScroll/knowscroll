import { z } from 'zod';
import { CONCEPT_CATALOGUE_VERSION } from './concepts.js';
import { REEL_COVERAGE_POLICY, type CoverageCatalogue, type CoverageMapping, type CoverageTarget } from './coverage.js';
import type { LibraryRecipe } from './library/plan.js';
import { ReelBriefSchema } from './reel/script.js';

/**
 * The code rule that decides coverage for a Reel (#674, slice 5.1). Like `scroll-recipe-coverage.v1` it is
 * stored with the mapping as the basis of the decision, and no person or model approves it.
 */
export const REEL_RECIPE_COVERAGE_RULE = 'reel-recipe-coverage.v1' as const;

/** Fewer eligible segments cannot show a viewer met the lesson, so no coverage is claimed. */
export const MIN_REEL_SEGMENTS = 3;
/** How many of the closing segments the supporting facet needs. */
const SUPPORTING_ANCHORS = 2;

/** What the stored provenance of a Reel published from an approved script says, as coverage needs it. */
export const ReelCoverageProvenanceSchema = z.looseObject({
  schemaVersion: z.literal('reel-provenance.v1'),
  kind: z.literal('cutroom_import'),
  fixture: z.literal(false),
  recipe: z.string().min(1).max(80),
  brief: ReelBriefSchema,
  twin: z.strictObject({
    assetId: z.uuid(),
    assetRevision: z.number().int().positive(),
    explanationUnitId: z.string().min(1).max(160),
  }),
});
export type ReelCoverageProvenance = z.infer<typeof ReelCoverageProvenanceSchema>;

/** One narration sentence of the script and the media window it is estimated to occupy. */
export interface ReelSegment {
  /** `s1` for the first sentence, in narration order. */
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly claimIds: readonly string[];
}

const wordCount = (text: string) => Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);

/**
 * The segments of a Reel: one for each narration sentence, which is one shot (the script check demands it).
 * Cutroom reports no shot times, so a segment's window is estimated from its share of the narration's words
 * over the admitted duration: the first segment starts at 0, the last ends at the duration, and the windows
 * tile the Reel. The estimate is the reason a viewer's watching is judged against a widened window (the
 * Evidence module's `reel-segment-seen.v1`). The cut is part of rule `reel-recipe-coverage.v1`: another cut, such as one
 * from real shot times, is a new rule version. Pure and deterministic.
 */
export function reelSegmentsOf(brief: Pick<ReelCoverageProvenance['brief'], 'narration'>, durationMs: number) {
  const words = brief.narration.map((sentence) => wordCount(sentence.text));
  const total = words.reduce((sum, count) => sum + count, 0);
  let before = 0;
  return brief.narration.map((sentence, index): ReelSegment => {
    const startMs = Math.round((durationMs * before) / total);
    before += words[index]!;
    const endMs = Math.round((durationMs * before) / total);
    return { id: `s${String(index + 1)}`, startMs, endMs, claimIds: sentence.claimIds };
  });
}

/**
 * A segment can bind a facet only when every claim it cites is listed in the script and rests on the twin
 * Scroll at the revision the Reel was made from. The script check guarantees this for a shipped script; it is
 * decided again from the stored provenance, because coverage rests on what was stored.
 */
export function segmentIsSupported(segment: ReelSegment, provenance: ReelCoverageProvenance): boolean {
  const { claims, claimSources } = provenance.brief;
  return (
    segment.claimIds.length > 0 &&
    segment.claimIds.every(
      (claimId) =>
        claims.some((claim) => claim.id === claimId) &&
        claimSources.some(
          (source) =>
            source.claimId === claimId &&
            source.assetId === provenance.twin.assetId &&
            source.assetRevision === provenance.twin.assetRevision,
        ),
    )
  );
}

export type ReelCoveragePlan =
  | { readonly kind: 'planned'; readonly mapping: CoverageMapping; readonly rule: typeof REEL_RECIPE_COVERAGE_RULE }
  | { readonly kind: 'refused'; readonly code: 'too_few_segments' | 'facet_not_in_catalogue' };

type RecipeFacets = Pick<LibraryRecipe, 'topicId' | 'facetId' | 'supportingFacetId'>;

/**
 * Binds a recipe's declared facets to segments of the stored Reel, as the Scroll rule binds them to blocks.
 *
 * - Eligible segments are the narration sentences whose claims are documented in the twin Scroll.
 * - The primary facet needs the first, middle and last eligible segment, so watching the opening never counts.
 * - The supporting facet, when declared, needs the last two eligible segments.
 *
 * The rule is structural, not semantic: it names which segments a viewer must have watched for the facet to
 * count, and cannot judge whether the film teaches it. Every binding carries the media window of each of its
 * segments, so the observed coverage can be judged from the mapping alone. Pure.
 */
export function planReelCoverage(
  recipe: RecipeFacets,
  target: CoverageTarget,
  catalogue: CoverageCatalogue,
): ReelCoveragePlan {
  const eligible = target.blocks.filter((block) => block.truthSupported && block.span !== undefined);
  if (eligible.length < MIN_REEL_SEGMENTS) return { kind: 'refused', code: 'too_few_segments' };

  const bindingOf = (facetId: string, segments: typeof eligible) => {
    const meaningSha256 = catalogue.meaningSha256(recipe.topicId, facetId);
    return meaningSha256 === undefined
      ? undefined
      : {
          topicId: recipe.topicId,
          facetId,
          meaningSha256,
          requiredBlockIds: segments.map((segment) => segment.id),
          requiredSpans: segments.map((segment): [number, number] => [segment.span![0], segment.span![1]]),
        };
  };
  const wanted = [{ facetId: recipe.facetId, segments: firstMiddleLast(eligible) }];
  if (recipe.supportingFacetId !== undefined && recipe.supportingFacetId !== recipe.facetId)
    wanted.push({ facetId: recipe.supportingFacetId, segments: eligible.slice(-SUPPORTING_ANCHORS) });

  const bindings: CoverageMapping['bindings'] = [];
  for (const { facetId, segments } of wanted) {
    const binding = bindingOf(facetId, segments);
    if (binding === undefined) return { kind: 'refused', code: 'facet_not_in_catalogue' };
    bindings.push(binding);
  }
  return {
    kind: 'planned',
    rule: REEL_RECIPE_COVERAGE_RULE,
    mapping: {
      version: REEL_COVERAGE_POLICY,
      documentSha256: target.documentSha256,
      provenanceSha256: target.provenanceSha256,
      explanationUnitId: target.explanationUnitId,
      framing: 'factual',
      framingSha256: target.framingSha256,
      readingFactsVersion: 2,
      readingFactsSha256: target.readingFactsSha256,
      catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      catalogueSha256: catalogue.sha256,
      bindings,
    },
  };
}

function firstMiddleLast<T>(items: readonly T[]): T[] {
  const middle = items[Math.floor((items.length - 1) / 2)];
  const picked = [items[0], middle, items.at(-1)];
  return picked.filter((item, index): item is T => item !== undefined && picked.indexOf(item) === index);
}
