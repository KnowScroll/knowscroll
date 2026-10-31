import type { LibrarySystem, SystemRecipes } from './plan.js';

/** Earth and climate: the original three planets, now each with several explanations. */
export const earthSystem = {
  id: 'earth',
  meaning: 'Physical processes of Earth and its astronomical setting.',
  sceneFamily: 'terraced.v1',
  haze: 'amber',
  topics: [
    {
      id: 'earth.seasons',
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
        {
          id: 'earth.seasons.elsewhere',
          meaning: 'Other planets have seasons too, set by their own tilt and orbit.',
        },
      ],
    },
    {
      id: 'earth.tides',
      meaning: 'Ocean tides under differential gravitational forcing and local conditions.',
      sceneFamily: 'archipelago.v1',
      facets: [
        { id: 'earth.tides.forcing', meaning: 'Differential lunar and solar gravity contributes to tidal forcing.' },
        { id: 'earth.tides.alignment', meaning: 'Sun and Moon alignment changes the combined tidal forcing.' },
        { id: 'earth.tides.coasts', meaning: 'Coastlines and basin dynamics limit simple global tide predictions.' },
      ],
    },
    {
      id: 'earth.greenhouse-effect',
      meaning: 'Atmospheric absorption and emission in Earth radiation balance.',
      sceneFamily: 'ridged.v1',
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
  ],
} as const satisfies LibrarySystem;

const system = 'earth';

export const earthRecipes = {
  seasons: {
    explanationUnitId: 'legacy-cutroom-seasons-v5',
    script: 'seasons-v5',
    assetId: 'af2628f1-98a7-4c39-9f81-628506d247a1',
    systemId: system,
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.axial-tilt',
    supportingFacetId: 'earth.seasons.limits',
    stageKit: 'earth-sky.v1',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'Why Earth has seasons: axial tilt changes daylight and sunlight angle; distance is not the cause. Include a useful interactive diagram with frames for opposite hemispheres. Explain the limits of the simplified picture.',
    pages: ['https://spaceplace.nasa.gov/seasons/en/'],
    scrollV2: {
      variant: 'stage',
      misconception: {
        kind: 'myth',
        claim: 'Earth has seasons because it is closer to the Sun in summer and farther away in winter.',
        source: { label: 'A Private Universe (1987 documentary)', reviewed: true },
      },
      landmark: { key: 'the-leaning-axis', name: 'The Leaning Axis' },
      finalCall: { kind: 'tilt' },
    },
  },
  'seasons-hemispheres': {
    explanationUnitId: 'earth-seasons-hemispheres-v1',
    assetId: '8a7d48fe-0397-4e00-91a8-b4700630880f',
    systemId: system,
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.hemispheres',
    stageKit: 'earth-sky.v1',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'Why the two hemispheres always have opposite seasons: through the year each hemisphere in turn tips toward the Sun and then away from it. Step through the two solstices and the two equinoxes and say what each means for daylight in each hemisphere. Do not suggest that distance from the Sun sets the seasons, and give no invented dates or temperatures.',
    pages: ['https://en.wikipedia.org/wiki/Season'],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-turning-halves', name: 'The Turning Halves' },
    },
  },
  'seasons-limits': {
    explanationUnitId: 'earth-seasons-limits-v1',
    assetId: 'cde79338-06f9-4405-aa1c-1ccff9c51d4b',
    systemId: system,
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.limits',
    stageKit: 'earth-sky.v1',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why the tilt explanation needs care. Earth is nearest the Sun in early January and farthest in early July, yet the Northern Hemisphere is coldest when Earth is nearest, which is why tilt and not distance explains the seasons. Explain that the four seasons are marked by the solstices and equinoxes and say what the simple picture leaves out. Give no invented temperatures or dates beyond those in the supplied passages.',
    pages: ['https://en.wikipedia.org/wiki/Earth%27s_orbit'],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-near-january', name: 'The Near January' },
    },
  },
  'seasons-elsewhere': {
    explanationUnitId: 'earth-seasons-elsewhere-v1',
    assetId: '226ced46-c82a-44a3-97ac-06d2d9369a30',
    systemId: system,
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.elsewhere',
    interactive: false,
    interactiveKind: null,
    brief:
      'Seasons on other planets, and why Earth is not the template. Say what the supplied passages state about seasons on Mars and on Uranus: Mars’s axis is tilted much as Earth’s is, so it has distinct seasons, but they last longer, while Uranus’s axis lies nearly at a right angle to its orbit, which gives it the most extreme seasons in the Solar System. Compare each with Earth’s seasons and say what the tilt does in each case. Give no invented dates, temperatures or season lengths beyond those in the supplied passages.',
    pages: ['https://science.nasa.gov/mars/facts/', 'https://science.nasa.gov/uranus/facts/'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sideways-giant', name: 'The Sideways Giant' },
    },
  },
  tides: {
    explanationUnitId: 'legacy-cutroom-tides-v4',
    script: 'tides-v4',
    assetId: '8349204a-0c98-45d3-a354-6c73be4a86de',
    systemId: system,
    topicId: 'earth.tides',
    facetId: 'earth.tides.forcing',
    supportingFacetId: 'earth.tides.coasts',
    // The Moon's pull, the two bulges and spring and neap alignment are the subject, and the kit draws exactly
    // those. Coasts are left to the text and the limits aside.
    stageKit: 'tides.v1',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How the Moon and Sun make tides: differential gravity, both tidal bulges, spring and neap alignment, real coastlines. Include an interactive diagram. Avoid implying the far bulge is a pile of water pulled through Earth or that every coast has the same timing.',
    pages: [
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides03_gravity.html',
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides06_variations.html',
    ],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-two-bulges', name: 'The Two Bulges' },
    },
  },
  'tides-spring-neap': {
    explanationUnitId: 'earth-tides-spring-neap-v1',
    assetId: '058cb4e3-cb0d-4dc6-9dc6-fb75106e24e6',
    systemId: system,
    topicId: 'earth.tides',
    facetId: 'earth.tides.alignment',
    // Spring and neap are the Sun and Moon lining up or standing at right angles, which the kit derives from
    // the phase and draws as added or partly cancelled bulges and as bars for the four phases.
    stageKit: 'tides.v1',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'Why tides are larger at some times of the month than others. At new and full Moon the Sun, Moon and Earth line up and their pulls add, giving larger tidal ranges; about a week later the Sun and Moon are at right angles and the range is moderate. Step through these alignments. Say that the name spring tide has nothing to do with the season, and do not suggest every coast shows the same size or timing.',
    pages: ['https://oceanservice.noaa.gov/facts/springtide.html', 'https://oceanservice.noaa.gov/facts/tides.html'],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-added-pulls', name: 'The Added Pulls' },
    },
  },
  'tides-coasts': {
    explanationUnitId: 'earth-tides-coasts-v1',
    assetId: 'b364e1fe-fcfc-4c05-8faf-c1931fd64e34',
    systemId: system,
    topicId: 'earth.tides',
    facetId: 'earth.tides.coasts',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why the same tide-raising pull gives very different tides on different coasts. The open ocean has a small tidal range, while some bays have a very large one and enclosed seas such as the Mediterranean have some of the smallest. Explain tidal resonance, where the shape and depth of a basin match the rhythm of the tide and amplify it, as in the Bay of Fundy. Do not present a tide height for any place as exact or current.',
    pages: ['https://en.wikipedia.org/wiki/Tidal_range', 'https://en.wikipedia.org/wiki/Tidal_resonance'],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sloshing-bay', name: 'The Sloshing Bay' },
    },
  },
  greenhouse: {
    explanationUnitId: 'legacy-cutroom-greenhouse',
    script: 'greenhouse',
    assetId: 'a73a7732-a154-4c10-aa6f-169fa10cd8aa',
    systemId: system,
    topicId: 'earth.greenhouse-effect',
    facetId: 'earth.greenhouse-effect.radiation',
    supportingFacetId: 'earth.greenhouse-effect.limits',
    // Sunlight in, infrared out, a layer that returns some and the ground warming until in and out match are
    // the subject; the kit draws them with one layer and makes no energy.
    stageKit: 'greenhouse.v1',
    interactive: false,
    interactiveKind: null,
    brief:
      'The greenhouse effect, a blanket made of gas: sunlight heats the surface; infrared absorption and emission slow cooling to space; the surface warms until energy balances. The blanket is an analogy, gases do not create energy or act as a solid lid. Distinguish the natural effect from strengthening it. Use comparison or disclosure.',
    pages: ['https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/'],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-gas-blanket', name: 'The Gas Blanket' },
    },
  },
  'greenhouse-radiation': {
    explanationUnitId: 'earth-greenhouse-radiation-paths-v1',
    assetId: '76b65d2e-991a-4be8-9d70-aab9f275396c',
    systemId: system,
    topicId: 'earth.greenhouse-effect',
    facetId: 'earth.greenhouse-effect.radiation',
    // The radiation paths are what the kit draws: reflected sunlight, the ground's infrared, and the layer
    // sending some up and some back down. It does not say all sunlight passes through or all infrared is
    // blocked.
    stageKit: 'greenhouse.v1',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'Follow the radiation paths: how do incoming sunlight and outgoing thermal radiation interact differently with the surface and atmosphere? Focus on reflection, absorption and emission, including atmospheric emission toward both space and the surface. Require an interactive canonical diagram with selectable process frames and an accessible text fallback. Frames explain processes, not successive simulated times. Use the supplied substantive radiation passages; navigation and citation metadata support no physical claim. Keep energy-balance accounting and analogy critique to brief context, not a second full lesson. Do not say all sunlight passes through or all infrared is blocked. No numerical climate forecast, invented temperatures or glasshouse experiment.',
    pages: [
      'https://science.nasa.gov/ems/13_radiationbudget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-returning-glow', name: 'The Returning Glow' },
    },
  },
  'greenhouse-balance': {
    explanationUnitId: 'earth-greenhouse-system-balance-v1',
    assetId: '02a7bdec-4628-4360-8f59-de7b459b183d',
    systemId: system,
    topicId: 'earth.greenhouse-effect',
    facetId: 'earth.greenhouse-effect.balance',
    // Balance and imbalance are the energy-balance view: two bars, equal once settled and unequal just after
    // the layer thickens, with the ground warming until they match.
    stageKit: 'greenhouse.v1',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'Account at the system boundary: why can internal surface-atmosphere energy exchanges coexist with a stable planet-wide energy budget, and what changes when incoming and outgoing energy differ? Focus on the whole Earth system, radiative equilibrium versus imbalance, and the distinction between redistribution inside the system and energy leaving to space. Require an interactive canonical diagram comparing explicitly described balance and imbalance states, with an accessible text fallback. These are qualitative explanatory states, not a temperature model or a predicted time sequence. Keep radiation-path mechanics and blanket critique to brief context. Use only retained supplied passages, not later sections of a full web article. Do not present historical numerical estimates as current measurements. No forecast, invented temperature, timescale or equilibrium calculation.',
    pages: [
      'https://science.nasa.gov/earth/earth-observatory/climate-and-earths-energy-budget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
    scrollV2: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-even-ledger', name: 'The Even Ledger' },
    },
  },
  'greenhouse-limits': {
    explanationUnitId: 'earth-greenhouse-analogy-audit-v1',
    assetId: 'ff51d698-4d91-4ce9-b54a-4c88f0e9ef9d',
    systemId: system,
    topicId: 'earth.greenhouse-effect',
    facetId: 'earth.greenhouse-effect.limits',
    // No kit: its subject is the audit of the blanket analogy, which the greenhouse kit cannot draw (D-194).
    interactive: false,
    interactiveKind: null,
    brief:
      'Audit the blanket analogy: which inferences does the comparison help with, and which must a reader reject? Organize the explanation around useful comparison versus misleading inference, using a canonical comparison or disclosure. Explain why continued energy escape and atmospheric absorption/emission make a sealed lid or energy-creating blanket misleading. Distinguish the natural greenhouse context from its human strengthening; a helpful natural effect does not imply additional greenhouse gas has no effect. Ground every correction in the supplied substantive passages and retain their caveats. This is an analogy-audit lesson, not a retelling of the complete radiation path or a second balance tutorial. The old broad greenhouse overview remains a separate unchanged recipe. Do not invent a glasshouse experiment, imply equivalence to a solid cover, or calculate a temperature forecast or numerical attribution.',
    pages: [
      'https://science.nasa.gov/ems/13_radiationbudget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
    scrollV2: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-leaky-blanket', name: 'The Leaky Blanket' },
    },
  },
} as const satisfies SystemRecipes<typeof earthSystem>;
