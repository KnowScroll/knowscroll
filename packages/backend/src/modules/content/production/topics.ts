import { RECIPES, type RecipeKey } from '../domain/library/index.js';
import type { ScrollV2Plan } from '../domain/library/plan.js';

/** The current production recipe. A topic has one job per version; a new recipe is a new version. */
export const SCROLL_PRODUCTION_VERSION = 'scroll-production.v14';
/**
 * The production recipe of a recipe the plan marks `scrollV2`: the same job, with the v2 writer.
 * It is a version of its own, so a recipe already published as a v1 Scroll at v14 is a new job here
 * and its Scroll becomes a new revision of the same asset (D-129).
 */
export const SCROLL_PRODUCTION_V2_VERSION = 'scroll-production.v15';
/** One writer call and at most one repair, per take. */
export const REQUEST_BOUND_PER_TOPIC = 2;
export { MAX_TAKES_PER_RECIPE } from '../domain/library/serving.js';
/**
 * The explanation recipes the generator runs, by operator key. The plan itself (systems, planets,
 * facets, briefs and research pages) is code-owned data in `domain/library/`, one file per system.
 */
export const TOPICS = RECIPES;
export type ScrollTopic = RecipeKey;
/** Explicit explanation identity; only the original three share their approved Reel identity. */
export function explanationUnitFor(topic: ScrollTopic): string {
  return TOPICS[topic].explanationUnitId;
}
/** Parse a bounded, code-defined topic identifier. */
export function parseScrollTopic(raw: string | undefined): ScrollTopic | undefined {
  return raw !== undefined && Object.hasOwn(TOPICS, raw) ? (raw as ScrollTopic) : undefined;
}

/** What the plan decides for a v2 recipe, or `undefined` for a recipe that stays a v1 Scroll. */
export function scrollV2PlanOf(key: string): ScrollV2Plan | undefined {
  const topic = parseScrollTopic(key);
  return topic === undefined ? undefined : TOPICS[topic].scrollV2;
}

/**
 * The production recipe version of a job key: v15 for a recipe the plan marks v2, v14 for every
 * other recipe and for a Scroll ordered from code. Every place that names a job by recipe and
 * version asks here, so a v1 recipe's jobs are untouched.
 */
export function productionVersionOf(key: string): string {
  return scrollV2PlanOf(key) === undefined ? SCROLL_PRODUCTION_VERSION : SCROLL_PRODUCTION_V2_VERSION;
}

/** Every production version a job row may carry. */
export const PRODUCTION_VERSIONS: readonly string[] = [SCROLL_PRODUCTION_VERSION, SCROLL_PRODUCTION_V2_VERSION];
