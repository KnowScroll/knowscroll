import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';

/**
 * The star kit (D-194): a star in balance, stars of different mass, and the stages of a star's life.
 * The writer chooses the view, which balance to show, the star's mass, the stage of its life and the
 * part to look at. Code derives the rest (D-195): what gravity and pressure do to the star's size, how
 * long each mass lives against the Sun, its colour and size, and how its life ends (a white dwarf for a
 * low or Sun-like mass, a supernova and a dense remnant for a high one). A stored state has no field in
 * which the Sun could end as a supernova.
 *
 * The masses are classes, not data: "low" is about half the Sun's, "high" about ten times it. The picture
 * gives no years and no figures.
 */
export const STAR_KIT = 'star.v1';

export const STAR_ENUMS = {
  /**
   * What the picture is of. `balance` cuts a star open to show the core and the two forces; `mass`
   * puts three stars side by side with how long each shines; `life` shows one star through the stages
   * of its life.
   */
  view: ['balance', 'mass', 'life'],
  /** In `balance`: gravity and the outward pressure are equal, or one of them wins. */
  balance: ['steady', 'gravity-wins', 'pressure-wins'],
  /** The star's mass: a low-mass star, one like the Sun, or a high-mass star. Drawn in `mass` (which one is marked) and `life`. */
  mass: ['low', 'sun-like', 'high'],
  /** In `life`: a cloud of gas, a star that fuses hydrogen, a giant, and the end. */
  stage: ['cloud', 'main-sequence', 'giant', 'end'],
  /** The part the picture draws the eye to, if it is drawn. */
  focus: ['none', 'core', 'gravity', 'pressure', 'lifetime', 'remnant'],
} as const;

export type StarState = KitState<typeof STAR_ENUMS>;
export type StarPatch = KitPatch<typeof STAR_ENUMS>;
export type StarView = StarState['view'];
export type StarMass = StarState['mass'];
export type StarStage = StarState['stage'];

export const INITIAL_STAR_STATE: StarState = {
  view: 'balance',
  balance: 'steady',
  mass: 'sun-like',
  stage: 'main-sequence',
  focus: 'none',
};

export const StarStateSchema = kitStateSchema(STAR_ENUMS);

/** The parts of the kit a picture may be made of. A focus names one of them, `lifetime` the bars of `mass`. */
export type StarPart = 'core' | 'gravity' | 'pressure' | 'lifetime' | 'remnant';

/** What a state draws. `remnant` is drawn only at the end of a life. */
export function starParts(state: Pick<StarState, 'view' | 'stage'>): readonly StarPart[] {
  switch (state.view) {
    case 'balance':
      return ['core', 'gravity', 'pressure'];
    case 'mass':
      return ['lifetime'];
    case 'life':
      return state.stage === 'end' ? ['remnant'] : [];
  }
}

/** The values a picture shows when a key does not matter to the view, so unseen differences are not counted as change. */
const NEUTRAL = { balance: 'steady', mass: 'sun-like', stage: 'main-sequence' } as const;

/** The state a view can really show: a key the view does not use is set aside, and so is a focus on a part that is not drawn. Idempotent. */
export function settleStarState(state: StarState): StarState {
  const parts = starParts(state);
  const focus = state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none';
  return {
    view: state.view,
    balance: state.view === 'balance' ? state.balance : NEUTRAL.balance,
    mass: state.view === 'balance' ? NEUTRAL.mass : state.mass,
    stage: state.view === 'life' ? state.stage : NEUTRAL.stage,
    focus,
  };
}

/** The star's mass in Suns for each class. Classes, not data: the picture gives no figure. */
export const MASS_IN_SUNS: Readonly<Record<StarMass, number>> = { low: 0.5, 'sun-like': 1, high: 10 };

/** A main-sequence star's lifetime in Suns' lifetimes: its fuel goes as the mass and its output as the mass to the power 3.5, so it goes as the mass to the power -2.5. */
export function lifetimeInSunLifetimes(mass: StarMass): number {
  return MASS_IN_SUNS[mass] ** -2.5;
}

/** A main-sequence star's radius in Sun radii: about the mass to the power 0.8. */
export function mainSequenceRadiusInSuns(mass: StarMass): number {
  return MASS_IN_SUNS[mass] ** 0.8;
}

/** How hot the surface is and so what colour the star shines: cooler and red, in between and yellow, hotter and blue-white. */
export type SurfaceTemperature = 'cool' | 'middle' | 'hot';
const SURFACE: Readonly<Record<StarMass, SurfaceTemperature>> = { low: 'cool', 'sun-like': 'middle', high: 'hot' };

/**
 * The colour class of a star's surface at a stage of its life: on the main sequence it follows the mass, a giant
 * or supergiant has swollen and cooled, so it is red, and the white dwarf left by a low-mass star is hot and white.
 * A cloud has no surface yet and is drawn cool.
 */
export function surfaceAt(mass: StarMass, stage: StarStage): SurfaceTemperature {
  if (stage === 'giant' || stage === 'cloud') return 'cool';
  if (stage === 'end') return 'hot';
  return SURFACE[mass];
}

/** How a star's life ends: it sheds its outer layers and leaves a white dwarf, or it explodes and leaves a very dense remnant. */
export type StarEnd = 'white-dwarf' | 'supernova';

/** What gravity and pressure leave the star doing: it holds its size, shrinks or swells. */
export type StarMotion = 'holds' | 'shrinks' | 'swells';

/** The strengths of the two forces in each balance, in units of gravity's. */
const PRESSURE_FOR: Readonly<Record<StarState['balance'], number>> = {
  steady: 1,
  'gravity-wins': 0.6,
  'pressure-wins': 1.4,
};

export interface StarPhysics {
  /** Gravity pulls inward with this strength (always 1) and the pressure from the core's energy pushes outward with `pressure`. */
  readonly gravity: number;
  readonly pressure: number;
  readonly motion: StarMotion;
  readonly surface: SurfaceTemperature;
  readonly lifetime: number;
  readonly radius: number;
  /** How the life of this mass ends. */
  readonly end: StarEnd;
}

/** What follows from a state by physics. Derived, never stored and never written by the model. */
export function starPhysics(state: Pick<StarState, 'balance' | 'mass'>): StarPhysics {
  const pressure = PRESSURE_FOR[state.balance];
  const net = pressure - 1;
  return {
    gravity: 1,
    pressure,
    motion: net === 0 ? 'holds' : net < 0 ? 'shrinks' : 'swells',
    surface: SURFACE[state.mass],
    lifetime: lifetimeInSunLifetimes(state.mass),
    radius: mainSequenceRadiusInSuns(state.mass),
    end: state.mass === 'high' ? 'supernova' : 'white-dwarf',
  };
}

const MASS_NAME: Readonly<Record<StarMass, string>> = {
  low: 'a low-mass star',
  'sun-like': 'a star like the Sun',
  high: 'a high-mass star',
};

const COLOUR_NAME: Readonly<Record<SurfaceTemperature, string>> = {
  cool: 'a cool, red-orange surface',
  middle: 'a yellow surface',
  hot: 'a hot, blue-white surface',
};

const BALANCE_SENTENCE: Readonly<Record<StarMotion, string>> = {
  holds:
    'Gravity pulls inward and the pressure from the core’s energy pushes outward with equal strength, so the star holds its size.',
  shrinks: 'Gravity pulls inward harder than the pressure pushes outward, so the star would shrink.',
  swells: 'The pressure pushes outward harder than gravity pulls inward, so the star would swell.',
};

function balanceSentences(state: StarState): string[] {
  return [
    'A star cut open to show its centre. In the hot, dense core, hydrogen fuses into helium and releases the energy that keeps the star shining.',
    BALANCE_SENTENCE[starPhysics(state).motion],
  ];
}

function massSentences(state: StarState): string[] {
  return [
    'Three stars side by side: a low-mass star, a star like the Sun and a high-mass star. A high-mass star is bigger, hotter and bluer, and a low-mass star is smaller, cooler and redder.',
    'Bars show how long each one shines, drawn on a stretched scale so that all three fit: the more massive the star, the faster it uses its fuel and the shorter its life.',
    `${MASS_NAME[state.mass].replace(/^a/u, 'A')} is marked.`,
  ];
}

const STAGE_SENTENCE: Readonly<Record<StarStage, (mass: StarMass) => string>> = {
  cloud: () =>
    'A cloud of gas and dust starts to collapse under its own gravity, and its centre grows denser and hotter.',
  'main-sequence': (mass) =>
    `The star has ${COLOUR_NAME[SURFACE[mass]]} and fuses hydrogen into helium in its core, where its energy balances gravity.`,
  giant: (mass) =>
    mass === 'high'
      ? 'Its core fuel running short, the star swells into a huge red supergiant.'
      : 'Its core hydrogen used up, the star swells into a red giant.',
  end: (mass) =>
    mass === 'high'
      ? 'The star’s core collapses and the star explodes as a supernova, leaving a small, very dense remnant.'
      : 'The star sheds its outer layers into space and leaves a small, hot white dwarf.',
};

function lifeSentences(state: StarState): string[] {
  return [
    `The life of ${MASS_NAME[state.mass]}, shown at one stage. No years are drawn.`,
    STAGE_SENTENCE[state.stage](state.mass),
  ];
}

const FOCUS_SENTENCE: Readonly<Record<StarState['focus'], string>> = {
  none: '',
  core: 'The picture draws the eye to the core.',
  gravity: 'The picture draws the eye to gravity.',
  pressure: 'The picture draws the eye to the pressure.',
  lifetime: 'The picture draws the eye to the bars.',
  remnant: 'The picture draws the eye to what is left.',
};

/**
 * What a star state shows, as sentences: the text version of a stage and its accessible name. It is
 * derived by code from the state and its physics, never written by the model, and it settles the
 * state first, so it mentions only what the view draws and cannot disagree with the picture.
 */
export function describeStarState(chosen: StarState): string {
  const state = settleStarState(chosen);
  const sentences =
    state.view === 'balance'
      ? balanceSentences(state)
      : state.view === 'mass'
        ? massSentences(state)
        : lifeSentences(state);
  return [...sentences, FOCUS_SENTENCE[state.focus]].filter((sentence) => sentence !== '').join(' ');
}

export const STAR_KIT_DEFINITION = defineKit({
  id: STAR_KIT,
  enums: STAR_ENUMS,
  initial: INITIAL_STAR_STATE,
  settle: settleStarState,
  describe: describeStarState,
  writerGuide: [
    'Code draws the picture from a fixed kit: a star cut open with its core, arrows for gravity and for pressure, three stars of different mass with bars for how long each shines, and one star through the stages of its life. You choose only the view, the balance, the mass, the stage and the part to look at, from the listed words. Code decides everything else: what gravity and pressure do to the star’s size, its colour and size, how long it lives and how its life ends. So the mass and stage you choose are claims the picture makes: choose the ones that match what the stop says.',
    '- The views: "balance" shows a star in cross-section with its core, gravity pulling in and pressure pushing out, and "balance" says whether they are "steady", whether "gravity-wins" or whether "pressure-wins"; "mass" shows a low-mass star, a star like the Sun and a high-mass star side by side with bars for how long each shines, and marks the one you choose with "mass" ("low", "sun-like" or "high"); "life" shows the star of that mass at one "stage": "cloud", "main-sequence", "giant" or "end". A low or Sun-like star ends as a white dwarf and a high-mass star in a supernova; code draws the end that fits the mass. A key a view does not use is ignored.',
    '- The picture draws no years, no figures and no named star. Say nothing that depends on one, and never say the Sun will explode or become a black hole.',
  ],
});
