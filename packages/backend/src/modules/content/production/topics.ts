import { RECIPES, type RecipeKey } from '../domain/library/index.js';
import type { ScrollV2Plan } from '../domain/library/plan.js';

/** The current production recipe. A topic has one job per version; a new recipe is a new version. */
export const SCROLL_PRODUCTION_VERSION = 'scroll-production.v14';
/**
 * The production recipe of a recipe the plan marks `scrollV2`: the same job, with the v2 writer.
 * It is a version of its own, so a recipe already published as a v1 Scroll at v14 is a new job here
 * and its Scroll becomes a new revision of the same asset (D-129).
 *
 * A recipe has at most three takes per production version (D-197), so this version is what bounds paid
 * production: it must change whenever the writer's instructions or the job's steps change, which gives
 * every recipe fresh takes. v16: the answer check joined the job (D-198), on writer `scroll-writer.v16`.
 * `versions.test.ts` pins the pair, so a writer bump cannot go in without this one.
 */
export const SCROLL_PRODUCTION_V2_VERSION = 'scroll-production.v16';
/** One writer call and at most one repair, per take. */
export const REQUEST_BOUND_PER_TOPIC = 2;
/**
 * A v2 library recipe's take sends at most six paid requests: the writer once and at most one repair
 * (two, whichever repairs it: the validator or the answer check), and the answer check once for each of
 * the two drafts the writer can produce, each with at most one repair of an unusable reply (D-198).
 */
export const REQUEST_BOUND_V2_PER_TOPIC = 6;
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
 * Why the plan does not let a recipe be produced at all, or `undefined`. A v2 recipe whose
 * misconception source label no person has reviewed is a plan problem: the library admits only
 * reviewed labels, so no request is spent on it until the plan says `reviewed` (D-129).
 */
export function planRefusalOf(key: string): 'misconception_source_unreviewed' | undefined {
  const misconception = scrollV2PlanOf(key)?.misconception;
  return misconception?.kind === 'myth' && !misconception.source.reviewed
    ? 'misconception_source_unreviewed'
    : undefined;
}

/**
 * The production recipe version of a job key: v15 for a recipe the plan marks v2, v14 for every
 * other recipe and for a Scroll ordered from code. Every place that names a job by recipe and
 * version asks here, so a v1 recipe's jobs are untouched.
 */
export function productionVersionOf(key: string): string {
  return scrollV2PlanOf(key) === undefined ? SCROLL_PRODUCTION_VERSION : SCROLL_PRODUCTION_V2_VERSION;
}

/** The most paid model requests one take of this recipe, or order, may send. */
export function requestBoundOf(key: string): number {
  return scrollV2PlanOf(key) === undefined ? REQUEST_BOUND_PER_TOPIC : REQUEST_BOUND_V2_PER_TOPIC;
}

/** Every production version a job row may carry. */
export const PRODUCTION_VERSIONS: readonly string[] = [SCROLL_PRODUCTION_VERSION, SCROLL_PRODUCTION_V2_VERSION];
