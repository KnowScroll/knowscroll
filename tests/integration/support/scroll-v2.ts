import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type { ScrollV2Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
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

/**
 * Marks a library recipe as a v2 recipe for the duration of a test and returns the undo. The plan marks
 * the four Seasons recipes (D-137); a test uses this for another recipe, or for a different plan.
 */
export function markScrollV2(key: ScrollTopic, plan: ScrollV2Plan): () => void {
  const recipe = RECIPES[key] as { scrollV2?: ScrollV2Plan };
  const before = recipe.scrollV2;
  recipe.scrollV2 = plan;
  return () => {
    if (before === undefined) delete recipe.scrollV2;
    else recipe.scrollV2 = before;
  };
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
 * the four Seasons recipes v2; this is how a test publishes the v1 revision that a v2 regeneration
 * follows, the way the library's Scrolls were before D-137.
 */
export function markScrollV1(key: ScrollTopic): () => void {
  const recipe = RECIPES[key] as { scrollV2?: ScrollV2Plan };
  const before = recipe.scrollV2;
  delete recipe.scrollV2;
  return () => {
    if (before !== undefined) recipe.scrollV2 = before;
  };
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
  for (const item of draft.items) delete item['stage'];
  return AuthoredScrollV2.parse(draft);
}
