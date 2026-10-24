import { RECIPE_KEYS, RECIPES, type RecipeKey } from './index.js';

/**
 * A recipe's job at one recipe version may be taken again after it was rejected, at most this many
 * times in all. A new take is a new business run: nothing the earlier takes sent is sent again.
 */
export const MAX_TAKES_PER_RECIPE = 3;

/** Where a recipe's Scroll stands, as far as choosing what to produce is concerned. */
export type ScrollProductionState =
  /** No admitted Scroll and no job at the current recipe version. */
  | 'not_started'
  /** A job is researching or writing it. */
  | 'running'
  /** Its Scroll is admitted. */
  | 'published'
  /** Every take so far was rejected and another may start. */
  | 'retryable'
  /** No take can start: one is of unknown outcome, the takes are used up, or its Scroll was withdrawn. */
  | 'stopped';

/** A production job's own state. */
export type ProductionJobState = 'research' | 'writer' | 'published' | 'rejected' | 'unknown';

/**
 * A recipe's standing from its takes at the current recipe version, in take order. A published job
 * or an unknown attempt ends it for good: only rejections can be taken again, up to
 * {@link MAX_TAKES_PER_RECIPE}. `admitted` says the recipe's Scroll is in the library. Pure.
 */
export function productionStanding(jobs: readonly ProductionJobState[], admitted: boolean): ScrollProductionState {
  if (admitted) return 'published';
  const latest = jobs.at(-1);
  if (latest === undefined) return 'not_started';
  if (latest === 'research' || latest === 'writer') return 'running';
  if (jobs.some((job) => job === 'unknown' || job === 'published')) return 'stopped';
  return jobs.length < MAX_TAKES_PER_RECIPE ? 'retryable' : 'stopped';
}

/** The take a send for the recipe should name: the next one after a rejection, the running one to resume, else the first. */
export function takeToSend(standing: ScrollProductionState, takes: number): number | undefined {
  switch (standing) {
    case 'not_started':
      return 1;
    case 'running':
      return takes;
    case 'retryable':
      return takes + 1;
    case 'published':
    case 'stopped':
      return undefined;
  }
}

/** A recipe's standing with the take a send for it should name (none when nothing can be sent). */
export interface ScrollProductionReading {
  readonly state: ScrollProductionState;
  readonly take?: number;
}

/** The catalogue meaning a person asked for: a planet, and optionally one angle on it. */
export interface CatalogueBrief {
  readonly topicId: string;
  readonly facetId?: string;
}

/** One recipe's standing for the operator's status list. */
export interface LibraryRecipeStatus {
  readonly recipe: RecipeKey;
  readonly state: ScrollProductionState;
  /** The latest take's own state at the current recipe version; absent before any job. */
  readonly job?: ProductionJobState;
  /** How many takes exist at the current recipe version. */
  readonly takes: number;
  /** The recipe's stable asset; present once a Scroll is admitted. */
  readonly assetId?: string;
  readonly revision?: number;
  /** Paid model attempts recorded on its jobs, across takes. */
  readonly attempts: number;
}

/** What a request for this catalogue meaning should produce, or `none` when nothing can. */
export type ScrollRecipeChoice =
  { readonly kind: 'recipe'; readonly recipe: RecipeKey; readonly take: number } | { readonly kind: 'none' };

/**
 * The recipes whose Scroll would satisfy the brief, best first: the recipes that teach the facet
 * itself, then those that cover it as their supporting facet. A brief without a facet is satisfied by
 * any recipe of the planet, in plan order. Pure; the plan guarantees every catalogue facet has one.
 */
export function recipesServing(brief: CatalogueBrief): readonly RecipeKey[] {
  const ofPlanet = RECIPE_KEYS.filter((key) => RECIPES[key].topicId === brief.topicId);
  if (brief.facetId === undefined) return ofPlanet;
  const teaching = ofPlanet.filter((key) => RECIPES[key].facetId === brief.facetId);
  const supporting = ofPlanet.filter((key) => RECIPES[key].supportingFacetId === brief.facetId);
  return [...teaching, ...supporting];
}

/**
 * Which recipe to produce for a brief: one already running (the request joins that work), else the
 * first that has not started, else the first whose rejected job may be taken again. Published and
 * stopped recipes are never chosen; `undefined` means nothing is left that could produce the Scroll.
 */
export function pickRecipeToProduce(
  candidates: readonly RecipeKey[],
  stateOf: (recipe: RecipeKey) => ScrollProductionState,
): RecipeKey | undefined {
  for (const wanted of ['running', 'not_started', 'retryable'] as const) {
    const found = candidates.find((recipe) => stateOf(recipe) === wanted);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every library recipe key, in plan order. */
export function libraryRecipes(): readonly RecipeKey[] {
  return RECIPE_KEYS;
}

/** A job to send: the recipe and the take to run. */
export interface ProductionSend {
  readonly recipe: RecipeKey;
  readonly take: number;
}

export interface LibraryProductionPlan {
  /** Jobs to send, in the order to send them. A take above 1 retries a rejected recipe. */
  readonly queue: readonly ProductionSend[];
  /** Recipes with nothing left to do: their Scroll exists, or no take can start. */
  readonly skipped: readonly { readonly recipe: RecipeKey; readonly reason: 'published' | 'stopped' }[];
}

/**
 * What an operator's library run sends jobs for. A recipe with an admitted Scroll needs none, and a
 * recipe that cannot be taken again is skipped with the reason. A `running` recipe is sent again on
 * purpose: its job is resumed, which recovers a run a crash or a spent budget left unfinished (a job
 * that is still queued or active is not duplicated). A rejected recipe gets its next take. Interactive
 * recipes go first on request, because they are the ones most likely to need attention.
 */
export function planLibraryProduction(
  standing: readonly LibraryRecipeStatus[],
  options: { readonly interactiveFirst: boolean },
): LibraryProductionPlan {
  const skipped = standing.flatMap((row) =>
    row.state === 'published' || row.state === 'stopped' ? [{ recipe: row.recipe, reason: row.state } as const] : [],
  );
  const queue = standing.flatMap((row): ProductionSend[] => {
    const take = takeToSend(row.state, row.takes);
    return take === undefined ? [] : [{ recipe: row.recipe, take }];
  });
  if (options.interactiveFirst)
    queue.sort((a, b) => Number(RECIPES[b.recipe].interactive) - Number(RECIPES[a.recipe].interactive));
  return { queue, skipped };
}
