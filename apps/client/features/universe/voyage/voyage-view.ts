/**
 * Which way the trial's camera looks and where it stands, once the flight (`flight.ts`) has said what it looks at and
 * from how far: down at a star or the whole universe from 30 degrees, turning toward a planet's day side as it comes in,
 * leaning with the ship, and holding its subject above the middle of the view. Part of the driver: three.js reaches it
 * only through `voyage-loader.ts`.
 */
import * as THREE from 'three';
import { FIELD_OF_VIEW, type CameraPose, type Vec3 } from '../space/camera-rig';
import { smooth } from '../space/paint';
import type { Chain } from './flight';
import { STOPS, type Stop } from './ladder';
import { GROUND_FIELD_OF_VIEW } from './voyage-chains';

/** How the turn a finger gives (points) becomes an angle round a star or the whole universe. */
const TURN_RADIANS_PER_POINT = 0.004;
/** How far above the plane of the star's planets the camera looks down at a star or the whole universe. */
const VIEW_ELEVATION = (30 * Math.PI) / 180;
/** From a planet the camera stands this far round from the line to its sun (radians). */
const DAY_SIDE_TURN = 0.6;
/** From a planet the camera stands this far above the plane of its star's planets (radians). */
const DAY_SIDE_LIFT = 0.32;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** A three.js point as the plain triple the rig and the flight work in. */
export const vec = (point: THREE.Vector3): Vec3 => [point.x, point.y, point.z];

/** Turns the drag into a direction round a star or the whole universe: the camera looks down at 30 degrees. */
export function orbitDirection(turnX: number, out: THREE.Vector3): THREE.Vector3 {
  const azimuth = turnX * TURN_RADIANS_PER_POINT;
  return out.set(
    Math.sin(azimuth) * Math.cos(VIEW_ELEVATION),
    Math.sin(VIEW_ELEVATION),
    Math.cos(azimuth) * Math.cos(VIEW_ELEVATION),
  );
}

const lift = new THREE.Vector3();
/** From a planet, the camera stands a little round from its sun, so its day side and its terminator both show. */
export function planetDirection(planet: THREE.Vector3, sun: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const away = out.set(sun.x - planet.x, 0, sun.z - planet.z);
  if (away.lengthSq() < 1e-9) away.set(0, 0, 1);
  away.normalize().applyAxisAngle(Y_AXIS, DAY_SIDE_TURN);
  return away
    .multiplyScalar(Math.cos(DAY_SIDE_LIFT))
    .add(lift.set(0, Math.sin(DAY_SIDE_LIFT), 0))
    .normalize();
}

/** What the camera's direction depends on this frame. */
export interface ViewInput {
  /** The stop the camera is going to, and the turn a finger gave (used at a star and the whole universe). */
  readonly stop: Stop;
  readonly turnX: number;
  /**
   * The planet the target is at or a flight is leaving, its star's sun, and the chain that holds that planet: its first
   * link is the planet's and its second the star's, whatever links follow.
   */
  readonly planet: THREE.Vector3 | undefined;
  readonly sun: THREE.Vector3 | undefined;
  readonly planetChain: Chain | null;
  /** How far the camera stands from what it looks at now. */
  readonly distance: number;
}

const toPlanet = new THREE.Vector3();
/**
 * Which way the camera looks from what it holds (pointing from it toward the camera). It turns from looking down at a
 * star toward the day side of the planet by its distance along the planet's chain, so the bearing eases both ways:
 * flying in, and flying out of a planet (where the chain is the one being left).
 */
export function viewDirection(input: ViewInput, out: THREE.Vector3): THREE.Vector3 {
  const direction = orbitDirection(input.stop === 'star' || input.stop === 'universe' ? input.turnX : 0, out);
  const chain = input.planetChain;
  if (input.planet === undefined || input.sun === undefined || chain === null) return direction;
  const towardPlanet = smooth(
    0,
    1,
    (Math.log(chain[1]!.distance) - Math.log(input.distance)) /
      (Math.log(chain[1]!.distance) - Math.log(chain[0]!.distance)),
  );
  return direction.lerp(planetDirection(input.planet, input.sun, toPlanet), towardPlanet).normalize();
}

/**
 * How far below the middle the camera aims, in layout points, so the subject sits at its stop's height. In flight the
 * height moves from the stop left to the stop ahead with the flight, so the view never jumps when a flight starts.
 */
export function heldOffset(leaving: Stop | null, going: Stop, q: number, height: number): number {
  const heldAt =
    leaving === null
      ? STOPS[going].heldAt
      : THREE.MathUtils.lerp(STOPS[leaving].heldAt, STOPS[going].heldAt, smooth(0, 1, q));
  return (0.5 - heldAt) * height;
}

/**
 * The camera's field of view at `distance` from a planet whose chain is `planetChain`: the sky's above the planet's
 * stop, the ground's (`groundDistance` away) below it, and in between by the distance's logarithm, as a flight moves.
 */
export function fieldOfView(planetChain: Chain | null, groundDistance: number | null, distance: number): number {
  if (planetChain === null || groundDistance === null) return FIELD_OF_VIEW;
  const orbit = planetChain[0]!.distance;
  const down = smooth(0, 1, (Math.log(orbit) - Math.log(distance)) / (Math.log(orbit) - Math.log(groundDistance)));
  return THREE.MathUtils.lerp(FIELD_OF_VIEW, GROUND_FIELD_OF_VIEW, down);
}

/** Where the camera stands and what it aims at. */
export interface Placement {
  /** What the camera looks at (a point of the flight's chain), and from how far along `direction`. */
  readonly focus: Vec3;
  readonly direction: THREE.Vector3;
  readonly distance: number;
  /** How far the view leans with the ship, and how far below the middle it aims ({@link heldOffset}), in points. */
  readonly lean: { readonly x: number; readonly y: number };
  readonly held: number;
  /** The camera's field of view (degrees) and its focal length in layout points. */
  readonly fov: number;
  readonly focal: number;
}

const up = new THREE.Vector3();
const right = new THREE.Vector3();
const aim = new THREE.Vector3();
/**
 * The camera's pose, and its position in `position`. The lean moves the view sideways in its own plane, so near
 * things slide past faster than far ones.
 */
export function placeCamera(placement: Placement, position: THREE.Vector3): CameraPose {
  const { direction, distance } = placement;
  up.set(0, 1, 0).addScaledVector(direction, -direction.y).normalize();
  right.crossVectors(up, direction).normalize();
  const leanUnits = distance / placement.focal;
  aim
    .set(...placement.focus)
    .addScaledVector(right, placement.lean.x * leanUnits)
    .addScaledVector(up, -(placement.lean.y + placement.held) * leanUnits);
  position.copy(aim).addScaledVector(direction, distance);
  return { position: vec(position), target: vec(aim), fov: placement.fov };
}
