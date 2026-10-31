import { AXIAL_TILT_DEGREES, physicsAtTilt, stageParts, stagePhysics, type StagePart, type StageState } from '../model';

/**
 * The drawing parameters of the "Earth & sky" kit (D-133): what the picture needs to place its parts,
 * worked out from the derived kit state and nothing else. The physics is `stagePhysics`'s: which
 * half leans toward the Sun, how high the Sun stands for each half and how warm its pin is. This file
 * only turns those answers into positions and angles; it never decides them, so a picture cannot
 * disagree with the text version of the same state.
 */

export type StageView = StageState['view'];

/** The picture's coordinate frame: every view is laid out inside 320 × 200. */
export const SCENE_WIDTH = 320;
export const SCENE_HEIGHT = 200;

/** The angle of each month on the orbit seen from above, in degrees, 0 = right, anticlockwise: June right, September top, December left, March bottom. */
export const MONTH_ANGLE_DEGREES: Readonly<Record<StageState['earthAt'], number>> = {
  jan: -150,
  feb: -120,
  mar: -90,
  apr: -60,
  may: -30,
  jun: 0,
  jul: 30,
  aug: 60,
  sep: 90,
  oct: 120,
  nov: 150,
  dec: 180,
};

/** The four moments the orbit views show as pale Earths, so that the one same lean can be seen in all of them. */
export const CARDINAL_MONTHS = ['dec', 'mar', 'jun', 'sep'] as const satisfies readonly StageState['earthAt'][];

/**
 * How far from the point of the surface that faces the Sun a hemisphere's pin sits, by how high the
 * Sun stands there. The beam lands steeply near that point and at a low angle far from it, which is
 * what the picture shows, so the angle of Ray follows from where the pin is.
 */
const PIN_DISTANCE_FROM_SUN_POINT_DEGREES: Readonly<Record<'high' | 'middle' | 'low', number>> = {
  high: 22,
  middle: 50,
  low: 76,
};

/** 0 = cool, 1 = warm: a pin's mark as a number, so a tween can blend two marks. */
const WARMTH: Readonly<Record<'warm' | 'neutral' | 'cool', number>> = { warm: 1, neutral: 0.5, cool: 0 };

/**
 * A pin's warmth for a distance from the point facing the Sun that the reader chose by turning the
 * axis, on the same scale as the table above: the high-Sun distance is fully warm, the low-Sun one fully cool.
 */
function warmthAtDistance(distance: number): number {
  const high = PIN_DISTANCE_FROM_SUN_POINT_DEGREES.high;
  const low = PIN_DISTANCE_FROM_SUN_POINT_DEGREES.low;
  return Math.min(1, Math.max(0, 1 - (distance - high) / (low - high)));
}

/** A to-scale orbit is nearly a circle; the stretched one is drawn flatter, with the Sun off-centre. */
const ORBIT_SHAPE: Readonly<Record<'orbit' | 'orbit-stretched', { ratio: number; sunOffset: number }>> = {
  orbit: { ratio: 0.94, sunOffset: 0 },
  'orbit-stretched': { ratio: 0.62, sunOffset: 0.42 },
};

export interface EarthSkyScene {
  readonly view: StageView;
  readonly parts: readonly StagePart[];
  /** Earth's place on the orbit, degrees. */
  readonly earthAngle: number;
  /** How flat the orbit is drawn (height / width). */
  readonly orbitRatio: number;
  /** How far the Sun sits from the orbit's centre toward the nearest point, as a share of the orbit's half-width. */
  readonly sunOffset: number;
  /** The drawn turn of the axis from straight up, degrees, clockwise positive. */
  readonly axisTurn: number;
  /** Angular distance of each hemisphere's pin from the point of the surface facing the Sun, degrees. */
  readonly northPinAway: number;
  readonly southPinAway: number;
  readonly northWarmth: number;
  readonly southWarmth: number;
  /** The Moon's place on its orbit, degrees, and whether it is drawn with its phase. */
  readonly moonAngle: number;
  readonly moonPhased: boolean;
  readonly focus: StageState['focus'];
}

/** Where the Moon is in each phase, seen from above with the Sun at the left: new beside the Sun, full away from it. */
const MOON_ANGLE: Readonly<Record<StageState['moonAt'], number>> = {
  off: 50,
  new: 180,
  'first-quarter': 270,
  full: 0,
  'last-quarter': 90,
};

/**
 * The axis is drawn leaning toward the Sun when the north does, away from it when the south does, and
 * upright when neither half leans (a lean toward or away from the viewer cannot be drawn flat). In the
 * orbit views it leans the same way in every month, which is the point of the picture.
 */
function axisTurnOf(view: StageView, leansToward: 'north' | 'south' | 'neither', tilt: number): number {
  if (view === 'orbit' || view === 'orbit-stretched') return -tilt;
  if (leansToward === 'north') return -tilt;
  if (leansToward === 'south') return tilt;
  return 0;
}

/**
 * The scene of a settled stage state. With a `tiltDegrees` other than today's the reader has turned
 * the axis at the Final call (D-187): the axis, the pins and Ray are worked out for that tilt by
 * `physicsAtTilt`, the same physics as the text version, and nothing else changes.
 */
export function sceneOf(state: StageState, tiltDegrees: number = AXIAL_TILT_DEGREES): EarthSkyScene {
  const turned = tiltDegrees !== AXIAL_TILT_DEGREES;
  const physics = turned ? physicsAtTilt(state, tiltDegrees) : stagePhysics(state);
  const orbit =
    state.view === 'orbit' || state.view === 'orbit-stretched' ? ORBIT_SHAPE[state.view] : ORBIT_SHAPE.orbit;
  const pins =
    turned && 'northDistance' in physics
      ? {
          northPinAway: physics.northDistance,
          southPinAway: physics.southDistance,
          northWarmth: warmthAtDistance(physics.northDistance),
          southWarmth: warmthAtDistance(physics.southDistance),
        }
      : {
          northPinAway: PIN_DISTANCE_FROM_SUN_POINT_DEGREES[physics.north.sunHeight],
          southPinAway: PIN_DISTANCE_FROM_SUN_POINT_DEGREES[physics.south.sunHeight],
          northWarmth: WARMTH[physics.north.pin],
          southWarmth: WARMTH[physics.south.pin],
        };
  return {
    view: state.view,
    parts: stageParts(state.view),
    earthAngle: MONTH_ANGLE_DEGREES[state.earthAt],
    orbitRatio: orbit.ratio,
    sunOffset: orbit.sunOffset,
    axisTurn: axisTurnOf(state.view, physics.leansToward, tiltDegrees),
    ...pins,
    moonAngle: MOON_ANGLE[state.moonAt],
    moonPhased: state.moonAt !== 'off',
    focus: state.focus,
  };
}

/** Whether a move between two scenes is drawn as one picture changing (a tween) or as one replacing another. */
export function canTween(from: EarthSkyScene, to: EarthSkyScene): boolean {
  const orbit = (view: StageView): boolean => view === 'orbit' || view === 'orbit-stretched';
  return from.view === to.view || (orbit(from.view) && orbit(to.view));
}

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/** The shortest way round between two angles, so Earth never travels the long way round the orbit. */
function lerpAngle(from: number, to: number, t: number): number {
  const difference = ((((to - from) % 360) + 540) % 360) - 180;
  return from + difference * t;
}

/** The scene `t` of the way (0..1) from one scene to another; the discrete parts switch at the middle. */
export function lerpScene(from: EarthSkyScene, to: EarthSkyScene, t: number): EarthSkyScene {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const late = t >= 0.5 ? to : from;
  return {
    ...late,
    earthAngle: lerpAngle(from.earthAngle, to.earthAngle, t),
    orbitRatio: lerp(from.orbitRatio, to.orbitRatio, t),
    sunOffset: lerp(from.sunOffset, to.sunOffset, t),
    axisTurn: lerp(from.axisTurn, to.axisTurn, t),
    northPinAway: lerp(from.northPinAway, to.northPinAway, t),
    southPinAway: lerp(from.southPinAway, to.southPinAway, t),
    northWarmth: lerp(from.northWarmth, to.northWarmth, t),
    southWarmth: lerp(from.southWarmth, to.southWarmth, t),
    moonAngle: lerpAngle(from.moonAngle, to.moonAngle, t),
  };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** A point on a circle at an angle measured anticlockwise from the right, with y pointing down the screen. */
export function onCircle(centre: Point, radius: number, degrees: number): Point {
  return { x: centre.x + radius * Math.cos(radians(degrees)), y: centre.y - radius * Math.sin(radians(degrees)) };
}

/** A point on an ellipse, same convention. */
export function onEllipse(centre: Point, halfWidth: number, halfHeight: number, degrees: number): Point {
  return {
    x: centre.x + halfWidth * Math.cos(radians(degrees)),
    y: centre.y - halfHeight * Math.sin(radians(degrees)),
  };
}

/** The unit vector of the axis, pointing north, for a drawn turn (clockwise positive from straight up). */
export function axisDirection(turnDegrees: number): Point {
  return { x: Math.sin(radians(turnDegrees)), y: -Math.cos(radians(turnDegrees)) };
}

/**
 * The pin of a hemisphere: on the face toward the Sun at its distance from the point that faces the
 * Sun exactly, above that point for the north and below it for the south. The Sun is at the left.
 */
export function pinPoint(centre: Point, radius: number, hemisphere: 'north' | 'south', awayDegrees: number): Point {
  const up = hemisphere === 'north' ? 1 : -1;
  return onCircle(centre, radius, 180 - up * awayDegrees);
}

/** How wide a beam of sunlight is in the picture; the patch it covers on the ground grows as the beam lands lower. */
export const BEAM_WIDTH = 14;

/** The two points where a horizontal beam of the given width, centred on a pin's height, meets the lit face. */
export function beamFootprint(centre: Point, radius: number, pin: Point): { top: Point; bottom: Point } {
  const edge = (y: number): Point => {
    const clamped = Math.max(-radius + 0.5, Math.min(radius - 0.5, y - centre.y));
    return { x: centre.x - Math.sqrt(radius * radius - clamped * clamped), y: centre.y + clamped };
  };
  return { top: edge(pin.y - BEAM_WIDTH / 2), bottom: edge(pin.y + BEAM_WIDTH / 2) };
}

/** The distance along the surface between the two footprint points: a low beam covers more ground. */
export function footprintLength(footprint: { top: Point; bottom: Point }): number {
  return Math.hypot(footprint.top.x - footprint.bottom.x, footprint.top.y - footprint.bottom.y);
}
