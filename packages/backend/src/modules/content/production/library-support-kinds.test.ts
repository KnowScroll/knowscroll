import { afterEach, describe, expect, it } from 'vitest';
import { RECIPES } from '../domain/library/index.js';
import type { ScrollV3Plan } from '../domain/library/plan.js';
import { checkerVersionOfRecipe, LIBRARY_CHECKER_VERSIONS } from './library-support-kinds.js';

const PLAN: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};
// The library plans every recipe as a document v3 Scroll since #790: a test of the v2 check takes this recipe's plan away and puts it back.
const recipe = RECIPES['seasons-elsewhere'] as { scrollV3?: ScrollV3Plan };
const planned = recipe.scrollV3;

describe('the checker version of the Scroll a recipe produces', () => {
  afterEach(() => {
    if (planned === undefined) delete recipe.scrollV3;
    else recipe.scrollV3 = planned;
  });

  it('is the v2 check’s for a recipe that is not planned as a document v3', () => {
    delete recipe.scrollV3;
    expect(checkerVersionOfRecipe('seasons-elsewhere')).toBe(LIBRARY_CHECKER_VERSIONS.v2);
  });

  it('is the v3 check’s for a recipe the plan marks scrollV3', () => {
    recipe.scrollV3 = PLAN;
    expect(checkerVersionOfRecipe('seasons-elsewhere')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });

  it('is the v3 check’s for a recipe the library plan marks scrollV3 since #787 and #790, with no mark from the test', () => {
    expect(checkerVersionOfRecipe('seasons-elsewhere')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
    expect(checkerVersionOfRecipe('seasons')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
    expect(checkerVersionOfRecipe('action-potential')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });

  // #781: a stored recipe is a document v3 recipe (was: the v2 check's), so its key alone names the v3 check, with no lookup.
  it('is the v3 check’s for a stored recipe, whatever the plan marks', () => {
    expect(checkerVersionOfRecipe('gen-a-planet')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });
});
