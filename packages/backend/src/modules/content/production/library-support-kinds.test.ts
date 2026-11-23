import { afterEach, describe, expect, it } from 'vitest';
import { RECIPES } from '../domain/library/index.js';
import type { ScrollV3Plan } from '../domain/library/plan.js';
import { checkerVersionOfRecipe, LIBRARY_CHECKER_VERSIONS } from './library-support-kinds.js';

const PLAN: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};
const recipe = RECIPES.seasons as { scrollV3?: ScrollV3Plan };

describe('the checker version of the Scroll a recipe produces', () => {
  afterEach(() => {
    delete recipe.scrollV3;
  });

  it('is the v2 check’s for a recipe that is not planned as a document v3', () => {
    expect(checkerVersionOfRecipe('seasons')).toBe(LIBRARY_CHECKER_VERSIONS.v2);
  });

  it('is the v3 check’s for a recipe the plan marks scrollV3', () => {
    recipe.scrollV3 = PLAN;
    expect(checkerVersionOfRecipe('seasons')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });

  // #781: a stored recipe is a document v3 recipe (was: the v2 check's), so its key alone names the v3 check, with no lookup.
  it('is the v3 check’s for a stored recipe, whatever the plan marks', () => {
    expect(checkerVersionOfRecipe('gen-a-planet')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });
});
