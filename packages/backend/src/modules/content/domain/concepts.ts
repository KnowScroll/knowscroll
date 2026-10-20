/** Source-reviewed meanings, not personal knowledge or a content/coverage seed. */
export const CONCEPT_CATALOGUE_VERSION = 'content-concepts.v1' as const;
const definitions = [
  { id: 'earth', parent: null, meaning: 'Physical processes of Earth and its astronomical setting.', facets: [] },
  {
    id: 'earth.seasons',
    parent: 'earth',
    meaning: 'Seasonal changes caused by axial tilt and orbital geometry.',
    facets: [
      { id: 'earth.seasons.axial-tilt', meaning: 'Axial tilt changes solar angle and daylight through the year.' },
      {
        id: 'earth.seasons.hemispheres',
        meaning: 'Opposite hemispheres experience contrasting seasonal illumination.',
      },
      {
        id: 'earth.seasons.limits',
        meaning: 'Limits of simplified seasonal geometry, including the distance misconception.',
      },
    ],
  },
  {
    id: 'earth.tides',
    parent: 'earth',
    meaning: 'Ocean tides under differential gravitational forcing and local conditions.',
    facets: [
      { id: 'earth.tides.forcing', meaning: 'Differential lunar and solar gravity contributes to tidal forcing.' },
      { id: 'earth.tides.alignment', meaning: 'Sun and Moon alignment changes the combined tidal forcing.' },
      { id: 'earth.tides.coasts', meaning: 'Coastlines and basin dynamics limit simple global tide predictions.' },
    ],
  },
  {
    id: 'earth.greenhouse-effect',
    parent: 'earth',
    meaning: 'Atmospheric absorption and emission in Earth radiation balance.',
    facets: [
      { id: 'earth.greenhouse-effect.radiation', meaning: 'Greenhouse gases absorb and emit infrared radiation.' },
      {
        id: 'earth.greenhouse-effect.balance',
        meaning: 'Surface temperature changes until incoming and outgoing energy balance.',
      },
      {
        id: 'earth.greenhouse-effect.limits',
        meaning: 'The blanket analogy has limits and gases do not create energy.',
      },
    ],
  },
] as const;
export const CONCEPTS = Object.freeze(
  definitions.map((topic) =>
    Object.freeze({
      ...topic,
      facets: Object.freeze(topic.facets.map((facet) => Object.freeze(facet))),
    }),
  ),
);

/** Exact membership only: a prefix, personal label or model string cannot admit a relationship. */
export function conceptMeaning(topicId: string, facetId: string) {
  const topic = CONCEPTS.find((entry) => entry.id === topicId);
  const facet = topic?.facets.find((entry) => entry.id === facetId);
  return topic && facet
    ? { topicId: topic.id, topicMeaning: topic.meaning, facetId: facet.id, facetMeaning: facet.meaning }
    : undefined;
}
