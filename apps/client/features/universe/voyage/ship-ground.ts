/**
 * The ship on the ground: it is always landed under you, standing upright on the land with a soft shadow beneath it,
 * and only lifts off while it is held (or being drawn into a place). Pure and three-free, like `ship-motion.ts`, which
 * calls it: how far the ship is lifted, how that shows (a rise, a little growth, a flame), and where its shadow lies.
 *
 * Where a number copies the design prototype (`Universe.dc.html`, `drawGlobe`, line 1354: the ship at rest on the landed
 * map) it says so: a shadow of `rgba(21,48,42,0.3)`, centred 0.42 of the ship's size under its middle and 0.3 by 0.09
 * of its size across. The prototype's ship does not lift on the ground (it has none to lift from), so the lift is new.
 */
import { smootherstep } from '../animation/easing';

/** A point on screen, in layout points, y down. */
interface Spot {
  readonly x: number;
  readonly y: number;
}

/** The size, in points, of a ship landed on the ground (the prototype's is `clamp(R * 0.13, 22, 46)`, 46 on the landed map). */
export const GROUND_SIZE = 42;
/**
 * How far below the middle of the ship its fins end, as a share of its size: the art's fins end 20 units below the
 * body's middle on a 60 unit board (`ship-layer.ts`), so a ship stands on the land with its fins on the ground point.
 */
export const FOOT_SHARE = 20 / 60;

/** How long a ship takes to lift off when it is taken, and to settle when it is let go, in seconds. */
export const LIFT_SECONDS = 0.2;
export const SETTLE_SECONDS = 0.3;
/** A lifted ship rises this share of its size above the ground point, and is this much larger (it is nearer). */
export const LIFT_RISE_SHARE = 0.34;
export const LIFT_GROWTH = 0.12;

/** The shadow's size across as a share of the ship's: a little wider than its fins (60 units board, fins 36 wide). */
const SHADOW_WIDTH_SHARE = 0.36;
const SHADOW_HEIGHT_SHARE = 0.1;
/** How far under the ship's fins the shadow's middle lies, as a share of its size (the prototype's 0.42 less the fins' 0.333). */
const SHADOW_DROP_SHARE = 0.03;
/** The shadow's opacity at its middle when landed: the prototype's 0.3, from a gradient that is softer than its flat ellipse. */
export const SHADOW_OPACITY = 0.42;
/** A fully lifted ship's shadow keeps this share of its size and of its opacity ... */
const SHADOW_LIFTED_SIZE = 0.62;
const SHADOW_LIFTED_OPACITY = 0.55;
/** ... and drifts away from the light (which is above and to the left) by this share of the rise, across and down. */
const SHADOW_DRIFT = { x: 0.9, y: 0.3 } as const;

/** Where a ship's shadow lies and how it looks, in layout points. */
export interface Shadow {
  /** The middle of the ellipse. */
  readonly x: number;
  readonly y: number;
  /** Its full width and height. */
  readonly width: number;
  readonly height: number;
  /** Its opacity at the middle, 0..1. */
  readonly opacity: number;
}

/** The linear lift, moved toward its goal: 1 while the ship is taken, 0 once it is let go. Reduced motion jumps. */
export function liftStep(lift: number, lifting: boolean, dt: number, snap: boolean): number {
  const goal = lifting ? 1 : 0;
  if (snap) return goal;
  const rate = dt / (lifting ? LIFT_SECONDS : SETTLE_SECONDS);
  return goal > lift ? Math.min(goal, lift + rate) : Math.max(goal, lift - rate);
}

/** How lifted a ship looks for a linear `lift` (0..1): the same easing at every frame rate. */
export const liftedOf = (lift: number): number => smootherstep(Math.min(1, Math.max(0, lift)));

/** The point of the ground a ship stands on: under its fins. */
export const footOf = (ship: Spot & { readonly size: number }): Spot => ({
  x: ship.x,
  y: ship.y + ship.size * FOOT_SHARE,
});

/**
 * The shadow of a ship at (`x`, `y`) of `size` that is `lifted` (0..1, see {@link liftedOf}) and `presence` there (0
 * while it is hidden for a flight): under its fins when landed, and smaller, fainter and drifted away from the light
 * as it rises. It lies on the ground point under the ship, never on the lifted ship.
 */
export function shadowOf(ship: Spot & { readonly size: number }, lifted: number, presence: number): Shadow {
  const { size } = ship;
  const rise = size * LIFT_RISE_SHARE * lifted;
  const foot = footOf(ship);
  const shrink = 1 - (1 - SHADOW_LIFTED_SIZE) * lifted;
  return {
    x: foot.x + rise * SHADOW_DRIFT.x,
    y: foot.y + size * SHADOW_DROP_SHARE + rise * SHADOW_DRIFT.y,
    width: size * SHADOW_WIDTH_SHARE * 2 * shrink,
    height: size * SHADOW_HEIGHT_SHARE * 2 * shrink,
    opacity: SHADOW_OPACITY * (1 - (1 - SHADOW_LIFTED_OPACITY) * lifted) * presence,
  };
}

/** The art stands 0.74 of the ship's size above its fins (nose to fins, 42 of 60 board units, less the flame) and 0.64 across. */
const BODY_HEIGHT_SHARE = 0.74;
const BODY_WIDTH_SHARE = 0.64;

/** The box a landed ship covers on screen, standing on `foot` (the point of the ground under its fins): names keep off it. */
export function shipBoxOf(foot: Spot, size: number) {
  return {
    x: foot.x - size * (BODY_WIDTH_SHARE / 2),
    y: foot.y - size * BODY_HEIGHT_SHARE,
    width: size * BODY_WIDTH_SHARE,
    height: size * BODY_HEIGHT_SHARE,
  };
}
