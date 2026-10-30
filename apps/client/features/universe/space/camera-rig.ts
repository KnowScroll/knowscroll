import { clamp, lerp, smooth } from './paint';

/**
 * Where the camera of a Universe space view stands. Pure maths: no three.js, no clock, so the poses
 * are the same on the web and on Hermes and a test can read them. The levels of the design are not
 * separate scenes but distances of one camera: the Overview and Far are the whole universe nearer
 * and farther, a System is the camera close over one sun.
 */

export type Vec3 = readonly [number, number, number];

/** A camera pose. `fov` is the vertical field of view in degrees. */
export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
}

/** Vertical field of view of every space view (design: 38 degrees). */
export const FIELD_OF_VIEW = 38;
const TAN_HALF_FOV = Math.tan((FIELD_OF_VIEW / 2) * (Math.PI / 180));

/** What the camera looks at. */
export type RigFocus =
  | {
      readonly kind: 'universe';
      readonly center: { readonly x: number; readonly z: number };
      /** Half the width and depth of everything that should fit, in scene units. */
      readonly halfWidth: number;
      readonly halfDepth: number;
    }
  | {
      readonly kind: 'system';
      readonly systemId: string;
      readonly center: { readonly x: number; readonly z: number };
      /** Radius of the outermost orbit and what sits beside it. */
      readonly radius: number;
    };

/** The person's camera: pixels panned and a zoom, relative to the framing that shows the whole view. */
export interface RigFrame {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Everything the rig needs to place the camera. */
export interface RigSpec {
  readonly focus: RigFocus;
  readonly frame: RigFrame;
  /** Layout size of the canvas in pixels. */
  readonly width: number;
  readonly height: number;
}

/** Zoom limits, per kind of view. */
export const ZOOM_LIMITS = {
  universe: { min: 0.4, max: 2.5 },
  system: { min: 0.7, max: 2.2 },
} as const;

/** Farther than this the universe reads as the "Far" level (U08): suns and haze, a tap picks a system. */
export const FAR_DISTANCE = 68;
const ELEVATION = { universe: (26.6 * Math.PI) / 180, system: (33 * Math.PI) / 180 } as const;
const MIN_DISTANCE = { universe: 24, system: 16 } as const;
/** How far past the framed area a pan may carry the target, as a share of its radius. */
const PAN_REACH = 0.9;

/** Half width, half depth and the largest reach (what a pan may add) of what a focus must fit. */
function extentOf(focus: RigFocus): { halfWidth: number; halfDepth: number; reach: number } {
  if (focus.kind === 'system') return { halfWidth: focus.radius, halfDepth: focus.radius, reach: focus.radius };
  return { halfWidth: focus.halfWidth, halfDepth: focus.halfDepth, reach: Math.max(focus.halfWidth, focus.halfDepth) };
}

/**
 * The distance at which a ground area of the given half width and depth fits a canvas of `aspect`
 * (width / height). Depth is foreshortened by the camera's elevation, so a deep universe still fits a
 * tall phone screen from nearby.
 */
export function fitDistance(halfWidth: number, halfDepth: number, aspect: number, kind: RigFocus['kind']): number {
  const wide = (halfWidth * (kind === 'system' ? 0.72 : 1.0)) / (TAN_HALF_FOV * Math.max(aspect, 0.1));
  const tall = (halfDepth * Math.sin(ELEVATION[kind]) + halfWidth * 0.15 + 0.8) / (TAN_HALF_FOV * 0.9);
  return Math.max(wide, tall, MIN_DISTANCE[kind]);
}

/** The pose a spec asks for, before the slow breathing drift. */
export function rigPose(spec: RigSpec): CameraPose {
  const { focus, frame, width, height } = spec;
  const kind = focus.kind;
  const limits = ZOOM_LIMITS[kind];
  const zoom = clamp(frame.scale, limits.min, limits.max);
  const { halfWidth, halfDepth, reach: extent } = extentOf(focus);
  const distance = fitDistance(halfWidth, halfDepth, width / Math.max(height, 1), kind) / zoom;
  const unitsPerPixel = (2 * distance * TAN_HALF_FOV) / Math.max(height, 1);
  const reach = extent * PAN_REACH;
  const elevation = ELEVATION[kind];
  const x = focus.center.x + clamp(frame.x * unitsPerPixel, -reach, reach);
  const z = focus.center.z + extent * 0.06 + clamp((frame.y * unitsPerPixel) / Math.sin(elevation), -reach, reach);
  return {
    target: [x, 0, z],
    position: [x, Math.sin(elevation) * distance, z + Math.cos(elevation) * distance],
    fov: FIELD_OF_VIEW,
  };
}

/** Distance from the camera to what it looks at. */
export function distanceOf(pose: CameraPose): number {
  return Math.hypot(
    pose.position[0] - pose.target[0],
    pose.position[1] - pose.target[1],
    pose.position[2] - pose.target[2],
  );
}

/** Whether the universe is far enough away to read as the Far level. */
export const isFar = (pose: CameraPose): boolean => distanceOf(pose) > FAR_DISTANCE;

/** The camera breathes: a slow wander of its position, a pure function of the scene time. */
export function withDrift(pose: CameraPose, t: number): CameraPose {
  const amount = distanceOf(pose) / 50;
  const [x, y, z] = pose.position;
  return {
    ...pose,
    position: [
      x + Math.sin(t * 0.11) * 0.6 * amount,
      y + Math.sin(t * 0.07) * 0.4 * amount,
      z + Math.sin(t * 0.05) * 0.5 * amount,
    ],
  };
}

const mix = (from: Vec3, to: Vec3, amount: number): Vec3 => [
  lerp(from[0], to[0], amount),
  lerp(from[1], to[1], amount),
  lerp(from[2], to[2], amount),
];

/** How long a fly into a system takes (design: tap system = 2.4 s), and how long a step back up takes (D-093). */
export const FLY_SECONDS = { down: 2.4, up: 0.3 } as const;

/**
 * The pose part-way through a fly from `from` to `to`, `elapsed` seconds in. The field of view widens
 * a little in the middle of the way, as the design's fly-in does. A fly is a pure function of time.
 */
export function flyPose(from: CameraPose, to: CameraPose, elapsed: number, seconds: number): CameraPose {
  const progress = smooth(0, 1, elapsed / seconds);
  return {
    position: mix(from.position, to.position, progress),
    target: mix(from.target, to.target, progress),
    fov: lerp(from.fov, to.fov, progress) + Math.sin(progress * Math.PI) * 9,
  };
}

/** Whether a fly has arrived. */
export const flyDone = (elapsed: number, seconds: number): boolean => elapsed >= seconds;
