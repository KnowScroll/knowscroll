import { RECIPES, type RecipeKey } from '../domain/library/index.js';

/** Reviewed production recipe, including role prompt changes; new versions never resume old jobs. */
export const SCROLL_PRODUCTION_VERSION = 'scroll-production.v13';
export const REQUEST_BOUND_PER_TOPIC = 4;
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
