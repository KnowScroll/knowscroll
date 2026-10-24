import { LIBRARY_SYSTEMS } from './library/index.js';

/**
 * Source-reviewed meanings, not personal knowledge or a content/coverage seed. The catalogue is
 * derived from the library plan, so a system, topic or facet exists exactly where the plan declares
 * it. Its digest covers every entry: changing the plan changes the digest, and coverage decided
 * against an earlier digest is corrected by appending new heads (see the content README).
 */
export const CONCEPT_CATALOGUE_VERSION = 'content-concepts.v1' as const;

export interface Concept {
  readonly id: string;
  /** The system a topic belongs to; `null` for a system. */
  readonly parent: string | null;
  readonly meaning: string;
  /** The angles a topic can be explained from; always empty for a system. */
  readonly facets: readonly { readonly id: string; readonly meaning: string }[];
}

function freezeConcept(concept: Concept): Concept {
  return Object.freeze({ ...concept, facets: Object.freeze(concept.facets.map((facet) => Object.freeze(facet))) });
}

export const CONCEPTS: readonly Concept[] = Object.freeze(
  LIBRARY_SYSTEMS.flatMap((system) => [
    freezeConcept({ id: system.id, parent: null, meaning: system.meaning, facets: [] }),
    ...system.topics.map((topic) =>
      freezeConcept({
        id: topic.id,
        parent: system.id,
        meaning: topic.meaning,
        facets: topic.facets.map(({ id, meaning }) => ({ id, meaning })),
      }),
    ),
  ]),
);

/** Exact membership only: a prefix, personal label or model string cannot admit a relationship. */
export function conceptMeaning(topicId: string, facetId: string) {
  const topic = CONCEPTS.find((entry) => entry.id === topicId);
  const facet = topic?.facets.find((entry) => entry.id === facetId);
  return topic && facet
    ? { topicId: topic.id, topicMeaning: topic.meaning, facetId: facet.id, facetMeaning: facet.meaning }
    : undefined;
}

const phrase = (id: string) => id.replaceAll('-', ' ');

/**
 * A short plain label for a catalogue meaning, made from its id: `earth.greenhouse-effect` is
 * "Greenhouse effect" and its facet `earth.greenhouse-effect.radiation` adds ": radiation". For a
 * person's list of requests, never a claim about what a Scroll says.
 */
export function conceptLabel(topicId: string, facetId?: string): string {
  const topic = phrase(topicId.slice(topicId.lastIndexOf('.') + 1));
  const heading = topic.charAt(0).toUpperCase() + topic.slice(1);
  if (facetId === undefined || !facetId.startsWith(`${topicId}.`)) return heading;
  return `${heading}: ${phrase(facetId.slice(topicId.length + 1))}`;
}
