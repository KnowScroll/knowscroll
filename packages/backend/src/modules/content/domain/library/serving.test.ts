import { describe, expect, it } from 'vitest';
import { RECIPES, type RecipeKey } from './index.js';
import {
  libraryRecipes,
  pickRecipeToProduce,
  planLibraryProduction,
  recipesServing,
  type LibraryRecipeStatus,
  type ScrollProductionState,
} from './serving.js';

const standing = (recipe: RecipeKey, state: ScrollProductionState): LibraryRecipeStatus => ({
  recipe,
  state,
  attempts: 0,
});

describe('which recipes serve a catalogue brief', () => {
  it('lists the recipes of a planet in plan order when no facet is asked for', () => {
    const served = recipesServing({ topicId: 'earth.greenhouse-effect' });
    expect(served[0]).toBe('greenhouse');
    expect(served.length).toBeGreaterThanOrEqual(3);
    for (const recipe of served) expect(RECIPES[recipe].topicId).toBe('earth.greenhouse-effect');
  });

  it('puts the recipe that teaches a facet before one that only covers it, and finds one for every facet', () => {
    const served = recipesServing({ topicId: 'earth.seasons', facetId: 'earth.seasons.axial-tilt' });
    expect(served.length).toBeGreaterThan(0);
    expect(RECIPES[served[0]!].facetId).toBe('earth.seasons.axial-tilt');
    const teachingCount = served.filter((recipe) => RECIPES[recipe].facetId === 'earth.seasons.axial-tilt').length;
    for (const recipe of served.slice(teachingCount))
      expect(RECIPES[recipe].supportingFacetId).toBe('earth.seasons.axial-tilt');
  });

  it('serves nothing for a meaning the plan does not hold', () => {
    expect(recipesServing({ topicId: 'earth.volcanoes' })).toEqual([]);
    expect(recipesServing({ topicId: 'earth.seasons', facetId: 'earth.seasons.volcanoes' })).toEqual([]);
  });
});

describe('which recipe to produce', () => {
  const candidates = ['seasons', 'tides', 'greenhouse'] as const;
  const choose = (states: Partial<Record<RecipeKey, ScrollProductionState>>) =>
    pickRecipeToProduce(candidates, (recipe) => states[recipe] ?? 'not_started');

  it('takes the first recipe that has not started', () => {
    expect(choose({})).toBe('seasons');
    expect(choose({ seasons: 'published', tides: 'stopped' })).toBe('greenhouse');
  });

  it('joins work that is already running before starting anything new', () => {
    expect(choose({ tides: 'running' })).toBe('tides');
  });

  it('chooses nothing when every recipe is published or stopped', () => {
    expect(choose({ seasons: 'published', tides: 'stopped', greenhouse: 'published' })).toBeUndefined();
  });
});

describe('what a library run queues', () => {
  it('queues recipes that have not started or are running, and skips the finished ones with the reason', () => {
    const plan = planLibraryProduction(
      [
        standing('seasons', 'published'),
        standing('tides', 'not_started'),
        standing('greenhouse', 'running'),
        standing('attention-mechanism', 'stopped'),
      ],
      { interactiveFirst: false },
    );
    expect(plan.queue).toEqual(['tides', 'greenhouse']);
    expect(plan.skipped).toEqual([
      { recipe: 'seasons', reason: 'published' },
      { recipe: 'attention-mechanism', reason: 'stopped' },
    ]);
  });

  it('puts interactive recipes first on request and keeps plan order within each group', () => {
    const all = libraryRecipes().map((recipe) => standing(recipe, 'not_started'));
    const plain = planLibraryProduction(all, { interactiveFirst: false }).queue;
    const interactiveFirst = planLibraryProduction(all, { interactiveFirst: true }).queue;
    expect(plain).toEqual(libraryRecipes());
    expect(interactiveFirst).toHaveLength(plain.length);
    const flags = interactiveFirst.map((recipe) => RECIPES[recipe].interactive);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(interactiveFirst.filter((recipe) => RECIPES[recipe].interactive)).toEqual(
      plain.filter((recipe) => RECIPES[recipe].interactive),
    );
  });
});
