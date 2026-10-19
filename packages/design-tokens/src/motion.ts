/**
 * Motion tokens with their reduced-motion variants (Tokens.html "Motion", V01). Only the sheet
 * has an authored easing (ease-out); the others use a standard deceleration curve until a
 * motion study names one (README.md).
 */

export type CubicBezier = readonly [number, number, number, number];

export const easing = {
  /** CSS `ease-out`. */
  easeOut: [0, 0, 0.58, 1],
  /** Standard deceleration (proposal; not authored). */
  standard: [0.2, 0, 0, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, CubicBezier>;

export interface MotionToken {
  readonly duration: number;
  readonly easing: CubicBezier;
  /** What the movement is, for documentation. */
  readonly kind: string;
  readonly reduced: {
    readonly duration: number;
    readonly kind: 'same-without-travel' | 'fade' | 'crossfade' | 'cut' | 'final-still' | 'off';
  };
}

export const motion = {
  /** Button or chip press: the offset shadow goes to 0. Reduced: same, without travel. */
  press: {
    duration: 120,
    easing: easing.standard,
    kind: 'shadow-to-zero',
    reduced: { duration: 120, kind: 'same-without-travel' },
  },
  /** Sheets and popovers rise 24 px. Reduced: 140 ms fade. */
  sheet: { duration: 240, easing: easing.easeOut, kind: 'rise-24', reduced: { duration: 140, kind: 'fade' } },
  /** Vertical subject change. Reduced: 160 ms crossfade. */
  subject: { duration: 320, easing: easing.standard, kind: 'slide-up', reduced: { duration: 160, kind: 'crossfade' } },
  /** Horizontal continuation; the yellow rail leads. Reduced: crossfade plus rail label. */
  thread: {
    duration: 360,
    easing: easing.standard,
    kind: 'slide-horizontal',
    reduced: { duration: 160, kind: 'crossfade' },
  },
  /** System → planet → region dolly (600–900 ms). Reduced: cut with a 200 ms fade. */
  camera: { duration: 750, easing: easing.standard, kind: 'dolly', reduced: { duration: 200, kind: 'cut' } },
  /** Formation, once per transition ID, skippable. Reduced: final still plus caption. */
  formation: {
    duration: 2400,
    easing: easing.standard,
    kind: 'formation',
    reduced: { duration: 0, kind: 'final-still' },
  },
  /** Twinkle and orbit drift: at most one cycle per 20 s. Reduced: off. */
  ambient: { duration: 20000, easing: easing.linear, kind: 'ambient', reduced: { duration: 0, kind: 'off' } },
} as const satisfies Record<string, MotionToken>;

export type MotionName = keyof typeof motion;

/** Distance a sheet rises while it appears. */
export const sheetRise = 24;

/** Duration for a motion token under the current reduced-motion setting. */
export function motionDuration(name: MotionName, reducedMotion: boolean): number {
  const token: MotionToken = motion[name];
  return reducedMotion ? token.reduced.duration : token.duration;
}
