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
      'How a star shines and stays steady. When a cloud of gas collapses, pressure and temperature at its core rise until hydrogen fuses into helium; the energy flowing outward creates a pressure that counters gravity and holds the star in balance. Say that the more massive a star is, the shorter its life on the main sequence. Do not say the Sun burns like a fire. Make no claim about how metallicity changes a star’s main-sequence lifetime.',
    pages: ['https://en.wikipedia.org/wiki/Main_sequence'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A collapsing gas cloud heats until hydrogen fuses into helium',
        "Fusion's outward pressure balances gravity, so the star holds steady",
        'The more massive a star is, the shorter its life on the main sequence',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'How a star comes to shine and hold steady, in order: gas cloud collapses under gravity; pressure and temperature rise at the core; hydrogen fuses into helium; heat flows outward as a pressure gradient; it counters the collapse (hydrostatic equilibrium).',
        },
        {
          kind: 'statement',
          purpose:
            "A short labelled list of three: gravity pulls the star inward while the pressure from the core's energy pushes outward; stars spend most of their lives on the main sequence, fusing hydrogen in the core; the more massive a star is, the shorter its life there.",
        },
      ],
      misconception: { kind: 'none' },
    },
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
    scrollV3: {
      shape: 'story',
      sections: [
        'Every star is born in a cloud and spends most of its life on the main sequence',
        'A low-mass star swells into a giant and ends as a white dwarf',
        'A high-mass star fuses heavier elements and can end in a supernova',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'The low-mass path, no years: molecular cloud; protostar; main-sequence star; giant; planetary nebula; white dwarf.',
        },
        {
          kind: 'flow',
          purpose:
            'The high-mass path, no years: main sequence; fuses carbon into heavier elements; silicon fuses into iron; iron core collapses and rebounds; supernova; neutron star or black hole.',
        },
      ],
      misconception: { kind: 'none' },
    },
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
    pages: [
      'https://en.wikipedia.org/wiki/Hertzsprung%E2%80%93Russell_diagram',
      'https://en.wikipedia.org/wiki/Main_sequence',
    ],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A chart of brightness against temperature sorts stars into groups',
        'The main sequence is where stars spend most of their lives; giants are far brighter than dwarfs',
        'A star leaves the main sequence when its core hydrogen is used up',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            'A short labelled list of three on how to read the chart: stars of greater luminosity are toward the top; stars with higher surface temperature are toward the left; most stars fall in one continuous band, the main sequence, where they spend the majority of their lives.',
        },
        {
          kind: 'flow',
          purpose:
            "How a star's place changes, in order: it spends most of its life on the main sequence; the hydrogen fuel at its core is used up; it evolves away from the main sequence into a supergiant, a red giant, or directly to a white dwarf. The more massive the star, the shorter its time on the main sequence.",
        },
      ],
      misconception: { kind: 'none' },
    },
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
      'How planets are found by their effect on starlight. When a planet passes in front of its star the starlight dips slightly and regularly, the method used by the Kepler and TESS telescopes; a planet’s pull can also make its star wobble, which shows up as shifts in the starlight’s wavelengths. Describe the dip in words only: the supplied passages give no figures for how deep it is. Say that different methods find different kinds of planets. Do not imply that most known planets were photographed directly.',
    pages: ['https://science.nasa.gov/exoplanets/how-we-find-and-characterize/'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'A planet crossing its star dims the starlight slightly and regularly',
        "A planet's pull makes its star wobble, shifting the starlight's wavelengths",
        'Different methods find different kinds of planets',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            "The transit method in order: a planet passes in front of its star; the starlight dips slightly; the dips repeat with each orbit; the period and the star's mass give the planet's orbital size.",
        },
        {
          kind: 'grid',
          purpose:
            'A comparison of four ways to find planets: rows radial velocity (wobble), transit (dip), microlensing (spike), direct imaging; columns what is seen and what it has found.',
        },
      ],
      misconception: { kind: 'none' },
    },
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
      'What the habitable zone is: the range of orbits around a star within which a planetary surface could potentially support liquid water. Say that the range depends on the brightness of the star, so stars of different brightness have zones at different distances, and that whether a planet is in the zone depends on the radius of its orbit and the star’s radiative flux. Describe the inner and outer edges in words and give no distances or starlight figures. Stress that being in the zone does not make a planet habitable or inhabited, and do not claim that life has been found elsewhere.',
    pages: ['https://en.wikipedia.org/wiki/Circumstellar_habitable_zone'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        'The habitable zone: the range of orbits where a planet could have liquid water on its surface',
        "The star's brightness and the planet's orbit set the zone; its edges are where water boils off or freezes",
        'Being in the zone does not make a planet habitable or inhabited',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            "A 2 x 2 of the zone's two edges: rows inner edge and outer edge, columns what happens to a planet's water there and what sets the limit. Inner: the star's light, trapped by greenhouse gases, boils the water off. Outer: the light is too weak, even with help from atmospheric gas, and the water freezes.",
        },
        {
          kind: 'statement',
          purpose:
            "A short labelled list of three: the zone is the range of orbits where a planetary surface could potentially support liquid water; the range depends on the star's brightness; different climate models give different sizes of zone.",
        },
      ],
      misconception: { kind: 'none' },
    },
  },
  'exoplanet-kinds': {
    explanationUnitId: 'space-exoplanets-kinds-v1',
    assetId: '1351c4b6-0388-46e0-9956-c9da2405f041',
    systemId: system,
    topicId: 'space.exoplanets',
    facetId: 'space.exoplanets.diversity',
    // No kit: the subject is what the name "super-Earth" does not say (composition, temperature, orbit,
    // habitability), and a ruler of masses would be a chart of real data, which is a later block (D-204).
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
      'How black holes form. When a star with more than about eight times the Sun’s mass runs out of fuel, its core collapses and the star explodes as a supernova; what is left depends on the star’s mass before the explosion: a neutron star near that threshold, and a stellar-mass black hole if it had around 20 times the Sun’s mass or more. Contrast this with the supermassive black holes at the centres of large galaxies, whose origins scientists are still working out, and mention the puzzling gap in sizes between the two. Do not say the Sun will become a black hole.',
    pages: ['https://science.nasa.gov/universe/black-holes/types/'],
    scrollV3: {
      shape: 'story',
      sections: [
        "A star above about eight Suns' mass runs out of fuel and its core collapses",
        'The supernova can leave a stellar-mass black hole',
        'Supermassive black holes: origins unsolved, with a puzzling gap in sizes',
      ],
      pictures: [
        {
          kind: 'flow',
          purpose:
            'How a stellar-mass black hole forms: a star above about eight Suns runs out of fuel; its core collapses and rebounds; it explodes as a supernova; if it was around 20 Suns or more, the core collapses to a black hole.',
        },
        {
          kind: 'grid',
          purpose:
            'A comparison of three sizes of black hole: rows stellar-mass, intermediate, supermassive; columns mass range and what is known of their origin.',
        },
      ],
      misconception: { kind: 'none' },
    },
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
      'What the event horizon is. It is the black hole’s boundary: inside it the speed needed to escape is greater than the speed of light, so nothing that crosses it can return. Compare the view from far away with what a spacecraft nearing the horizon would meet, including the stretching called spaghettification that strong tidal gravity causes. Do not call the horizon a solid surface and do not describe the centre as understood.',
    pages: ['https://science.nasa.gov/universe/black-holes/anatomy/', 'https://spaceplace.nasa.gov/black-holes/en/'],
    scrollV3: {
      shape: 'mechanism',
      sections: [
        "The event horizon is the black hole's boundary",
        'Inside it, escaping would need more than the speed of light',
        'From far away versus close in: the dark shadow, and spaghettification',
      ],
      pictures: [
        {
          kind: 'statement',
          purpose:
            "One labelled list of three about the event horizon: it is the black hole's boundary; inside it, escape would need more than the speed of light; its shadow looks about twice the size of the black hole.",
        },
        {
          kind: 'grid',
          purpose:
            'A 2 x 2 comparing two viewpoints: rows seen from far away and met by a spacecraft near the horizon, columns what is seen or felt and why.',
        },
      ],
      misconception: { kind: 'none' },
    },
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
    scrollV3: {
      shape: 'argument',
      sections: [
        'Black holes give off no light, so astronomers read their effects',
        'Glowing gas and orbiting stars: the clues of light and motion',
        'Ripples in space-time and bent light: the clues of gravity itself',
      ],
      pictures: [
        {
          kind: 'grid',
          purpose:
            'Four lines of evidence: rows accretion disk, orbiting stars, gravitational waves, gravitational lensing; columns what is seen and what it reveals.',
        },
      ],
      misconception: { kind: 'none' },
    },
  },
} as const satisfies SystemRecipes<typeof spaceSystem>;
