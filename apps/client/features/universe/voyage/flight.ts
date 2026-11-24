import { clamp, lerp } from '../space/paint';
import type { Vec3 } from '../space/camera-rig';

/**
 * How the camera travels between two stops of the ladder, after the Round 7.3 prototype (`Universe.dc.html`, `fly` and
 * the camera block of `frame`; Grammar board line 85). Pure: positions are read from the scene by the caller every
 * frame and handed in, because planets orbit while the camera flies.
 *
 * The camera is where it is because of two things: what it looks at (`focus`) and how far away it is (`distance`).
 * Distance changes exponentially, so on screen the place you go to grows at a steady rate and then faster as you near
 * it ("its gravity sucks us in"). A flight between two places neither of which holds the other first climbs to the
 * stop that holds both, crosses, and falls in.
 */

/** One stop of a place's chain: at this distance, the camera looks at this point. */
export interface ChainLink {
  readonly distance: number;
  readonly point: Vec3;
}

/**
 * A place's stops from the nearest outward (a planet: the planet, its star, the whole universe), with distances that
 * grow. Between two links the focus moves in a straight line as the distance does, so where the camera is depends only
 * on what you are in and how far out you are.
 */
export type Chain = readonly ChainLink[];

const mix = (from: Vec3, to: Vec3, amount: number): Vec3 => [
  lerp(from[0], to[0], amount),
  lerp(from[1], to[1], amount),
  lerp(from[2], to[2], amount),
];

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

/** Smootherstep: starts and ends at rest. */
export const ease = (q: number): number => {
  const x = clamp(q);
  return x * x * x * (x * (6 * x - 15) + 10);
};

/**
 * The fall toward a place: gentle at first, gathering speed, a little past and caught. For the first 86% of the time
 * progress is `0.93·(q/0.86)^2.2`; the last 14% closes to 1 with a small overshoot (the prototype's `grav`).
 */
export function gravity(q: number): number {
  const x = clamp(q);
  if (x < 0.86) return 0.93 * Math.pow(x / 0.86, 2.2);
  const u = (x - 0.86) / 0.14;
  return 0.93 + 0.07 * u + 0.07 * Math.sin(Math.PI * u) * (1 - 0.3 * u);
}

/** Leaving: a moment of being held, then away. */
export const release = (q: number): number => 1 - gravity(1 - clamp(q));

export type FlightCurve = 'gravity' | 'release' | 'ease';

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

/** The longest flights, seconds: with a climb, and without. */
const LONGEST = { climb: 4.4, straight: 3.4 } as const;

/** Plans a flight. Under reduced motion the caller cuts to the destination instead of flying. */
export function planFlight(request: FlightRequest): FlightPlan {
  const { fromDistance, toDistance, peakDistance } = request;
  const logFrom = Math.log(fromDistance);
  const logTo = Math.log(toDistance);
  const hump = peakDistance === null ? 0 : Math.max(0, Math.log(peakDistance) - (logFrom + logTo) / 2);
  const span = Math.abs(logTo - logFrom) + 2 * hump;
  let seconds = Math.min(0.9 + 0.36 * span, hump > 0 ? LONGEST.climb : LONGEST.straight);
  if (request.touchesGround) seconds *= 1.15;
  if (request.fast === true) seconds *= 0.6;
  const curve: FlightCurve =
    hump > 0
      ? 'ease'
      : toDistance < 0.5 * fromDistance
        ? 'gravity'
        : toDistance > 2 * fromDistance
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
  curve === 'gravity' ? gravity(q) : curve === 'release' ? release(q) : ease(q);

export interface FlightFrame {
  readonly focus: Vec3;
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
  const chain = plan.follow === 'to' || (plan.follow === 'swap' && q >= 0.5) ? toChain : fromChain;
  const along = focusAlong(chain, distance);
  const keep = 1 - ease(clamp(2 * q));
  return {
    focus: [along[0] + plan.offset[0] * keep, along[1] + plan.offset[1] * keep, along[2] + plan.offset[2] * keep],
    distance,
    q,
    done: q >= 1,
  };
}
