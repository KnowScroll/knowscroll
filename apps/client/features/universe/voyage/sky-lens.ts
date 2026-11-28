/**
 * The look of gravity in the trial, as the owner ruled it (27 November): "we want to treat solar system as group, galaxy,
 * and stars and if planet is alone they distort". Bodies are never bent; only the background behind them is. A solar
 * system bends space as ONE mass round its whole extent (its planets' orbits), centred on its sun; a lone star bends
 * round itself; a planet bends space only when it is alone at its own planet stop, never beside its sun. Nothing bends
 * on the ground. This file says which masses bend, and holds the maths of one bend (`sourceOf`), a mirror of the pass's
 * fragment shader (`sky-pass.ts`) so the shader's profile is tested here.
 *
 * Pure and three-free; the driver projects the masses and eases their weights from frame to frame.
 */
import type { Stop } from './ladder';

/** How many masses bend the sky at once; the pass's uniform array has this many slots. */
export const LENS_SLOTS = 6;
/**
 * A lens's Einstein radius, as a share of its group's radius. Under 1, so that nothing is mirrored: a point lens maps the
 * inside of its Einstein radius to the far side, which is wrong for a group that fills the screen. Inside the group the
 * sky is an even zoom of 1 / (1 - share²) (about 5, under the sun's glow and the planets), and just outside it is
 * stretched round the mass the most (the same factor at the rim, 1.6 at one and a half radii): the arcs a lens draws.
 * 0.7 and 0.8 were tried on the sky of the trial and showed too little.
 */
export const EINSTEIN_SHARE = 0.9;
/** The bend is full out to this many group radii and gone by {@link FADE_END}, so a lens never covers the screen. */
export const FADE_START = 3;
export const FADE_END = 6;
/** Masses whose group is smaller than this, in layout points, are not worth a slot. */
const LENS_MIN_PX = 3;

/** A mass on screen this frame, in layout points (y down, as layout is). */
export interface LensMass {
  readonly id: string;
  readonly kind: 'system' | 'planet';
  /** The system it belongs to (a planet's is its star's). */
  readonly systemId: string;
  readonly x: number;
  readonly y: number;
  /** The group's radius on screen: a system's planets' orbits, a lone star's glow, a lone planet's globe. */
  readonly radiusPx: number;
}

/** A lens to draw: where, how wide its group is and how far it bends (`einstein`, 0 for none). */
export interface Lens {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly einstein: number;
}

/** Where the camera is, as far as the masses care. */
export interface LensTarget {
  readonly stop: Stop;
  readonly systemId: string | null;
  readonly planetId: string | null;
}

/**
 * Which masses bend this frame, by id (a weight of 1; the driver eases it). At the whole universe every system rings. At
 * a star only that star's system does. At a planet only that planet, alone: not its star. On the ground nothing.
 */
export function wantedMasses(target: LensTarget, masses: readonly LensMass[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const mass of masses) {
    if (mass.radiusPx < LENS_MIN_PX) continue;
    const bends =
      target.stop === 'universe'
        ? mass.kind === 'system'
        : target.stop === 'star'
          ? mass.kind === 'system' && mass.id === target.systemId
          : target.stop === 'planet' && mass.kind === 'planet' && mass.id === target.planetId;
    if (bends) wanted.set(mass.id, 1);
  }
  return wanted;
}

/**
 * The `max` widest lenses among `masses`, each as strong as its eased `weights` entry says (0 to 1); absent is none.
 * Groups that overlap on screen bend as one ({@link mergeOverlapping}) before the widest are kept.
 */
export function strongestLenses(
  masses: readonly LensMass[],
  weights: ReadonlyMap<string, number>,
  max: number,
): Lens[] {
  const lenses = masses
    .map((mass) => ({
      x: mass.x,
      y: mass.y,
      radius: mass.radiusPx,
      einstein: EINSTEIN_SHARE * mass.radiusPx * (weights.get(mass.id) ?? 0),
    }))
    .filter((lens) => lens.einstein > 0 && lens.radius >= LENS_MIN_PX);
  return mergeOverlapping(lenses)
    .sort((a, b) => b.radius - a.radius)
    .slice(0, max);
}

/** A circle on screen: a lens's group, or the circle round several. */
interface Circle {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * A circle round all of `circles`: centred where their areas balance, as wide as the farthest edge from there. Not the
 * smallest such circle, but it holds every one and is the circle itself for one.
 */
function circleRound(circles: readonly Circle[]): Circle {
  let area = 0;
  let x = 0;
  let y = 0;
  for (const circle of circles) {
    const weight = circle.radius * circle.radius;
    area += weight;
    x += circle.x * weight;
    y += circle.y * weight;
  }
  x /= area;
  y /= area;
  let radius = 0;
  for (const circle of circles) radius = Math.max(radius, Math.hypot(circle.x - x, circle.y - y) + circle.radius);
  return { x, y, radius };
}

const overlap = (a: Circle, b: Circle): boolean => Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius;

/**
 * Lenses whose groups overlap on screen become one lens, so no part of the sky is bent twice (the owner, 28 November:
 * crowded systems "as in a galaxy" must not make the bends overlap). While two groups' circles overlap they join, and a
 * joined group's circle round its members may meet another, which joins too. Whether groups join is a matter of where
 * they are, never of how strong: so a group fading out at another stop stays joined until it is gone.
 *
 * A joined lens's mass is the sum of its members' masses (a lens's mass goes as its Einstein radius squared), held to
 * {@link EINSTEIN_SHARE} of its circle, so it never mirrors. It is centred where the masses balance and reaches the
 * farthest member's edge, each member counting by its eased weight, so a member fading in or out moves the joined lens
 * smoothly from the circle without it to the circle with it.
 */
export function mergeOverlapping(lenses: readonly Lens[]): Lens[] {
  if (lenses.length < 2) return [...lenses];
  let groups: Lens[][] = lenses.map((lens) => [lens]);
  for (let joined = true; joined;) {
    joined = false;
    const circles = groups.map(circleRound);
    outer: for (let a = 0; a < groups.length; a += 1)
      for (let b = a + 1; b < groups.length; b += 1)
        if (overlap(circles[a]!, circles[b]!)) {
          groups = [
            ...groups.slice(0, a),
            [...groups[a]!, ...groups[b]!],
            ...groups.slice(a + 1, b),
            ...groups.slice(b + 1),
          ];
          joined = true;
          break outer;
        }
  }
  return groups.map((members) => (members.length === 1 ? members[0]! : joinedLens(members)));
}

/** One lens for overlapping `members`: see {@link mergeOverlapping}. */
function joinedLens(members: readonly Lens[]): Lens {
  let mass = 0;
  let x = 0;
  let y = 0;
  for (const lens of members) {
    const weight = lens.einstein * lens.einstein;
    mass += weight;
    x += lens.x * weight;
    y += lens.y * weight;
  }
  x /= mass;
  y /= mass;
  // A member's eased weight is its Einstein radius as a share of the most its group can have; it counts beside the
  // strongest member's, so members easing in or out together keep the circle round them all, as one lens would.
  const weightOf = (lens: Lens) => lens.einstein / (EINSTEIN_SHARE * lens.radius);
  let strongest = 0;
  for (const lens of members) strongest = Math.max(strongest, weightOf(lens));
  let radius = 0;
  for (const lens of members)
    radius = Math.max(radius, (weightOf(lens) / strongest) * (Math.hypot(lens.x - x, lens.y - y) + lens.radius));
  return { x, y, radius, einstein: Math.min(EINSTEIN_SHARE * radius, Math.sqrt(mass)) };
}

/** GLSL's `smoothstep`. */
function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** How much of a lens's bend is left at `distance` from its centre: all of it out to 3 radii, none from 6. */
export function bendFade(distance: number, radius: number): number {
  return 1 - smoothstep(FADE_START * radius, FADE_END * radius, distance);
}

/**
 * Where the background is read for the pixel at `at`: the pixel's own place, moved by each lens by
 * `-d · θE² / max(r, R)² · fade` (`d` the pixel's offset from the lens, `r` its length, `R` the group's radius, θE the
 * Einstein radius), the shifts of several lenses added. Outside R the sky is stretched round the mass into arcs (the
 * way a lens draws a galaxy behind a cluster); inside R it is an even zoom. With no lenses it is `at` itself.
 */
export function sourceOf(
  at: { readonly x: number; readonly y: number },
  lenses: readonly Lens[],
): { x: number; y: number } {
  let x = at.x;
  let y = at.y;
  for (const lens of lenses) {
    if (lens.einstein <= 0) continue;
    const dx = at.x - lens.x;
    const dy = at.y - lens.y;
    const r = Math.hypot(dx, dy);
    const reach = Math.max(r, lens.radius);
    const pull = ((lens.einstein * lens.einstein) / (reach * reach)) * bendFade(r, lens.radius);
    x -= dx * pull;
    y -= dy * pull;
  }
  return { x, y };
}
