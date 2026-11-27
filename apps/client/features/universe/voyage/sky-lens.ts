/**
 * Which bodies bend the stars behind them, and how much: the look of gravity in the trial (the owner, 27 November:
 * "a gravitational lensing and spacetime warp like effect to show the gravity in a cool way"). Every star seen from
 * the whole universe and from its own stop bends the sky round it a little, and the body pulling the ship bends it
 * more, the harder it pulls. A planet bends it only while it pulls. Nothing bends at a planet or on its ground, where
 * the world fills the view.
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

/** The place the held ship bends toward and how hard it pulls (0..1), from the last frame; null when none. */
export interface LensPull {
  readonly x: number;
  readonly y: number;
  readonly strength: number;
}

/** A star bends the sky round it by this share of its radius on screen, plus {@link STAR_LENS_MIN}. */
const STAR_LENS_SHARE = 1.8;
/** Points: so a far star, a dot on screen, still bends the stars behind it a little. */
const STAR_LENS_MIN = 6;
/** The most a body pulling the ship at full strength adds to its lens, in points. */
const PULL_LENS = 72;
/** The pull is matched to the body under it within this many points, or the body's radius if larger. */
const PULL_MATCH = 14;
/** Lenses smaller than this, in points, are not worth a slot. */
const LENS_MIN = 1.5;

/** The lens radius each body wants this frame, by id; bodies that bend nothing are absent. */
export function lensRadii(stop: Stop, bodies: readonly LensBody[], pull: LensPull | null): Map<string, number> {
  const radii = new Map<string, number>();
  if (stop === 'planet' || stop === 'ground') return radii;
  let pulling: LensBody | null = null;
  if (pull !== null && pull.strength > 0) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const body of bodies) {
      const distance = Math.hypot(body.x - pull.x, body.y - pull.y);
      if (distance <= Math.max(PULL_MATCH, body.radiusPx) && distance < nearest) {
        nearest = distance;
        pulling = body;
      }
    }
  }
  for (const body of bodies) {
    const own = body.kind === 'system' ? body.radiusPx * STAR_LENS_SHARE + STAR_LENS_MIN : 0;
    const pulled = body === pulling && pull !== null ? PULL_LENS * Math.min(1, pull.strength) : 0;
    const radius = own + pulled;
    if (radius >= LENS_MIN) radii.set(body.id, radius);
  }
  return radii;
}

/**
 * The lenses to draw: the `max` largest, each at its body. `radii` are the eased ones the driver keeps, which may
 * still hold a body that has just stopped pulling (easing out) as long as it is on screen.
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
