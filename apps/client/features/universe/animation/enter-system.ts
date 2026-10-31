import type { CameraPose } from '../space/camera-rig';
import { clamp01, easeOut, lerp, logLerp, progress, rise, smootherstep, smoothstep } from './easing';
import { add, bezier, cameraBasis, length, mix, normalize, scale, sub, type Vec3 } from './vec3';

/**
 * Entering a system (design "Enter a system", 29 Oct): a small rocket rises in from under the bottom
 * edge and leads the way while the camera swings round and settles over the system; the rocket pulls
 * ahead and parks beside the planet where the system keeps its ship. 5.3 s, the same for every system.
 * Everything here is a pure function of `t`.
 *
 * The design draws two scenes (the overview and the detailed system) and cross-fades them. This tab
 * draws one scene with one camera (D-107), so there is no hand-over: the camera path alone carries
 * the story, and the design's overview-to-system scale (K, 2.18 for its sample system) is already
 * built into the distances.
 */
export const ENTER_SYSTEM = {
  seconds: 5.3,
  cameraStart: 0.35,
  cameraEnd: 4.6,
  rocketStart: 0.4,
  go: 2.55,
  parked: 4.4,
  /** The tap ring opens over this long (0.5 to 0.6 s in the design). */
  tapSeconds: 0.6,
} as const;

/** The design's U02 scene is this much bigger than the overview drawing; the rocket's offsets shrink by it. */
const SCALE_DOWN = 1 / 2.18;
const START_OFFSET: Vec3 = scale([0.34, -1.85, -2.7], SCALE_DOWN);
const HOLD_OFFSET: Vec3 = scale([0.06, -0.42, -4.6], SCALE_DOWN);
const FAR_OFFSET: Vec3 = scale([0, -0.3, -16], SCALE_DOWN);
const ROCKET_SIZE = 0.42 * SCALE_DOWN;
/** How far above and behind the dock the glide's last bend sits. */
const APPROACH = { up: 2.2 * SCALE_DOWN, back: 3.2 * SCALE_DOWN } as const;

interface Spherical {
  readonly radius: number;
  readonly elevation: number;
  readonly yaw: number;
}
function sphericalOf(offset: Vec3): Spherical {
  const radius = length(offset);
  return { radius, elevation: Math.asin(offset[1] / radius), yaw: Math.atan2(offset[0], offset[2]) };
}

/** What the path is built from. All world positions are at the instant being drawn. */
export interface EnterSystemScene {
  /** The camera of the whole-universe view, without its drift. */
  readonly from: CameraPose;
  /** The camera of the system view, without its drift. */
  readonly to: CameraPose;
  /** The system's sun. */
  readonly sun: Vec3;
  /** Where the rocket parks: beside the planet that holds the ship, or the first planet. */
  readonly dock: Vec3;
}

export interface RocketFrame {
  readonly position: Vec3;
  /** Where the nose points. */
  readonly direction: Vec3;
  /** Edge length in scene units; zero once the ship has taken over. */
  readonly size: number;
  /** Engine strength, 0 to 1. */
  readonly heat: number;
  readonly visible: boolean;
}

/** The chrome of both screens and the tap ring, each a pure function of `t` (design: "Destination chrome rises in last"). */
export interface EnterSystemChrome {
  /** The overview's header, chips and names fade away. */
  readonly overviewOpacity: number;
  /** Planet names in the system view. */
  readonly labelsOpacity: number;
  readonly back: { opacity: number; offset: number };
  readonly title: { opacity: number; offset: number };
  readonly bottom: { opacity: number; offset: number };
  /** One ring opens and fades where the system was touched. */
  readonly tapRing: { opacity: number; scale: number };
}

export interface EnterSystemFrame {
  readonly pose: CameraPose;
  readonly rocket: RocketFrame;
  /** Scale of the ship that stays parked at the dock, 0 to 1 (the rocket swaps for it, 0.3 s). */
  readonly parkedShip: number;
  readonly chrome: EnterSystemChrome;
}

/** How far through the swing the camera is, 0 to 1. */
export const cameraProgress = (t: number): number =>
  smootherstep(progress(t, ENTER_SYSTEM.cameraStart, ENTER_SYSTEM.cameraEnd));

/** The camera on a sphere round the sun, from the whole-universe pose to the system pose. */
export function cameraAt(t: number, scene: EnterSystemScene): CameraPose {
  const e = cameraProgress(t);
  const bend = Math.sin(Math.PI * e);
  const start = sphericalOf(sub(scene.from.position, scene.sun));
  const end = sphericalOf(sub(scene.to.position, scene.sun));
  const radius = logLerp(start.radius, end.radius, e);
  const elevation = lerp(start.elevation, end.elevation, e) - 0.14 * bend;
  const yaw = lerp(start.yaw, end.yaw, e) - 0.5 * bend;
  const offset: Vec3 = [
    radius * Math.cos(elevation) * Math.sin(yaw),
    radius * Math.sin(elevation),
    radius * Math.cos(elevation) * Math.cos(yaw),
  ];
  return {
    position: add(scene.sun, offset),
    target: mix(scene.from.target, scene.to.target, e),
    fov: scene.from.fov + 4 * bend,
  };
}

/** The rocket in camera space while we follow close behind it: rises in, then holds ahead with a small bob. */
function followOffset(t: number): Vec3 {
  const rising = easeOut((t - ENTER_SYSTEM.rocketStart) / 1.1);
  const held = mix(START_OFFSET, HOLD_OFFSET, rising);
  return add(held, [Math.sin(t * 1.3) * 0.05 * SCALE_DOWN, Math.sin(t * 1.9) * 0.04 * SCALE_DOWN, 0]);
}

function toWorld(pose: CameraPose, offset: Vec3): Vec3 {
  const { right, up, back } = cameraBasis(pose.position, pose.target);
  return add(pose.position, add(add(scale(right, offset[0]), scale(up, offset[1])), scale(back, offset[2])));
}

/** Where the rocket is, and how far along its glide to the dock, 0 to 1. */
function rocketPath(t: number, scene: EnterSystemScene): { position: Vec3; glide: number } {
  const pose = cameraAt(t, scene);
  const start = toWorld(pose, followOffset(t));
  const ahead = toWorld(pose, FAR_OFFSET);
  const away = normalize([pose.position[0] - scene.dock[0], 0, pose.position[2] - scene.dock[2]]);
  const bendPoint = add(add(scene.dock, [0, APPROACH.up, 0]), scale(away, APPROACH.back));
  const x = clamp01((t - ENTER_SYSTEM.go) / (ENTER_SYSTEM.parked - ENTER_SYSTEM.go));
  // It eases off, then makes a long glide in to park.
  const glide = Math.pow(x * x * (3 - 2 * x), 0.7);
  return { position: bezier(start, ahead, bendPoint, scene.dock, glide), glide };
}

function rocketAt(t: number, scene: EnterSystemScene): RocketFrame {
  const { position, glide } = rocketPath(t, scene);
  const step = 0.03;
  const heading = sub(rocketPath(t + step, scene).position, position);
  const pose = cameraAt(t, scene);
  // Seen three-quarters from behind, nose up as it climbs in; it turns to its heading as it pulls ahead.
  const { right, up, back } = cameraBasis(pose.position, pose.target);
  const sway = sub(followOffset(t + step), followOffset(t));
  const local: Vec3 = add([-0.3, 0.18, -1], scale(sway, 20 / SCALE_DOWN));
  const nose = normalize(add(add(scale(right, local[0]), scale(up, local[1])), scale(back, local[2])));
  const toHeading = length(heading) > 1e-6 ? normalize(heading) : nose;
  const direction = normalize(mix(nose, toHeading, smoothstep(0, 0.2, glide)));
  const parkedSwap = smoothstep(ENTER_SYSTEM.parked - 0.05, ENTER_SYSTEM.parked + 0.25, t);
  // Up to 2.5 times larger mid-flight so it stays readable, back to its true size when parked.
  const size = ROCKET_SIZE * (1 + 1.5 * Math.pow(Math.sin(Math.PI * glide), 0.8)) * (1 - parkedSwap);
  const heat =
    (1 - 0.7 * smoothstep(ENTER_SYSTEM.parked - 1, ENTER_SYSTEM.parked, t)) *
    smoothstep(ENTER_SYSTEM.rocketStart, ENTER_SYSTEM.rocketStart + 0.25, t);
  return { position, direction, size, heat, visible: t > ENTER_SYSTEM.rocketStart && parkedSwap < 1 };
}

export function chromeAt(t: number): EnterSystemChrome {
  const ring = clamp01(t / ENTER_SYSTEM.tapSeconds);
  return {
    overviewOpacity: 1 - smoothstep(0.05, 0.45, t),
    labelsOpacity: smoothstep(4.3, 4.9, t),
    back: rise(t, 4.35, 4.85, -8),
    title: rise(t, 4.5, 5.0, 10),
    bottom: rise(t, 4.6, 5.1, 10),
    tapRing: { opacity: t < ENTER_SYSTEM.tapSeconds ? 0.9 * (1 - ring) : 0, scale: 1 + 2.2 * easeOut(ring) },
  };
}

/** The whole frame at `t` seconds. `t` is clamped to the animation's length. */
export function enterSystemFrame(rawT: number, scene: EnterSystemScene): EnterSystemFrame {
  const t = Math.min(Math.max(rawT, 0), ENTER_SYSTEM.seconds);
  return {
    pose: cameraAt(t, scene),
    rocket: rocketAt(t, scene),
    parkedShip: smoothstep(ENTER_SYSTEM.parked - 0.05, ENTER_SYSTEM.parked + 0.25, t),
    chrome: chromeAt(t),
  };
}
