import type { AnswerCheckSummary } from '../answer-check.js';
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
  /** A v2 Scroll was produced and waits for an operator to read and release it; no take can start (D-138). */
  | 'held'
  /** Every take so far was rejected and another may start. */
  | 'retryable'
  /** No take can start: one is of unknown outcome, the takes are used up, or its Scroll was withdrawn. */
  | 'stopped';

/**
 * A production job's own state, as far as a recipe's standing is concerned. `held`: the job published
 * its Scroll into the review gate and an operator has not decided yet. A job whose Scroll the gate
 * rejected is counted `rejected`, because the take is spent and the next may start (D-138).
 */
export type ProductionJobState = 'research' | 'writer' | 'published' | 'held' | 'rejected' | 'unknown';

/**
 * A recipe's standing from its takes at the current recipe version, in take order. A published job
 * or an unknown attempt ends it for good: only rejections can be taken again, up to
 * {@link MAX_TAKES_PER_RECIPE}. `admitted` says the recipe's Scroll is in the library. A job held for
 * review is neither: it waits for an operator, and only a rejection by the gate frees the next take. Pure.
 */
export function productionStanding(jobs: readonly ProductionJobState[], admitted: boolean): ScrollProductionState {
  if (admitted) return 'published';
  const latest = jobs.at(-1);
  if (latest === undefined) return 'not_started';
  if (latest === 'research' || latest === 'writer') return 'running';
  if (latest === 'held') return 'held';
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
    case 'held':
    case 'stopped':
      return undefined;
  }
}

/**
 * Where a recipe stands as far as making another take of its published Scroll goes (D-197). Only a v2
 * library recipe whose Scroll is served can be regenerated: the new take is stored held, the served
 * Scroll stays served until an operator releases the new one, and a recipe has at most three takes per
 * production version, which is what stops a loop of paid production.
 */
export type RegenerationState =
  /** The plan does not mark the recipe v2: it publishes without a read, so it is never regenerated. */
  | 'not_v2'
  /** No v2 Scroll is served yet; `produce-library` makes the first one. */
  | 'not_published'
  /** Another take may start. */
  | 'available'
  /** A take is queued or running. Sending it again resumes it. */
  | 'running'
  /** A new revision waits for an operator to release or reject it. */
  | 'held'
  /** The three takes of this production version are used; a new writer version gives new ones. */
  | 'spent'
  /** The latest take's outcome is unknown: reconcile it with `reasoning unknown` first. */
  | 'stopped';

/**
 * A recipe's regeneration state from its takes at the current production version, in take order.
 * `heldRevision` says a revision of the asset waits for a decision, whichever version made it. Pure.
 */
export function regenerationStanding(facts: {
  readonly v2: boolean;
  readonly admitted: boolean;
  readonly jobs: readonly ProductionJobState[];
  readonly heldRevision: boolean;
}): RegenerationState {
  if (!facts.v2) return 'not_v2';
  if (!facts.admitted) return 'not_published';
  const latest = facts.jobs.at(-1);
  if (latest === 'research' || latest === 'writer') return 'running';
  if (latest === 'held' || facts.heldRevision) return 'held';
  if (facts.jobs.includes('unknown')) return 'stopped';
  return facts.jobs.length < MAX_TAKES_PER_RECIPE ? 'available' : 'spent';
}

/** The take a regeneration should send: the next one, or the running one to resume. */
export function regenerationTake(state: RegenerationState, takes: number): number | undefined {
  if (state === 'available') return takes + 1;
  return state === 'running' ? takes : undefined;
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
  /** The held revision waiting for an operator, when the recipe's standing is `held`. */
  readonly heldRevision?: number;
  /** Paid model attempts recorded on its jobs, across takes. */
  readonly attempts: number;
  /** Whether another take of its served Scroll may be made, and why not (D-197). */
  readonly regeneration?: RegenerationState;
  /** Takes still unused at the current production version; present for a v2 library recipe. */
  readonly takesLeft?: number;
  /** What the answer check said about the latest take; absent when no check ran for it. */
  readonly check?: AnswerCheckSummary;
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

/** Why a recipe is not regenerated now: its `RegenerationState`, which is also what the operator reads. */
export type RegenerationSkip = Exclude<RegenerationState, 'available' | 'running'>;

export interface RegenerationPlan {
  /** Takes to send, in plan order. A running take is sent again to resume it; a job already queued is not doubled. */
  readonly queue: readonly ProductionSend[];
  readonly skipped: readonly { readonly recipe: RecipeKey; readonly reason: RegenerationSkip }[];
}

/**
 * What `content regenerate` sends: the next take of every recipe whose served v2 Scroll may be made
 * again, and the running take of one that is under way. Every other recipe is skipped with the reason.
 * It never starts a first production (that is `produce-library`'s) and never a take past the third. Pure.
 */
export function planRegeneration(standing: readonly LibraryRecipeStatus[]): RegenerationPlan {
  const queue: ProductionSend[] = [];
  const skipped: { recipe: RecipeKey; reason: RegenerationSkip }[] = [];
  for (const row of standing) {
    const state = row.regeneration ?? 'not_v2';
    const take = regenerationTake(state, row.takes);
    if (take !== undefined) queue.push({ recipe: row.recipe, take });
    else if (state !== 'available' && state !== 'running') skipped.push({ recipe: row.recipe, reason: state });
  }
  return { queue, skipped };
}

export interface LibraryProductionPlan {
  /** Jobs to send, in the order to send them. A take above 1 retries a rejected recipe. */
  readonly queue: readonly ProductionSend[];
  /** Recipes with nothing left to do: their Scroll exists, or no take can start. */
  readonly skipped: readonly { readonly recipe: RecipeKey; readonly reason: 'published' | 'held' | 'stopped' }[];
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
    row.state === 'published' || row.state === 'held' || row.state === 'stopped'
      ? [{ recipe: row.recipe, reason: row.state } as const]
      : [],
  );
  const queue = standing.flatMap((row): ProductionSend[] => {
    const take = takeToSend(row.state, row.takes);
    return take === undefined ? [] : [{ recipe: row.recipe, take }];
  });
  if (options.interactiveFirst)
    queue.sort((a, b) => Number(RECIPES[b.recipe].interactive) - Number(RECIPES[a.recipe].interactive));
  return { queue, skipped };
}
