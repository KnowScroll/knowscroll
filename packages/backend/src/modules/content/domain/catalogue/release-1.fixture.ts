import type { LibrarySystem } from '../library/plan.js';

/**
 * The library plan exactly as release 1 of the catalogue seeded it (migration 0116, D-419), frozen. The live plan
 * (`LIBRARY_SYSTEMS`) keeps growing in code; tests that prove the seed is exact compare against this copy, never against
 * the plan, so adding a topic to the plan breaks nothing here. Never edit it: a catalogue that changes is a new release.
 */
export const RELEASE_1_PLAN: readonly LibrarySystem[] = [
  {
    id: 'earth',
    meaning: 'Physical processes of Earth and its astronomical setting.',
    sceneFamily: 'terraced.v1',
    haze: 'amber',
    topics: [
      {
        id: 'earth.seasons',
        meaning: 'Seasonal changes caused by axial tilt and orbital geometry.',
        facets: [
          {
            id: 'earth.seasons.axial-tilt',
            meaning: 'Axial tilt changes solar angle and daylight through the year.',
          },
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
          {
            id: 'earth.tides.forcing',
            meaning: 'Differential lunar and solar gravity contributes to tidal forcing.',
          },
          {
            id: 'earth.tides.alignment',
            meaning: 'Sun and Moon alignment changes the combined tidal forcing.',
          },
          {
            id: 'earth.tides.coasts',
            meaning: 'Coastlines and basin dynamics limit simple global tide predictions.',
          },
        ],
      },
      {
        id: 'earth.greenhouse-effect',
        meaning: 'Atmospheric absorption and emission in Earth radiation balance.',
        sceneFamily: 'ridged.v1',
        facets: [
          {
            id: 'earth.greenhouse-effect.radiation',
            meaning: 'Greenhouse gases absorb and emit infrared radiation.',
          },
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
  },
  {
    id: 'space',
    meaning: 'Stars, planets and black holes, and the methods astronomers use to study them.',
    sceneFamily: 'archipelago.v1',
    haze: 'violet',
    topics: [
      {
        id: 'space.stars',
        meaning: 'How stars shine, how their mass shapes their lives and how they are measured.',
        sceneFamily: 'terraced.v1',
        facets: [
          {
            id: 'space.stars.fusion',
            meaning: 'Fusion in the core powers a star while gas pressure balances gravity.',
          },
          {
            id: 'space.stars.lifecycle',
            meaning: 'A star’s mass sets how it ages and how it ends.',
          },
          {
            id: 'space.stars.measurement',
            meaning: 'Colour and brightness tell astronomers a star’s temperature, size and kind.',
          },
        ],
      },
      {
        id: 'space.exoplanets',
        meaning: 'Planets orbiting other stars, how they are found and what they are like.',
        facets: [
          {
            id: 'space.exoplanets.detection',
            meaning: 'Most exoplanets are found indirectly, through their effect on starlight.',
          },
          {
            id: 'space.exoplanets.habitability',
            meaning: 'Whether liquid water could exist on a planet depends on starlight and many other factors.',
          },
          {
            id: 'space.exoplanets.diversity',
            meaning: 'Worlds around other stars include kinds with no counterpart in the Solar System.',
          },
        ],
      },
      {
        id: 'space.black-holes',
        meaning: 'Regions where gravity is so strong that nothing, not even light, can return.',
        sceneFamily: 'ridged.v1',
        facets: [
          {
            id: 'space.black-holes.formation',
            meaning: 'Black holes form when massive stars collapse, and some grow far larger by other routes.',
          },
          {
            id: 'space.black-holes.horizon',
            meaning: 'The event horizon is the boundary beyond which nothing can escape.',
          },
          {
            id: 'space.black-holes.evidence',
            meaning: 'Black holes are known from their effects on stars, gas and spacetime, not by direct sight.',
          },
        ],
      },
    ],
  },
  {
    id: 'machine-learning',
    meaning: 'How computers learn patterns from data, and how modern language models work.',
    sceneFamily: 'ridged.v1',
    haze: 'teal',
    topics: [
      {
        id: 'machine-learning.attention',
        meaning: 'Attention lets a model weigh which parts of its input matter for each part of its output.',
        sceneFamily: 'terraced.v1',
        facets: [
          {
            id: 'machine-learning.attention.mechanism',
            meaning: 'Queries, keys and values turn similarity scores into weights over the input.',
          },
          {
            id: 'machine-learning.attention.example',
            meaning: 'A worked case shows which input words a model weighs when producing each output word.',
          },
          {
            id: 'machine-learning.attention.limits',
            meaning: 'Attention weights are not a full explanation, and attention has its own costs.',
          },
        ],
      },
      {
        id: 'machine-learning.transformers',
        meaning: 'The transformer is the network design behind most modern language models.',
        facets: [
          {
            id: 'machine-learning.transformers.architecture',
            meaning: 'A stack of similar blocks combines attention with feed-forward layers.',
          },
          {
            id: 'machine-learning.transformers.embeddings',
            meaning: 'Tokens become vectors whose geometry carries part of their meaning.',
          },
          {
            id: 'machine-learning.transformers.generation',
            meaning: 'A language model writes text by predicting one token at a time.',
          },
        ],
      },
      {
        id: 'machine-learning.training',
        meaning: 'Training adjusts a network’s numbers from data so that its predictions improve.',
        sceneFamily: 'archipelago.v1',
        facets: [
          {
            id: 'machine-learning.training.optimization',
            meaning: 'Gradient descent nudges parameters in the direction that lowers a loss.',
          },
          {
            id: 'machine-learning.training.examples',
            meaning: 'Training examples strengthen or weaken the connections between a network’s units.',
          },
          {
            id: 'machine-learning.training.generalization',
            meaning: 'A useful model does well on new data, not only on the data it learned from.',
          },
        ],
      },
      {
        id: 'machine-learning.efficiency',
        meaning: 'Designs and encodings that keep large models affordable to train and run.',
        sceneFamily: 'terraced.v1',
        facets: [
          {
            id: 'machine-learning.efficiency.long-inputs',
            meaning: 'Attention cost and memory grow quickly with input length, and designs reduce them.',
          },
          {
            id: 'machine-learning.efficiency.sparsity',
            meaning: 'Mixture of experts uses only part of a model for each input.',
          },
          {
            id: 'machine-learning.efficiency.tokens',
            meaning: 'Subword tokenization turns text into a manageable vocabulary of pieces.',
          },
        ],
      },
    ],
  },
  {
    id: 'human-body',
    meaning: 'How the organs and systems of the human body work.',
    sceneFamily: 'archipelago.v1',
    haze: 'coral',
    topics: [
      {
        id: 'human-body.heart-and-blood',
        meaning: 'The heart and blood vessels move blood, and with it oxygen, around the body.',
        sceneFamily: 'ridged.v1',
        facets: [
          {
            id: 'human-body.heart-and-blood.pumping',
            meaning: 'The heart’s chambers and valves pump blood in a repeating cycle.',
          },
          {
            id: 'human-body.heart-and-blood.pressure',
            meaning: 'Blood pressure depends on the heart’s output and on how much the vessels resist flow.',
          },
          {
            id: 'human-body.heart-and-blood.oxygen',
            meaning: 'Haemoglobin picks up oxygen in the lungs and releases it where it is needed.',
          },
        ],
      },
      {
        id: 'human-body.nervous-system',
        meaning: 'Nerve cells send signals along their length and between one another.',
        facets: [
          {
            id: 'human-body.nervous-system.signal',
            meaning: 'A nerve cell fires a brief electrical impulse, an action potential, along its length.',
          },
          {
            id: 'human-body.nervous-system.synapse',
            meaning: 'Chemical messengers carry the signal across the gap between two cells.',
          },
          {
            id: 'human-body.nervous-system.reflex',
            meaning: 'Short circuits through the spinal cord produce fast, automatic responses.',
          },
        ],
      },
      {
        id: 'human-body.immune-system',
        meaning: 'The immune system recognises and responds to threats such as infections.',
        sceneFamily: 'terraced.v1',
        facets: [
          {
            id: 'human-body.immune-system.innate',
            meaning: 'Fast, general defences respond within hours without earlier exposure.',
          },
          {
            id: 'human-body.immune-system.adaptive',
            meaning: 'Lymphocytes learn a specific threat and tailor a response to it.',
          },
          {
            id: 'human-body.immune-system.memory',
            meaning: 'After exposure or vaccination, memory cells let the next response start faster.',
          },
        ],
      },
    ],
  },
  {
    id: 'computing',
    meaning: 'How the web, browsers and everyday algorithms work.',
    sceneFamily: 'terraced.v1',
    haze: 'cobalt',
    topics: [
      {
        id: 'computing.web-requests',
        meaning: 'What happens between typing an address and seeing a page.',
        sceneFamily: 'archipelago.v1',
        facets: [
          {
            id: 'computing.web-requests.naming',
            meaning: 'The Domain Name System turns a name into the address of a server.',
          },
          {
            id: 'computing.web-requests.secure-transport',
            meaning: 'A secure connection lets a browser and server exchange data privately.',
          },
          {
            id: 'computing.web-requests.caching',
            meaning: 'Caches reuse earlier responses to save time and traffic.',
          },
        ],
      },
      {
        id: 'computing.browsers',
        meaning: 'How a browser turns code into a page you can use.',
        facets: [
          {
            id: 'computing.browsers.rendering',
            meaning: 'Parsing, styling, layout and painting turn markup into pixels.',
          },
          {
            id: 'computing.browsers.event-loop',
            meaning: 'Scripts run one task at a time, and events wait their turn.',
          },
          {
            id: 'computing.browsers.same-origin',
            meaning: 'The same-origin policy keeps one site’s pages from reading another’s data.',
          },
        ],
      },
      {
        id: 'computing.algorithms',
        meaning: 'Ways of solving problems with code, and how their cost grows with the size of the problem.',
        sceneFamily: 'ridged.v1',
        facets: [
          {
            id: 'computing.algorithms.growth',
            meaning: 'Cost is described by how the work grows with the size of the input.',
          },
          {
            id: 'computing.algorithms.sorting',
            meaning: 'Different sorting strategies trade speed, memory and stability.',
          },
          {
            id: 'computing.algorithms.hashing',
            meaning: 'Hash tables give fast lookups by turning keys into positions.',
          },
        ],
      },
    ],
  },
  {
    id: 'history',
    meaning: 'How past events and ideas shaped the world, told with their uncertainties.',
    sceneFamily: 'ridged.v1',
    haze: 'pink',
    topics: [
      {
        id: 'history.industrial-revolution',
        meaning: 'The shift from hand tools and farms to machines and factories, beginning in Britain.',
        facets: [
          {
            id: 'history.industrial-revolution.causes',
            meaning: 'Why industrialisation began where and when it did, and which causes historians weigh.',
          },
          {
            id: 'history.industrial-revolution.technology',
            meaning: 'New machines and power sources changed how goods were made.',
          },
          {
            id: 'history.industrial-revolution.consequences',
            meaning: 'Industrialisation changed where people lived and how they worked.',
          },
          {
            id: 'history.industrial-revolution.interpretation',
            meaning: 'Historians disagree about why and when Western Europe pulled ahead.',
          },
        ],
      },
    ],
  },
];

/** What release 1 holds, as counts. */
export const RELEASE_1_COUNTS = { systems: 6, topics: 17, facets: 53 } as const;

/** The digest release 1 stores, which every coverage mapping decided before the catalogue was data recorded as its catalogue digest. */
export const RELEASE_1_DIGEST = 'b2c474bed5f2f0d6dafcc9c8663ff1b0a9279b143312a970f2f591882941e6cd';
