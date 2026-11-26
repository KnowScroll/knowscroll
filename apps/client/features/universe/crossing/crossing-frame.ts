import { clamp01, lerp, smootherstep, smoothstep } from '../animation/easing';

/**
 * The crossing to a friend's Universe (Round 7.3): one short full-screen film, drawn by a fragment shader and a few
 * 2D marks. This file is the whole film as a pure function of film time `q` (0 to 1): no clock, no GL, so a still can
 * be drawn at any `q` and the beats can be tested at their boundaries. Every constant is the prototype's
 * (`Universe.dc.html`, `drawWarp`).
 */

/** Out to a friend, or home again. Home swaps the two colours and the two bubbles, and has no names in common. */
export type CrossingDirection = 'out' | 'home';

/** How long the film lasts, in seconds: 7.5 the first time for a friend, 3.6 after, 3.8 going home. */
export function crossingSeconds(direction: CrossingDirection, seen: boolean): number {
  if (direction === 'home') return 3.8;
  return seen ? 3.6 : 7.5;
}

const WAY_OUT_COLOURS = { a: '#FFC98A', m: '#B79BFF', b: '#5EF0DC' } as const;
const WAY_HOME_COLOURS = { a: '#5EF0DC', m: '#B79BFF', b: '#FFC98A' } as const;

/** Four yellow arcs close on the other universe, each this long (radians) and spinning this fast (radians a second). */
const ARC_COUNT = 4;
const ARC_LENGTH = 0.9;
const ARC_SPIN = 0.9;

/** The mark's soft glow behind the other universe, in its radii. */
const HALO_RADII = 2.6;
const HALO_ALPHA = 0.4;

/** The throat's centre sways by this much (px) at full depth; the two shakes peak at these `q` and reach 5 px. */
const SWAY = { x: 20, y: 14 };
const SHAKE_PEAKS = [0.39, 0.91] as const;
const SHAKE_PX = 5;

/** A name in common lasts this long (in `q`), and the next starts this much after it. */
const NAME_SPAN = 0.22;
const NAME_STAGGER = 0.12;
const NAMES_START = 0.47;

/** Where the header lines sit, as a share of the height. */
const HEADER_AT = 0.19;

/** What the fragment shader is given. Positions and radii are in units of the short side of the screen, y up. */
export interface CrossingShaderUniforms {
  /** The shader's own clock, seconds (the film time `q` times its length). */
  readonly time: number;
  /** Centre of the ball and the throat, from the screen's centre. */
  readonly centre: readonly [number, number];
  /** The ball's radius (the way through opening, then blown up to cover the screen). */
  readonly ballRadius: number;
  /** 0 draws the ball, 1 draws the throat. */
  readonly open: number;
  /** How far the colour has run from the first colour to the last, 0 to 1. */
  readonly tint: number;
  readonly twist: number;
  readonly speed: number;
  /** The other universe's sky at the far end of the throat: its radius, whether it is dark, and the light round it. */
  readonly farRadius: number;
  readonly dark: number;
  readonly glow: number;
  readonly seed: number;
  /** Where the film starts (`a`), passes (`m`) and ends (`b`), as hex colours. */
  readonly colours: { readonly a: string; readonly m: string; readonly b: string };
}

/** A universe's bubble drawn in 2D: its centre and radius in layout px and how seen it is. */
export interface CrossingBubble {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
}

/** The other universe's bubble, with the soft glow round it. */
export interface CrossingAheadBubble extends CrossingBubble {
  readonly haloRadius: number;
  readonly haloAlpha: number;
}

/** The yellow ring that closes on the other universe: four arcs, with where the first starts. */
export interface CrossingRing {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
  /** Radians the first arc starts at; the others follow at quarter turns. */
  readonly spin: number;
  readonly arcCount: number;
  readonly arcLength: number;
}

/** Which line of the film a label is. */
export type CrossingLabelKey = 'course' | 'ring' | 'opens' | 'common';

/** A line of text. Its centre is `x`, its top is `y` (the film's labels hang from their top). */
export interface CrossingLabel {
  readonly key: CrossingLabelKey;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly alpha: number;
  /** Mono capitals (the header lines), or the display face (names). */
  readonly mono: boolean;
}

/** One name in common drifting out of the far end: the name (centred on `x`, hanging from `y`) and its glow. */
export interface CrossingName {
  readonly index: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly alpha: number;
  /** The glow behind the name sits 10 px above its text line and is not kept on screen. */
  readonly glow: { readonly x: number; readonly y: number; readonly radius: number };
}

/** Everything one frame of the film needs. */
export interface CrossingFrame {
  readonly q: number;
  readonly seconds: number;
  readonly shader: CrossingShaderUniforms;
  /** The whole picture is moved by this many px (two shakes, none with reduced motion). */
  readonly shake: { readonly x: number; readonly y: number };
  /** The bubble you are leaving: yours on the way out, the friend's on the way home. Null once it has gone. */
  readonly behind: CrossingBubble | null;
  /** The bubble you are heading for. Null once the way through has opened. */
  readonly ahead: CrossingAheadBubble | null;
  readonly ring: CrossingRing | null;
  readonly labels: readonly CrossingLabel[];
  readonly names: readonly CrossingName[];
  /** The white flash over everything, 0 to 1. */
  readonly flash: number;
}

/** What a frame depends on besides `q` and the direction. */
export interface CrossingFrameOptions {
  /** The screen in layout px. */
  readonly size: { readonly width: number; readonly height: number };
  /** The visited friend's first name, for "Setting course for Ravi's universe". Unused going home. */
  readonly friendName?: string;
  /** Shared systems, in order. Out only: home has none. */
  readonly names?: readonly string[];
  /** The film's length in seconds; absent: {@link crossingSeconds} for the first time. */
  readonly seconds?: number;
  /** Reduced motion: no shake. (The film itself is not played at all then.) */
  readonly reducedMotion?: boolean;
}

/** Half the width of a mono capital (DM Mono is 0.6 em wide, plus the 1 px spacing) and of a display letter, as an estimate. */
function estimatedWidth(text: string, size: number, mono: boolean): number {
  return mono ? text.length * (size * 0.6 + 1) : text.length * size * 0.55;
}

/** A label's centre kept inside the screen, as the prototype does, once its width is known roughly. */
function keptOnScreen(x: number, text: string, size: number, mono: boolean, width: number): number {
  const half = estimatedWidth(text, size, mono) / 2 + 8;
  if (x <= 0 || x >= width || half * 2 >= width) return x;
  return Math.min(Math.max(x, half), width - half);
}

function labelAt(
  key: CrossingLabelKey,
  text: string,
  x: number,
  y: number,
  size: number,
  alpha: number,
  mono: boolean,
  width: number,
): CrossingLabel | null {
  if (alpha <= 0.03) return null;
  const shown = mono ? text.toUpperCase() : text;
  return { key, text, x: keptOnScreen(x, shown, size, mono, width), y, size, alpha: Math.min(1, alpha), mono };
}

/** The shake offset: the screen jolts twice, as the way opens and as the far end arrives. */
function shakeAt(q: number, seconds: number, reducedMotion: boolean): { x: number; y: number } {
  if (reducedMotion) return { x: 0, y: 0 };
  const amount = SHAKE_PEAKS.reduce((sum, peak) => sum + Math.exp(-Math.pow((q - peak) / 0.03, 2)), 0) * SHAKE_PX;
  return { x: Math.sin(seconds * 61) * amount, y: Math.cos(seconds * 53) * amount };
}

/**
 * The film at time `q`, 0 to 1 (clamped). Beats, in `q`: the course is set 0.01 to 0.16; a ring closes on their
 * universe 0.04 to 0.15; the way through opens 0.13 to 0.38; the dive 0.27 to 0.42; the throat 0.36 to 0.80; the far
 * end is in sight from 0.45 and fills the screen by 0.95; the names in common drift past from 0.47; the flash
 * rises 0.92 to 0.995.
 */
export function crossingFrame(q: number, direction: CrossingDirection, options: CrossingFrameOptions): CrossingFrame {
  const home = direction === 'home';
  const { width, height } = options.size;
  const shortSide = Math.min(width, height);
  // Marks are laid out against the smaller of the width and 62 % of the height, so a tall phone does not push them wide.
  const markUnit = Math.min(width, height * 0.62);
  const time = clamp01(q);
  const seconds = time * (options.seconds ?? crossingSeconds(direction, false));
  const colours = home ? WAY_HOME_COLOURS : WAY_OUT_COLOURS;

  const turn = smootherstep(smoothstep(0.03, 0.16, time));
  const open = smootherstep(smoothstep(0.13, 0.3, time));
  const dive = smoothstep(0.27, 0.42, time);
  const throat = smoothstep(0.36, 0.45, time);
  const arrive = smoothstep(0.74, 0.95, time);
  const tint = smoothstep(0.42, 0.8, time);

  const centreX = width / 2 + SWAY.x * Math.sin(seconds * 0.7) * throat;
  const centreY = height * 0.43 + SWAY.y * Math.sin(seconds * 1.05 + 1) * throat;
  const ballRadius = 0.2 * open * (1 + 14 * Math.pow(dive, 2.6));
  const farRadius = (0.07 + 0.07 * smoothstep(0.45, 0.74, time)) * (1 + 26 * Math.pow(arrive, 3));

  const shader: CrossingShaderUniforms = {
    time: seconds,
    centre: [(centreX - width / 2) / shortSide, -(centreY - height / 2) / shortSide],
    ballRadius,
    open: throat,
    tint,
    twist: 2.4,
    speed: 0.5,
    farRadius,
    dark: 0,
    glow: 1.1 * Math.pow(arrive, 2),
    seed: 3,
    colours,
  };

  const beforeThrough = 1 - smoothstep(0.3, 0.38, time);
  const labels: CrossingLabel[] = [];
  let behind: CrossingBubble | null = null;
  let ahead: CrossingAheadBubble | null = null;
  let ring: CrossingRing | null = null;

  if (beforeThrough > 0.01) {
    const behindAlpha = 1 - smoothstep(0.16, 0.3, time);
    if (behindAlpha > 0.01) {
      behind = {
        x: width / 2 - width * 0.8 * turn,
        y: height * 0.5 + height * 0.3 * turn,
        radius: markUnit * lerp(0.44, 0.3, turn),
        alpha: behindAlpha,
      };
    }
    const far = 1 - open;
    if (far > 0.01) {
      const aheadRadius = markUnit * 0.085;
      const x = lerp(width / 2, width / 2 + width * 0.27, 1 - turn);
      const y = lerp(height * 0.43, height * 0.25, 1 - turn);
      const closing = smoothstep(0.04, 0.15, time);
      const ringRadius = aheadRadius * lerp(3.4, 1.5, closing);
      ahead = {
        x,
        y,
        radius: aheadRadius,
        alpha: far * smoothstep(0, 0.05, time),
        haloRadius: aheadRadius * HALO_RADII,
        haloAlpha: HALO_ALPHA,
      };
      ring = {
        x,
        y,
        radius: ringRadius,
        alpha: far * closing,
        spin: seconds * ARC_SPIN,
        arcCount: ARC_COUNT,
        arcLength: ARC_LENGTH,
      };
      const ringLabel = labelAt(
        'ring',
        home ? 'Home' : `${options.friendName ?? ''}’s universe`,
        x,
        y + ringRadius + 8,
        13,
        far * closing,
        false,
        width,
      );
      if (ringLabel !== null) labels.push(ringLabel);
    }
    const course = labelAt(
      'course',
      home ? 'Setting course for home' : `Setting course for ${options.friendName ?? ''}’s universe`,
      width / 2,
      height * HEADER_AT,
      10.5,
      beforeThrough * smoothstep(0.01, 0.06, time) * (1 - smoothstep(0.13, 0.16, time)),
      true,
      width,
    );
    if (course !== null) labels.push(course);
    const opens = labelAt(
      'opens',
      'A way through opens',
      width / 2,
      height * HEADER_AT,
      10.5,
      beforeThrough * smoothstep(0.16, 0.2, time),
      true,
      width,
    );
    if (opens !== null) labels.push(opens);
  }

  const shared = home ? [] : (options.names ?? []);
  const names: CrossingName[] = [];
  shared.forEach((text, index) => {
    const along = clamp01((time - NAMES_START - index * NAME_STAGGER) / NAME_SPAN);
    if (along <= 0 || along >= 1) return;
    const angle = 2.5 + index * 2.3;
    const reach = markUnit * (0.1 + 0.5 * Math.pow(along, 1.7));
    const size = 12 + 14 * along;
    const alpha = Math.sin(Math.PI * along);
    const x = centreX + Math.cos(angle) * reach;
    const y = centreY + Math.sin(angle) * reach * 1.1;
    names.push({
      index,
      text,
      x: keptOnScreen(x, text, size, false, width),
      y,
      size,
      alpha,
      glow: { x, y: y - 10, radius: 10 + 14 * along },
    });
  });
  if (shared.length > 0 && time > NAMES_START && time < 0.8) {
    const common = labelAt(
      'common',
      'What you have in common',
      width / 2,
      height * HEADER_AT,
      10.5,
      Math.sin((Math.PI * (time - NAMES_START)) / 0.33),
      true,
      width,
    );
    if (common !== null) labels.push(common);
  }

  return {
    q: time,
    seconds,
    shader,
    shake: shakeAt(time, seconds, options.reducedMotion === true),
    behind,
    ahead,
    ring,
    labels,
    names,
    flash: smoothstep(0.92, 0.995, time),
  };
}
