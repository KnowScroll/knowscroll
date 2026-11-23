import { describe, expect, it } from 'vitest';
import { RECIPE_KEYS } from '../domain/library/index.js';
import {
  parseProductionRecipe,
  parseScrollTopic,
  planRefusalOf,
  productionVersionOf,
  REQUEST_BOUND_V3_PER_TOPIC,
  requestBoundOf,
  scrollV2PlanOf,
  scrollV3PlanOf,
  SCROLL_PRODUCTION_V3_VERSION,
  storedPlanRefusalOf,
} from './topics.js';
import { isHeldForReview } from './review-hold.js';
import { plannedDocumentVersionOf } from '../adapters/production-state.js';

const stored = 'gen-heart-valves-and-blood-flow-1a2b3c4d';

/** What the job queue and the job table decide from a recipe key alone, with no database: a stored recipe is a document v3 recipe (#781). */
describe('production keys of stored recipes (D-412, #781)', () => {
  it('runs a stored recipe as a document v3 recipe: the v3 production version and the v3 request bound', () => {
    expect(productionVersionOf(stored)).toBe(SCROLL_PRODUCTION_V3_VERSION);
    expect(requestBoundOf(stored)).toBe(REQUEST_BOUND_V3_PER_TOPIC);
    expect(plannedDocumentVersionOf(stored)).toBe('scroll-document.v3');
    // It has no v2 plan any more, and its key-only v3 plan is a marker: no misconception, no pictures.
    expect(scrollV2PlanOf(stored)).toBeUndefined();
    expect(scrollV3PlanOf(stored)).toMatchObject({ misconception: { kind: 'none' } });
    expect(scrollV3PlanOf(stored)?.pictures).toBeUndefined();
    // Nothing the plan refuses applies: it has no myth to review.
    expect(planRefusalOf(stored)).toBeUndefined();
  });

  it('decides the same for every stored key, whatever its row holds (the key alone is enough)', () => {
    for (const key of ['gen-a-11111111', 'gen-how-the-sea-rises-twice-a-day-aabbccdd']) {
      expect(productionVersionOf(key)).toBe(SCROLL_PRODUCTION_V3_VERSION);
      expect(requestBoundOf(key, 'question')).toBe(REQUEST_BOUND_V3_PER_TOPIC);
      expect(scrollV2PlanOf(key)).toBeUndefined();
    }
  });

  it('holds a stored recipe for review: its subject carries a document v3 plan', () => {
    expect(isHeldForReview({ attribution: 'library', scrollV3: scrollV3PlanOf(stored)! })).toBe(true);
  });

  it('refuses, as a plan problem, a stored recipe whose row has no document v3 plan, and nothing else', () => {
    // A row that held a v2 plan (the database no longer writes one) must not be written by the v3 version silently.
    expect(storedPlanRefusalOf(stored, {})).toBe('stored_recipe_plan_not_v3');
    expect(storedPlanRefusalOf(stored, { scrollV3: scrollV3PlanOf(stored) })).toBeUndefined();
    // A code recipe and an order are never refused here, with or without a v3 plan.
    expect(storedPlanRefusalOf('seasons', {})).toBeUndefined();
    expect(storedPlanRefusalOf(`order-${'a'.repeat(32)}`, {})).toBeUndefined();
  });

  it('leaves a code recipe exactly as it was', () => {
    for (const key of RECIPE_KEYS) {
      expect(parseScrollTopic(key)).toBe(key);
      expect(parseProductionRecipe(key)).toBe(key);
    }
    expect(parseScrollTopic(stored)).toBeUndefined();
  });

  it('accepts a stored key by its shape and nothing else that is not a recipe', () => {
    expect(parseProductionRecipe(stored)).toBe(stored);
    expect(parseProductionRecipe('gen-')).toBeUndefined();
    expect(parseProductionRecipe('unknown-recipe')).toBeUndefined();
    expect(parseProductionRecipe(undefined)).toBeUndefined();
    expect(parseProductionRecipe('order-0123456789abcdef0123456789abcdef')).toBeUndefined();
  });
});
