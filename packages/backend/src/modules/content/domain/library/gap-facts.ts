import type { ScrollProductionState } from './serving.js';

/**
 * What the library can serve readers right now, by planet and facet (#674, D-414): the Scrolls that are admitted and released,
 * never one that is held for an operator's read or withdrawn. The gap loop's scan reads it to find the planets that are
 * thin and the facets that have nothing. Shared, nonpersonal.
 */
export interface ReleasedCoverage {
  /** Only planets with at least one released Scroll appear; a planet missing from the list has none. */
  readonly planets: readonly ReleasedPlanet[];
}

export interface ReleasedPlanet {
  readonly topicId: string;
  /** The distinct explanations (a Reel and its Scroll twin count once) with a released Scroll about the planet. */
  readonly units: number;
  /** Released explanations by facet; a facet with none is absent. */
  readonly facets: readonly { readonly facetId: string; readonly units: number }[];
}

/** One recipe that would serve a gap's planet, with where its production stands. */
export interface GapRecipe {
  readonly key: string;
  /** Stored in the database (`gen-…`), as the loop's proposals are; a code recipe is the operator's to produce. */
  readonly stored: boolean;
  readonly facetId: string;
  readonly state: ScrollProductionState;
  /** The take a send for it should name, when one can start or resume. */
  readonly take?: number;
}
