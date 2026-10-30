import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type { ScrollV2Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import type { ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
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
 * Marks a library recipe as a v2 recipe for the duration of a test and returns the undo. No recipe of
 * the real plan is marked yet, so the tests mark one the way the plan will.
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
