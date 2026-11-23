import { afterEach, describe, expect, it } from 'vitest';
import { RECIPES } from '../domain/library/index.js';
import type { ScrollV3Plan } from '../domain/library/plan.js';
import { checkerVersionOfRecipe, LIBRARY_CHECKER_VERSIONS } from './library-support-kinds.js';

const PLAN: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};
// A recipe the library keeps as a v2 recipe: the test marks it and takes the mark away, and the real v3 plans stay.
const recipe = RECIPES['seasons-elsewhere'] as { scrollV3?: ScrollV3Plan };

describe('the checker version of the Scroll a recipe produces', () => {
  afterEach(() => {
    delete recipe.scrollV3;
  });

  it('is the v2 check’s for a recipe that is not planned as a document v3, and for a stored recipe', () => {
    expect(checkerVersionOfRecipe('seasons-elsewhere')).toBe(LIBRARY_CHECKER_VERSIONS.v2);
    expect(checkerVersionOfRecipe('gen-a-planet')).toBe(LIBRARY_CHECKER_VERSIONS.v2);
  });

  it('is the v3 check’s for a recipe the plan marks scrollV3', () => {
    recipe.scrollV3 = PLAN;
    expect(checkerVersionOfRecipe('seasons-elsewhere')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });

  it('is the v3 check’s for a recipe the library plan marks scrollV3 since #787, with no mark from the test', () => {
    expect(checkerVersionOfRecipe('seasons')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
    expect(checkerVersionOfRecipe('action-potential')).toBe(LIBRARY_CHECKER_VERSIONS.v3);
  });
});
