import { describe, expect, it } from 'vitest';
import { RECIPES, type RecipeKey } from './index.js';
import {
  libraryRecipes,
  MAX_TAKES_PER_RECIPE,
  pickRecipeToProduce,
  planLibraryProduction,
  productionStanding,
  recipesServing,
  takeToSend,
  type LibraryRecipeStatus,
  type ScrollProductionState,
} from './serving.js';

const takesOf: Record<ScrollProductionState, number> = {
  not_started: 0,
  running: 1,
  published: 1,
  held: 1,
  retryable: 1,
  stopped: 3,
};
const standing = (recipe: RecipeKey, state: ScrollProductionState): LibraryRecipeStatus => ({
  recipe,
  state,
  takes: takesOf[state],
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

  it('retries a rejected recipe only when nothing untried or running is left', () => {
    expect(choose({ seasons: 'retryable' })).toBe('tides');
    expect(choose({ seasons: 'retryable', tides: 'published', greenhouse: 'stopped' })).toBe('seasons');
    expect(choose({ seasons: 'retryable', tides: 'running' })).toBe('tides');
  });

  it('chooses nothing when every recipe is published or stopped', () => {
    expect(choose({ seasons: 'published', tides: 'stopped', greenhouse: 'published' })).toBeUndefined();
  });
});

describe('what a library run queues', () => {
  it('queues the first take of a recipe not started, resumes a running one, takes a rejected one again, and skips the rest with the reason', () => {
    const plan = planLibraryProduction(
      [
        standing('seasons', 'published'),
        standing('tides', 'not_started'),
        standing('greenhouse', 'running'),
        standing('attention-mechanism', 'stopped'),
        standing('hash-tables', 'retryable'),
      ],
      { interactiveFirst: false },
    );
    expect(plan.queue).toEqual([
      { recipe: 'tides', take: 1 },
      { recipe: 'greenhouse', take: 1 },
      { recipe: 'hash-tables', take: 2 },
    ]);
    expect(plan.skipped).toEqual([
      { recipe: 'seasons', reason: 'published' },
      { recipe: 'attention-mechanism', reason: 'stopped' },
    ]);
  });

  it('puts interactive recipes first on request and keeps plan order within each group', () => {
    const all = libraryRecipes().map((recipe) => standing(recipe, 'not_started'));
    const plain = planLibraryProduction(all, { interactiveFirst: false }).queue.map((send) => send.recipe);
    const interactiveFirst = planLibraryProduction(all, { interactiveFirst: true }).queue.map((send) => send.recipe);
    expect(plain).toEqual(libraryRecipes());
    expect(interactiveFirst).toHaveLength(plain.length);
    const flags = interactiveFirst.map((recipe) => RECIPES[recipe].interactive);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(interactiveFirst.filter((recipe) => RECIPES[recipe].interactive)).toEqual(
      plain.filter((recipe) => RECIPES[recipe].interactive),
    );
  });
});

describe('takes of a recipe', () => {
  it('starts with no job, and runs while a job is researching or writing', () => {
    expect(productionStanding([], false)).toBe('not_started');
    expect(productionStanding(['research'], false)).toBe('running');
    expect(productionStanding(['writer'], false)).toBe('running');
    expect(productionStanding(['rejected', 'writer'], false)).toBe('running');
  });

  it('can be taken again after rejections, at most three takes in all', () => {
    expect(MAX_TAKES_PER_RECIPE).toBe(3);
    expect(productionStanding(['rejected'], false)).toBe('retryable');
    expect(productionStanding(['rejected', 'rejected'], false)).toBe('retryable');
    expect(productionStanding(['rejected', 'rejected', 'rejected'], false)).toBe('stopped');
  });

  it('never takes a recipe again after an unknown attempt or a published job', () => {
    expect(productionStanding(['unknown'], false)).toBe('stopped');
    expect(productionStanding(['rejected', 'unknown'], false)).toBe('stopped');
    expect(productionStanding(['published'], false)).toBe('stopped');
    expect(productionStanding(['rejected', 'published'], false)).toBe('stopped');
  });

  it('is published whenever its Scroll is admitted, whatever the jobs say', () => {
    expect(productionStanding([], true)).toBe('published');
    expect(productionStanding(['rejected'], true)).toBe('published');
  });

  it('names the take a send should run', () => {
    expect(takeToSend('not_started', 0)).toBe(1);
    expect(takeToSend('running', 2)).toBe(2);
    expect(takeToSend('retryable', 1)).toBe(2);
    expect(takeToSend('retryable', 2)).toBe(3);
    expect(takeToSend('stopped', 3)).toBeUndefined();
    expect(takeToSend('published', 1)).toBeUndefined();
  });
});
