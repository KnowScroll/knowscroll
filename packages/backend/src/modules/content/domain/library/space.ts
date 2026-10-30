import type { LibrarySystem, SystemRecipes } from './plan.js';

/** Space: stars, other worlds and black holes, and how astronomers know about them. */
export const spaceSystem = {
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
        { id: 'space.stars.lifecycle', meaning: 'A star’s mass sets how it ages and how it ends.' },
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
} as const satisfies LibrarySystem;

const system = 'space';

export const spaceRecipes = {
  'stars-fusion': {
    explanationUnitId: 'space-stars-fusion-v1',
    assetId: '637df7a3-e65d-4c94-8205-36e95818e7f8',
    systemId: system,
    topicId: 'space.stars',
    facetId: 'space.stars.fusion',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'How a star shines and stays steady. When a cloud of gas collapses, pressure and temperature at its core rise until hydrogen fuses into helium; the energy flowing outward creates a pressure that counters gravity and holds the star in balance. Let the reader compare a star in balance with what would happen if either gravity or pressure won. Say that more massive stars use their fuel faster and live shorter lives. Do not say the Sun burns like a fire.',
    pages: ['https://en.wikipedia.org/wiki/Main_sequence'],
  },
  'stars-lifecycle': {
    explanationUnitId: 'space-stars-lifecycle-v1',
    assetId: '62f0627c-4a90-4008-8cf2-cac958cbb226',
    systemId: system,
    topicId: 'space.stars',
    facetId: 'space.stars.lifecycle',
    interactive: true,
    interactiveKind: 'timeline',
    brief:
      'How stars age and end. A star’s mass sets its path: a low-mass star swells into a giant and ends as a white dwarf, while a high-mass star can end in a supernova. Lay the stages out in order, without years, for a low-mass star and for a high-mass one. Do not say the Sun will become a supernova, and give no exact lifetimes.',
    pages: ['https://science.nasa.gov/universe/stars/'],
  },
  'stars-colour-brightness': {
    explanationUnitId: 'space-stars-colour-brightness-v1',
    assetId: 'c3942f38-34d4-4234-8803-9994433b2b68',
    systemId: system,
    topicId: 'space.stars',
    facetId: 'space.stars.measurement',
    interactive: false,
    interactiveKind: null,
    brief:
      'What colour and brightness reveal about a star. Plotting stars by temperature or colour against luminosity sorts them into groups, such as the main sequence, giants and white dwarfs, in a chart called the Hertzsprung–Russell diagram. Explain how that chart lets astronomers read a star’s likely kind and stage. Do not claim colour alone gives a star’s age or that every main-sequence star is alike.',
    pages: ['https://en.wikipedia.org/wiki/Hertzsprung%E2%80%93Russell_diagram'],
  },
  'exoplanet-transit': {
    explanationUnitId: 'space-exoplanets-transit-v1',
    assetId: 'f625ad99-e71c-4bc0-980e-4636455d8b02',
    systemId: system,
    topicId: 'space.exoplanets',
    facetId: 'space.exoplanets.detection',
    interactive: true,
    interactiveKind: 'chart',
    brief:
      'How planets are found by their effect on starlight. When a planet passes in front of its star the starlight dips slightly and regularly, the method used by the Kepler and TESS telescopes; a planet’s pull can also make its star wobble, which shows up as shifts in the starlight’s wavelengths. Let the reader compare the dip from a small and a large planet, in illustrative units. Say that different methods find different kinds of planets. Do not imply that most known planets were photographed directly.',
    pages: ['https://science.nasa.gov/exoplanets/how-we-find-and-characterize/'],
  },
  'exoplanet-habitable-zone': {
    explanationUnitId: 'space-exoplanets-habitable-zone-v1',
    assetId: '96737a4f-4cf8-453c-88eb-ddb450116111',
    systemId: system,
    topicId: 'space.exoplanets',
    facetId: 'space.exoplanets.habitability',
    interactive: true,
    interactiveKind: 'simulation',
    brief:
      'What the habitable zone is: the region around a star where a planet could have liquid water on its surface. A planet’s distance from its star sets how much starlight it receives, and stars of different brightness have zones at different distances. Let the reader move a planet outward and see how the starlight it receives falls, labelled as illustrative. Stress that being in the zone does not make a planet habitable or inhabited, and do not claim that life has been found elsewhere.',
    pages: ['https://en.wikipedia.org/wiki/Circumstellar_habitable_zone'],
  },
  'exoplanet-kinds': {
    explanationUnitId: 'space-exoplanets-kinds-v1',
    assetId: '1351c4b6-0388-46e0-9956-c9da2405f041',
    systemId: system,
    topicId: 'space.exoplanets',
    facetId: 'space.exoplanets.diversity',
    interactive: false,
    interactiveKind: null,
    brief:
      'A kind of world with no counterpart in the Solar System: the super-Earth, a planet more massive than Earth but well below Uranus and Neptune. Explain that the name describes mass alone and says nothing about temperature, composition, orbit or habitability. Compare it with the planets of the Solar System. Do not call any planet Earth-like without saying in what way, and do not claim that any is known to host life.',
    pages: ['https://en.wikipedia.org/wiki/Super-Earth'],
  },
  'black-hole-formation': {
    explanationUnitId: 'space-black-holes-formation-v1',
    assetId: 'e98ed4cd-e3fd-4463-acd7-7a68a16f2c82',
    systemId: system,
    topicId: 'space.black-holes',
    facetId: 'space.black-holes.formation',
    interactive: false,
    interactiveKind: null,
    brief:
      'How black holes form. When a star with more than about eight times the Sun’s mass runs out of fuel, its core collapses and the star explodes as a supernova, and what remains can be a stellar-mass black hole. Contrast this with the supermassive black holes at the centres of large galaxies, whose origins scientists are still working out, and mention the puzzling gap in sizes between the two. Do not say the Sun will become a black hole.',
    pages: ['https://science.nasa.gov/universe/black-holes/types/'],
  },
  'black-hole-horizon': {
    explanationUnitId: 'space-black-holes-horizon-v1',
    assetId: 'f1b42f11-432b-4533-ad08-bba27304d457',
    systemId: system,
    topicId: 'space.black-holes',
    facetId: 'space.black-holes.horizon',
    interactive: true,
    interactiveKind: 'diagram',
    brief:
      'What the event horizon is. It is the black hole’s boundary, not a solid surface: inside it the speed needed to escape is greater than the speed of light, so nothing that crosses it can return. Let the reader compare the view from far away with what a spacecraft nearing the horizon would meet, including the stretching called spaghettification that strong tidal gravity causes. Do not describe the centre as understood.',
    pages: ['https://science.nasa.gov/universe/black-holes/anatomy/', 'https://spaceplace.nasa.gov/black-holes/en/'],
  },
  'black-hole-evidence': {
    explanationUnitId: 'space-black-holes-evidence-v1',
    assetId: 'ae9f0a1f-da32-41c5-a92b-63af00633461',
    systemId: system,
    topicId: 'space.black-holes',
    facetId: 'space.black-holes.evidence',
    interactive: false,
    interactiveKind: null,
    brief:
      'How astronomers know black holes exist when they emit no light of their own. Cover the gas and dust that glow in X-rays as they swirl in, stars whose orbits reveal an unseen heavy object at a galaxy’s centre, ripples in spacetime called gravitational waves, and the way a black hole bends light from objects behind it. Do not suggest that any one line of evidence alone settles the matter.',
    pages: ['https://science.nasa.gov/universe/black-holes/'],
  },
} as const satisfies SystemRecipes<typeof spaceSystem>;
