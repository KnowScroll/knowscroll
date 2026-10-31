import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';

/**
 * The black-hole kit (D-204): how a massive star's end can leave a black hole, what the event horizon
 * is, why a black hole pulls from far away no more than a star of its mass, and four ways astronomers
 * know black holes exist. The writer chooses the view, a star and its stage, a black hole, how far a
 * merger has gone and the part to look at. Code derives the rest (D-205): the horizon's radius from the mass
 * (2GM over c squared, so it goes as the mass), the speed needed to escape at any distance, the orbits that a
 * hidden mass makes (Kepler), the heat of a disc at each radius, the size of the shadow, and the chirp of two
 * black holes spiralling together. A stored state has no field in which a Sun-like star could leave a black
 * hole or a bigger black hole could have a smaller horizon.
 *
 * Masses are classes and the picture is a diagram: it draws nothing at the centre of a black hole, because
 * that is not understood, and it draws the shadow as the shadow, not as the horizon.
 */
export const BLACK_HOLE_KIT = 'black-hole.v1';

export const BLACK_HOLE_ENUMS = {
  /**
   * What the picture is of. `formation` is the end of a star; `horizon` is two black holes to scale with the
   * horizon and the light near it; `pull` is a star and a black hole of the same mass; `orbits`, `disc`,
   * `waves` and `shadow` are four ways black holes are known.
   */
  view: ['formation', 'horizon', 'pull', 'orbits', 'disc', 'waves', 'shadow'],
  /** In `formation`: a star like the Sun, or one many times the Sun's mass. */
  star: ['sun-like', 'massive'],
  /** In `formation`: in the middle of its life, with its fuel run out, and at its end. */
  stage: ['fusing', 'fuel-out', 'end'],
  /** In `horizon`: the black hole marked, a smaller one or one four times as massive. */
  hole: ['small', 'large'],
  /** In `waves`: two black holes far apart, spiralling close together, or merged. */
  merger: ['apart', 'close', 'merged'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: [
    'none',
    'star',
    'core',
    'remnant',
    'horizon',
    'light-out',
    'light-in',
    'hole',
    'stars',
    'centre',
    'disc',
    'holes',
    'signal',
    'ring',
    'shadow',
  ],
} as const;

export type BlackHoleState = KitState<typeof BLACK_HOLE_ENUMS>;
export type BlackHolePatch = KitPatch<typeof BLACK_HOLE_ENUMS>;
export type BlackHoleView = BlackHoleState['view'];
export type ProgenitorStar = BlackHoleState['star'];
export type LifeStage = BlackHoleState['stage'];
export type HoleSize = BlackHoleState['hole'];
export type MergerStage = BlackHoleState['merger'];

export const INITIAL_BLACK_HOLE_STATE: BlackHoleState = {
  view: 'formation',
  star: 'massive',
  stage: 'fusing',
  hole: 'small',
  merger: 'apart',
  focus: 'none',
};

export const BlackHoleStateSchema = kitStateSchema(BLACK_HOLE_ENUMS);

/** The parts of the kit a picture may be made of. A focus names one of them. */
export type BlackHolePart =
  | 'star'
  | 'core'
  | 'remnant'
  | 'horizon'
  | 'light-out'
  | 'light-in'
  | 'hole'
  | 'stars'
  | 'centre'
  | 'disc'
  | 'holes'
  | 'signal'
  | 'ring'
  | 'shadow';

/** What a state draws. A remnant is drawn only at the end of a star's life. */
export function blackHoleParts(state: Pick<BlackHoleState, 'view' | 'stage'>): readonly BlackHolePart[] {
  switch (state.view) {
    case 'formation':
      return state.stage === 'end' ? ['star', 'core', 'remnant'] : ['star', 'core'];
    case 'horizon':
      return ['horizon', 'light-out', 'light-in'];
    case 'pull':
      return ['star', 'hole'];
    case 'orbits':
      return ['stars', 'centre'];
    case 'disc':
      return ['disc', 'hole'];
    case 'waves':
      return ['holes', 'signal'];
    case 'shadow':
      return ['ring', 'shadow', 'horizon'];
  }
}

const NEUTRAL = {
  star: INITIAL_BLACK_HOLE_STATE.star,
  stage: 'fusing',
  hole: 'small',
  merger: 'apart',
} as const;

/** The state a view can really show: a key the view does not use is set aside, and so is a focus on a part that is not drawn. Idempotent. */
export function settleBlackHoleState(state: BlackHoleState): BlackHoleState {
  const parts = blackHoleParts(state);
  const formation = state.view === 'formation';
  return {
    view: state.view,
    star: formation ? state.star : NEUTRAL.star,
    stage: formation ? state.stage : NEUTRAL.stage,
    hole: state.view === 'horizon' ? state.hole : NEUTRAL.hole,
    merger: state.view === 'waves' ? state.merger : NEUTRAL.merger,
    focus: state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none',
  };
}

const GRAVITATIONAL_CONSTANT = 6.6743e-11;
const LIGHT_SPEED = 299_792_458;
const SUN_MASS_KILOGRAMS = 1.98847e30;

/** The radius of the event horizon of a non-spinning black hole, in kilometres: two G M over c squared, so it goes as the mass. */
export function horizonRadiusKilometres(massInSuns: number): number {
  return (2 * GRAVITATIONAL_CONSTANT * massInSuns * SUN_MASS_KILOGRAMS) / LIGHT_SPEED ** 2 / 1000;
}

/** The masses, in Suns, of the two black holes of `horizon`: illustrative stellar-mass holes, one four times the other. */
export const HOLE_MASS_IN_SUNS: Readonly<Record<HoleSize, number>> = { small: 10, large: 40 };

/** The speed needed to escape from a distance, as a share of the speed of light, with the distance in horizon radii: it is one at the horizon and falls as the distance grows. */
export function escapeSpeedShare(distanceInHorizonRadii: number): number {
  return Math.sqrt(1 / distanceInHorizonRadii);
}

/** The pull of a mass on an object at a distance (Newton's law, per unit of the object's mass), in what the Sun's mass gives at a metre. Far from either, a star and a black hole of the same mass give the same. */
export function pullAt(massInSuns: number, distanceMetres: number): number {
  return (GRAVITATIONAL_CONSTANT * massInSuns * SUN_MASS_KILOGRAMS) / distanceMetres ** 2;
}

/** The masses, in Suns, of the two stars of `formation`. */
export const PROGENITOR_MASS_IN_SUNS: Readonly<Record<ProgenitorStar, number>> = { 'sun-like': 1, massive: 25 };

/** A star must have more than about this many Suns' mass for its core to collapse when its fuel runs out. */
export const CORE_COLLAPSE_MASS_IN_SUNS = 8;

export type StarEnding = 'white-dwarf' | 'supernova';

export interface FormationPhysics {
  readonly massInSuns: number;
  /** Whether the star's core collapses when its fuel runs out, which only a massive star's does. */
  readonly coreCollapses: boolean;
  /** A star like the Sun sheds its layers and leaves a white dwarf; a massive star explodes, and what is left of the core can be a black hole. */
  readonly ending: StarEnding;
  readonly canLeaveBlackHole: boolean;
}

/** What follows from a star's mass by physics. */
export function formationPhysics(star: ProgenitorStar): FormationPhysics {
  const massInSuns = PROGENITOR_MASS_IN_SUNS[star];
  const coreCollapses = massInSuns > CORE_COLLAPSE_MASS_IN_SUNS;
  return {
    massInSuns,
    coreCollapses,
    ending: coreCollapses ? 'supernova' : 'white-dwarf',
    canLeaveBlackHole: coreCollapses,
  };
}

/** The three stars of `orbits`: radius against the nearest, in the same units whatever the hidden mass is. */
export const ORBIT_RADII = [1, 2, 4] as const;

/** The period of a circular orbit round a mass, in units where radius one takes period one (Kepler's third law: period squared goes as radius cubed). */
export function orbitPeriod(radius: number): number {
  return radius ** 1.5;
}

/** The speed of a circular orbit (the circumference over the period, with a turn of one), in units where radius one is travelled at speed one: it falls as the square root of the radius. */
export function orbitSpeed(radius: number): number {
  return radius / orbitPeriod(radius);
}

/** The mass inside an orbit, in units of the mass that gives radius one period one: radius cubed over period squared, the same for every orbit round one mass. */
export function massInsideOrbit(radius: number, period: number): number {
  return radius ** 3 / period ** 2;
}

/** The radii of the rings of `disc`, in inner edges of the disc, and the inner edge in horizon radii (the innermost stable orbit of a non-spinning hole). */
export const DISC_RINGS = [1, 2, 4, 8] as const;
export const DISC_INNER_EDGE_IN_HORIZON_RADII = 3;
/** The temperature of the innermost ring of a stellar-mass black hole's disc, in kelvins: millions, so it glows in X-rays. Illustrative. */
export const DISC_INNER_KELVINS = 1e7;

/** The temperature of the disc at a radius in inner edges: it falls as the radius to the power minus three quarters (a thin disc, away from its inner edge). */
export function discKelvins(radiusInInnerEdges: number): number {
  return DISC_INNER_KELVINS * radiusInInnerEdges ** -0.75;
}

/** The radius of the shadow, in horizon radii: the impact parameter of light that just circles a non-spinning black hole, three root three over two. */
export const SHADOW_RADIUS_IN_HORIZON_RADII = (3 * Math.sqrt(3)) / 2;

/** Time to merger of the three places of `waves`, in units of the time at `apart`. Illustrative. */
export const TIME_TO_MERGER: Readonly<Record<MergerStage, number>> = { apart: 1, close: 0.01, merged: 0 };

/** How far apart the two holes are against the start: it falls as the time to merger to the power one quarter. */
export function separationAt(timeToMerger: number): number {
  return timeToMerger ** 0.25;
}

/** The frequency of the waves against the start: twice the orbit's, so it rises as the time to merger to the power minus three eighths. */
export function waveFrequencyAt(timeToMerger: number): number {
  return timeToMerger ** (-3 / 8);
}

/** The strength of the waves against the start: it rises as the frequency to the power two thirds. */
export function waveStrengthAt(timeToMerger: number): number {
  return waveFrequencyAt(timeToMerger) ** (2 / 3);
}

export interface BlackHolePhysics {
  readonly formation: FormationPhysics;
  /** In `horizon`: the marked hole's mass and horizon radius, and the other's, in Suns and kilometres. */
  readonly holeMassInSuns: number;
  readonly horizonKilometres: number;
  readonly horizonRatio: number;
  readonly mergerTime: number;
}

/** What follows from a state by physics. Derived, never stored and never written by the model. */
export function blackHolePhysics(state: Pick<BlackHoleState, 'star' | 'hole' | 'merger'>): BlackHolePhysics {
  const holeMassInSuns = HOLE_MASS_IN_SUNS[state.hole];
  return {
    formation: formationPhysics(state.star),
    holeMassInSuns,
    horizonKilometres: horizonRadiusKilometres(holeMassInSuns),
    horizonRatio: HOLE_MASS_IN_SUNS.large / HOLE_MASS_IN_SUNS.small,
    mergerTime: TIME_TO_MERGER[state.merger],
  };
}

const formationSentence = (state: BlackHoleState, physics: FormationPhysics): string[] => {
  const massive = state.star === 'massive';
  const intro = massive
    ? 'The end of a star many times the Sun’s mass. Only a star above about eight times the Sun’s mass ends this way.'
    : 'The end of a star like the Sun, shown to compare. A star like the Sun is too light to collapse into a black hole and will not become one.';
  const step: Readonly<Record<LifeStage, string>> = {
    fusing: 'In the middle of its life hydrogen fuses in its core, and the pressure from that energy balances gravity.',
    'fuel-out': massive
      ? 'Its core fuel used up, the pressure that held the core up falls away and gravity wins: the core collapses inward.'
      : 'Its core hydrogen used up, the star swells into a red giant.',
    end: physics.canLeaveBlackHole
      ? 'The collapse throws off the star’s outer layers in a supernova explosion, and what is left of the core can be a black hole.'
      : 'It sheds its outer layers into space and leaves a small, hot white dwarf.',
  };
  return [intro, step[state.stage]];
};

const HORIZON_SENTENCE =
  'Two black holes drawn to the same scale, one four times as massive as the other. The edge of a black hole is its event horizon, about three kilometres from the centre for each Sun’s mass of the hole, so four times the mass means a horizon four times as wide. Light aimed straight outward from outside the horizon can get away; inside it even light aimed outward falls farther in. The horizon is a boundary in space, not a surface.';

const horizonSentences = (state: BlackHoleState): string[] => [
  HORIZON_SENTENCE,
  `The ${state.hole === 'small' ? 'smaller' : 'larger'} hole is marked.`,
];

const PULL_SENTENCES = [
  'A star and a black hole of the same mass, with the same pull on a faraway object. Far from either, gravity depends only on the mass and the distance, so a black hole does not pull harder than a star of its mass, and it does not suck in everything around it. Near the horizon it is very different. Not to scale: the black hole is far smaller than the star.',
];

const ORBITS_SENTENCES = [
  'Three stars circling a point where nothing shines, on orbits drawn as circles for simplicity. The nearer a star is to the centre, the faster it moves, and all three orbits follow from one large mass hidden there.',
];

const DISC_SENTENCES = [
  'Gas spiralling towards a black hole forms a disc that heats as it falls: the nearer the hole, the hotter the gas, and the hottest inner gas glows in X-rays. The glow is drawn in false colour, since X-rays cannot be seen, and the black hole itself gives out no light.',
];

const MERGER_SENTENCES: Readonly<Record<MergerStage, string>> = {
  apart:
    'Two black holes circle each other, far apart. They make ripples in space itself, gravitational waves, drawn on a graph of wave strength over time, not to scale. Far apart the ripples are weak and slow.',
  close:
    'Two black holes spiral close together, orbiting faster and faster. The ripples in space they make grow stronger and quicker, a rising chirp on the graph of wave strength over time, not to scale.',
  merged:
    'Two black holes have merged into one. The ripples in space they made reached their strongest at the merger, then die away, as the graph of wave strength over time, not to scale, shows.',
};

const SHADOW_SENTENCES = [
  'A bright ring of glowing gas round a dark patch, as in images made with a network of radio telescopes. The dark patch is the black hole’s shadow: light from behind it that passes this close is bent into the hole. The shadow is about two and a half times as wide as the horizon, which lies inside it, so it is not the horizon itself.',
];

/** Said of every clue that astronomers read: the clues together make the case, none alone does. */
const ONE_CLUE = 'This is one clue to a black hole, but it does not prove one by itself.';
const CLUE_VIEWS: readonly BlackHoleView[] = ['orbits', 'disc', 'waves', 'shadow'];

const FOCUS_SENTENCE: Readonly<Record<BlackHoleState['focus'], string>> = {
  none: '',
  star: 'The picture draws the eye to the star.',
  core: 'The picture draws the eye to the core.',
  remnant: 'The picture draws the eye to what is left.',
  horizon: 'The picture draws the eye to the horizon.',
  'light-out': 'The picture draws the eye to the light aimed outward from outside the horizon.',
  'light-in': 'The picture draws the eye to the light inside the horizon.',
  hole: 'The picture draws the eye to the black hole.',
  stars: 'The picture draws the eye to the stars.',
  centre: 'The picture draws the eye to the centre of the orbits.',
  disc: 'The picture draws the eye to the disc.',
  holes: 'The picture draws the eye to the black holes.',
  signal: 'The picture draws the eye to the graph of wave strength.',
  ring: 'The picture draws the eye to the ring.',
  shadow: 'The picture draws the eye to the shadow.',
};

/**
 * What a black-hole state shows, as sentences: the text version of a stage and its accessible name. It is
 * derived by code from the state and its physics, never written by the model, and it settles the state
 * first, so it mentions only what the view draws and cannot disagree with the picture.
 */
export function describeBlackHoleState(chosen: BlackHoleState): string {
  const state = settleBlackHoleState(chosen);
  const physics = blackHolePhysics(state);
  const sentences = {
    formation: () => formationSentence(state, physics.formation),
    horizon: () => horizonSentences(state),
    pull: () => PULL_SENTENCES,
    orbits: () => ORBITS_SENTENCES,
    disc: () => DISC_SENTENCES,
    waves: () => [MERGER_SENTENCES[state.merger]],
    shadow: () => SHADOW_SENTENCES,
  }[state.view]();
  const clue = CLUE_VIEWS.includes(state.view) ? [ONE_CLUE] : [];
  return [...sentences, ...clue, FOCUS_SENTENCE[state.focus]].filter((sentence) => sentence !== '').join(' ');
}

export const BLACK_HOLE_KIT_DEFINITION = defineKit({
  id: BLACK_HOLE_KIT,
  enums: BLACK_HOLE_ENUMS,
  initial: INITIAL_BLACK_HOLE_STATE,
  settle: settleBlackHoleState,
  describe: describeBlackHoleState,
  writerGuide: [
    'Code draws the picture from a fixed kit: how a star ends (a star like the Sun beside a massive star, through the middle of its life, its fuel running out and its end), black holes drawn to scale with their event horizon and the light near it, a star and a black hole of the same mass pulling alike from far away, stars circling a hidden mass, a disc of glowing gas, two black holes merging with the ripples they make, and the shadow in a ring of gas. You choose only the view, the star, its stage, the hole, the merger and the part to look at, from the listed words. Code decides everything else: the size of the horizon from the mass, how the star ends, the orbits, the heat of the disc, the shadow and the ripples. So what you choose is a claim the picture makes: choose the words that match what the stop says.',
    '- The views: "formation" shows a star of mass "sun-like" or "massive" at a "stage": "fusing" (the middle of its life), "fuel-out" or "end"; a massive star’s core collapses and it can leave a black hole, a star like the Sun swells and leaves a white dwarf, and code draws the end that fits the mass; "horizon" shows two black holes to scale and marks the "hole" you choose, "small" or "large" (four times the mass, so four times the horizon), with light near the horizon; "pull" shows a star and a black hole of the same mass pulling alike from far away; "orbits", "disc", "waves" and "shadow" are four clues to a black hole, and "waves" shows two black holes at a "merger" of "apart", "close" or "merged". A key a view does not use is ignored.',
    '- The picture draws stellar-mass black holes made by a massive star’s collapse. The supermassive ones at the centres of galaxies and how they grew are told in words only. Never say a star like the Sun will become a black hole, never say a black hole sucks in everything, say the horizon is a boundary and not a surface, and say nothing about the centre beyond that it is not understood. The shadow is not the horizon. No one clue proves a black hole: say that the clues together do.',
  ],
});
