import { z } from '../zod.js';

/**
 * The drawing kit the stage engine will draw (planned, S-1). A writer arranges kit parts by closed
 * enum value: it never draws, never names a coordinate and never writes a number, so a stage state
 * can neither be malformed nor state a fact (D-120). One kit exists in this version, "Earth & sky":
 * the Sun, Earth with its tilted axis, its orbit, Ray the sunbeam, pins on the two hemispheres and
 * the Moon. Adding a kit means a new kit id, not a change to this one.
 */
export const EARTH_SKY_KIT = 'earth-sky.v1';

/** Every key of a stage state and the values it may take. */
export const STAGE_ENUMS = {
  /** What the picture is of. */
  view: ['sun-earth', 'orbit', 'earth-close', 'moon-orbit', 'night-sky'],
  /** Where Earth is on its orbit, by month. */
  earthAt: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  /** The lean of Earth's axis: as Earth's really is, straight up, or tipped right over on its side. */
  axis: ['earth', 'upright', 'sideways'],
  /** Ray the sunbeam: hidden, or striking the ground straight on, from high, or from low. */
  ray: ['off', 'overhead', 'high', 'low'],
  /** The orbit: hidden, drawn to scale (nearly a circle) or stretched so the nearest and farthest points show. */
  orbit: ['hidden', 'to-scale', 'exaggerated'],
  /** A pin in the northern half of Earth. */
  northPin: ['off', 'warm', 'cool'],
  /** A pin in the southern half of Earth. */
  southPin: ['off', 'warm', 'cool'],
  /** The Moon's phase as seen from Earth, or hidden. */
  moonAt: ['off', 'new', 'first-quarter', 'full', 'last-quarter'],
  /** The part the picture draws the eye to. */
  focus: ['none', 'sun', 'earth', 'moon', 'axis', 'ray', 'orbit', 'north-pin', 'south-pin'],
} as const;

export type StageKey = keyof typeof STAGE_ENUMS;
export const STAGE_KEYS = Object.keys(STAGE_ENUMS) as readonly StageKey[];

/** One complete stage state: every key has a value. */
export type StageState = { readonly [Key in StageKey]: (typeof STAGE_ENUMS)[Key][number] };
/** What a stop changes: the keys it names. The rest carry over from the previous state. */
export type StagePatch = { readonly [Key in StageKey]?: (typeof STAGE_ENUMS)[Key][number] };

/** The state before any stop changes it. */
export const INITIAL_STAGE_STATE: StageState = {
  view: 'sun-earth',
  earthAt: 'jun',
  axis: 'earth',
  ray: 'off',
  orbit: 'hidden',
  northPin: 'off',
  southPin: 'off',
  moonAt: 'off',
  focus: 'none',
};

export const StageStateSchema = z.strictObject({
  view: z.enum(STAGE_ENUMS.view),
  earthAt: z.enum(STAGE_ENUMS.earthAt),
  axis: z.enum(STAGE_ENUMS.axis),
  ray: z.enum(STAGE_ENUMS.ray),
  orbit: z.enum(STAGE_ENUMS.orbit),
  northPin: z.enum(STAGE_ENUMS.northPin),
  southPin: z.enum(STAGE_ENUMS.southPin),
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

/** True when a patch changes at least one value of the previous state. */
export function changesStage(previous: StageState, patch: StagePatch | undefined): boolean {
  return patch !== undefined && STAGE_KEYS.some((key) => patch[key] !== undefined && patch[key] !== previous[key]);
}

const MONTH_NAMES: Readonly<Record<StageState['earthAt'], string>> = {
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

const VIEW_SENTENCE: Readonly<Record<StageState['view'], string>> = {
  'sun-earth': 'The Sun is on the left and Earth is on the right.',
  orbit: 'Earth circles the Sun, seen from above.',
  'earth-close': 'A close view of Earth.',
  'moon-orbit': 'The Moon circles Earth.',
  'night-sky': 'A view of the night sky.',
};

const AXIS_SENTENCE: Readonly<Record<StageState['axis'], string>> = {
  earth: 'Earth’s axis leans, as it really does.',
  upright: 'Earth’s axis stands straight up.',
  sideways: 'Earth’s axis is tipped right over on its side.',
};

const RAY_SENTENCE: Readonly<Record<StageState['ray'], string>> = {
  off: '',
  overhead: 'Ray the sunbeam strikes the ground straight on.',
  high: 'Ray the sunbeam arrives from high in the sky and covers a small patch of ground.',
  low: 'Ray the sunbeam arrives at a low angle and spreads over a wide patch of ground.',
};

const ORBIT_SENTENCE: Readonly<Record<StageState['orbit'], string>> = {
  hidden: '',
  'to-scale': 'The orbit is drawn to scale, and looks almost like a circle.',
  exaggerated: 'The orbit is stretched so that the nearest and farthest points show.',
};

const MOON_SENTENCE: Readonly<Record<StageState['moonAt'], string>> = {
  off: '',
  new: 'The Moon is new, between Earth and the Sun.',
  'first-quarter': 'The Moon is at first quarter, at right angles to the Sun.',
  full: 'The Moon is full, on the far side of Earth from the Sun.',
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

const pinSentence = (side: 'north' | 'south', mark: StageState['northPin']): string =>
  mark === 'off' ? '' : `A pin in the ${side} is marked ${mark}.`;

/**
 * What a stage state shows, as sentences: the text version of a stage and its accessible name.
 * It is derived from the state alone and written by code, never by the model: the kit knows what
 * it draws, so the description cannot disagree with the picture or state a fact.
 */
export function describeStageState(state: StageState): string {
  const orbitShown = state.view === 'orbit' || state.view === 'sun-earth';
  const earthShown = state.view !== 'night-sky' && state.view !== 'moon-orbit';
  return [
    VIEW_SENTENCE[state.view],
    orbitShown ? `Earth is where it is in ${MONTH_NAMES[state.earthAt]}.` : '',
    earthShown ? AXIS_SENTENCE[state.axis] : '',
    orbitShown ? ORBIT_SENTENCE[state.orbit] : '',
    RAY_SENTENCE[state.ray],
    pinSentence('north', state.northPin),
    pinSentence('south', state.southPin),
    MOON_SENTENCE[state.moonAt],
    FOCUS_SENTENCE[state.focus],
  ]
    .filter((sentence) => sentence !== '')
    .join(' ');
}
