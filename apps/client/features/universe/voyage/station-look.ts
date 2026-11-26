/**
 * What the trial look draws of a room's station, as numbers and colours: how big it is on screen, what its ring wears,
 * which lights it shows and when they blink. Pure, so the picture (`station-layer.tsx`) only places and paints. After
 * the design prototype (`Universe.dc.html`, `drawRooms` and `K.station`).
 */
import { ROOM_SWATCHES } from '@knowscroll/contracts';
import { hexToUnit, mixRgb, seededRandom, smooth, TAU, type Rgb } from '../space/paint';
import type { SpaceStationDefinition } from '../space/space-definition';

/*
 * Size. The prototype draws a room `clamp(46 * s, 18, 150)` px across, `s` being the scale at its depth: about 62 pt when
 * the camera is at the room's own stop. Here a station's anchor says how big its body is on screen (`radiusPx`), which
 * follows the same perspective; the factor is chosen so that a star's stop, which frames the station with its planets,
 * draws it about as large as the prototype does at a room's stop, and the whole universe draws it small, never under the
 * prototype's 18 pt floor.
 */
/** A station's drawn width, in points, for each point of its anchor's radius on screen. */
export const STATION_PER_RADIUS = 2.6;
export const STATION_MIN = 18;
export const STATION_MAX = 150;

/** How wide a station is drawn, in points, given the radius of its anchor on screen. */
export function stationSize(radiusPx: number): number {
  return Math.min(STATION_MAX, Math.max(STATION_MIN, STATION_PER_RADIUS * radiusPx));
}

/*
 * The picture's own coordinates: a sprite of `SPRITE` points a side, which the layer scales to the drawn width. The
 * fractions are the prototype's, of the sprite's width, from its top-left corner.
 */
export const SPRITE = 100;
/** The pink light near the antenna, and how far its glow reaches (0.12 of the width). */
export const ANTENNA_LIGHT = { x: 0.436 * SPRITE, y: 0.241 * SPRITE, radius: 0.12 * SPRITE } as const;
/** The yellow beacon above the antenna, 0.34 of the width over the middle, 0.22 across. */
export const BEACON = { x: 0.5 * SPRITE, y: 0.16 * SPRITE, radius: 0.22 * SPRITE } as const;
/** The warm glow behind a station: its radius is 1.5 of the width. */
export const WARM_GLOW_RADIUS = 1.5;

/** The ring as the prototype paints it: its far half, its near half and the highlight along it. */
export interface RingColours {
  readonly far: string;
  readonly near: string;
  readonly shine: string;
}
const DEFAULT_RING: RingColours = { far: '#B96A16', near: '#FFB347', shine: '#FFDFA0' };
/** An accent darker than this share of white would vanish into the dark sky: it is lifted toward white. */
const DARKEST_ACCENT = 0.2;

const toHex = (rgb: Rgb): string =>
  `#${rgb
    .map((value) =>
      Math.round(value * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
const mix = (hex: string, other: string, share: number): string =>
  toHex(mixRgb(hexToUnit(hex), hexToUnit(other), share));
const luminance = (hex: string): number => {
  const [red, green, blue] = hexToUnit(hex);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

/**
 * What the ring wears: the prototype's orange, or the room's own accent (D-170) with the same far, near and shine
 * relation. The accent of a room is any of the kit's swatches, some of them near black: those are lifted so the ring
 * can still be seen against the sky.
 */
export function ringColours(accent: keyof typeof ROOM_SWATCHES | undefined): RingColours {
  if (accent === undefined) return DEFAULT_RING;
  const swatch = ROOM_SWATCHES[accent];
  const near = luminance(swatch) < DARKEST_ACCENT ? mix(swatch, '#FFFFFF', 0.55) : swatch;
  return { far: mix(near, '#000000', 0.37), near, shine: mix(near, '#FFFFFF', 0.5) };
}

/** The light a live station shows instead of the pink one: the same red the scene's station gives it. */
export const LIVE_LIGHT = '#FF2E1F';
export const IDLE_LIGHT = '#FFA3CF';

/** What one station is drawn from: its room's face and what the person is allowed to see of it. */
export interface StationLook {
  readonly ring: RingColours;
  /** Lights lit of the constellation's seven; absent unless the station carries a sky (a member's, D-174). */
  readonly lit: number | undefined;
  /** A Launch or a Reel is on: a red light that pulses. */
  readonly live: boolean;
  /** Quiet under the Lately lens: dimmer, and its lights do not blink. */
  readonly calm: boolean;
  /** Where in its blink and hover the station is, so that stations do not move together. */
  readonly phase: number;
}

/** A station's own point in the cycle, in radians: from its id, never the same twice in a row of rooms. */
export function phaseOf(id: string): number {
  return seededRandom(`${id}:phase`)() * TAU;
}

/** What to draw of a station of the scene's definition: its accent, its sky, what is live, and whether it is calm. */
export function stationLookOf(station: SpaceStationDefinition): StationLook {
  return {
    ring: ringColours(station.emblem?.palette.accent),
    lit: station.sky?.lit,
    live: station.live !== undefined,
    calm: station.calm === true,
    phase: phaseOf(station.id),
  };
}

/*
 * The seven lights of the room's constellation (D-174), round it on a tilted ring: the prototype's `1.25` and `0.5` of
 * the width across and up, appearing as the station grows from 34 to 70 points. A station that carries no sky (an
 * outsider's) has none: the number lit is the member's own fact.
 */
export const SKY_STARS = 7;
const SKY_REACH = { across: 1.25, up: 0.5 } as const;
const SKY_APPEARS = { from: 34, to: 70 } as const;
/** The radius of one of the lights, in points whatever the size of the station. */
export const SKY_LIGHT_RADIUS = 7;

export interface SkyLight {
  /** From the station's middle, in points. */
  readonly x: number;
  readonly y: number;
  readonly lit: boolean;
}

/** How visible the ring of lights is at a drawn width: none while the station is small. */
export const skyAlpha = (width: number): number => smooth(SKY_APPEARS.from, SKY_APPEARS.to, width);

/** The constellation's lights round a station of this width, or none for a station with no sky or one too small. */
export function skyLights(width: number, lit: number | undefined): readonly SkyLight[] {
  if (lit === undefined || skyAlpha(width) < 0.02) return [];
  return Array.from({ length: SKY_STARS }, (_, star) => {
    const angle = (star * TAU) / SKY_STARS;
    return {
      x: Math.cos(angle) * width * SKY_REACH.across,
      y: Math.sin(angle) * width * SKY_REACH.up,
      lit: star < lit,
    };
  });
}

/*
 * Motion, as keyframes for an `Animated.Value` that loops 0 to 1 once per period. A station's phase shifts where it
 * starts. Sampled, so that the animation runs on the native side with no timer of its own.
 */
export const BLINK_PERIOD_MS = Math.round((TAU / 2.6) * 1000);
export const HOVER_PERIOD_MS = Math.round((TAU / 1.1) * 1000);
export const PULSE_PERIOD_MS = Math.round((TAU / 4) * 1000);
/** The light is on while `sin` of its angle is over this (the prototype's 0.2: about 44 % of the time). */
const BLINK_THRESHOLD = 0.2;
/** How wide the switch from off to on is, in `sin` units: quick, but not a flash. */
const BLINK_EDGE = 0.12;
/** How far a station rises and sinks, in points. */
export const HOVER_AMPLITUDE = 1.5;

export interface Keyframes {
  readonly inputRange: readonly number[];
  readonly outputRange: readonly number[];
}

/** `value` sampled evenly over one turn of the clock, the last sample equal to the first so the loop is seamless. */
function sampled(value: (turn: number) => number, steps: number): Keyframes {
  const inputRange = Array.from({ length: steps + 1 }, (_, step) => step / steps);
  return { inputRange, outputRange: inputRange.map((turn) => (turn === 1 ? value(0) : value(turn))) };
}

const sine = (turn: number, phase: number): number => Math.sin(turn * TAU + phase);

/** The antenna light's opacity over one period: on while the sine of its angle is over the threshold. */
export const blinkFrames = (phase: number): Keyframes =>
  sampled((turn) => smooth(BLINK_THRESHOLD - BLINK_EDGE / 2, BLINK_THRESHOLD + BLINK_EDGE / 2, sine(turn, phase)), 60);

/** How far a station is lifted over one period, in points (negative is up). */
export const hoverFrames = (phase: number): Keyframes => sampled((turn) => sine(turn, phase) * HOVER_AMPLITUDE, 24);

/** The size of a live station's red glow over one period, as a share of its resting size (the scene's 1.25 +/- 0.45). */
export const pulseFrames = (): Keyframes => sampled((turn) => 1.25 + 0.45 * sine(turn, 0), 24);
