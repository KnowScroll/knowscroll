import { admitRecipeCoverage } from '../application/admit-recipe-coverage.js';
import { codeRecipeOf } from '../application/recipe-book.js';
import type { EditorialCoverage, ImportEditorialScrollPorts } from '../application/ports.js';
import { coverageHeadPorts } from './coverage-store.js';
import { admissionTransaction } from './postgres-store.js';
import { makeStoredRecipes } from './stored-recipes.js';
import { attributePrimaryTopic } from './topic-attribution.js';

/** What a hand-written Scroll's topic attribution rests on: the library recipe its source names. */
const EDITORIAL_ATTRIBUTION_VERSION = 'editorial-recipe-taxonomy.v1';

/**
 * Attributes a newly stored hand-written document v3 to the planet of the recipe its source names, and decides its
 * coverage by the beat rule (`scroll-recipe-coverage.v3`), inside the import's own admission transaction, so the
 * revision, its topic and its coverage head commit together or not at all (#761, decision G1). The recipe gives the
 * topic and facets; the Scroll keeps its own explanation unit. A recipe the library does not know, an attribution that
 * conflicts with one already there, or a Scroll the rule cannot bind is `not_admitted`, and the caller rolls back.
 */
export const admitEditorialCoverage: ImportEditorialScrollPorts['admitCoverage'] = async (
  tx,
  revision,
  recipeKey,
): Promise<EditorialCoverage> => {
  const trx = admissionTransaction(tx);
  const recipe = codeRecipeOf(recipeKey) ?? (await makeStoredRecipes(trx).get(recipeKey));
  if (recipe === undefined) return { kind: 'not_admitted', code: 'recipe_unknown' };
  const attributed = await attributePrimaryTopic(trx, {
    assetId: revision.assetId,
    revision: revision.revision,
    topicId: recipe.topicId,
    version: EDITORIAL_ATTRIBUTION_VERSION,
  });
  if (!attributed) return { kind: 'not_admitted', code: 'attribution_conflict' };
  const outcome = await admitRecipeCoverage(
    coverageHeadPorts,
    tx,
    {
      explanationUnitId: revision.explanationUnitId,
      topicId: recipe.topicId,
      facetId: recipe.facetId,
      supportingFacetId: recipe.supportingFacetId,
    },
    { assetId: revision.assetId, assetRevision: revision.revision },
  );
  return outcome.kind === 'admitted' ? { kind: 'admitted' } : { kind: 'not_admitted', code: outcome.code };
};
