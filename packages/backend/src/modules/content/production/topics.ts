/** Reviewed production recipe, including role prompt changes; new versions never resume old jobs. */
export const SCROLL_PRODUCTION_VERSION = 'scroll-production.v3';
export const REQUEST_BOUND_PER_TOPIC = 4;
export const TOPICS = {
  seasons: {
    script: 'seasons-v5',
    assetId: 'af2628f1-98a7-4c39-9f81-628506d247a1',
    brief:
      'Why Earth has seasons: axial tilt changes daylight and sunlight angle; distance is not the cause. Include a useful interactive diagram with frames for opposite hemispheres. Explain the limits of the simplified picture.',
    pages: ['https://spaceplace.nasa.gov/seasons/en/'],
  },
  tides: {
    script: 'tides-v4',
    assetId: '8349204a-0c98-45d3-a354-6c73be4a86de',
    brief:
      'How the Moon and Sun make tides: differential gravity, both tidal bulges, spring and neap alignment, real coastlines. Include an interactive diagram. Avoid implying the far bulge is a pile of water pulled through Earth or that every coast has the same timing.',
    pages: [
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides03_gravity.html',
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides06_variations.html',
    ],
  },
  greenhouse: {
    script: 'greenhouse',
    assetId: 'a73a7732-a154-4c10-aa6f-169fa10cd8aa',
    brief:
      'The greenhouse effect, a blanket made of gas: sunlight heats the surface; infrared absorption and emission slow cooling to space; the surface warms until energy balances. The blanket is an analogy, gases do not create energy or act as a solid lid. Distinguish the natural effect from strengthening it. Use comparison or disclosure.',
    pages: ['https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/'],
  },
} as const;
export type ScrollTopic = keyof typeof TOPICS;
/** The same explanation identity as its owner-approved imported Reel sibling. */
export function explanationUnitFor(topic: ScrollTopic): string {
  return `legacy-cutroom-${TOPICS[topic].script}`;
}
/** Parse a bounded, code-defined topic identifier. */
export function parseScrollTopic(raw: string | undefined): ScrollTopic | undefined {
  return raw !== undefined && Object.hasOwn(TOPICS, raw) ? (raw as ScrollTopic) : undefined;
}
