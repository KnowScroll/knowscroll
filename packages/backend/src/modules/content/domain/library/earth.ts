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
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'Why Earth has seasons: axial tilt changes how directly the Sun’s rays reach each hemisphere through the year, and the two hemispheres have opposite timing; distance is not the cause. Explain the limits of the simplified picture: Earth’s orbit is a little lop-sided, so its distance from the Sun does change, but not in a way that makes the seasons.',
    pages: ['https://spaceplace.nasa.gov/seasons/en/'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'Tilt, not distance, causes the seasons, against a common wrong idea',
        'The tilt gives each hemisphere its turn toward the Sun, six months apart',
        'What the simple picture leaves out: the orbit is a little lop-sided',
      ],
      pictures: [
        {
          kind: 'chart',
          purpose:
            "Bars of Earth's closest and farthest distance from the Sun, in miles, so the reader sees the two bars are nearly equal and distance cannot explain the seasons. Unit: miles. Caption: orbit not to scale.",
        },
        {
          kind: 'grid',
          purpose:
            "A 2 x 2 of tilt and season: rows June and December, columns Northern and Southern Hemisphere; each cell says which pole tilts toward the Sun and the season that gives. The Southern cells say only that the timing is the opposite of the north's, since no passage names the Southern seasons.",
        },
      ],
      misconception: {
        kind: 'myth',
        claim: 'Earth has seasons because it is closer to the Sun in summer and farther away in winter.',
        source: { label: 'A Private Universe (1987 documentary)', reviewed: true },
      },
    },
  },
  'seasons-hemispheres': {
    explanationUnitId: 'earth-seasons-hemispheres-v1',
    assetId: '8a7d48fe-0397-4e00-91a8-b4700630880f',
    systemId: system,
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.hemispheres',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'Why the two hemispheres always have opposite seasons: through the year each hemisphere in turn tips toward the Sun and then away from it. Step through the two solstices and the two equinoxes and say what each means for the tip toward the Sun and for daylight, as far as the supplied passage states it: at an equinox day and night are about equal, and around the March equinox the north has spring as its hours of daylight increase while the south has autumn as its daylight hours shorten. Do not say when daylight starts to grow or shrink at a solstice, do not suggest that distance from the Sun sets the seasons, and give no invented dates or temperatures.',
    pages: ['https://en.wikipedia.org/wiki/Season'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Why the two hemispheres always have opposite seasons',
        'Four turning points in the year: two solstices and two equinoxes',
        'What each point means for the tip toward the Sun and for daylight',
      ],
      pictures: [
        {
          kind: 'cycle',
          purpose:
            "The year as a ring of four turning points: March equinox, June solstice, September equinox, December solstice. Each item's note gives only what the passages state for that point: which hemisphere tips most toward the Sun at a solstice (the north about June 21, the south around December 21), equal day and night at an equinox, and spring with lengthening daylight in the north and autumn with shortening daylight in the south around the March equinox. Centre: the tilted Earth.",
        },
        {
          kind: 'statement',
          purpose: "One number: the tilt of Earth's axis, 23.4 degrees, labelled as the tilt that gives the seasons.",
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'seasons-limits': {
    explanationUnitId: 'earth-seasons-limits-v1',
    assetId: 'cde79338-06f9-4405-aa1c-1ccff9c51d4b',
    systemId: system,
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.limits',
    interactive: false,
    interactiveKind: null,
    brief:
      'Why the tilt explanation needs care. Earth is nearest the Sun in early January and farthest in early July, yet the Northern Hemisphere is coldest when Earth is nearest, which is why tilt and not distance explains the seasons. Explain that the four seasons are marked by the solstices and equinoxes and say what the simple picture leaves out. Give no invented temperatures or dates beyond those in the supplied passages.',
    pages: ['https://en.wikipedia.org/wiki/Earth%27s_orbit'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'A puzzle: Earth is nearest the Sun in January, yet the north is coldest',
        'So tilt, not distance, is the cause; the year is marked by four points',
        'What the simple picture leaves out: a slightly elliptical orbit',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            'One number: about 7 per cent more total solar energy reaches Earth at perihelion than at aphelion, set against the fact that the Northern Hemisphere is coldest when Earth is nearest the Sun.',
        },
        {
          kind: 'cycle',
          purpose:
            "The orbit as a ring of six marked points in order: perihelion (early January), March equinox, June solstice, aphelion (early July), September equinox, December solstice. Each note says whether the point marks a season or marks Earth's nearest or farthest distance from the Sun, so the reader sees the two sets of points are different.",
        },
      ],
      misconception: { kind: 'none' },
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
      'Seasons on other planets, and why Earth is not the template. Say what the supplied passages state about seasons on Mars and on Uranus: Mars’s axis is tilted much as Earth’s is, so it has distinct seasons, but they last longer, while Uranus’s axis lies nearly at a right angle to its orbit, which gives it the most extreme seasons in the Solar System. Compare each with Earth’s seasons and say what the tilt does in each case. Do not state the length of Earth’s seasons, and do not call them equal or three months long: Earth’s orbit is slightly elliptical too, and the supplied passages simplify this. Give every Martian season length in sols. Give no invented dates, temperatures or season lengths beyond those in the supplied passages.',
    pages: ['https://science.nasa.gov/mars/facts/', 'https://science.nasa.gov/uranus/facts/'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'Earth is not the template: other planets have seasons too',
        "Mars: a tilt much like Earth's, but longer and uneven seasons",
        'Uranus: tipped nearly on its side, with the most extreme seasons',
      ],
      pictures: [
        {
          kind: 'chart',
          purpose:
            'Bars of axial tilt in degrees for Earth, Mars and Uranus, so the reader sees that Mars is close to Earth and Uranus is far from both. Values: Earth 23.4, Mars 25, Uranus 97.77. Unit: degrees.',
        },
        {
          kind: 'chart',
          purpose:
            'Bars of the four Martian season lengths in sols (northern spring 194, summer 178, autumn 142, winter 154), to show that the seasons are unequal. Unit: sols.',
        },
      ],
      misconception: { kind: 'none' },
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
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How the Moon and Sun make tides: differential gravity, both tidal bulges, and the Sun’s smaller part with spring and neap alignment. Avoid implying the far bulge is a pile of water pulled through Earth or that every coast has the same timing; the supplied passages say nothing about particular coasts.',
    pages: [
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides03_gravity.html',
      'https://oceanservice.noaa.gov/education/tutorial_tides/tides06_variations.html',
    ],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'The Moon pulls harder on the near side of Earth than on the far side',
        'Gravity and inertia make two bulges that stay lined up with the Moon',
        'The Sun adds a smaller pull and changes the size of the tides',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            "A 2 x 2 of the two bulges: rows near side and far side of Earth, columns what the Moon's gravity does there and what results. The near and far bulges must be shown as gravity beating inertia, then inertia beating gravity.",
        },
        {
          kind: 'statement',
          purpose:
            "A short list of what changes the size of the tides beyond the Moon: the Sun (about half the Moon's effect), the Moon's changing distance, and Earth's changing distance from the Sun.",
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'tides-spring-neap': {
    explanationUnitId: 'earth-tides-spring-neap-v1',
    assetId: '058cb4e3-cb0d-4dc6-9dc6-fb75106e24e6',
    systemId: system,
    topicId: 'earth.tides',
    facetId: 'earth.tides.alignment',
    interactive: true,
    interactiveKind: 'sequence',
    brief:
      'Why tides are larger at some times of the month than others. At new and full Moon the Sun, Moon and Earth line up and their pulls add, giving larger tidal ranges; about a week later the Sun and Moon are at right angles and the range is moderate. Step through these alignments. Say that the name spring tide has nothing to do with the season, and do not suggest every coast shows the same size or timing.',
    pages: ['https://oceanservice.noaa.gov/facts/springtide.html', 'https://oceanservice.noaa.gov/facts/tides.html'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Why tides swell and shrink over a month',
        "New and full Moon: the Sun's pull adds to the Moon's, giving spring tides",
        'A week on the pulls partly cancel, giving neap tides; not named for a season',
      ],
      pictures: [
        {
          kind: 'cycle',
          purpose:
            "The lunar month as a ring of four phases: new Moon, first quarter, full Moon, third quarter. Each item's note says spring (pulls add) or neap (pulls partly cancel) and what that does to high and low tides.",
        },
        {
          kind: 'statement',
          purpose:
            'One labelled list of three: spring tide (Sun and Moon in line, at new and full Moon, ranges slightly larger); neap tide (at right angles, at the quarter Moons); neither name comes from the season.',
        },
      ],
      misconception: { kind: 'none' },
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
      'Why the same tide-raising pull gives very different tides on different coasts. The open ocean has a small tidal range, while some bays have a very large one and enclosed seas such as the Mediterranean have some of the smallest. Explain tidal resonance, where the shape and depth of a basin match the rhythm of the tide and amplify it, as in the Bay of Fundy. Do not present a tide height for any place as exact or current: give a range only as the mean range the supplied passages state, and say it is a mean.',
    pages: ['https://en.wikipedia.org/wiki/Tidal_range', 'https://en.wikipedia.org/wiki/Tidal_resonance'],
    scrollV3: {
      shape: 'argument',
      sections: [
        'The same tide-raising pull gives very different tides on different coasts',
        'The open ocean has a small range; some bays are huge, enclosed seas tiny',
        "Resonance: a basin whose shape and depth match the tide's rhythm amplifies it",
      ],
      pictures: [
        {
          kind: 'chart',
          purpose:
            'Bars of mean tidal range in metres: the typical open ocean (1) against the Bay of Fundy (11.7), Ungava Bay (9.75) and the Bristol Channel (9.60). Unit: metres. The values are hidden, and the caption says they are mean ranges, not a forecast.',
        },
      ],
      misconception: { kind: 'none' },
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
    interactive: false,
    interactiveKind: null,
    brief:
      'The greenhouse effect, a blanket made of gas: sunlight heats the surface; greenhouse gases absorb most of the infrared the warmed Earth emits and send some of it back toward the surface, restricting the outward passage of heat; an energy budget out of balance warms or cools the atmosphere. The blanket is an analogy, gases do not create energy or act as a solid lid. Distinguish the natural effect from strengthening it.',
    pages: [
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
      'https://science.nasa.gov/ems/13_radiationbudget/',
    ],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        "Gases act like a blanket, holding heat near Earth's surface",
        'The blanket is an analogy: the gases absorb and return heat, and some still escapes to space',
        'The natural effect, and how burning fossil fuels strengthens it',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            'One number: the average surface temperature of 15 degrees C that the natural greenhouse effect maintains.',
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 comparing the natural greenhouse effect with its human strengthening: rows natural and strengthened, columns what it is and what follows.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'greenhouse-radiation': {
    explanationUnitId: 'earth-greenhouse-radiation-paths-v1',
    assetId: '76b65d2e-991a-4be8-9d70-aab9f275396c',
    systemId: system,
    topicId: 'earth.greenhouse-effect',
    facetId: 'earth.greenhouse-effect.radiation',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'Follow the radiation paths: how do incoming sunlight and outgoing thermal radiation interact differently with the surface and atmosphere? Focus on reflection, absorption and emission, including atmospheric emission toward both space and the surface. Require an interactive canonical diagram with selectable process frames and an accessible text fallback. Frames explain processes, not successive simulated times. Use the supplied substantive radiation passages; navigation and citation metadata support no physical claim. Keep energy-balance accounting and analogy critique to brief context, not a second full lesson. Do not say all sunlight passes through or all infrared is blocked. No numerical climate forecast, invented temperatures or glasshouse experiment.',
    pages: [
      'https://science.nasa.gov/ems/13_radiationbudget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'Sunlight arrives as shortwave radiation: some reflected, some absorbed',
        'Absorbed energy is emitted back out as longwave infrared radiation',
        'Greenhouse gases absorb most of it and re-emit some toward the surface',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'The radiation path in order: sunlight arrives (shortwave); some is reflected by clouds, snow or ice; some is absorbed by the air; the rest is absorbed at the surface; the warmed surface and air emit longwave; greenhouse gases absorb most of it and the air re-emits some toward the surface and some to space. Six steps at most.',
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 contrasting incoming shortwave and outgoing longwave radiation: rows incoming and outgoing, columns what it is and what happens to it.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'greenhouse-balance': {
    explanationUnitId: 'earth-greenhouse-system-balance-v1',
    assetId: '02a7bdec-4628-4360-8f59-de7b459b183d',
    systemId: system,
    topicId: 'earth.greenhouse-effect',
    facetId: 'earth.greenhouse-effect.balance',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'Account at the system boundary: why can internal surface-atmosphere energy exchanges coexist with a stable planet-wide energy budget, and what changes when incoming and outgoing energy differ? Focus on the whole Earth system, radiative equilibrium versus imbalance, and the distinction between redistribution inside the system and energy leaving to space. Require an interactive canonical diagram comparing explicitly described balance and imbalance states, with an accessible text fallback. These are qualitative explanatory states, not a temperature model or a predicted time sequence. Keep radiation-path mechanics and blanket critique to brief context. Use only retained supplied passages, not later sections of a full web article. Do not present historical numerical estimates as current measurements, and give no percentage or power figure unless a passage states it as an estimate. No forecast, invented temperature, timescale or equilibrium calculation.',
    pages: [
      'https://science.nasa.gov/earth/earth-observatory/climate-and-earths-energy-budget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        "Energy swaps inside the Earth system while the planet's total stays steady",
        'Balance: incoming sunlight equals heat leaving to space, so climate is stable',
        'Imbalance: change either flow and global temperatures must rise or fall',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            "A short labelled list of three: inside the system, heat is moved around by evaporation, convection, rainfall, winds and ocean circulation; at the system's edge, heat flows back to space; when incoming solar energy equals the heat leaving to space, Earth is in radiative equilibrium.",
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 comparing balance and imbalance: rows balance and imbalance, columns incoming vs outgoing energy and what happens to temperature.',
        },
      ],
      misconception: { kind: 'none' },
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
      'Audit the blanket analogy: which inferences does the comparison help with, and which must a reader reject? Organize the explanation around useful comparison versus misleading inference. Explain why continued energy escape and atmospheric absorption/emission make a sealed lid or energy-creating blanket misleading. Distinguish the natural greenhouse context from its human strengthening; a helpful natural effect does not imply additional greenhouse gas has no effect. Ground every correction in the supplied substantive passages and retain their caveats. This is an analogy-audit lesson, not a retelling of the complete radiation path or a second balance tutorial. The old broad greenhouse overview remains a separate unchanged recipe. Do not invent a glasshouse experiment, imply equivalence to a solid cover, or calculate a temperature forecast or numerical attribution.',
    pages: [
      'https://science.nasa.gov/ems/13_radiationbudget/',
      'https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/',
    ],
    scrollV3: {
      shape: 'argument',
      sections: [
        'The blanket analogy: what it gets right about holding heat near the surface',
        'Where it misleads: it is not a sealed lid and it creates no energy',
        'Natural effect and human strengthening: a helpful effect can still be added to',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 audit of the analogy: rows what the blanket suggests and what the atmosphere actually does, columns useful and misleading. Useful: heat is held near the surface. Misleading: a sealed lid; the gases absorb most of the infrared and return some of it, and some radiates out into space, so heat still leaves.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
} as const satisfies SystemRecipes<typeof earthSystem>;
