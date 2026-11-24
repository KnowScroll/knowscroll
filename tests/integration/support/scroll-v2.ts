import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import type { ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import {
  extractResearch,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/orrin.fixture.js';
import { textCapabilities } from './scroll.js';

/** A client that declares both document schemas. */
export const v2Capabilities = {
  ...textCapabilities,
  documentSchemas: [...textCapabilities.documentSchemas, SCROLL_DOCUMENT_V2_SCHEMA_VERSION],
};

/** A recipe with the plan it may carry (a library test): what a test changes and puts back. */
type PlannedRecipe = { scrollV3?: ScrollV3Plan };

/**
 * Makes every library recipe a v1 recipe until the undo is called. Create commissions only v1 recipes
 * (D-138), so the files that test Create's own mechanics (who starts a production, the caps, the waiting) run on
 * the library as it was when every recipe was v1. Call it in `beforeAll` and the undo in `afterAll`: a test file has a process of its own.
 */
export function markLibraryV1(): () => void {
  const undoAll = (Object.keys(RECIPES) as ScrollTopic[]).map((key) => markScrollV1(key));
  return () => undoAll.forEach((undo) => undo());
}

/**
 * Makes a library recipe a v1 recipe for the duration of a test and returns the undo. The plan marks
 * every recipe document v3 (#787, #790); this is how a test publishes the v1 revision that a
 * document v3 regeneration follows, the way the library's Scrolls were before D-137.
 */
export function markScrollV1(key: ScrollTopic): () => void {
  const recipe = RECIPES[key] as PlannedRecipe;
  const { scrollV3: before } = recipe;
  delete recipe.scrollV3;
  return () => {
    if (before !== undefined) recipe.scrollV3 = before;
  };
}

/**
 * Makes the named library recipes v1 recipes until the undo is called. The plan marks every recipe document v3 (#787, #790);
 * a file that tests the v1 path (who publishes straight to admitted, the production job) names the recipes it uses as v1 examples. Call it in the
 * describe body and the undo in `afterAll`: a test file has a process of its own.
 */
export function markRecipesV1(...keys: ScrollTopic[]): () => void {
  const undoAll = keys.map((key) => markScrollV1(key));
  return () => undoAll.forEach((undo) => undo());
}

/**
 * The page a fixture serves for a recipe URL when the recipe is written about the invented planet Orrin:
 * the Orrin page itself, and for another URL a page of its own (a recipe with two pages gets two).
 */
export function orrinResearchFor(url: string): ResearchPage {
  if (url === fixtureResearchPageV2.url) return fixtureResearchPageV2;
  return extractResearch(
    `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, `This invented fixture page for ${url} adds nothing further about Orrin.`].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
    url,
    '2026-10-20T00:00:00.000Z',
  );
}
