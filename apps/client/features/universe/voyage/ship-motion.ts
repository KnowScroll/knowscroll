/**
 * The motion of the Universe's rocket: a ship the person can drag, that glides home when let go,
 * bends toward a place it could catch, and hides while the view flies. Round 7.3 look.
 *
 * Pure: screen coordinates in layout points, no three.js, no React and no clock. The caller owns
 * the frame loop and passes `dt` in seconds. Every function returns a new value and never mutates
 * its arguments, so the same inputs always give the same ship.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ShipTarget extends Point {
  readonly id: string;
}

export interface ShipHome extends Point {
  /** Size in points when parked. */
  readonly size: number;
  /** Radians, 0 = nose up. */
  readonly heading: number;
}

export interface ShipBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

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
  /** Released somewhere in empty sky: it stays there until recentred. */
  readonly free: boolean;
  /** Held now, or free: the view leans with it. */
  readonly loose: boolean;
  /** How far the view is leaned, in points. */
  readonly lean: Point;
  /** Id of the target it is bending toward, or null. */
  readonly candidate: string | null;
}

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
}

export interface ShipRelease {
  readonly state: ShipState;
  /** The target to fly to, or null when the ship stays loose where it is. */
  readonly goTo: string | null;
}

export const MAX_STEP_SECONDS = 0.1;
/** A target this close to the finger pulls the ship toward it and is marked as the candidate. */
export const CATCH_RADIUS = 64;
/** Lifting the finger this close to the candidate sends the ship there. */
export const RELEASE_RADIUS = 70;
/** A finger this close to the drawn ship takes it. */
export const PICK_RADIUS = 26;
/** The ship must be at least this present to be taken. */
export const PICK_MIN_VIS = 0.6;
export const HELD_SIZE = 34;

const FOLLOW_STIFFNESS = 34;
const FOLLOW_DAMPING_RATIO = 0.75;
const HOME_STIFFNESS = 70;
const HOME_DAMPING_RATIO = 0.9;
const MAX_BEND = 0.45;
const TURN_SPEED = 22;
const FAST_TURN_RATE = 8;
const SLOW_TURN_RATE = 3.5;
const SIZE_RATE = 6;
const FLAME_FULL_SPEED = 240;
const HELD_FLAME = 0.16;
const LEAVE_FLAME = 0.9;
const LEAN_GAIN = 0.5;
const LEAN_RATE = 3.2;
const LEAN_DECAY = 0.02;
const LEAN_REST = 0.4;
const FREE_DRAG_RATE = 2.4;
const VIS_LEAVE_RATE = 10;
const VIS_ARRIVE_RATE = 3.2;
const HIDDEN_RISE = 46;
const HIDDEN_GROWTH = 0.45;
const HIDDEN_SNAP_VIS = 0.05;
const PARKING_OFFSETS: readonly number[] = [0, 64, -64, 112, -112];

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const smootherstep = (q: number): number => q * q * q * (q * (6 * q - 15) + 10);
const springCoefficients = (stiffness: number, ratio: number): { k: number; c: number } => ({
  k: stiffness,
  c: 2 * ratio * Math.sqrt(stiffness),
});
const FOLLOW = springCoefficients(FOLLOW_STIFFNESS, FOLLOW_DAMPING_RATIO);
const HOME = springCoefficients(HOME_STIFFNESS, HOME_DAMPING_RATIO);

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
    loose: false,
    lean: { x: 0, y: 0 },
    candidate: null,
  };
}

interface Velocity {
  readonly vx: number;
  readonly vy: number;
}

/** The nearest target within the catch radius of the finger, with its distance. */
function nearestCatch(finger: Point, targets: readonly ShipTarget[]): { target: ShipTarget; distance: number } | null {
  let best: { target: ShipTarget; distance: number } | null = null;
  for (const target of targets) {
    const distance = Math.hypot(target.x - finger.x, target.y - finger.y);
    if (distance < CATCH_RADIUS && (best === null || distance < best.distance)) best = { target, distance };
  }
  return best;
}

function spring(from: Point, velocity: Velocity, to: Point, gains: { k: number; c: number }, dt: number): Velocity {
  return {
    vx: velocity.vx + (gains.k * (to.x - from.x) - gains.c * velocity.vx) * dt,
    vy: velocity.vy + (gains.k * (to.y - from.y) - gains.c * velocity.vy) * dt,
  };
}

/** Where the view should lean for a ship at `at`: half the way from the centre, capped. */
function leanTarget(at: Point, input: ShipInput): Point {
  const x = (at.x - input.viewCentre.x) * LEAN_GAIN;
  const y = (at.y - input.viewCentre.y) * LEAN_GAIN;
  const length = Math.hypot(x, y);
  if (length <= input.leanLimit || length === 0) return { x, y };
  const scale = input.leanLimit / length;
  return { x: x * scale, y: y * scale };
}

/**
 * Advances the ship by `dt` seconds (clamped to 0.1). While held it follows the finger on a soft
 * spring and bends toward a target within 64 pt; at rest it glides home; released in empty sky it
 * drifts to a stop and stays. The view leans with a loose ship and the ship is carried back by the
 * lean step, so it does not slide on screen. Reduced motion snaps and does not lean.
 */
export function stepShip(state: ShipState, input: ShipInput, dtSeconds: number): ShipState {
  const dt = clamp(dtSeconds, 0, MAX_STEP_SECONDS);
  if (dt === 0) return state;
  const held = input.drag !== null;
  const free = state.free || held;
  const loose = free;
  const snap = input.reducedMotion;

  const vis = snap
    ? input.away
      ? 0
      : 1
    : state.vis +
      ((input.away ? 0 : 1) - state.vis) * Math.min(1, dt * (input.away ? VIS_LEAVE_RATE : VIS_ARRIVE_RATE));

  let candidate: string | null = null;
  let velocity: Velocity = { vx: state.vx, vy: state.vy };
  let x = state.x;
  let y = state.y;
  if (input.drag !== null) {
    const caught = nearestCatch(input.drag, input.targets);
    let goal: Point = input.drag;
    if (caught) {
      candidate = caught.target.id;
      const bend = MAX_BEND * (1 - caught.distance / CATCH_RADIUS);
      goal = { x: goal.x + (caught.target.x - goal.x) * bend, y: goal.y + (caught.target.y - goal.y) * bend };
    }
    if (snap) {
      x = goal.x;
      y = goal.y;
      velocity = { vx: 0, vy: 0 };
    } else {
      velocity = spring(state, velocity, goal, FOLLOW, dt);
    }
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
  if (loose && !snap) {
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
  const wanted = moving ? Math.atan2(velocity.vy, velocity.vx) + Math.PI / 2 : loose ? 0 : input.home.heading;
  const turn = Math.atan2(Math.sin(wanted - state.heading), Math.cos(wanted - state.heading));
  const heading =
    snap && !moving ? wanted : state.heading + turn * Math.min(1, dt * (moving ? FAST_TURN_RATE : SLOW_TURN_RATE));

  const targetSize = loose ? HELD_SIZE : input.home.size;
  const size = snap ? targetSize : state.size + (targetSize - state.size) * Math.min(1, dt * SIZE_RATE);
  const presence = smootherstep(clamp(vis, 0, 1));
  const flame = Math.max(clamp(speed / FLAME_FULL_SPEED, 0, 1), (1 - presence) * LEAVE_FLAME, loose ? HELD_FLAME : 0);

  return { x, y, vx: velocity.vx, vy: velocity.vy, heading, flame, size, vis, free, loose, lean, candidate };
}

/**
 * The finger lifted. A candidate within 70 pt of the ship is where it goes: the caller flies
 * there as if that place had been tapped. Anywhere else the ship stays loose in the sky.
 */
export function releaseShip(state: ShipState, targets: readonly ShipTarget[]): ShipRelease {
  const candidate = targets.find((target) => target.id === state.candidate);
  if (candidate && Math.hypot(candidate.x - state.x, candidate.y - state.y) < RELEASE_RADIUS) {
    return { state: { ...state, candidate: null, free: false }, goTo: candidate.id };
  }
  return { state: { ...state, candidate: null }, goTo: null };
}

/** Puts a ship that was left in the sky back on its parking spot. */
export function recentreShip(state: ShipState): ShipState {
  return { ...state, free: false, loose: false, candidate: null };
}

/** The ship as it is painted: when it hides it rises 46 pt, grows by half and fades. */
export function drawn(state: ShipState): DrawnShip {
  const presence = smootherstep(clamp(state.vis, 0, 1));
  return {
    x: state.x,
    y: state.y - (1 - presence) * HIDDEN_RISE,
    size: state.size * (1 + (1 - presence) * HIDDEN_GROWTH),
    heading: state.heading,
    flame: state.flame,
    alpha: presence,
  };
}

/** A finger within 26 pt of the drawn ship takes it, once the ship is mostly there. */
export function pickShip(state: ShipState, x: number, y: number): boolean {
  if (state.vis <= PICK_MIN_VIS) return false;
  const ship = drawn(state);
  return Math.hypot(ship.x - x, ship.y - y) <= PICK_RADIUS;
}

export interface ParkingInput {
  readonly anchor: Point;
  /** Things the person might tap, with their radius. */
  readonly avoid: readonly (Point & { readonly r: number })[];
}

/**
 * Where the ship parks: the first offset along x from the anchor that is clear of every tappable
 * thing, so it never rests on top of one. With no clear spot it stays at the anchor.
 */
export function parkingSpot({ anchor, avoid }: ParkingInput): Point {
  for (const offset of PARKING_OFFSETS) {
    const spot = { x: anchor.x + offset, y: anchor.y };
    const clear = avoid.every((thing) => Math.hypot(thing.x - spot.x, thing.y - spot.y) >= Math.max(40, thing.r + 18));
    if (clear) return spot;
  }
  return anchor;
}
