import { describe, expect, it } from 'vitest';
import { RECIPES, type RecipeKey } from './index.js';
import {
  libraryRecipes,
  MAX_TAKES_PER_RECIPE,
  pickRecipeToProduce,
  planLibraryProduction,
  planRegeneration,
  productionStanding,
  recipesServing,
  regenerationStanding,
  regenerationTake,
  takeToSend,
  type LibraryRecipeStatus,
  type ProductionJobState,
  type RegenerationState,
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

describe('regenerating a served v2 Scroll (D-197)', () => {
  const stand = (
    jobs: readonly ProductionJobState[],
    overrides: { v2?: boolean; admitted?: boolean; heldRevision?: boolean } = {},
  ) => regenerationStanding({ v2: true, admitted: true, jobs, heldRevision: false, ...overrides });

  it('applies only to a v2 recipe whose Scroll is served, and says why otherwise', () => {
    expect(stand([], { v2: false })).toBe('not_v2');
    expect(stand([], { admitted: false })).toBe('not_published');
    expect(stand(['rejected'], { admitted: false })).toBe('not_published');
  });

  it('may take a published recipe again until its three takes of the production version are used', () => {
    expect(stand([])).toBe('available');
    expect(stand(['published'])).toBe('available');
    expect(stand(['published', 'rejected'])).toBe('available');
    expect(stand(['published', 'published'])).toBe('available');
    expect(stand(['published', 'published', 'published'])).toBe('spent');
    expect(stand(['rejected', 'rejected', 'rejected'])).toBe('spent');
  });

  it('waits while a take runs or a revision waits for a decision, and stops at an attempt of unknown outcome', () => {
    expect(stand(['published', 'writer'])).toBe('running');
    expect(stand(['research'])).toBe('running');
    expect(stand(['published', 'held'])).toBe('held');
    // A revision an earlier production version left held blocks a new one too: decide it first.
    expect(stand([], { heldRevision: true })).toBe('held');
    expect(stand(['published', 'unknown'])).toBe('stopped');
  });

  it('names the take to send: the next after a finished one, the running one to resume, none otherwise', () => {
    const states: RegenerationState[] = ['not_v2', 'not_published', 'available', 'running', 'held', 'spent', 'stopped'];
    expect(states.map((state) => regenerationTake(state, 2))).toEqual([
      undefined,
      undefined,
      3,
      2,
      undefined,
      undefined,
      undefined,
    ]);
    expect(regenerationTake('available', 0)).toBe(1);
  });

  it('queues the next take of the recipes that may be regenerated, resumes a running one and skips the rest with the reason', () => {
    const row = (recipe: RecipeKey, regeneration: RegenerationState, takes: number): LibraryRecipeStatus => ({
      recipe,
      state: 'published',
      takes,
      attempts: 0,
      regeneration,
    });
    const plan = planRegeneration([
      row('seasons', 'available', 1),
      row('seasons-hemispheres', 'running', 2),
      row('seasons-limits', 'held', 2),
      row('seasons-elsewhere', 'spent', 3),
      row('tides', 'not_v2', 0),
      row('greenhouse', 'not_published', 0),
      row('cardiac-cycle', 'stopped', 1),
      row('dns-lookup', 'available', 0),
    ]);
    expect(plan.queue).toEqual([
      { recipe: 'seasons', take: 2 },
      { recipe: 'seasons-hemispheres', take: 2 },
      { recipe: 'dns-lookup', take: 1 },
    ]);
    expect(plan.skipped).toEqual([
      { recipe: 'seasons-limits', reason: 'held' },
      { recipe: 'seasons-elsewhere', reason: 'spent' },
      { recipe: 'tides', reason: 'not_v2' },
      { recipe: 'greenhouse', reason: 'not_published' },
      { recipe: 'cardiac-cycle', reason: 'stopped' },
    ]);
  });

  it('treats a status with no regeneration state as not regenerable, never as available', () => {
    const plan = planRegeneration([{ recipe: 'seasons', state: 'published', takes: 1, attempts: 0 }]);
    expect(plan.queue).toEqual([]);
    expect(plan.skipped).toEqual([{ recipe: 'seasons', reason: 'not_v2' }]);
  });
});
