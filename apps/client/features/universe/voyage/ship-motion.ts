/**
 * The motion of the Universe's rocket: a ship the person can drag, that glides home when let go, bends toward a place
 * it could catch, and hides while the view flies. Its numbers are the prototype's ship block (`Universe.dc.html`, the
 * `frame` function, lines 1886-1929, and the pointer handlers from line 2037); each constant below names the one it
 * copies.
 *
 * Pure, and three-free (the controller reaches the main bundle): screen coordinates in layout points, no React and no
 * clock. The caller owns the frame loop and passes `dt` in seconds. Every function returns a new value and never
 * mutates its arguments, so the same inputs always give the same ship.
 */
import { smootherstep } from '../animation/easing';
import { wrapAngle } from './flight';
import { onLettingGo, PLACE_PULL, pullGoal, type Pull } from './ship-gravity';

/** A place on screen, in layout points, y down. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A place the ship could be let go over, and what to call it when it is. */
export interface ShipTarget extends Point {
  readonly id: string;
  /** How it pulls the ship (`ship-gravity.ts`); a place given none pulls as the prototype's places all do. */
  readonly pull?: Pull;
}

/** Where the ship parks when nothing holds it. */
export interface ShipHome extends Point {
  /** Size in points when parked. */
  readonly size: number;
  /** Radians, 0 = nose up. */
  readonly heading: number;
}

/** The part of the screen the ship may be in, in layout points. */
export interface ShipBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Everything about the ship that carries from one frame to the next. */
export interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Radians, 0 = nose up. */
  readonly heading: number;
  /** Flame strength, 0..1. */
  readonly flame: number;
  /** Size in points. */
  readonly size: number;
  /** How present the ship is, 0 (hidden during a flight or pinch) to 1. */
  readonly vis: number;
  /** Held now, or let go in empty sky: it stays where it is until recentred, and the view leans with it (the prototype's `loose`). */
  readonly free: boolean;
  /** How far the view is leaned, in points. */
  readonly lean: Point;
  /** Id of the target it is bending toward, or null. */
  readonly candidate: string | null;
  /** How hard the candidate pulls, 0 (the edge of its reach) to 1 (the finger on it): for the look of the pull. */
  readonly pullStrength: number;
  /** Id of the place a ship let go near it is being drawn into, or null. */
  readonly falling: string | null;
}

/** What the screen tells the ship each frame. */
export interface ShipInput {
  readonly home: ShipHome;
  /** Finger position while the ship is held, else null. */
  readonly drag: Point | null;
  /** Places the ship could catch. */
  readonly targets: readonly ShipTarget[];
  /** True during a flight or a pinch: the ship hides. */
  readonly away: boolean;
  readonly bounds: ShipBounds;
  /** Snap into place: no springs, no lean, no fade. */
  readonly reducedMotion: boolean;
  /** The point the view leans away from: the lean follows the ship's offset from it. */
  readonly viewCentre: Point;
  /** The most the view may lean, in points. */
  readonly leanLimit: number;
}

/** The ship as it is painted: `vis` already turned into a lift, a growth and a fade. */
export interface DrawnShip {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly heading: number;
  readonly flame: number;
  readonly alpha: number;
  /**
   * Where the place the held ship bends toward is on screen, if any: it lights up, so the person sees what letting go
   * would do (the prototype's `PICK` glow).
   */
  readonly catchAt?: Point | null;
  /** How hard that place pulls, 0..1 (0 when nothing does). */
  readonly pullStrength?: number;
}

/** What letting go of the ship does. */
export interface ShipRelease {
  readonly state: ShipState;
  /** The target to fly to, or null when the ship stays free where it is. */
  readonly goTo: string | null;
}

/** The longest step one call advances, in seconds: a stalled frame does not throw the ship across the screen. */
const MAX_STEP_SECONDS = 0.1;
/**
 * The longest single step of the springs, in seconds: a frame is cut into steps no longer than this, so the ship moves
 * the same at 30, 60 or 120 frames a second.
 */
const MAX_SUBSTEP_SECONDS = 1 / 120;
/** A finger this close to the drawn ship takes it: the prototype's hit radius for the ship, `r: 26` (line 1924). */
const PICK_RADIUS = 26;
/**
 * The ship must be more present than this to be taken. The prototype adds the hit area at `e > 0.6` (line 1924) with `e`
 * the eased presence; this tests `vis` itself.
 */
const PICK_MIN_VIS = 0.6;
/** The size, in points, of a ship in the hand: `ship.sz` eases to 34 (line 1918). */
const HELD_SIZE = 34;

/** Spring that follows the finger: stiffness `k` and damping ratio `zeta` of `v += (k (to - at) - 2 zeta sqrt(k) v) dt` (line 1905). */
const FOLLOW_STIFFNESS = 34;
const FOLLOW_DAMPING_RATIO = 0.75;
/** Spring that glides the ship home, same form (line 1908). */
const HOME_STIFFNESS = 70;
const HOME_DAMPING_RATIO = 0.9;
/** The spring that draws a ship let go near a body into it: softer than the finger's, so it is seen to fall in. */
const FALL_STIFFNESS = 26;
const FALL_DAMPING_RATIO = 0.8;
/** Slower than this, in points per second, the ship stops turning its nose toward where it goes (line 1916). */
const TURN_SPEED = 22;
/** How fast the heading catches up while moving and while resting, per second (line 1917). */
const FAST_TURN_RATE = 8;
const SLOW_TURN_RATE = 3.5;
/** How fast the size eases to its target, per second (line 1918). */
const SIZE_RATE = 6;
/** The speed, in points per second, at which the flame is full (line 1919). */
const FLAME_FULL_SPEED = 240;
/** The least flame a ship in the hand has (line 1919). */
const HELD_FLAME = 0.16;
/** The flame of a ship that is hiding, in proportion to how far gone it is (line 1919). */
const LEAVE_FLAME = 0.9;
/** How much of the ship's offset from the view centre the view leans by (line 1912). */
const LEAN_GAIN = 0.5;
/** How fast the lean follows its target, per second (line 1913). */
const LEAN_RATE = 3.2;
/** What is left of the lean after one second once the ship is back home: `look *= 0.02 ^ dt` (line 1915). */
const LEAN_DECAY = 0.02;
/** A lean smaller than this, in points, is dropped to nothing (line 1915). */
const LEAN_REST = 0.4;
/** How fast a ship let go in empty sky slows, per second: `v *= exp(-2.4 dt)` (line 1906). */
const FREE_DRAG_RATE = 2.4;
/** How fast `vis` falls toward 0 when the ship hides, and rises toward 1 when it returns, per second (line 1899). */
const VIS_LEAVE_RATE = 10;
const VIS_ARRIVE_RATE = 3.2;
/** How far a hiding ship rises, in points, and how much it grows, as a share of its size (line 1921). */
const HIDDEN_RISE = 46;
const HIDDEN_GROWTH = 0.45;
/** A ship this hidden does not glide home: it is put there (line 1906). */
const HIDDEN_SNAP_VIS = 0.05;
/** The offsets along x from the anchor to try, in order, when something tappable is under the ship (line 1892). */
const PARKING_OFFSETS: readonly number[] = [0, 64, -64, 112, -112];
/** A parked ship keeps at least this far, in points, from anything tappable, or the thing's radius plus the margin (line 1892). */
const PARKING_MIN_CLEARANCE = 40;
const PARKING_MARGIN = 18;

/**
 * Not `space/paint`'s `clamp`: for a range turned the wrong way round (`low > high`, a very small screen) and for
 * -0 it gives another answer, and the ship has always used this order.
 */
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Spring gains `k` and `c` for a stiffness and a damping ratio: `c = 2 * ratio * sqrt(k)`. */
const springCoefficients = (stiffness: number, ratio: number): { k: number; c: number } => ({
  k: stiffness,
  c: 2 * ratio * Math.sqrt(stiffness),
});
const FOLLOW = springCoefficients(FOLLOW_STIFFNESS, FOLLOW_DAMPING_RATIO);
const HOME = springCoefficients(HOME_STIFFNESS, HOME_DAMPING_RATIO);
const FALL = springCoefficients(FALL_STIFFNESS, FALL_DAMPING_RATIO);

const pullOfTarget = (target: ShipTarget): Pull => target.pull ?? PLACE_PULL;
const placesOf = (targets: readonly ShipTarget[]) =>
  targets.map((target) => ({ id: target.id, x: target.x, y: target.y, pull: pullOfTarget(target) }));

/** A ship parked at `home`, fully present and not held. */
export function initialShip(home: ShipHome): ShipState {
  return {
    x: home.x,
    y: home.y,
    vx: 0,
    vy: 0,
    heading: home.heading,
    flame: 0,
    size: home.size,
    vis: 1,
    free: false,
    lean: { x: 0, y: 0 },
    candidate: null,
    pullStrength: 0,
    falling: null,
  };
}

interface Velocity {
  readonly vx: number;
  readonly vy: number;
}

/** The velocity after one step of a damped spring pulling `from` toward `to`. */
function spring(from: Point, velocity: Velocity, to: Point, gains: { k: number; c: number }, dt: number): Velocity {
  return {
    vx: velocity.vx + (gains.k * (to.x - from.x) - gains.c * velocity.vx) * dt,
    vy: velocity.vy + (gains.k * (to.y - from.y) - gains.c * velocity.vy) * dt,
  };
}

/** Where the view should lean for a ship at `at`: {@link LEAN_GAIN} of the way from the centre, capped. */
function leanTarget(at: Point, input: ShipInput): Point {
  const x = (at.x - input.viewCentre.x) * LEAN_GAIN;
  const y = (at.y - input.viewCentre.y) * LEAN_GAIN;
  const length = Math.hypot(x, y);
  if (length <= input.leanLimit || length === 0) return { x, y };
  const scale = input.leanLimit / length;
  return { x: x * scale, y: y * scale };
}

/**
 * Advances the ship by `dt` seconds (at most {@link MAX_STEP_SECONDS}; no time at all returns `state` itself), in
 * steps of at most {@link MAX_SUBSTEP_SECONDS}. While held it follows the finger on a soft spring, its goal bent toward
 * the places that pull it (`ship-gravity.ts`); let go near a body it is drawn in; at rest it glides home; let go in
 * empty sky it drifts to a stop and stays. The view leans with a free ship and the ship is carried back by the lean
 * step, so it does not slide on screen. Reduced motion snaps and does not lean.
 */
export function stepShip(state: ShipState, input: ShipInput, dtSeconds: number): ShipState {
  const dt = clamp(dtSeconds, 0, MAX_STEP_SECONDS);
  if (dt === 0) return state;
  if (input.reducedMotion) return stepOnce(state, input, dt);
  const steps = Math.ceil(dt / MAX_SUBSTEP_SECONDS - 1e-9);
  const places = input.drag === null ? null : placesOf(input.targets);
  let ship = state;
  for (let step = 0; step < steps; step += 1) ship = stepOnce(ship, input, dt / steps, places);
  return ship;
}

/** One step of {@link stepShip}, short enough for the springs. */
function stepOnce(
  state: ShipState,
  input: ShipInput,
  dt: number,
  places: ReturnType<typeof placesOf> | null = input.drag === null ? null : placesOf(input.targets),
): ShipState {
  const held = input.drag !== null;
  const snap = input.reducedMotion;
  const fallingTo =
    held || state.falling === null ? undefined : input.targets.find((target) => target.id === state.falling);
  // The place a ship falls into can leave the screen (the view turned away): then it stays free where it is.
  const falling = fallingTo === undefined ? null : state.falling;
  const free = state.free || held || falling !== null;

  const vis = snap
    ? input.away
      ? 0
      : 1
    : state.vis +
      ((input.away ? 0 : 1) - state.vis) * Math.min(1, dt * (input.away ? VIS_LEAVE_RATE : VIS_ARRIVE_RATE));

  let candidate: string | null = falling;
  let pullStrength = 0;
  let velocity: Velocity = { vx: state.vx, vy: state.vy };
  let x = state.x;
  let y = state.y;
  if (input.drag !== null) {
    const pulled = pullGoal(input.drag, places ?? [], state.candidate);
    candidate = pulled.candidate;
    pullStrength = pulled.strength;
    if (snap) {
      x = pulled.x;
      y = pulled.y;
      velocity = { vx: 0, vy: 0 };
    } else {
      velocity = spring(state, velocity, pulled, FOLLOW, dt);
    }
  } else if (fallingTo !== undefined) {
    pullStrength = state.pullStrength;
    velocity = spring(state, velocity, fallingTo, FALL, dt);
  } else if (free) {
    const decay = Math.exp(-FREE_DRAG_RATE * dt);
    velocity = { vx: velocity.vx * decay, vy: velocity.vy * decay };
  } else if (snap || vis < HIDDEN_SNAP_VIS) {
    x = input.home.x;
    y = input.home.y;
    velocity = { vx: 0, vy: 0 };
  } else {
    velocity = spring(state, velocity, input.home, HOME, dt);
  }
  x += velocity.vx * dt;
  y += velocity.vy * dt;

  let lean = state.lean;
  if (free && !snap) {
    const target = leanTarget({ x, y }, input);
    const rate = Math.min(1, dt * LEAN_RATE);
    const stepX = (target.x - lean.x) * rate;
    const stepY = (target.y - lean.y) * rate;
    lean = { x: lean.x + stepX, y: lean.y + stepY };
    x -= stepX;
    y -= stepY;
  } else if (lean.x !== 0 || lean.y !== 0) {
    const decay = snap ? 0 : Math.pow(LEAN_DECAY, dt);
    lean = { x: lean.x * decay, y: lean.y * decay };
    if (Math.hypot(lean.x, lean.y) < LEAN_REST) lean = { x: 0, y: 0 };
  }
  x = clamp(x, input.bounds.left, input.bounds.right);
  y = clamp(y, input.bounds.top, input.bounds.bottom);

  const speed = Math.hypot(velocity.vx, velocity.vy);
  const moving = speed > TURN_SPEED;
  const wanted = moving ? Math.atan2(velocity.vy, velocity.vx) + Math.PI / 2 : free ? 0 : input.home.heading;
  const turn = wrapAngle(wanted - state.heading);
  const heading =
    snap && !moving ? wanted : state.heading + turn * Math.min(1, dt * (moving ? FAST_TURN_RATE : SLOW_TURN_RATE));

  const targetSize = free ? HELD_SIZE : input.home.size;
  const size = snap ? targetSize : state.size + (targetSize - state.size) * Math.min(1, dt * SIZE_RATE);
  const presence = smootherstep(clamp(vis, 0, 1));
  const flame = Math.max(clamp(speed / FLAME_FULL_SPEED, 0, 1), (1 - presence) * LEAVE_FLAME, free ? HELD_FLAME : 0);

  return {
    x,
    y,
    vx: velocity.vx,
    vy: velocity.vy,
    heading,
    flame,
    size,
    vis,
    free,
    lean,
    candidate,
    pullStrength,
    falling,
  };
}

/**
 * The finger lifted. The candidate is where the ship goes when it is within the candidate's catch: the caller flies
 * there as if that place had been tapped. A little farther from a body (its `fall`), the ship is drawn in first and
 * {@link arrival} says when it is there; with reduced motion it goes at once. Anywhere else it stays free in the sky.
 */
export function releaseShip(state: ShipState, targets: readonly ShipTarget[], reducedMotion = false): ShipRelease {
  const candidate = targets.find((target) => target.id === state.candidate);
  if (candidate) {
    const distance = Math.hypot(candidate.x - state.x, candidate.y - state.y);
    const outcome = onLettingGo(pullOfTarget(candidate), distance);
    if (outcome === 'go' || (outcome === 'fall' && reducedMotion))
      return { state: { ...state, candidate: null, pullStrength: 0, falling: null, free: false }, goTo: candidate.id };
    if (outcome === 'fall') return { state: { ...state, falling: candidate.id }, goTo: null };
  }
  return { state: { ...state, candidate: null, pullStrength: 0 }, goTo: null };
}

/**
 * The place a falling ship has reached, once it is at the body's edge (its `core`): the caller flies there and calls
 * {@link landShip}. Null while it is still on its way, or not falling.
 */
export function arrival(state: ShipState, targets: readonly ShipTarget[]): string | null {
  if (state.falling === null) return null;
  const target = targets.find((candidate) => candidate.id === state.falling);
  if (target === undefined) return null;
  return Math.hypot(target.x - state.x, target.y - state.y) <= pullOfTarget(target).core ? target.id : null;
}

/** A ship that reached the place it fell into: it is no longer free, and goes home as the view flies. */
export function landShip(state: ShipState): ShipState {
  return { ...state, free: false, falling: null, candidate: null, pullStrength: 0 };
}

/** Puts a ship that was left in the sky back on its parking spot. */
export function recentreShip(state: ShipState): ShipState {
  return { ...state, free: false, candidate: null, pullStrength: 0, falling: null };
}

/**
 * The ship as it is painted: when it hides it rises, grows and fades (the prototype's `e`, lines 1916 and 1921).
 * `catchStrength` is how strongly the place at `catchAt` is lit: its pull, or all of it where letting go would go there.
 */
export function drawn(
  state: ShipState,
  catchAt: Point | null = null,
  catchStrength: number = state.pullStrength,
): DrawnShip {
  const presence = smootherstep(clamp(state.vis, 0, 1));
  return {
    x: state.x,
    y: state.y - (1 - presence) * HIDDEN_RISE,
    size: state.size * (1 + (1 - presence) * HIDDEN_GROWTH),
    heading: state.heading,
    flame: state.flame,
    alpha: presence,
    catchAt,
    pullStrength: catchAt === null ? 0 : catchStrength,
  };
}

/** True when a finger at (`x`, `y`) takes the ship: it is within the pick radius of the drawn ship, which is mostly there. */
export function pickShip(state: ShipState, x: number, y: number): boolean {
  if (state.vis <= PICK_MIN_VIS) return false;
  const ship = drawn(state);
  return Math.hypot(ship.x - x, ship.y - y) <= PICK_RADIUS;
}

/** What {@link parkingSpot} needs to know. */
export interface ParkingInput {
  /** The spot the ship would like. */
  readonly anchor: Point;
  /** Things the person might tap, with their radius. */
  readonly avoid: readonly (Point & { readonly r: number })[];
}

/**
 * Where the ship parks: the first offset along x from the anchor that is clear of every tappable thing, so it never
 * rests on top of one. With no clear spot it stays at the anchor.
 */
export function parkingSpot({ anchor, avoid }: ParkingInput): Point {
  for (const offset of PARKING_OFFSETS) {
    const spot = { x: anchor.x + offset, y: anchor.y };
    const clear = avoid.every(
      (thing) =>
        Math.hypot(thing.x - spot.x, thing.y - spot.y) >= Math.max(PARKING_MIN_CLEARANCE, thing.r + PARKING_MARGIN),
    );
    if (clear) return spot;
  }
  return anchor;
}
