import { contentStems } from '../ask-support.js';
import type { CatalogueConcept, CatalogueSnapshot } from './snapshot.js';

/** How many topics a prompt that must choose among the catalogue's topics may show. */
export const SHORTLIST_TOPICS = 24;

/**
 * The topics a model is shown when it must choose one for a piece of text (D-419): all of the servable topics while there are
 * no more than `limit`, otherwise the `limit` whose label, meaning or facets share the most key words with the text, best first,
 * and none when no key word matches. Pure, and bounded however large the catalogue grows. A topic outside the shortlist cannot
 * be chosen, which is the point: the model is never asked to read ten thousand topics.
 */
export function shortlistTopics(
  snapshot: CatalogueSnapshot,
  text: string,
  limit: number = SHORTLIST_TOPICS,
): readonly CatalogueConcept[] {
  const topics = snapshot.topics();
  if (topics.length <= limit) return topics;
  const wanted = contentStems(text);
  if (wanted.size === 0) return [];
  const scored = topics.flatMap((topic, at) => {
    const own = contentStems(
      [topic.label, topic.meaning, ...topic.facets.flatMap((facet) => [facet.label, facet.meaning])].join(' '),
    );
    let shared = 0;
    for (const stem of wanted) if (own.has(stem)) shared += 1;
    return shared === 0 ? [] : [{ topic, shared, at }];
  });
  return scored
    .sort((a, b) => b.shared - a.shared || a.at - b.at)
    .slice(0, limit)
    .map((entry) => entry.topic);
}
