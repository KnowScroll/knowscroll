import { clamp01, lerp, progress, rise, smoothstep } from './easing';
import { add, cross, normalize, scale, sub, type Vec3 } from './vec3';

/**
 * The first open (design "First open", 28 Oct): once in the lifetime of the account, the first time it
 * opens the Universe tab. Dust streams in along five spiral arms and builds a star that trembles and
 * bursts; a long trip past planets, galaxies, asteroids and two systems; a slow build to light speed;
 * a smooth stop on U01 Empty. 21.2 s, Skip always there. Everything is a pure function of `t`.
 */
export const FIRST_OPEN = {
  /** The star trembles from here. */
  shake: 4.9,
  bang: 5.9,
  warp: 13.9,
  full: 16.9,
  exit: 17.5,
  /** The camera has stopped on U01 Empty. */
  arrive: 20.0,
  /** The whole animation. */
  seconds: 21.2,
  /** Where the animation ends for an account that already has places (D-115): the empty-state title would rise now. */
  withPlaces: 19.6,
  /** The cross-fade from the last frame to the real map, for an account that already has places (D-115). */
  crossFade: 0.3,
  /** Length of the straight path the camera travels, in scene units. */
  distance: 2765,
  /** The dust that builds the star arrives between these times. */
  dustFrom: 1.6,
  dustTo: 4.9,
} as const;

const { shake, bang, warp, full, exit, arrive } = FIRST_OPEN;

/** U01 Empty's camera: where the animation ends. */
export const END_POSITION: Vec3 = [0, 4, 30];
export const END_TARGET: Vec3 = [0, 0, 0];
const FORWARD = normalize(sub(END_TARGET, END_POSITION));
const LOOK_DISTANCE = Math.hypot(...sub(END_TARGET, END_POSITION));
const SIDE: Vec3 = [1, 0, 0];
const UP = normalize(cross(SIDE, FORWARD));
const START: Vec3 = sub(END_POSITION, scale(FORWARD, FIRST_OPEN.distance));

/** A point on the path `along` units from the start, `across` to the right and `high` above it. */
export const pathPoint = (along: number, across = 0, high = 0): Vec3 =>
  add(add(add(START, scale(FORWARD, along)), scale(SIDE, across)), scale(UP, high));
/** The forming star. */
export const CORE: Vec3 = pathPoint(26);

// Coming to a stop: no jolt when it starts or ends, most of the slowing early, a long gentle glide at the end.
const stopFactor = (t: number): number => {
  const u = clamp01((t - exit) / (arrive - exit));
  return Math.pow(1 - u, 3) * (1 + 3 * u);
};
const velocity = (t: number): number =>
  smoothstep(bang + 0.05, bang + 0.95, t) * (1 + 0.6 * smoothstep(warp, full, t)) * stopFactor(t);
/** 0 cruising, 1 at light speed: a slow, smooth three-second build. */
export const warpAt = (t: number): number => smoothstep(warp, full, t) * stopFactor(t);
const STREAK_VELOCITY = (t: number): number => velocity(t) * (1 + 2 * warpAt(t));

const STEP = 1 / 400;
const STEPS = Math.round(arrive / STEP);
function integrate(speed: (t: number) => number): Float32Array {
  const total = new Float32Array(STEPS + 2);
  for (let at = 1; at < total.length; at += 1) total[at] = total[at - 1]! + speed(at * STEP) * STEP;
  return total;
}
const PATH = integrate(velocity);
const STREAKS = integrate(STREAK_VELOCITY);
const PEAK = FIRST_OPEN.distance / PATH[STEPS]!;
function lookup(table: Float32Array, t: number): number {
  if (t <= 0) return 0;
  if (t >= arrive) return table[STEPS]!;
  const position = t / STEP;
  const index = Math.floor(position);
  return lerp(table[index]!, table[index + 1]!, position - index);
}
/** How far along the path the camera is. The speed curve is integrated, so the path ends exactly on U01 Empty. */
export const distanceAt = (t: number): number => lookup(PATH, t) * PEAK;
export const speedAt = (t: number): number => velocity(t) * PEAK;
/** How far the stars have streamed past; they move faster than the camera at light speed. */
export const streamedAt = (t: number): number => lookup(STREAKS, t) * PEAK;
export const streakSpeedAt = (t: number): number => STREAK_VELOCITY(t);
/** How much of the dust has fallen into the star, 0 to 1. */
export const formedAt = (t: number): number => progress(t, FIRST_OPEN.dustFrom, FIRST_OPEN.dustTo);

export interface FirstOpenCamera {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
  /** Tilt of the camera's up, radians. */
  readonly roll: number;
}

const rotateAboutUp = (vector: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const along = UP[0] * vector[0] + UP[1] * vector[1] + UP[2] * vector[2];
  const k = cross(UP, vector);
  return [
    vector[0] * c + k[0] * s + UP[0] * along * (1 - c),
    vector[1] * c + k[1] * s + UP[1] * along * (1 - c),
    vector[2] * c + k[2] * s + UP[2] * along * (1 - c),
  ];
};

export function cameraAt(t: number): FirstOpenCamera {
  const sinceBang = t - bang;
  const born = sinceBang >= 0;
  const roll = 0.2 * Math.sin(2 * Math.PI * smoothstep(bang + 0.35, warp + 0.6, t));
  const fov =
    38 +
    18 * Math.min(1, velocity(t)) +
    16 * warpAt(t) +
    (born ? 3 * Math.exp(-sinceBang * 3.5) * smoothstep(0, 0.08, sinceBang) : 0);
  // Before the bang the camera circles slowly round the forming star, about 18 degrees, creeping closer.
  const yaw = -0.32 * (1 - smoothstep(0, bang - 0.2, t));
  const reach = 26 + 20 * (1 - smoothstep(0, bang, t));
  const before: Vec3 = add(CORE, scale(rotateAboutUp(scale(FORWARD, -1), yaw), reach));
  const base = born ? pathPoint(distanceAt(t)) : before;
  const target = born ? add(base, scale(FORWARD, LOOK_DISTANCE)) : CORE;
  const tremble = born ? 0.1 * Math.exp(-sinceBang * 5) : 0.05 * Math.pow(smoothstep(shake, bang, t), 2);
  const shaken = add(add(base, scale(SIDE, Math.sin(t * 47) * tremble)), scale(UP, Math.cos(t * 41) * tremble));
  return { position: shaken, target, fov, roll };
}

export interface FirstOpenFrame {
  readonly camera: FirstOpenCamera;
  /** The forming star: how big (0 to 1), how hot, and whether it is still there. */
  readonly star: { readonly visible: boolean; readonly size: number; readonly heat: number; readonly squeeze: number };
  /** The warm flash of the bang, 0 to 0.9. */
  readonly flash: number;
  /** The Skip chip's opacity: always there until just before arrival. */
  readonly skip: number;
  /** The stars of the sky switch on at the bang. */
  readonly sky: number;
  readonly warp: number;
  /** The empty state rises in over the last second and a half (an account with no places). */
  readonly empty: {
    readonly header: { opacity: number; offset: number };
    readonly title: { opacity: number; offset: number };
    readonly line: { opacity: number; offset: number };
    readonly action: { opacity: number; offset: number };
  };
}

export function firstOpenFrame(rawT: number): FirstOpenFrame {
  const t = Math.min(Math.max(rawT, 0), FIRST_OPEN.seconds);
  const formed = formedAt(t);
  const heat = smoothstep(shake, bang - 0.15, t);
  const rising = FIRST_OPEN.withPlaces;
  return {
    camera: cameraAt(t),
    star: {
      visible: t < bang && formed > 0,
      size: (0.04 + 0.96 * Math.pow(formed, 0.7)) * (1 + 0.025 * heat * Math.sin(t * 22)),
      heat,
      squeeze: 1 - 0.4 * smoothstep(bang - 0.22, bang, t),
    },
    flash: smoothstep(bang - 0.05, bang + 0.02, t) * (1 - smoothstep(bang + 0.04, bang + 0.6, t)) * 0.9,
    skip: 1 - smoothstep(arrive - 0.7, arrive - 0.2, t),
    sky: smoothstep(bang + 0.05, bang + 1.8, t),
    warp: warpAt(t),
    empty: {
      header: rise(t, rising, rising + 0.6, -8),
      title: rise(t, rising + 0.2, rising + 0.8, 10),
      line: rise(t, rising + 0.35, rising + 0.95, 10),
      action: rise(t, rising + 0.5, rising + 1.1, 10),
    },
  };
}

/** The shock rings of the bang: the warm one, then the pink one 0.12 s later. */
export function shockAt(t: number, lag: number): { visible: boolean; scale: number; opacity: number } {
  const k = t - bang - lag;
  return {
    visible: k > 0 && k < 1.4,
    scale: 2 + 140 * (1 - Math.pow(1 - clamp01(k / 1.1), 3)),
    opacity: 1 - smoothstep(0.15, 1.1, k),
  };
}

/** How long the animation plays: to the empty state's end, or to the point where a map takes over, plus its cross-fade. */
export const firstOpenSeconds = (accountHasPlaces: boolean): number =>
  accountHasPlaces ? FIRST_OPEN.withPlaces + FIRST_OPEN.crossFade : FIRST_OPEN.seconds;

/** Opacity of the animation's picture: it fades over the real map in the last 0.3 s when the account has places. */
export const pictureOpacityAt = (t: number, accountHasPlaces: boolean): number =>
  accountHasPlaces ? 1 - smoothstep(FIRST_OPEN.withPlaces, FIRST_OPEN.withPlaces + FIRST_OPEN.crossFade, t) : 1;
