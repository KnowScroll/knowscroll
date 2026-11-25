/**
 * How the camera travels between two stops of the ladder, after the prototype (`Universe.dc.html`: `fly`, `grav`,
 * `chainFocus` and the camera block of `frame`; Grammar board line 85). Pure, and three-free: the controller reaches the
 * main bundle. Positions are read from the scene by the caller every frame and handed in, because planets orbit while
 * the camera flies.
 *
 * The camera is where it is because of two things: what it looks at (`focus`) and how far away it is (`distance`).
 * Distance changes exponentially, so on screen the place you go to grows at a steady rate and then faster as you near
 * it ("its gravity sucks us in"). A flight between two places neither of which holds the other first climbs to the
 * stop that holds both, crosses, and falls in.
 */
import { mix } from '../animation/vec3';
import { smootherstep } from '../animation/easing';
import { clamp, lerp } from '../space/paint';
import type { Vec3 } from '../space/camera-rig';

/** One stop of a place's chain: at this distance, the camera looks at this point. */
export interface ChainLink {
  readonly distance: number;
  readonly point: Vec3;
}

/**
 * A place's stops from the nearest outward (a planet: the planet, its star, the whole universe), with distances that
 * grow. Between two links the focus moves in a straight line as the distance does, so where the camera is depends only
 * on what you are in and how far out you are (the prototype's `chain` and `chainFocus`).
 */
export type Chain = readonly ChainLink[];

/** Where the camera looks at `distance` along `chain`. Nearer than the first link: its point. Farther than the last: its point. */
export function focusAlong(chain: Chain, distance: number): Vec3 {
  const first = chain[0]!;
  if (distance <= first.distance) return first.point;
  for (let index = 1; index < chain.length; index += 1) {
    const near = chain[index - 1]!;
    const far = chain[index]!;
    if (distance <= far.distance)
      return mix(near.point, far.point, (distance - near.distance) / (far.distance - near.distance));
  }
  return chain[chain.length - 1]!.point;
}

/* The shape of the prototype's `grav` curve (`Universe.dc.html` line 705). */
/** The share of the flight's time spent falling; the rest is the catch. */
const FALL_END = 0.86;
/** How far the fall has got when it ends, of the whole distance. */
const REACH = 0.93;
/** The fall's power curve: above 1, so it starts very gently and gathers speed. */
const FALL_EXPONENT = 2.2;
/** The share of the flight's time spent in the catch (what is left after {@link FALL_END}). */
const CATCH_SPAN = 0.14;
/** The distance the catch still has to cover, of the whole (what is left after {@link REACH}). */
const CATCH_DISTANCE = 0.07;
/** How far past its straight line the catch swings, of the whole distance. */
const OVERSHOOT = 0.07;
/** How much of the swing is taken off by the end of the catch, so it dies away as the flight lands. */
const OVERSHOOT_TAPER = 0.3;

/**
 * The fall toward a place: gentle at first, gathering speed, a little past and caught. Progress from 0 to 1 over `q`,
 * the share of the flight's time (clamped to 0..1).
 */
export function gravity(q: number): number {
  const x = clamp(q);
  if (x < FALL_END) return REACH * Math.pow(x / FALL_END, FALL_EXPONENT);
  const u = (x - FALL_END) / CATCH_SPAN;
  return REACH + CATCH_DISTANCE * u + OVERSHOOT * Math.sin(Math.PI * u) * (1 - OVERSHOOT_TAPER * u);
}

/** Leaving: a moment of being held, then away. The prototype's `1 - grav(1 - q)`. */
export const release = (q: number): number => 1 - gravity(1 - clamp(q));

/**
 * How a flight's progress runs over its time: `gravity` falling in a long way, `release` going out a long way,
 * `ease` (smootherstep, at rest at both ends) otherwise and over a climb.
 */
export type FlightCurve = 'gravity' | 'release' | 'ease';

/** A flight laid out at launch: where it goes, how long it takes and how it follows the chains. */
export interface FlightPlan {
  readonly fromDistance: number;
  readonly toDistance: number;
  /** How far the flight climbs above the straight line in log distance, so it passes through the stop holding both ends. 0: no climb. */
  readonly hump: number;
  readonly seconds: number;
  readonly curve: FlightCurve;
  /**
   * Which chain the focus follows: going in, the destination's; going out, the origin's; over a climb, the origin's up
   * to the top and the destination's after (at the top both chains are at the shared stop, so nothing jumps).
   */
  readonly follow: 'to' | 'from' | 'swap';
  /** Where the camera looked at launch, less where the followed chain says it should look: faded out by half way. */
  readonly offset: Vec3;
}

/** What {@link planFlight} needs to know about a flight. */
export interface FlightRequest {
  readonly fromDistance: number;
  readonly toDistance: number;
  /** The distance of the stop that holds both ends, when neither end holds the other; null when one does. */
  readonly peakDistance: number | null;
  /** Where the camera looks now. */
  readonly launchFocus: Vec3;
  readonly fromChain: Chain;
  readonly toChain: Chain;
  /** The flight starts or ends on the ground: a little longer, as the prototype has it. */
  readonly touchesGround: boolean;
  /** A step made by a pinch or a scroll: quicker, because the fingers already moved the camera part of the way. */
  readonly fast?: boolean;
}

/** The prototype's duration: `0.9 + 0.36 * span` seconds, where `span` is the log-distance travelled plus the climb both ways. */
const BASE_SECONDS = 0.9;
const SECONDS_PER_LOG_UNIT = 0.36;
/** The longest flights, seconds: with a climb, and without (the prototype's `peak ? 4.4 : 3.4`). */
const LONGEST = { climb: 4.4, straight: 3.4 } as const;
/** A flight to or from the ground lasts this much longer than it would. */
const GROUND_SLOWDOWN = 1.15;
/** A pinch or scroll step lasts this much of what it would, since the fingers already moved the camera. */
const PINCH_SPEEDUP = 0.6;
/** Going in to under this share of the distance falls with `gravity`; going out to over this multiple, with `release`. */
const LONG_WAY_IN = 0.5;
const LONG_WAY_OUT = 2;
/** The share of a climb's time after which the focus follows the destination's chain instead of the origin's. */
const SWAP_AT = 0.5;

/** Plans a flight. Under reduced motion the caller cuts to the destination instead of flying. */
export function planFlight(request: FlightRequest): FlightPlan {
  const { fromDistance, toDistance, peakDistance } = request;
  const logFrom = Math.log(fromDistance);
  const logTo = Math.log(toDistance);
  const hump = peakDistance === null ? 0 : Math.max(0, Math.log(peakDistance) - (logFrom + logTo) / 2);
  const span = Math.abs(logTo - logFrom) + 2 * hump;
  let seconds = Math.min(BASE_SECONDS + SECONDS_PER_LOG_UNIT * span, hump > 0 ? LONGEST.climb : LONGEST.straight);
  if (request.touchesGround) seconds *= GROUND_SLOWDOWN;
  if (request.fast === true) seconds *= PINCH_SPEEDUP;
  const curve: FlightCurve =
    hump > 0
      ? 'ease'
      : toDistance < LONG_WAY_IN * fromDistance
        ? 'gravity'
        : toDistance > LONG_WAY_OUT * fromDistance
          ? 'release'
          : 'ease';
  const follow = hump > 0 ? 'swap' : toDistance <= fromDistance ? 'to' : 'from';
  const reference = follow === 'to' ? request.toChain : request.fromChain;
  const along = focusAlong(reference, fromDistance);
  const offset: Vec3 = [
    request.launchFocus[0] - along[0],
    request.launchFocus[1] - along[1],
    request.launchFocus[2] - along[2],
  ];
  return { fromDistance, toDistance, hump, seconds, curve, follow, offset };
}

const progressOf = (curve: FlightCurve, q: number): number =>
  curve === 'gravity' ? gravity(q) : curve === 'release' ? release(q) : smootherstep(q);

/** The camera at one moment of a flight. */
export interface FlightFrame {
  /** Where the camera looks. */
  readonly focus: Vec3;
  /** How far the camera is from what it looks at. */
  readonly distance: number;
  /** Time through the flight, 0 to 1. */
  readonly q: number;
  readonly done: boolean;
}

/** Where the camera is `elapsed` seconds into `plan`, with the two ends' chains as they are now. */
export function flightAt(plan: FlightPlan, elapsed: number, fromChain: Chain, toChain: Chain): FlightFrame {
  const q = clamp(elapsed / plan.seconds);
  const e = progressOf(plan.curve, q);
  const distance = Math.exp(
    lerp(Math.log(plan.fromDistance), Math.log(plan.toDistance), e) + plan.hump * Math.sin(Math.PI * q),
  );
  const chain = plan.follow === 'to' || (plan.follow === 'swap' && q >= SWAP_AT) ? toChain : fromChain;
  const along = focusAlong(chain, distance);
  // The launch offset is gone by half way: `2 * q` reaches 1 there.
  const keep = 1 - smootherstep(2 * q);
  return {
    focus: [along[0] + plan.offset[0] * keep, along[1] + plan.offset[1] * keep, along[2] + plan.offset[2] * keep],
    distance,
    q,
    done: q >= 1,
  };
}

/** An angle wrapped into -PI..PI, so the difference of two headings or longitudes is the short way round. */
export const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
