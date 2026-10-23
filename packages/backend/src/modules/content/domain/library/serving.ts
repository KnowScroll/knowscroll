import { RECIPE_KEYS, RECIPES, type RecipeKey } from './index.js';

/** Where a recipe's Scroll stands, as far as choosing what to produce is concerned. */
export type ScrollProductionState =
  /** No admitted Scroll and no job at the current recipe version. */
  | 'not_started'
  /** A job is researching or writing it. */
  | 'running'
  /** Its Scroll is admitted. */
  | 'published'
  /** The job at the current recipe version ended without a Scroll; it is never run again. */
  | 'stopped';

/** The catalogue meaning a person asked for: a planet, and optionally one angle on it. */
export interface CatalogueBrief {
  readonly topicId: string;
  readonly facetId?: string;
}

/** One recipe's standing for the operator's status list. */
export interface LibraryRecipeStatus {
  readonly recipe: RecipeKey;
  readonly state: ScrollProductionState;
  /** The job's own state at the current recipe version; absent before any job. */
  readonly job?: 'research' | 'writer' | 'published' | 'rejected' | 'unknown';
  /** The recipe's stable asset; present once a Scroll is admitted. */
  readonly assetId?: string;
  readonly revision?: number;
  /** Paid model attempts recorded on the job. */
  readonly attempts: number;
}

/** What a request for this catalogue meaning should produce, or `none` when nothing can. */
export type ScrollRecipeChoice = { readonly kind: 'recipe'; readonly recipe: RecipeKey } | { readonly kind: 'none' };

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
 * first that has not started. Published and stopped recipes are never chosen; `undefined` means
 * nothing is left that could produce the Scroll.
 */
export function pickRecipeToProduce(
  candidates: readonly RecipeKey[],
  stateOf: (recipe: RecipeKey) => ScrollProductionState,
): RecipeKey | undefined {
  return (
    candidates.find((recipe) => stateOf(recipe) === 'running') ??
    candidates.find((recipe) => stateOf(recipe) === 'not_started')
  );
}

/** Every library recipe key, in plan order. */
export function libraryRecipes(): readonly RecipeKey[] {
  return RECIPE_KEYS;
}

export interface LibraryProductionPlan {
  /** Recipes to send a job for, in the order to send them. */
  readonly queue: readonly RecipeKey[];
  /** Recipes with nothing left to do: their Scroll exists, or their job ended without one. */
  readonly skipped: readonly { readonly recipe: RecipeKey; readonly reason: 'published' | 'stopped' }[];
}

/**
 * What an operator's library run sends jobs for. A recipe with an admitted Scroll needs none, and a
 * recipe whose job already ended at this version cannot run again. A `running` recipe is queued
 * again on purpose: its job is resumed, which recovers a run a crash left unfinished (the job ID is
 * stable, so a job that still exists is not duplicated). Interactive recipes go first on request,
 * because they are the ones most likely to need attention.
 */
export function planLibraryProduction(
  standing: readonly LibraryRecipeStatus[],
  options: { readonly interactiveFirst: boolean },
): LibraryProductionPlan {
  const skipped = standing.flatMap((row) =>
    row.state === 'published' || row.state === 'stopped' ? [{ recipe: row.recipe, reason: row.state } as const] : [],
  );
  const queue = standing
    .filter((row) => row.state === 'not_started' || row.state === 'running')
    .map((row) => row.recipe);
  if (options.interactiveFirst) queue.sort((a, b) => Number(RECIPES[b].interactive) - Number(RECIPES[a].interactive));
  return { queue, skipped };
}
