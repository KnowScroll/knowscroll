import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';
import { blackbodyColour, peakNanometres } from './spectrum.js';
import {
  LUMINOSITY_MASS_EXPONENT,
  mainSequenceLuminosityForMass,
  mainSequenceRadiusForMass,
  RADIUS_MASS_EXPONENT,
} from './star.js';

/**
 * The starlight kit (D-204): what the light of a star tells and what it makes possible. The writer
 * chooses the view, a kind of star, a distance, a planet's orbit and the part to look at. Code derives the
 * rest (D-205): a star's colour from its surface temperature (hotter is bluer, by Wien's law and Planck's
 * spectrum), its output from its size and temperature together (L goes as R squared times T to the fourth),
 * how its light thins with distance (one over the distance squared), where it lies on the chart of stars,
 * and where a planet could have liquid water (the zone's distances go as the square root of the output). A
 * stored state has no field in which a hotter star could be redder or a brighter star's zone could lie
 * closer in.
 *
 * The kinds of star are illustrative. The three main-sequence stars take their size and output from the
 * same power laws as the star kit (`star.v1`), and their temperature follows from them; the red giant and
 * the white dwarf are typical, not named stars. The picture gives no years and no real star's data.
 */
export const STARLIGHT_KIT = 'starlight.v1';

export const STARLIGHT_ENUMS = {
  /**
   * What the picture is of. `colour` puts five stars in a row over the spectrum; `output` compares one
   * star's size, heat and output with a star like the Sun; `dimming` spreads light over growing distances;
   * `diagram` places the stars on a chart of temperature against output; `zone` draws the habitable zones
   * of three stars with a planet's orbit.
   */
  view: ['colour', 'output', 'dimming', 'diagram', 'zone'],
  /** A kind of star. Marked in `colour`, `output` and `diagram`; in `zone` only the first three have a zone. */
  star: ['low-mass', 'sun-like', 'bright', 'giant', 'white-dwarf'],
  /** In `dimming`: how far the marked frame is: one, two or four steps from the star. */
  distance: ['near', 'middle', 'far'],
  /** In `zone`: a planet's orbit: about as close as Mercury, as far as Earth, or four times as far as Earth, or no planet. */
  orbit: ['none', 'inner', 'earth', 'outer'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: ['none', 'star', 'spectrum', 'size', 'heat', 'output', 'spread', 'looks', 'main-sequence', 'zone', 'planet'],
} as const;

export type StarlightState = KitState<typeof STARLIGHT_ENUMS>;
export type StarlightPatch = KitPatch<typeof STARLIGHT_ENUMS>;
export type StarlightView = StarlightState['view'];
export type StarKind = StarlightState['star'];
export type StarlightDistance = StarlightState['distance'];
export type PlanetOrbit = StarlightState['orbit'];

export const INITIAL_STARLIGHT_STATE: StarlightState = {
  view: 'colour',
  star: 'sun-like',
  distance: 'near',
  orbit: 'none',
  focus: 'none',
};

export const StarlightStateSchema = kitStateSchema(STARLIGHT_ENUMS);

/** The parts of the kit a picture may be made of. A focus names one of them. */
export type StarlightPart =
  'star' | 'spectrum' | 'size' | 'heat' | 'output' | 'spread' | 'looks' | 'main-sequence' | 'zone' | 'planet';

/** What a state draws. The planet is drawn only where an orbit is chosen. */
export function starlightParts(state: Pick<StarlightState, 'view' | 'orbit'>): readonly StarlightPart[] {
  switch (state.view) {
    case 'colour':
      return ['star', 'spectrum'];
    case 'output':
      return ['star', 'size', 'heat', 'output'];
    case 'dimming':
      return ['star', 'spread', 'looks'];
    case 'diagram':
      return ['star', 'main-sequence'];
    case 'zone':
      return state.orbit === 'none' ? ['star', 'zone'] : ['star', 'zone', 'planet'];
  }
}

/** The three stars whose zones are drawn: the others have no zone the picture can honestly draw. */
export const ZONE_STARS = ['low-mass', 'sun-like', 'bright'] as const;
export type ZoneStar = (typeof ZONE_STARS)[number];
const isZoneStar = (kind: StarKind): kind is ZoneStar => (ZONE_STARS as readonly string[]).includes(kind);

/**
 * The state a view can really show: a key the view does not use is set aside, and so is a focus on a part that is
 * not drawn. A zone is drawn for three stars only, so a giant or a white dwarf chosen in `zone` is settled to a
 * star like the Sun (the guide tells the writer). Idempotent.
 */
export function settleStarlightState(state: StarlightState): StarlightState {
  const parts = starlightParts(state);
  const focus = state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none';
  const star =
    state.view === 'dimming'
      ? INITIAL_STARLIGHT_STATE.star
      : state.view === 'zone' && !isZoneStar(state.star)
        ? INITIAL_STARLIGHT_STATE.star
        : state.star;
  return {
    view: state.view,
    star,
    distance: state.view === 'dimming' ? state.distance : INITIAL_STARLIGHT_STATE.distance,
    orbit: state.view === 'zone' ? state.orbit : INITIAL_STARLIGHT_STATE.orbit,
    focus,
  };
}

/** The Sun's surface temperature in kelvins: the reference every output and zone is measured against. */
export const SUN_SURFACE_KELVINS = 5772;

/** The masses, in Suns, of the three main-sequence kinds. */
export const MAIN_SEQUENCE_MASS_IN_SUNS: Readonly<Record<ZoneStar, number>> = {
  'low-mass': 0.5,
  'sun-like': 1,
  bright: 2,
};

/** A red giant's and a white dwarf's surface temperature (kelvins) and radius (Suns' radii): typical, illustrative values. */
const OTHER_STARS = {
  giant: { kelvins: 4000, radius: 25 },
  'white-dwarf': { kelvins: 15000, radius: 0.01 },
} as const;

/** Where a star lies on the chart of stars. */
export type StarGroup = 'main-sequence' | 'giants' | 'white-dwarfs';

export interface StarlightStar {
  readonly kelvins: number;
  /** Radius in Suns' radii. */
  readonly radius: number;
  /** Output in Suns' outputs: radius squared times (temperature over the Sun's) to the fourth. */
  readonly luminosity: number;
  /** Where its glow is strongest, in nanometres (Wien's law). */
  readonly peakNanometres: number;
  /** What colour it looks, from the spectrum of a surface at its temperature. */
  readonly colour: string;
  readonly group: StarGroup;
}

/** A star's output in Suns' outputs, from its radius in Suns' radii and surface temperature: the Stefan-Boltzmann law as a ratio to the Sun. */
export function luminosityOf(radius: number, kelvins: number): number {
  return radius ** 2 * (kelvins / SUN_SURFACE_KELVINS) ** 4;
}

/**
 * The output of a main-sequence star at a surface temperature, in Suns' outputs. The mass-output and mass-size power
 * laws fix the temperature of each mass (it goes as the mass to the power (3.5 - 2 * 0.8) / 4), so the output of
 * the band of main-sequence stars is the temperature to the power 3.5 over that exponent.
 */
export function mainSequenceLuminosityAt(kelvins: number): number {
  const temperatureExponent = (LUMINOSITY_MASS_EXPONENT - 2 * RADIUS_MASS_EXPONENT) / 4;
  return (kelvins / SUN_SURFACE_KELVINS) ** (LUMINOSITY_MASS_EXPONENT / temperatureExponent);
}

/** Which part of the chart a star at this temperature and output lies in: a tenth of the main sequence's output or less, a tenfold more or less. */
export function starGroup(kelvins: number, luminosity: number): StarGroup {
  const dex = Math.log10(luminosity / mainSequenceLuminosityAt(kelvins));
  return dex > 1 ? 'giants' : dex < -1 ? 'white-dwarfs' : 'main-sequence';
}

function starFrom(kelvins: number, radius: number): StarlightStar {
  const luminosity = luminosityOf(radius, kelvins);
  return {
    kelvins,
    radius,
    luminosity,
    peakNanometres: peakNanometres(kelvins),
    colour: blackbodyColour(kelvins),
    group: starGroup(kelvins, luminosity),
  };
}

/** The surface temperature of a main-sequence star of a mass: the temperature at which its radius gives its output. */
function mainSequenceKelvins(massInSuns: number): number {
  const radius = mainSequenceRadiusForMass(massInSuns);
  return SUN_SURFACE_KELVINS * (mainSequenceLuminosityForMass(massInSuns) / radius ** 2) ** 0.25;
}

/** What a kind of star is: derived, never stored. */
export function starlightStar(kind: StarKind): StarlightStar {
  if (isZoneStar(kind)) {
    const mass = MAIN_SEQUENCE_MASS_IN_SUNS[kind];
    return starFrom(mainSequenceKelvins(mass), mainSequenceRadiusForMass(mass));
  }
  return starFrom(OTHER_STARS[kind].kelvins, OTHER_STARS[kind].radius);
}

/** The five kinds, hottest surface last: the order the colour view draws them in. */
export const STARS_BY_TEMPERATURE: readonly StarKind[] = [...STARLIGHT_ENUMS.star].sort(
  (first, second) => starlightStar(first).kelvins - starlightStar(second).kelvins,
);

/** How many steps from the star each frame lies: the marked one is one of these. Illustrative. */
export const DISTANCE_STEPS: Readonly<Record<StarlightDistance, number>> = { near: 1, middle: 2, far: 4 };

/** The share of a star's light one square catches at a distance, against the same square one step away: one over the distance squared. */
export function dimmedShare(distance: StarlightDistance): number {
  return 1 / DISTANCE_STEPS[distance] ** 2;
}

/**
 * The starlight (in what Earth gets from the Sun) at the inner and outer edges of the zone where a planet could
 * keep liquid water on its surface. Illustrative conservative limits for a Sun-like star (Kopparapu and others,
 * 2013): beyond the inner one a planet's water would be lost, beyond the outer one it would freeze whatever its air.
 * Real limits shift with the colour of the starlight and with the planet.
 */
export const ZONE_STARLIGHT = { inner: 1.107, outer: 0.356 } as const;

/** A planet's distance in astronomical units (Earth's distance from the Sun is one) for each orbit. */
export const ORBIT_ASTRONOMICAL_UNITS: Readonly<Record<Exclude<PlanetOrbit, 'none'>, number>> = {
  inner: 0.4,
  earth: 1,
  outer: 4,
};

/** The starlight a planet gets at a distance, in what Earth gets from the Sun: output over distance squared. */
export function starlightAt(luminosity: number, astronomicalUnits: number): number {
  return luminosity / astronomicalUnits ** 2;
}

export interface HabitableZone {
  readonly innerAstronomicalUnits: number;
  readonly outerAstronomicalUnits: number;
}

/** The zone of a star of a given output: its distances go as the square root of the output. */
export function habitableZoneOf(luminosity: number): HabitableZone {
  return {
    innerAstronomicalUnits: Math.sqrt(luminosity / ZONE_STARLIGHT.inner),
    outerAstronomicalUnits: Math.sqrt(luminosity / ZONE_STARLIGHT.outer),
  };
}

export type ZoneVerdict = 'too-hot' | 'in-zone' | 'too-cold';

/** Whether a planet at a distance gets more starlight than the inner limit, between the limits, or less than the outer one. */
export function zoneVerdict(luminosity: number, astronomicalUnits: number): ZoneVerdict {
  const light = starlightAt(luminosity, astronomicalUnits);
  return light > ZONE_STARLIGHT.inner ? 'too-hot' : light < ZONE_STARLIGHT.outer ? 'too-cold' : 'in-zone';
}

export interface StarlightPhysics {
  readonly star: StarlightStar;
  readonly reference: StarlightStar;
  /** Base-ten logarithms of the star's surface area, the light each patch gives out, and the output, each against the Sun-like star's. */
  readonly sizeDex: number;
  readonly heatDex: number;
  readonly outputDex: number;
  /** In `dimming`: steps from the star, and the share of the light a square catches against one step away. */
  readonly distanceSteps: number;
  readonly share: number;
  /** The zone of each star that has one. */
  readonly zones: Readonly<Record<ZoneStar, HabitableZone>>;
  /** The planet's distance and whether it lies in each star's zone, when an orbit is chosen. */
  readonly planet:
    undefined | { readonly astronomicalUnits: number; readonly verdicts: Readonly<Record<ZoneStar, ZoneVerdict>> };
}

/** What follows from a state by physics. Derived, never stored and never written by the model. */
export function starlightPhysics(state: Pick<StarlightState, 'star' | 'distance' | 'orbit'>): StarlightPhysics {
  const star = starlightStar(state.star);
  const reference = starlightStar('sun-like');
  const sizeDex = Math.log10((star.radius / reference.radius) ** 2);
  const heatDex = Math.log10((star.kelvins / reference.kelvins) ** 4);
  const zones = Object.fromEntries(
    ZONE_STARS.map((kind) => [kind, habitableZoneOf(starlightStar(kind).luminosity)]),
  ) as Record<ZoneStar, HabitableZone>;
  const astronomicalUnits = state.orbit === 'none' ? undefined : ORBIT_ASTRONOMICAL_UNITS[state.orbit];
  return {
    star,
    reference,
    sizeDex,
    heatDex,
    outputDex: Math.log10(star.luminosity / reference.luminosity),
    distanceSteps: DISTANCE_STEPS[state.distance],
    share: dimmedShare(state.distance),
    zones,
    planet:
      astronomicalUnits === undefined
        ? undefined
        : {
            astronomicalUnits,
            verdicts: Object.fromEntries(
              ZONE_STARS.map((kind) => [kind, zoneVerdict(starlightStar(kind).luminosity, astronomicalUnits)]),
            ) as Record<ZoneStar, ZoneVerdict>,
          },
  };
}

const STAR_NAME: Readonly<Record<StarKind, string>> = {
  'low-mass': 'a low-mass star',
  'sun-like': 'a star like the Sun',
  bright: 'a brighter, hotter star',
  giant: 'a red giant',
  'white-dwarf': 'a white dwarf',
};

const capital = (text: string): string => text.replace(/^./u, (letter) => letter.toUpperCase());

function colourSentences(state: StarlightState): string[] {
  return [
    'Five stars in a row, from the hottest, blue-white, on the left to the coolest, red-orange, on the right, over a strip of the spectrum from ultraviolet to infrared. Each star’s marker shows the wavelength where it shines most strongly: the hotter the surface, the shorter that wavelength and the bluer the star looks. Colours are strengthened so that they can be told apart, and sizes are not to scale.',
    `${capital(STAR_NAME[state.star])} is marked.`,
  ];
}

function outputSentences(state: StarlightState, physics: StarlightPhysics): string[] {
  const intro =
    'A star drawn beside a star like the Sun, on a stretched scale. Three bars compare them, each step on the bars being ten times: the area of its surface, the light each patch of surface gives out (which rises steeply with temperature) and its total output, which is the two together. Colours are strengthened.';
  if (state.star === 'sun-like') return [intro, 'It is the star like the Sun itself, so every bar sits at the middle.'];
  const larger = physics.sizeDex > 0;
  const hotter = physics.heatDex > 0;
  const amount = `${Math.abs(physics.outputDex) > 1 ? 'far ' : ''}${physics.outputDex > 0 ? 'greater' : 'less'}`;
  const decides = Math.abs(physics.sizeDex) > Math.abs(physics.heatDex) ? 'size' : 'heat';
  return [
    intro,
    `${capital(STAR_NAME[state.star])} is ${larger ? 'larger' : 'smaller'} and its surface is ${hotter ? 'hotter' : 'cooler'}.`,
    larger === hotter
      ? `Both push the same way, so its total output is ${amount}.`
      : `Its ${decides} counts for more, so its total output is ${amount}.`,
  ];
}

const SHARE_WORDS: Readonly<Record<number, string>> = { 1: 'the same', 4: 'a quarter', 16: 'a sixteenth' };
const FRAME_WORDS: Readonly<Record<StarlightDistance, string>> = {
  near: 'nearest',
  middle: 'middle',
  far: 'farthest',
};

function dimmingSentences(state: StarlightState, physics: StarlightPhysics): string[] {
  const looks = SHARE_WORDS[physics.distanceSteps ** 2] ?? '';
  return [
    'A star at the left and three square frames at growing distances. The farther the frame, the wider it is, so the same light is spread over more squares and one square catches less: a quarter at twice the distance, a sixteenth at four times. Colours are strengthened.',
    `The ${FRAME_WORDS[state.distance]} frame is marked: there a square catches ${looks} of the light it catches nearest, though the star gives out just as much.`,
  ];
}

const GROUP_WORDS: Readonly<Record<StarGroup, string>> = {
  'main-sequence': 'on the main sequence',
  giants: 'among the giants, above the band',
  'white-dwarfs': 'among the white dwarfs, below the band',
};

function diagramSentences(state: StarlightState, physics: StarlightPhysics): string[] {
  return [
    'A chart of stars: temperature along the bottom, hotter to the left, and the light each gives out up the side, both on stretched scales. Most stars lie on a diagonal band, the main sequence; giants lie above it and white dwarfs below. Five stars are drawn. A star’s place suggests its kind and stage; colour alone does not give its age. Colours are strengthened.',
    `${capital(STAR_NAME[state.star])} is marked: it lies ${GROUP_WORDS[physics.star.group]}.`,
  ];
}

const ORBIT_WORDS: Readonly<Record<Exclude<PlanetOrbit, 'none'>, string>> = {
  inner: 'about as close as Mercury is to the Sun',
  earth: 'at Earth’s distance from the Sun',
  outer: 'four times Earth’s distance from the Sun',
};

const VERDICT_WORDS: Readonly<Record<ZoneVerdict, string>> = {
  'too-hot': 'too hot',
  'in-zone': 'inside the zone',
  'too-cold': 'too cold',
};

function zoneSentences(state: StarlightState, physics: StarlightPhysics): string[] {
  const intro =
    'Three stars’ habitable zones along a scale of distance. A zone is the band where a planet’s surface could hold liquid water, if its air and other conditions allow. The brighter and hotter the star, the farther out and the wider its zone. Zone edges are illustrative; colours are strengthened.';
  const planet =
    physics.planet === undefined || state.orbit === 'none'
      ? ''
      : `A planet ${ORBIT_WORDS[state.orbit]} is ${VERDICT_WORDS[physics.planet.verdicts['low-mass']]} for the low-mass star, ${VERDICT_WORDS[physics.planet.verdicts['sun-like']]} for the star like the Sun and ${VERDICT_WORDS[physics.planet.verdicts.bright]} for the brighter one.`;
  return [
    intro,
    planet,
    `${capital(STAR_NAME[state.star])} is marked. A planet inside a zone is not thereby a planet with water or life.`,
  ];
}

const FOCUS_SENTENCE: Readonly<Record<StarlightState['focus'], string>> = {
  none: '',
  star: 'The picture draws the eye to the star.',
  spectrum: 'The picture draws the eye to the markers on the spectrum.',
  size: 'The picture draws the eye to the bar for size.',
  heat: 'The picture draws the eye to the bar for heat.',
  output: 'The picture draws the eye to the bar for total output.',
  spread: 'The picture draws the eye to the frames.',
  looks: 'The picture draws the eye to the marked frame.',
  'main-sequence': 'The picture draws the eye to the main sequence.',
  zone: 'The picture draws the eye to the zone.',
  planet: 'The picture draws the eye to the planet.',
};

/**
 * What a starlight state shows, as sentences: the text version of a stage and its accessible name. It is
 * derived by code from the state and its physics, never written by the model, and it settles the state
 * first, so it mentions only what the view draws and cannot disagree with the picture.
 */
export function describeStarlightState(chosen: StarlightState): string {
  const state = settleStarlightState(chosen);
  const physics = starlightPhysics(state);
  const sentences =
    state.view === 'colour'
      ? colourSentences(state)
      : state.view === 'output'
        ? outputSentences(state, physics)
        : state.view === 'dimming'
          ? dimmingSentences(state, physics)
          : state.view === 'diagram'
            ? diagramSentences(state, physics)
            : zoneSentences(state, physics);
  return [...sentences, FOCUS_SENTENCE[state.focus]].filter((sentence) => sentence !== '').join(' ');
}

export const STARLIGHT_KIT_DEFINITION = defineKit({
  id: STARLIGHT_KIT,
  enums: STARLIGHT_ENUMS,
  initial: INITIAL_STARLIGHT_STATE,
  settle: settleStarlightState,
  describe: describeStarlightState,
  writerGuide: [
    'Code draws the picture from a fixed kit: five kinds of star in their colours over the spectrum, one star compared with a star like the Sun by size, heat and total output, light thinning with distance, a chart of stars by temperature and output, and the habitable zones of three stars with a planet’s orbit. You choose only the view, the kind of star, the distance, the orbit and the part to look at, from the listed words. Code decides everything else: each star’s colour comes from its surface temperature, its output from its size and temperature together, the dimming from the distance, and the zones from the stars’ output. So the star you choose is a claim the picture makes: choose the one that matches what the stop says.',
    '- The views: "colour" shows five stars from cool to hot over the spectrum, with where each shines most strongly, and marks the one you choose with "star"; "output" shows one star beside a star like the Sun with bars for its size, its heat and its total output; "dimming" shows a star and three frames at one, two and four steps ("distance" is "near", "middle" or "far"), and does not use "star"; "diagram" shows the five stars on the chart of temperature against output, the main sequence and the giants and white dwarfs; "zone" shows the habitable zones of a low-mass star, a star like the Sun and a brighter, hotter one, and a planet at an "orbit": "none", "inner" (about as close as Mercury), "earth" (as far as Earth) or "outer" (four times as far as Earth). The stars: "low-mass", "sun-like", "bright" (brighter and hotter than the Sun), "giant" (a red giant) and "white-dwarf". In "zone" only the first three have a zone, and a giant or a white dwarf is shown as a star like the Sun. A key a view does not use is ignored.',
    '- A habitable zone is where liquid water could exist on a surface, not where life exists or where a planet is habitable. Say "could have liquid water", never that a planet in the zone has water, an atmosphere or life. The picture draws no year, no named star and no real planet: its stars and orbits are illustrative. Colour alone does not give a star’s age, and not every main-sequence star is alike. The Sun looks white from space: never call it a yellow star. The picture’s colours are strengthened and the edges of its zones are illustrative, so give no figure for either.',
  ],
});
