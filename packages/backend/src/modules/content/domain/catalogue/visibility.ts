import type { ReleasedCoverage } from '../library/gap-facts.js';
import type { CatalogueSnapshot } from './snapshot.js';

/**
 * The topics that are not servable yet and now have the supply that makes them so (D-419): at least as many distinct released
 * explanations as the topic's own formation threshold (three), spread over at least as many of its own facets (two), by
 * default. That is the least a person needs to be able to form the planet, so a topic nobody can form is never offered,
 * matched, listed or made a room. Counted from released, coverage-mapped Scrolls only: a Scroll held for an operator's read, a
 * withdrawn one, a recipe or a request counts for nothing. `withheld` names the topics that are never made servable whatever supply they have: the
 * topics that grew (D-422) and the owner has not approved, which the caller reads from the table that holds the approval.
 */
export function topicsNowServable(
  snapshot: CatalogueSnapshot,
  coverage: ReleasedCoverage,
  withheld: ReadonlySet<string> = new Set(),
): readonly string[] {
  const supply = new Map(coverage.planets.map((planet) => [planet.topicId, planet]));
  return snapshot.allTopics().flatMap((topic) => {
    if (topic.servable || withheld.has(topic.id)) return [];
    const planet = supply.get(topic.id);
    if (planet === undefined) return [];
    const own = new Set(topic.facets.map((facet) => facet.id));
    const covered = planet.facets.filter((facet) => own.has(facet.facetId) && facet.units >= 1).length;
    return planet.units >= topic.policy.planetUnits && covered >= topic.policy.planetFacets ? [topic.id] : [];
  });
}
