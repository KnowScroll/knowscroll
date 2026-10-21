/** Reviewed production recipe, including role prompt changes; new versions never resume old jobs. */
export const SCROLL_PRODUCTION_VERSION = 'scroll-production.v12';
export const REQUEST_BOUND_PER_TOPIC = 4;
export const TOPICS = {
  seasons: {
    explanationUnitId: 'legacy-cutroom-seasons-v5',
    interactive: true,
    script: 'seasons-v5',
    topicId: 'earth.seasons',
    assetId: 'af2628f1-98a7-4c39-9f81-628506d247a1',
    brief:
      'Why Earth has seasons: axial tilt changes daylight and sunlight angle; distance is not the cause. Include a useful interactive diagram with frames for opposite hemispheres. Explain the limits of the simplified picture.',
    pages: ['https://spaceplace.nasa.gov/seasons/en/'],
  },
  tides: {
    explanationUnitId: 'legacy-cutroom-tides-v4',
    interactive: true,
    script: 'tides-v4',
    topicId: 'earth.tides',
    assetId: '8349204a-0c98-45d3-a354-6c73be4a86de',
    brief:
      'How the Moon and Sun make tides: differential gravity, both tidal bulges, spring and neap alignment, real coastlines. Include an interactive diagram. Avoid implying the far bulge is a pile of water pulled through Earth or that every coast has the same timing.',
    pages: [
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides03_gravity.html',
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides06_variations.html',
    ],
  },
  greenhouse: {
    explanationUnitId: 'legacy-cutroom-greenhouse',
    interactive: false,
    script: 'greenhouse',
    topicId: 'earth.greenhouse-effect',
    assetId: 'a73a7732-a154-4c10-aa6f-169fa10cd8aa',
    brief:
      'The greenhouse effect, a blanket made of gas: sunlight heats the surface; infrared absorption and emission slow cooling to space; the surface warms until energy balances. The blanket is an analogy, gases do not create energy or act as a solid lid. Distinguish the natural effect from strengthening it. Use comparison or disclosure.',
    pages: ['https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/'],
  },
  'greenhouse-radiation': {
    explanationUnitId: 'earth-greenhouse-radiation-paths-v1',
    interactive: true,
    topicId: 'earth.greenhouse-effect',
    assetId: '76b65d2e-991a-4be8-9d70-aab9f275396c',
    brief:
      'Follow the radiation paths: how do incoming sunlight and outgoing thermal radiation interact differently with the surface and atmosphere? Focus on reflection, absorption and emission, including atmospheric emission toward both space and the surface. Require an interactive canonical diagram with selectable process frames and an accessible text fallback. Frames explain processes, not successive simulated times. Use the supplied substantive radiation passages; navigation and citation metadata support no physical claim. Keep energy-balance accounting and analogy critique to brief context, not a second full lesson. Do not say all sunlight passes through or all infrared is blocked. No numerical climate forecast, invented temperatures or glasshouse experiment.',
    pages: [
      'https://science.nasa.gov/ems/13_radiationbudget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
  },
  'greenhouse-balance': {
    explanationUnitId: 'earth-greenhouse-system-balance-v1',
    interactive: true,
    topicId: 'earth.greenhouse-effect',
    assetId: '02a7bdec-4628-4360-8f59-de7b459b183d',
    brief:
      'Account at the system boundary: why can internal surface-atmosphere energy exchanges coexist with a stable planet-wide energy budget, and what changes when incoming and outgoing energy differ? Focus on the whole Earth system, radiative equilibrium versus imbalance, and the distinction between redistribution inside the system and energy leaving to space. Require an interactive canonical diagram comparing explicitly described balance and imbalance states, with an accessible text fallback. These are qualitative explanatory states, not a temperature model or a predicted time sequence. Keep radiation-path mechanics and blanket critique to brief context. Use only retained supplied passages, not later sections of a full web article. Do not present historical numerical estimates as current measurements. No forecast, invented temperature, timescale or equilibrium calculation.',
    pages: [
      'https://science.nasa.gov/earth/earth-observatory/climate-and-earths-energy-budget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
  },
  'greenhouse-limits': {
    explanationUnitId: 'earth-greenhouse-analogy-audit-v1',
    interactive: false,
    topicId: 'earth.greenhouse-effect',
    assetId: 'ff51d698-4d91-4ce9-b54a-4c88f0e9ef9d',
    brief:
      'Audit the blanket analogy: which inferences does the comparison help with, and which must a reader reject? Organize the explanation around useful comparison versus misleading inference, using a canonical comparison or disclosure. Explain why continued energy escape and atmospheric absorption/emission make a sealed lid or energy-creating blanket misleading. Distinguish the natural greenhouse context from its human strengthening; a helpful natural effect does not imply additional greenhouse gas has no effect. Ground every correction in the supplied substantive passages and retain their caveats. This is an analogy-audit lesson, not a retelling of the complete radiation path or a second balance tutorial. The old broad greenhouse overview remains a separate unchanged recipe. Do not invent a glasshouse experiment, imply equivalence to a solid cover, or calculate a temperature forecast or numerical attribution.',
    pages: [
      'https://science.nasa.gov/ems/13_radiationbudget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
  },
} as const;
export type ScrollTopic = keyof typeof TOPICS;
/** Explicit explanation identity; only the original three share their approved Reel identity. */
export function explanationUnitFor(topic: ScrollTopic): string {
  return TOPICS[topic].explanationUnitId;
}
/** Parse a bounded, code-defined topic identifier. */
export function parseScrollTopic(raw: string | undefined): ScrollTopic | undefined {
  return raw !== undefined && Object.hasOwn(TOPICS, raw) ? (raw as ScrollTopic) : undefined;
}
