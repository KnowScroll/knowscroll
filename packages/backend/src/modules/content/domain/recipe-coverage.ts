import { CONCEPT_CATALOGUE_VERSION } from './concepts.js';
import {
  coverageLocatorTypes,
  COVERAGE_POLICY,
  type CoverageCatalogue,
  type CoverageMapping,
  type CoverageTarget,
} from './coverage.js';
import type { LibraryRecipe } from './library/plan.js';

/**
 * The code rule that decides coverage for a generated Scroll. It is stored with the mapping as the
 * basis of the decision: no person or model approves coverage.
 */
export const RECIPE_COVERAGE_RULE = 'scroll-recipe-coverage.v1' as const;

/**
 * The same rule over the units of a `scroll-document.v2` (D-127): the eligible units are its read
 * stops with documented claims, and the primary facet needs the first, middle and last of them.
 * Calls bind nothing, so how a person played never decides whether a place forms (D-063).
 */
export const RECIPE_COVERAGE_RULE_V2 = 'scroll-recipe-coverage.v2' as const;

/** Fewer eligible blocks cannot show a reader met the lesson, so no coverage is claimed. */
export const MIN_BODY_BLOCKS = 3;
/** How many of the closing body blocks the supporting facet needs. */
const SUPPORTING_ANCHORS = 2;

export type RecipeCoveragePlan =
  | { readonly kind: 'planned'; readonly mapping: CoverageMapping; readonly rule: string }
  | { readonly kind: 'refused'; readonly code: 'too_few_body_blocks' | 'facet_not_in_catalogue' };

type RecipeFacets = Pick<LibraryRecipe, 'topicId' | 'facetId' | 'supportingFacetId'>;

/**
 * Binds a recipe's declared facets to blocks of the admitted document. The rule is structural, not
 * semantic: it names which blocks a reader must have seen for the facet to count, and cannot judge
 * whether the prose teaches it. The recipe brief and the writer checks govern that.
 *
 * - Eligible blocks are top-level paragraphs, quotes and callouts whose claims are documented.
 * - The primary facet needs the first, middle and last eligible block, so skimming the opening
 *   never counts as meeting it.
 * - The supporting facet, when declared, needs the last two eligible blocks, where the brief puts
 *   the closing treatment.
 *
 * Pure. Every identity in the mapping comes from the stored `target` and the catalogue.
 */
export function planRecipeCoverage(
  recipe: RecipeFacets,
  target: CoverageTarget,
  catalogue: CoverageCatalogue,
): RecipeCoveragePlan {
  const locatorTypes = coverageLocatorTypes(target.readingFactsVersion);
  const eligible = target.blocks
    .filter((block) => !block.nested && block.truthSupported && locatorTypes.includes(block.type))
    .map((block) => block.id);
  if (eligible.length < MIN_BODY_BLOCKS) return { kind: 'refused', code: 'too_few_body_blocks' };

  const wanted = [{ facetId: recipe.facetId, requiredBlockIds: firstMiddleLast(eligible) }];
  if (recipe.supportingFacetId !== undefined && recipe.supportingFacetId !== recipe.facetId)
    wanted.push({ facetId: recipe.supportingFacetId, requiredBlockIds: eligible.slice(-SUPPORTING_ANCHORS) });

  const bindings: CoverageMapping['bindings'] = [];
  for (const { facetId, requiredBlockIds } of wanted) {
    const meaningSha256 = catalogue.meaningSha256(recipe.topicId, facetId);
    if (meaningSha256 === undefined) return { kind: 'refused', code: 'facet_not_in_catalogue' };
    bindings.push({ topicId: recipe.topicId, facetId, meaningSha256, requiredBlockIds });
  }
  return {
    kind: 'planned',
    rule: target.readingFactsVersion === 3 ? RECIPE_COVERAGE_RULE_V2 : RECIPE_COVERAGE_RULE,
    mapping: {
      version: COVERAGE_POLICY,
      documentSha256: target.documentSha256,
      provenanceSha256: target.provenanceSha256,
      explanationUnitId: target.explanationUnitId,
      framing: 'factual',
      framingSha256: target.framingSha256,
      readingFactsVersion: target.readingFactsVersion === 3 ? 3 : 2,
      readingFactsSha256: target.readingFactsSha256,
      catalogueVersion: CONCEPT_CATALOGUE_VERSION,
      catalogueSha256: catalogue.sha256,
      bindings,
    },
  };
}

function firstMiddleLast(ids: readonly string[]): string[] {
  const middle = ids[Math.floor((ids.length - 1) / 2)];
  const picked = [ids[0], middle, ids.at(-1)];
  return picked.filter((id, index): id is string => id !== undefined && picked.indexOf(id) === index);
}
