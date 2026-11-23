import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type {
  ScrollV2Plan,
  ScrollV3Plan,
  StageKitId,
} from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { KIT_PLANS_V2 } from '../../../packages/backend/src/modules/content/production/spike-v2/kit-plans.js';
import type { ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import {
  extractResearch,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { textCapabilities } from './scroll.js';

/** The plan for a recipe made to publish the labelled Orrin fixture: a stage Scroll with a reviewed CI myth. */
export const ORRIN_PLAN: ScrollV2Plan = {
  variant: 'stage',
  misconception: {
    kind: 'myth',
    claim: 'Orrin is warmest because it is closest to its star.',
    source: { label: 'CI fixture label', reviewed: true },
  },
};

/** A client that declares both document schemas. */
export const v2Capabilities = {
  ...textCapabilities,
  documentSchemas: [...textCapabilities.documentSchemas, SCROLL_DOCUMENT_V2_SCHEMA_VERSION],
};

/** A recipe with the two plans it may carry, one at most (a library test): what a test changes and puts back. */
type PlannedRecipe = { scrollV2?: ScrollV2Plan; scrollV3?: ScrollV3Plan };

/**
 * Marks a library recipe as a v2 recipe for the duration of a test and returns the undo. The plan marks
 * the plain recipes of the waves and the recipes no drawing kit drew (D-137, D-199, D-217); a test uses this
 * for another recipe, or for a different plan. A recipe the plan marks document v3 (#787) loses that plan while
 * it is marked v2, because a recipe never carries both.
 */
export function markScrollV2(key: ScrollTopic, plan: ScrollV2Plan): () => void {
  const recipe = RECIPES[key] as PlannedRecipe;
  const { scrollV2: before, scrollV3: beforeV3 } = recipe;
  delete recipe.scrollV3;
  recipe.scrollV2 = plan;
  return () => {
    if (before === undefined) delete recipe.scrollV2;
    else recipe.scrollV2 = before;
    if (beforeV3 !== undefined) recipe.scrollV3 = beforeV3;
  };
}

/**
 * Makes one of the 22 recipes that had a drawing kit a v2 stage recipe again for the duration of a test, with the kit and the v2 plan it
 * had before #787 (`KIT_PLANS_V2`), and returns the undo. The library plans these recipes as document v3 Scrolls, which have no
 * kit; the v2 production path and the kit code stay until each kit is deleted, and the tests of that path run on a kit recipe this way.
 */
export function markKitRecipeV2(key: keyof typeof KIT_PLANS_V2): () => void {
  const recipe = RECIPES[key] as PlannedRecipe & { stageKit?: StageKitId };
  const { scrollV2, scrollV3, stageKit } = recipe;
  const { kit, plan } = KIT_PLANS_V2[key];
  delete recipe.scrollV3;
  recipe.scrollV2 = plan;
  recipe.stageKit = kit;
  return () => {
    if (scrollV2 === undefined) delete recipe.scrollV2;
    else recipe.scrollV2 = scrollV2;
    if (scrollV3 !== undefined) recipe.scrollV3 = scrollV3;
    if (stageKit === undefined) delete recipe.stageKit;
    else recipe.stageKit = stageKit;
  };
}

/**
 * Makes all 22 recipes that had a drawing kit v2 stage recipes again until the undo is called (see `markKitRecipeV2`). A file that
 * tests the v2 path (production of a stage Scroll, the check of a v2 Scroll, the release policy over v2 Scrolls) uses a kit recipe as its
 * example. Call it in the describe body and the undo in `afterAll`: a test file has a process of its own.
 */
export function markKitRecipesV2(): () => void {
  const undoAll = (Object.keys(KIT_PLANS_V2) as (keyof typeof KIT_PLANS_V2)[]).map((key) => markKitRecipeV2(key));
  return () => undoAll.reverse().forEach((undo) => undo());
}

/**
 * Makes every library recipe a v1 recipe until the undo is called. Create commissions only v1 recipes
 * (D-138) and the plan is moving every recipe to v2 (D-137, D-199), so the files that test Create's own
 * mechanics (who starts a production, the caps, the waiting) run on the library as it was when every
 * recipe was v1. Call it in `beforeAll` and the undo in `afterAll`: a test file has a process of its own.
 */
export function markLibraryV1(): () => void {
  const undoAll = (Object.keys(RECIPES) as ScrollTopic[]).map((key) => markScrollV1(key));
  return () => undoAll.forEach((undo) => undo());
}

/**
 * Makes a library recipe a v1 recipe for the duration of a test and returns the undo. The plan marks
 * recipes v2 or document v3 (the 22 that had a kit, #787); this is how a test publishes the v1 revision that a
 * v2 or v3 regeneration follows, the way the library's Scrolls were before D-137.
 */
export function markScrollV1(key: ScrollTopic): () => void {
  const recipe = RECIPES[key] as PlannedRecipe;
  const { scrollV2: before, scrollV3: beforeV3 } = recipe;
  delete recipe.scrollV2;
  delete recipe.scrollV3;
  return () => {
    if (before !== undefined) recipe.scrollV2 = before;
    if (beforeV3 !== undefined) recipe.scrollV3 = beforeV3;
  };
}

/**
 * Makes the named library recipes v1 recipes until the undo is called. The plan marks the Seasons recipes
 * and the kit and wave recipes v2 or, for the 22 that had a kit, document v3 (D-137, D-199, D-217, #787); a file that tests the v1 path (who publishes
 * straight to admitted, the production job) names the recipes it uses as v1 examples. Call it in the
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

/** The Orrin answer for a plain Scroll: the same writing, with no picture (a plain recipe is told to write none). */
export function plainOrrin(): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
  for (const item of draft.items) {
    delete item['stage'];
    // A call that turns the picture needs a picture to turn (D-383).
    delete item['revealsNext'];
  }
  return AuthoredScrollV2.parse(draft);
}
