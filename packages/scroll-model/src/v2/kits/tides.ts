import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';

/**
 * The tides kit (D-194): Earth wrapped in an ocean, the Moon, the Sun, the Moon's pull and the tides
 * they raise. The writer chooses the view, the Moon's phase and the part to look at. Code derives the
 * rest (D-195): where the two bulges form, how tall the combined bulges are, and whether the tide is a
 * spring tide (Sun, Moon and Earth in a line) or a neap tide (at right angles). A stored state has no
 * field in which a bulge could point away from the Moon.
 *
 * It draws the idea of the tide-raising force, not a coast: real tides also depend on the shape and
 * depth of every basin, which the picture leaves out.
 */
export const TIDES_KIT = 'tides.v1';

export const TIDES_ENUMS = {
  /**
   * What the picture is of. `pull` draws the Moon's pull on three places of Earth; `bulges` the two
   * bulges the Moon raises; `sun-moon` the Sun's bulges added to the Moon's, seen from above;
   * `range` the size of the tide through the four main phases.
   */
  view: ['pull', 'bulges', 'sun-moon', 'range'],
  /** Where the Moon is in its month, drawn in `sun-moon` and `range`. */
  moonAt: ['new', 'first-quarter', 'full', 'last-quarter'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: ['none', 'moon', 'sun', 'near-bulge', 'far-bulge', 'range'],
} as const;

export type TidesState = KitState<typeof TIDES_ENUMS>;
export type TidesPatch = KitPatch<typeof TIDES_ENUMS>;
export type TidesView = TidesState['view'];
export type MoonPhase = TidesState['moonAt'];

export const INITIAL_TIDES_STATE: TidesState = { view: 'bulges', moonAt: 'new', focus: 'none' };

export const TidesStateSchema = kitStateSchema(TIDES_ENUMS);

/** The parts of the kit a picture may be made of. `phase` stands for "the Moon's phase matters here". */
export type TidesPart =
  'earth' | 'ocean' | 'moon' | 'sun' | 'pull-arrows' | 'bulges' | 'solar-bulges' | 'range-bars' | 'phase';

const VIEW_PARTS: Readonly<Record<TidesView, readonly TidesPart[]>> = {
  pull: ['earth', 'moon', 'pull-arrows'],
  bulges: ['earth', 'ocean', 'moon', 'bulges'],
  'sun-moon': ['sun', 'earth', 'ocean', 'moon', 'bulges', 'solar-bulges', 'phase'],
  range: ['range-bars', 'phase'],
};

/** The parts a view draws. Anything else is never drawn, never described and never a focus. */
export function tidesParts(view: TidesView): readonly TidesPart[] {
  return VIEW_PARTS[view];
}

const FOCUS_PART: Readonly<Record<TidesState['focus'], TidesPart | null>> = {
  none: null,
  moon: 'moon',
  sun: 'sun',
  'near-bulge': 'bulges',
  'far-bulge': 'bulges',
  range: 'range-bars',
};

/** The phase a picture shows when the phase does not matter to it, so unseen differences are not counted as change. */
const NEUTRAL_PHASE: MoonPhase = 'new';

/** The state a view can really show: a phase where the view has none, or a focus on a part that is not there, is set aside. Idempotent. */
export function settleTidesState(state: TidesState): TidesState {
  const parts = tidesParts(state.view);
  const focusPart = FOCUS_PART[state.focus];
  return {
    view: state.view,
    moonAt: parts.includes('phase') ? state.moonAt : NEUTRAL_PHASE,
    focus: focusPart === null || parts.includes(focusPart) ? state.focus : 'none',
  };
}

/** The Sun's tide-raising force as a share of the Moon's: about 0.46. */
export const SOLAR_SHARE_OF_LUNAR = 0.46;

/** The distance to the Moon in Earth radii (about 60). */
export const MOON_DISTANCE_EARTH_RADII = 60;

/** The directions in the top-down picture, degrees anticlockwise from the right: the Sun is at the left. */
export const SUN_DIRECTION_DEGREES = 180;
export const MOON_DIRECTION_DEGREES: Readonly<Record<MoonPhase, number>> = {
  new: 180,
  'first-quarter': 270,
  full: 0,
  'last-quarter': 90,
};

/** The Moon's pull at three places, in units of its pull at Earth's centre: nearest the Moon, the centre, farthest. */
export interface MoonPull {
  readonly near: number;
  readonly centre: number;
  readonly far: number;
}

/**
 * Newton's inverse-square law at the near side, the centre and the far side of Earth: the Moon is
 * `MOON_DISTANCE_EARTH_RADII` away, so the near side is one radius closer and the far side one farther.
 * The near side is pulled more than the centre and the far side less; measured against the centre, the
 * near water is drawn toward the Moon and the far water away from it.
 */
export function moonPull(): MoonPull {
  const distance = MOON_DISTANCE_EARTH_RADII;
  const atCentre = 1 / (distance * distance);
  return {
    near: 1 / ((distance - 1) * (distance - 1)) / atCentre,
    centre: 1,
    far: 1 / ((distance + 1) * (distance + 1)) / atCentre,
  };
}

/** The combined tide of the Moon and the Sun: how tall its bulges are, and the line along which they lie. */
export interface CombinedTide {
  /** In units of the Moon's own bulge height. */
  readonly amplitude: number;
  /** Direction of one bulge, degrees anticlockwise from the right, in [0, 180); the other bulge is opposite. */
  readonly axisDegrees: number;
}

const radiansOf = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Each body raises a wave with two crests round the planet, one on each side along the line to the
 * body: the Moon's has height 1 and the Sun's `SOLAR_SHARE_OF_LUNAR`. Adding two such waves gives one
 * wave whose crests lie between theirs, nearer the stronger. Each is written as a point at twice its
 * angle, so "two crests" is one turn, and the sum of the points is the sum of the waves.
 */
export function combinedTide(moonDegrees: number, sunDegrees: number): CombinedTide {
  const across = Math.cos(radiansOf(2 * moonDegrees)) + SOLAR_SHARE_OF_LUNAR * Math.cos(radiansOf(2 * sunDegrees));
  const up = Math.sin(radiansOf(2 * moonDegrees)) + SOLAR_SHARE_OF_LUNAR * Math.sin(radiansOf(2 * sunDegrees));
  const half = (Math.atan2(up, across) * 180) / Math.PI / 2;
  return { amplitude: Math.hypot(across, up), axisDegrees: ((half % 180) + 180) % 180 };
}

/** Which tide a phase gives: the Sun and Moon in a line with Earth add (spring); at right angles they partly cancel (neap). */
export type TideKind = 'spring' | 'neap';

export interface TidesPhysics {
  readonly moonDegrees: number;
  readonly sunDegrees: number;
  /** The Moon's own pair of bulges lies along `moonDegrees` and the Sun's along `sunDegrees`. */
  readonly combined: CombinedTide;
  readonly kind: TideKind;
}

/** What follows from a phase by physics. Derived, never stored and never written by the model. */
export function tidesPhysics(state: Pick<TidesState, 'moonAt'>): TidesPhysics {
  const moonDegrees = MOON_DIRECTION_DEGREES[state.moonAt];
  const combined = combinedTide(moonDegrees, SUN_DIRECTION_DEGREES);
  // In a line: the two directions differ by 0 or 180 degrees, so the two pairs of crests coincide.
  const inLine = Math.abs(Math.sin(radiansOf(moonDegrees - SUN_DIRECTION_DEGREES))) < 1e-9;
  return { moonDegrees, sunDegrees: SUN_DIRECTION_DEGREES, combined, kind: inLine ? 'spring' : 'neap' };
}

/** The size of the combined tide at each phase, in units of the greatest. */
export function tideRangeByPhase(): Readonly<Record<MoonPhase, number>> {
  const sizes = TIDES_ENUMS.moonAt.map((phase) => [phase, tidesPhysics({ moonAt: phase }).combined.amplitude] as const);
  const greatest = Math.max(...sizes.map(([, size]) => size));
  return Object.fromEntries(sizes.map(([phase, size]) => [phase, size / greatest])) as Record<MoonPhase, number>;
}

const VIEW_SENTENCE: Readonly<Record<TidesView, string>> = {
  pull: 'Earth is on the left and the Moon is on the right. Three arrows show the Moon’s pull, strongest on the side of Earth nearest the Moon, weaker at Earth’s centre and weakest on the far side. The differences are exaggerated so that they can be seen. Measured against Earth’s centre, the near water is pulled toward the Moon and the far water away from it.',
  bulges:
    'Earth is wrapped in an ocean that is stretched into two bulges along the line to the Moon, one on the side that faces the Moon and one on the opposite side. The two are about equal, and the stretching is exaggerated.',
  'sun-moon':
    'Seen from above Earth’s north pole, with the Sun far away at the left. Sizes and distances are not to scale.',
  range:
    'Four bars compare the size of the tide through the Moon’s four main phases: new, first quarter, full and last quarter.',
};

const MOON_SENTENCE: Readonly<Record<MoonPhase, string>> = {
  new: 'The Moon is new, between Earth and the Sun.',
  'first-quarter': 'The Moon is at first quarter, at right angles to the Sun.',
  full: 'The Moon is full, with Earth between it and the Sun.',
  'last-quarter': 'The Moon is at last quarter, at right angles to the Sun.',
};

const KIND_SENTENCE: Readonly<Record<TideKind, string>> = {
  spring:
    'The Sun, the Moon and Earth are in a line, so the Sun’s small bulges lie on top of the Moon’s and add to them: the combined bulges are as tall as they get, a spring tide.',
  neap: 'The Sun and the Moon are at right angles, so the Sun’s small bulges lie across the Moon’s and partly cancel them: the combined bulges are as low as they get, a neap tide.',
};

const FOCUS_SENTENCE: Readonly<Record<TidesState['focus'], string>> = {
  none: '',
  moon: 'The picture draws the eye to the Moon.',
  sun: 'The picture draws the eye to the Sun.',
  'near-bulge': 'The picture draws the eye to the bulge on the side facing the Moon.',
  'far-bulge': 'The picture draws the eye to the bulge on the side away from the Moon.',
  range: 'The picture draws the eye to the bars.',
};

const phaseName = (phase: MoonPhase): string => phase.replace('-', ' ');

/** Two sizes closer than this are the same size: the sums are floating-point. */
const SAME_SIZE = 1e-9;

/** The sentence about the bars: which phases give the largest tides and which the smallest, from the same sums the bars are drawn from. */
function rangeSentence(moonAt: MoonPhase): string {
  const sizes = tideRangeByPhase();
  const phases = TIDES_ENUMS.moonAt;
  const lowest = Math.min(...phases.map((phase) => sizes[phase]));
  const named = (keep: (size: number) => boolean): string =>
    phases
      .filter((phase) => keep(sizes[phase]))
      .map(phaseName)
      .join(' and ');
  return `The bars are tallest at ${named((size) => size > 1 - SAME_SIZE)} and shortest at ${named((size) => size < lowest + SAME_SIZE)}. The Moon is now at ${phaseName(moonAt)}, and its bar is marked.`;
}

/**
 * What a tides state shows, as sentences: the text version of a stage and its accessible name. It is
 * derived by code from the state and its physics, never written by the model, and it settles the
 * state first, so it mentions only what the view draws and cannot disagree with the picture.
 */
export function describeTidesState(chosen: TidesState): string {
  const state = settleTidesState(chosen);
  const parts = tidesParts(state.view);
  const physics = tidesPhysics(state);
  const topDown = state.view === 'sun-moon';
  return [
    VIEW_SENTENCE[state.view],
    topDown ? MOON_SENTENCE[state.moonAt] : '',
    topDown
      ? 'The Moon raises two bulges in Earth’s ocean, one facing it and one opposite, and the Sun raises two smaller ones along its own line.'
      : '',
    parts.includes('solar-bulges') ? KIND_SENTENCE[physics.kind] : '',
    state.view === 'range' ? rangeSentence(state.moonAt) : '',
    FOCUS_SENTENCE[state.focus],
  ]
    .filter((sentence) => sentence !== '')
    .join(' ');
}

export const TIDES_KIT_DEFINITION = defineKit({
  id: TIDES_KIT,
  enums: TIDES_ENUMS,
  initial: INITIAL_TIDES_STATE,
  settle: settleTidesState,
  describe: describeTidesState,
  writerGuide: [
    'Code draws the picture from a fixed kit: Earth wrapped in an ocean, the Moon, the Sun, arrows for the Moon’s pull and the bulges of water they raise. You choose only the view, the Moon’s phase and the part to look at, from the listed words. Code decides everything else: where the bulges form, how tall they are and whether the tide is a spring tide or a neap tide all follow from the phase. So the phase you choose is a claim the picture makes: choose the one that matches what the stop says.',
    '- The views: "pull" shows the Moon’s pull on the near side, the centre and the far side of Earth (the differences are exaggerated); "bulges" shows the two bulges of water the Moon raises, one facing it and one opposite; "sun-moon" shows Earth, the Moon and the Sun from above, with the Sun’s smaller bulges added to the Moon’s, and is the view for spring and neap tides; "range" compares the size of the tide at new, first quarter, full and last quarter. Only "sun-moon" and "range" show the Moon’s phase; a phase or a focus on a part the view does not draw is ignored.',
    '- The picture draws no coast, place or time of day; coasts belong to the text.',
  ],
});
