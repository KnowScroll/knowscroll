import { z } from '../zod.js';

/**
 * The drawing kit the stage engine will draw (planned, S-1). A writer arranges kit parts by closed
 * enum value: it never draws, never names a coordinate and never writes a number, so a stage state
 * can neither be malformed nor state a fact (D-120). One kit exists in this version, "Earth & sky":
 * the Sun, Earth with its tilted axis, its orbit, Ray the sunbeam, pins on the two hemispheres and
 * the Moon. Adding a kit means a new kit id, not a change to this one.
 *
 * The writer chooses only what a teacher would point at: the view, the month (where Earth is on
 * its orbit), the Moon's phase and the part to look at. Everything physical follows from those by
 * code (D-124): the tilt, which half leans toward the Sun, the pins and the angle of Ray. A stored
 * state has no field in which a contradiction could be written.
 */
export const EARTH_SKY_KIT = 'earth-sky.v1';

/** The tilt of Earth's axis in every picture of the kit: fixed, and the same all year. */
export const AXIAL_TILT_DEGREES = 23.4;

/** Every key of a stage state and the values the writer may give it. */
export const STAGE_ENUMS = {
  /**
   * What the picture is of. `orbit` draws the orbit to scale (nearly a circle); `orbit-stretched`
   * stretches it so that the nearest and farthest points show.
   */
  view: ['sun-earth', 'orbit', 'orbit-stretched', 'earth-close', 'moon-orbit'],
  /** Where Earth is on its orbit, by month. March and September are the equinoxes, June and December the solstices. */
  earthAt: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  /** The Moon's phase, drawn only in `moon-orbit`; `off` draws the Moon without marking a phase. */
  moonAt: ['off', 'new', 'first-quarter', 'full', 'last-quarter'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: ['none', 'sun', 'earth', 'moon', 'axis', 'ray', 'orbit', 'north-pin', 'south-pin'],
} as const;

export type StageKey = keyof typeof STAGE_ENUMS;
export const STAGE_KEYS = Object.keys(STAGE_ENUMS) as readonly StageKey[];

/** One complete stage state: every key has a value. What a stored document holds is always settled. */
export type StageState = { readonly [Key in StageKey]: (typeof STAGE_ENUMS)[Key][number] };
/** What a stop changes: the keys it names. The rest carry over from the previous state. */
export type StagePatch = { readonly [Key in StageKey]?: (typeof STAGE_ENUMS)[Key][number] };

/** The state before any stop changes it. */
export const INITIAL_STAGE_STATE: StageState = {
  view: 'sun-earth',
  earthAt: 'jun',
  moonAt: 'off',
  focus: 'none',
};

export const StageStateSchema = z.strictObject({
  view: z.enum(STAGE_ENUMS.view),
  earthAt: z.enum(STAGE_ENUMS.earthAt),
  moonAt: z.enum(STAGE_ENUMS.moonAt),
  focus: z.enum(STAGE_ENUMS.focus),
});

/** The state after a stop's changes: patched keys replace the previous values, the rest carry over. */
export function applyStagePatch(previous: StageState, patch: StagePatch | undefined): StageState {
  if (patch === undefined) return previous;
  const next: Record<StageKey, string> = { ...previous };
  for (const key of STAGE_KEYS) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  return next as StageState;
}

type StageView = StageState['view'];
type StageMonth = StageState['earthAt'];

/** The parts of the kit a picture may be made of. `season` stands for "the month matters here". */
export type StagePart = 'sun' | 'earth' | 'axis' | 'orbit' | 'ray' | 'pins' | 'moon' | 'season';

/** What each view draws. Anything else is never drawn, never described and never a focus. */
const VIEW_PARTS: Readonly<Record<StageView, readonly StagePart[]>> = {
  'sun-earth': ['sun', 'earth', 'axis', 'ray', 'pins', 'season'],
  orbit: ['sun', 'earth', 'axis', 'orbit', 'pins', 'season'],
  'orbit-stretched': ['sun', 'earth', 'axis', 'orbit', 'pins', 'season'],
  'earth-close': ['earth', 'axis', 'ray', 'pins', 'season'],
  'moon-orbit': ['sun', 'earth', 'moon'],
};

/** The parts a view draws. */
export function stageParts(view: StageView): readonly StagePart[] {
  return VIEW_PARTS[view];
}

const FOCUS_PART: Readonly<Record<StageState['focus'], StagePart | null>> = {
  none: null,
  sun: 'sun',
  earth: 'earth',
  moon: 'moon',
  axis: 'axis',
  ray: 'ray',
  orbit: 'orbit',
  'north-pin': 'pins',
  'south-pin': 'pins',
};

/** The month a picture shows when the month does not matter to it, so that unseen differences are not counted as change. */
const NEUTRAL_MONTH: StageMonth = 'mar';

/**
 * The state a view can really show. Values for parts the view does not draw are set aside: the
 * month where the view has no seasons, the Moon's phase where it has no Moon, a focus on a part
 * that is not there. Settling is idempotent, and code does it before a state is stored; a stored
 * state that is not settled is refused.
 */
export function settleStageState(state: StageState): StageState {
  const parts = stageParts(state.view);
  const focusPart = FOCUS_PART[state.focus];
  return {
    view: state.view,
    earthAt: parts.includes('season') ? state.earthAt : NEUTRAL_MONTH,
    moonAt: parts.includes('moon') ? state.moonAt : 'off',
    focus: focusPart === null || parts.includes(focusPart) ? state.focus : 'none',
  };
}

/** How high the Sun stands for a hemisphere at noon, which sets both Ray's angle and the pin there. */
export type SunHeight = 'high' | 'middle' | 'low';
/** What a pin is marked: warm under a high Sun, cool under a low one. */
export type PinMark = 'warm' | 'neutral' | 'cool';

export interface HemispherePhysics {
  readonly sunHeight: SunHeight;
  readonly pin: PinMark;
}

/** What follows from a state by physics. Derived, never stored and never written by the model. */
export interface StagePhysics {
  readonly tiltDegrees: typeof AXIAL_TILT_DEGREES;
  /** Which half of Earth leans toward the Sun in this month. */
  readonly leansToward: 'north' | 'south' | 'neither';
  readonly north: HemispherePhysics;
  readonly south: HemispherePhysics;
}

/**
 * How far the northern half leans toward the Sun in each month, in percent of the full tilt: the
 * sine of the year, nil at the equinoxes (March, September) and greatest at the solstices (June,
 * December). The southern half leans by the same amount the other way.
 */
export const NORTH_LEAN_PERCENT: Readonly<Record<StageMonth, number>> = {
  jan: -87,
  feb: -50,
  mar: 0,
  apr: 50,
  may: 87,
  jun: 100,
  jul: 87,
  aug: 50,
  sep: 0,
  oct: -50,
  nov: -87,
  dec: -100,
};

/** A half whose lean toward the Sun is at least this many percent of the full tilt has a high Sun (and a low one the other way). */
const LEAN_THRESHOLD_PERCENT = 50;

const PIN_FOR: Readonly<Record<SunHeight, PinMark>> = { high: 'warm', middle: 'neutral', low: 'cool' };
const OPPOSITE: Readonly<Record<SunHeight, SunHeight>> = { high: 'low', middle: 'middle', low: 'high' };

function sunHeightOfNorth(month: StageMonth): SunHeight {
  const lean = NORTH_LEAN_PERCENT[month];
  if (lean >= LEAN_THRESHOLD_PERCENT) return 'high';
  if (lean <= -LEAN_THRESHOLD_PERCENT) return 'low';
  return 'middle';
}

/**
 * The physics of a state, from its month alone: Earth's tilt is always 23.4 degrees, the half that
 * leans toward the Sun has a high Sun, a warm pin and a steep Ray, the other half the opposite, and
 * at the equinoxes neither leans. Pure and total.
 */
export function stagePhysics(state: Pick<StageState, 'earthAt'>): StagePhysics {
  const north = sunHeightOfNorth(state.earthAt);
  const south = OPPOSITE[north];
  return {
    tiltDegrees: AXIAL_TILT_DEGREES,
    leansToward: north === 'high' ? 'north' : north === 'low' ? 'south' : 'neither',
    north: { sunHeight: north, pin: PIN_FOR[north] },
    south: { sunHeight: south, pin: PIN_FOR[south] },
  };
}

const MONTH_NAMES: Readonly<Record<StageMonth, string>> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

const VIEW_SENTENCE: Readonly<Record<StageView, string>> = {
  'sun-earth': 'The Sun is on the left and Earth is on the right.',
  orbit: 'Earth circles the Sun, seen from above, on an orbit drawn to scale that looks almost like a circle.',
  'orbit-stretched':
    'Earth circles the Sun, seen from above, on an orbit stretched so that the nearest and farthest points show.',
  'earth-close': 'A close view of Earth.',
  'moon-orbit': 'The Moon circles Earth, lit by the distant Sun.',
};

const MOON_SENTENCE: Readonly<Record<StageState['moonAt'], string>> = {
  off: '',
  new: 'The Moon is new, between Earth and the Sun.',
  'first-quarter': 'The Moon is at first quarter, at right angles to the Sun.',
  full: 'The Moon is full, with Earth between it and the Sun.',
  'last-quarter': 'The Moon is at last quarter, at right angles to the Sun.',
};

const FOCUS_SENTENCE: Readonly<Record<StageState['focus'], string>> = {
  none: '',
  sun: 'The picture draws the eye to the Sun.',
  earth: 'The picture draws the eye to Earth.',
  moon: 'The picture draws the eye to the Moon.',
  axis: 'The picture draws the eye to the axis.',
  ray: 'The picture draws the eye to Ray.',
  orbit: 'The picture draws the eye to the orbit.',
  'north-pin': 'The picture draws the eye to the pin in the north.',
  'south-pin': 'The picture draws the eye to the pin in the south.',
};

const LEAN_SENTENCE: Readonly<Record<StagePhysics['leansToward'], string>> = {
  north: 'The northern half leans toward the Sun and the southern half leans away from it.',
  south: 'The southern half leans toward the Sun and the northern half leans away from it.',
  neither: 'Neither half leans toward the Sun or away from it.',
};

const PIN_WORDS: Readonly<Record<PinMark, string>> = {
  warm: 'marked warm',
  neutral: 'marked neither warm nor cool',
  cool: 'marked cool',
};

const pinSentence = (physics: StagePhysics): string =>
  `A pin in the north is ${PIN_WORDS[physics.north.pin]}, and a pin in the south is ${PIN_WORDS[physics.south.pin]}.`;

const RAY_WORDS: Readonly<Record<SunHeight, string>> = {
  high: 'arrives from high in the sky and lands on a small patch of ground',
  middle: 'arrives at a middling angle',
  low: 'arrives at a low angle and spreads over a wide patch of ground',
};

const raySentence = (physics: StagePhysics): string =>
  `In the north, Ray the sunbeam ${RAY_WORDS[physics.north.sunHeight]}. In the south, Ray ${RAY_WORDS[physics.south.sunHeight]}.`;

/**
 * What a stage state shows, as sentences: the text version of a stage and its accessible name.
 * It is derived by code from the state and the physics of its month, never written by the model,
 * and it settles the state first, so it mentions only what the view draws and cannot disagree with
 * the picture, state a fact the kit does not hold or describe a picture that is physically impossible.
 */
export function describeStageState(chosen: StageState): string {
  const state = settleStageState(chosen);
  const parts = stageParts(state.view);
  const physics = stagePhysics(state);
  const has = (part: StagePart): boolean => parts.includes(part);
  return [
    VIEW_SENTENCE[state.view],
    has('season') ? `The time of year is ${MONTH_NAMES[state.earthAt]}.` : '',
    has('axis') ? `Earth’s axis is tilted by ${AXIAL_TILT_DEGREES} degrees and points the same way all year.` : '',
    has('season') ? LEAN_SENTENCE[physics.leansToward] : '',
    has('pins') ? pinSentence(physics) : '',
    has('ray') ? raySentence(physics) : '',
    has('moon') ? MOON_SENTENCE[state.moonAt] : '',
    FOCUS_SENTENCE[state.focus],
  ]
    .filter((sentence) => sentence !== '')
    .join(' ');
}
