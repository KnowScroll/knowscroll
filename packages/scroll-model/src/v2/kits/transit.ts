import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';

/**
 * The transit kit (D-194): a star, a planet crossing in front of it, and the dip in the star's light.
 * The writer chooses the view, which planet, where it is along its crossing and the part to look at.
 * Code derives the rest (D-195): how much of the star the planet covers, so how deep the dip is
 * (the square of the planet's width against the star's), the whole light curve, and whether the planet
 * blocks light at all from where it is. A stored state has no field in which a small planet could
 * make a deep dip.
 *
 * The planets are two illustrative sizes, "small" and "large", and the picture is simple: the star is
 * an evenly bright disc and the planet crosses its middle. Real stars are dimmer toward the edge, and
 * the dips are enlarged so that they show.
 */
export const TRANSIT_KIT = 'transit.v1';

export const TRANSIT_ENUMS = {
  /**
   * What the picture is of. `orbit` is the planet going round its star seen from above, with us
   * watching from below; `crossing` is the star's disc with the planet in front and the graph of its
   * brightness; `compare` is the graphs of a small planet and a large one together.
   */
  view: ['orbit', 'crossing', 'compare'],
  /** Which planet, in `orbit` and `crossing`. */
  planet: ['small', 'large'],
  /** Where the planet is along its crossing: before it, as it starts to cross, halfway, as it leaves, after it. */
  at: ['before', 'ingress', 'middle', 'egress', 'after'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: ['none', 'star', 'planet', 'dip'],
} as const;

export type TransitState = KitState<typeof TRANSIT_ENUMS>;
export type TransitPatch = KitPatch<typeof TRANSIT_ENUMS>;
export type TransitView = TransitState['view'];
export type PlanetSize = TransitState['planet'];
export type CrossingPlace = TransitState['at'];

export const INITIAL_TRANSIT_STATE: TransitState = { view: 'orbit', planet: 'small', at: 'before', focus: 'none' };

export const TransitStateSchema = kitStateSchema(TRANSIT_ENUMS);

/** The parts of the kit a picture may be made of. */
export type TransitPart = 'star' | 'planet' | 'orbit' | 'curve' | 'dip';

const VIEW_PARTS: Readonly<Record<TransitView, readonly TransitPart[]>> = {
  orbit: ['star', 'planet', 'orbit'],
  crossing: ['star', 'planet', 'curve', 'dip'],
  compare: ['star', 'planet', 'curve', 'dip'],
};

/** The parts a view draws. Anything else is never drawn, never described and never a focus. */
export function transitParts(view: TransitView): readonly TransitPart[] {
  return VIEW_PARTS[view];
}

const NEUTRAL = { planet: 'small', at: 'before' } as const;

/**
 * The state a view can really show. `compare` draws both planets together, so it takes no single
 * planet and no place along the crossing; a focus on a part that is not drawn is set aside. Idempotent.
 */
export function settleTransitState(state: TransitState): TransitState {
  const parts = transitParts(state.view);
  const compare = state.view === 'compare';
  const focus = state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none';
  return {
    view: state.view,
    planet: compare ? NEUTRAL.planet : state.planet,
    at: compare ? NEUTRAL.at : state.at,
    focus,
  };
}

/** A planet's width as a share of the star's: illustrative sizes, a small one and one twice as wide. */
export const PLANET_WIDTH_SHARE: Readonly<Record<PlanetSize, number>> = { small: 0.1, large: 0.2 };

/** How far the planet's centre is from the star's, along its path, in star radii, at each place along the crossing. */
export const CROSSING_SEPARATION: Readonly<Record<CrossingPlace, number>> = {
  before: -2,
  ingress: -1,
  middle: 0,
  egress: 1,
  after: 2,
};

/** How far from its star the planet orbits, in star radii: the picture's own, so that the planet can be seen to go round. */
export const ORBIT_RADIUS_IN_STAR_RADII = 8;

/**
 * The share of the star's disc a planet of the given width (a share of the star's) covers when its
 * centre is `separation` star radii from the star's centre: the overlap of two discs, over the star's
 * area. Nothing when apart, all of the planet's own area when it lies wholly inside the star.
 */
export function coveredShare(widthShare: number, separation: number): number {
  const planet = widthShare;
  const apart = Math.abs(separation);
  if (apart >= 1 + planet) return 0;
  if (apart <= 1 - planet) return planet * planet;
  const lens =
    planet * planet * Math.acos((apart * apart + planet * planet - 1) / (2 * apart * planet)) +
    Math.acos((apart * apart + 1 - planet * planet) / (2 * apart)) -
    0.5 * Math.sqrt((-apart + planet + 1) * (apart + planet - 1) * (apart - planet + 1) * (apart + planet + 1));
  return lens / Math.PI;
}

/** The star's brightness, in units of its brightness with no planet in front, with the planet `separation` star radii from its centre. */
export function brightnessAt(widthShare: number, separation: number): number {
  return 1 - coveredShare(widthShare, separation);
}

/** The deepest dip a planet makes, with it wholly in front: the square of its width against the star's. */
export function transitDepth(widthShare: number): number {
  return widthShare * widthShare;
}

/** Where the planet is round its orbit, degrees from the line to us (0 is between us and the star), from where it is along its crossing. */
export function orbitDegreesAt(place: CrossingPlace): number {
  return (Math.asin(CROSSING_SEPARATION[place] / ORBIT_RADIUS_IN_STAR_RADII) * 180) / Math.PI;
}

export interface TransitPhysics {
  readonly widthShare: number;
  readonly separation: number;
  /** The share of the star covered now, and so the brightness now. */
  readonly covered: number;
  readonly brightness: number;
  /** The deepest dip this planet makes. */
  readonly depth: number;
  /** Whether the planet is in front of the star as we see it, even in part. */
  readonly blocking: boolean;
  readonly orbitDegrees: number;
}

/** What follows from a state by physics. Derived, never stored and never written by the model. */
export function transitPhysics(state: Pick<TransitState, 'planet' | 'at'>): TransitPhysics {
  const widthShare = PLANET_WIDTH_SHARE[state.planet];
  const separation = CROSSING_SEPARATION[state.at];
  const covered = coveredShare(widthShare, separation);
  return {
    widthShare,
    separation,
    covered,
    brightness: 1 - covered,
    depth: transitDepth(widthShare),
    blocking: covered > 0,
    orbitDegrees: orbitDegreesAt(state.at),
  };
}

const SIZE_WORDS: Readonly<Record<PlanetSize, string>> = { small: 'a small planet', large: 'a large planet' };

const PLACE_WORDS: Readonly<Record<CrossingPlace, string>> = {
  before: 'The planet has not yet reached the star as we see it, so it blocks none of its light.',
  ingress: 'The planet is just starting to cross the star’s edge, so it blocks a little of its light.',
  middle: 'The planet is halfway across the star, in front of it, so it blocks as much light as it ever does.',
  egress: 'The planet is just leaving the star’s far edge, so it blocks a little of its light.',
  after: 'The planet has passed the star as we see it, so it blocks none of its light.',
};

function orbitSentences(state: TransitState): string[] {
  return [
    `Seen from above, ${SIZE_WORDS[state.planet]} goes round its star. We watch from far below, so the planet crosses in front of the star as we see it only when it passes between us and the star. Sizes and distances are not to scale.`,
    PLACE_WORDS[state.at],
  ];
}

function crossingSentences(state: TransitState, physics: TransitPhysics): string[] {
  const place = state.at === 'middle' ? 'At the middle of its crossing the dip is as deep as it gets.' : '';
  return [
    `A star seen as a bright disc, and ${SIZE_WORDS[state.planet]} that crosses it. Below is a graph of the star’s brightness over time: level, then a dip while the planet crosses, then level again, with a marker for where the planet is now. The dip is enlarged so that it can be seen.`,
    PLACE_WORDS[state.at],
    physics.blocking ? place : 'The marker sits on the level part of the graph.',
  ];
}

const timesWords = (ratio: number): string => ({ 2: 'twice', 4: 'four times' })[ratio] ?? `${ratio} times`;

function compareSentences(): string[] {
  const widthRatio = PLANET_WIDTH_SHARE.large / PLANET_WIDTH_SHARE.small;
  const depthRatio = transitDepth(PLANET_WIDTH_SHARE.large) / transitDepth(PLANET_WIDTH_SHARE.small);
  return [
    'Two graphs of a star’s brightness are drawn together: a shallow dip for a small planet and a deeper dip for a large one, each crossing the same star.',
    `The large planet is ${timesWords(widthRatio)} as wide and its dip is ${timesWords(depthRatio)} as deep, because the dip follows the area of the star the planet covers. The dips are enlarged so that they can be seen, and the sizes are illustrative.`,
  ];
}

const FOCUS_SENTENCE: Readonly<Record<TransitState['focus'], string>> = {
  none: '',
  star: 'The picture draws the eye to the star.',
  planet: 'The picture draws the eye to the planet.',
  dip: 'The picture draws the eye to the dip.',
};

/**
 * What a transit state shows, as sentences: the text version of a stage and its accessible name. It
 * is derived by code from the state and its physics, never written by the model, and it settles the
 * state first, so it mentions only what the view draws and cannot disagree with the picture.
 */
export function describeTransitState(chosen: TransitState): string {
  const state = settleTransitState(chosen);
  const physics = transitPhysics(state);
  const sentences =
    state.view === 'orbit'
      ? orbitSentences(state)
      : state.view === 'crossing'
        ? crossingSentences(state, physics)
        : compareSentences();
  return [...sentences, FOCUS_SENTENCE[state.focus]].filter((sentence) => sentence !== '').join(' ');
}

export const TRANSIT_KIT_DEFINITION = defineKit({
  id: TRANSIT_KIT,
  enums: TRANSIT_ENUMS,
  initial: INITIAL_TRANSIT_STATE,
  settle: settleTransitState,
  describe: describeTransitState,
  writerGuide: [
    'Code draws the picture from a fixed kit: a star, a planet, its orbit seen from above and the graph of the star’s brightness as the planet crosses in front. You choose only the view, which planet, where it is along its crossing and the part to look at, from the listed words. Code decides everything else: how much of the star the planet covers, how deep the dip is and the whole graph. So the planet and place you choose are claims the picture makes: choose the ones that match what the stop says.',
    '- The views: "orbit" shows the planet going round its star seen from above, and when it passes between us and the star; "crossing" shows the star’s disc with the planet in front and the graph of its brightness, with a marker; "compare" shows the graphs of a small planet and a large one together. "planet" is "small" or "large" and "at" is "before", "ingress" (just starting to cross), "middle", "egress" (just leaving) or "after"; "compare" shows both planets and ignores them.',
    '- The picture is the transit method only: it shows no wobble of the star, no light from the planet and no picture of a real planet. The sizes are illustrative and the dips are enlarged, so say nothing about the size of a real planet or a real dip from it.',
  ],
});
