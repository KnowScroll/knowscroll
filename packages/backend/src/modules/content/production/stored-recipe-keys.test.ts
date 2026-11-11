import { describe, expect, it } from 'vitest';
import { RECIPE_KEYS } from '../domain/library/index.js';
import {
  parseProductionRecipe,
  parseScrollTopic,
  planRefusalOf,
  productionVersionOf,
  REQUEST_BOUND_V2_PER_TOPIC,
  requestBoundOf,
  scrollV2PlanOf,
  SCROLL_PRODUCTION_V2_VERSION,
} from './topics.js';

const stored = 'gen-heart-valves-and-blood-flow-1a2b3c4d';

/** What the job queue and the job table decide from a recipe key alone, with no database: stored recipes are v2 recipes. */
describe('production keys of stored recipes (D-412)', () => {
  it('runs a stored recipe as a v2 recipe: the v2 production version and the v2 request bound', () => {
    expect(productionVersionOf(stored)).toBe(SCROLL_PRODUCTION_V2_VERSION);
    expect(requestBoundOf(stored)).toBe(REQUEST_BOUND_V2_PER_TOPIC);
    expect(scrollV2PlanOf(stored)).toEqual({ variant: 'plain', misconception: { kind: 'none' } });
    // Nothing the plan refuses applies: it has no myth to review.
    expect(planRefusalOf(stored)).toBeUndefined();
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
