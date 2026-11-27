/**
 * Which bodies bend the stars behind them, and how much: the look of gravity in the trial. The owner, 27 November:
 * the ship "should not warp the spacetime but the planet / sun and all should do that", and since they move, the bend
 * moves with them. So every sun and every planet on screen bends the sky behind it, all the time, a sun more than a
 * planet, each by its size on screen; the ship plays no part (it is only pulled: `ship-gravity.ts`). Nothing bends on
 * a planet's ground, where the land fills the view.
 *
 * Pure and three-free; the driver projects the bodies and eases the radii from frame to frame.
 */
import type { Stop } from './ladder';

/** A body on screen this frame, in layout points. */
export interface LensBody {
  readonly id: string;
  readonly kind: 'system' | 'planet';
  readonly x: number;
  readonly y: number;
  /** Its radius on screen. */
  readonly radiusPx: number;
}

/** How far each kind of body bends the sky: this share of its radius on screen, plus `min` points. */
const LENS_OF: Readonly<Record<LensBody['kind'], { readonly share: number; readonly min: number }>> = {
  // A far sun is a dot on screen: the minimum keeps its bend visible round it.
  system: { share: 2.2, min: 10 },
  planet: { share: 1.5, min: 5 },
};
/** Lenses smaller than this, in points, are not worth a slot. */
const LENS_MIN = 1.5;

/** The lens radius each body wants this frame, by id; bodies that bend nothing are absent. */
export function lensRadii(stop: Stop, bodies: readonly LensBody[]): Map<string, number> {
  const radii = new Map<string, number>();
  if (stop === 'ground') return radii;
  for (const body of bodies) {
    const { share, min } = LENS_OF[body.kind];
    const radius = body.radiusPx * share + min;
    if (radius >= LENS_MIN) radii.set(body.id, radius);
  }
  return radii;
}

/**
 * The lenses to draw: the `max` largest, each at its body. `radii` are the eased ones the driver keeps, which may
 * still hold a body that has just left (easing out) as long as it is on screen.
 */
export function strongestLenses(
  bodies: readonly LensBody[],
  radii: ReadonlyMap<string, number>,
  max: number,
): { x: number; y: number; radius: number }[] {
  return bodies
    .map((body) => ({ x: body.x, y: body.y, radius: radii.get(body.id) ?? 0 }))
    .filter((lens) => lens.radius >= LENS_MIN)
    .sort((a, b) => b.radius - a.radius)
    .slice(0, max);
}
