/**
 * `canonical-lattice.v2`: where a new object of a map at scale is laid out (D-417). Pure: the same arguments always
 * give the same place, and nothing here reads activity, evidence, time or what else exists besides the numbers it is
 * given. An object that was laid out is never laid out again, so a place already drawn never moves.
 *
 * Positions are descriptor anchor units. One fine lattice cell is `FINE_SPACING` (the cell `canonical-lattice.v1`
 * placed every object on); the client draws 300 units as 3.2 scene units.
 */
export const LAYOUT_V1 = 'canonical-lattice.v1' as const;
export const LAYOUT_V2 = 'canonical-lattice.v2' as const;
export type SceneLayout = typeof LAYOUT_V1 | typeof LAYOUT_V2;

/** The pitch of the lattice `canonical-lattice.v1` used, and of a planet's orbit steps. */
export const FINE_SPACING = 300;
/** The pitch of the coarse grid systems take a cell on: three fine cells, room for a system's orbits. */
export const SYSTEM_SPACING = 900;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The grid cell `(i, j)` of cell number `n`, on a square spiral outward from the origin: cell 0 is `(0, 0)`, ring `r`
 * holds the `8r` cells at Chebyshev distance `r`. A bijection from the whole numbers to the grid, so a cell number
 * names one cell for ever and the next number is always the next cell outward.
 */
export function spiralCell(n: number): { readonly i: number; readonly j: number } {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('A cell number is a whole number from 0.');
  if (n === 0) return { i: 0, j: 0 };
  let ring = Math.floor((Math.sqrt(n) + 1) / 2);
  while ((2 * ring + 1) ** 2 <= n) ring++;
  while ((2 * ring - 1) ** 2 > n) ring--;
  const k = n - (2 * ring - 1) ** 2;
  const side = 2 * ring;
  if (k < side) return { i: ring, j: -ring + 1 + k };
  if (k < 2 * side) return { i: ring - 1 - (k - side), j: ring };
  if (k < 3 * side) return { i: -ring, j: ring - 1 - (k - 2 * side) };
  return { i: -ring + 1 + (k - 3 * side), j: -ring };
}

/** The anchor of the centre of cell `n` (the layer is the caller's). */
export function cellAnchor(n: number): Point {
  const { i, j } = spiralCell(n);
  return { x: i * SYSTEM_SPACING, y: j * SYSTEM_SPACING };
}

/**
 * The first cell number at or after `from` that a new system may take. A world that began on `canonical-lattice.v1`
 * has objects out to `legacyReach` (the widest of their anchors); a cell whose centre lies within one grid pitch of
 * that square is left empty, so a new system is never drawn over the older ones. A world with none (`legacyReach` 0)
 * blocks nothing.
 */
export function nextSystemCell(from: number, legacyReach: number): number {
  if (!Number.isSafeInteger(from) || from < 0) throw new RangeError('A cell number is a whole number from 0.');
  let n = from;
  if (legacyReach <= 0) return n;
  for (;;) {
    const { i, j } = spiralCell(n);
    if (Math.max(Math.abs(i), Math.abs(j)) * SYSTEM_SPACING >= legacyReach + SYSTEM_SPACING) return n;
    n++;
  }
}

/** Angles in [0, pi) before angles in [pi, 2pi); within a half, counter-clockwise by the cross product: exact. */
const half = (dx: number, dy: number): 0 | 1 => (dy > 0 || (dy === 0 && dx > 0) ? 0 : 1);
function byDistanceThenAngle(a: readonly [number, number], b: readonly [number, number]): number {
  const distance = a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2);
  if (distance !== 0) return distance;
  const halves = half(a[0], a[1]) - half(b[0], b[1]);
  return halves !== 0 ? halves : -(a[0] * b[1] - a[1] * b[0]);
}

const offsets: [number, number][] = [];
let offsetsRadius = 0;
/** Every lattice point but the origin within `radius` fine cells, nearest first, equal distances by angle. */
function growOffsets(wanted: number): void {
  while (offsets.length < wanted) {
    offsetsRadius = Math.max(2, offsetsRadius * 2);
    const found: [number, number][] = [];
    for (let dx = -offsetsRadius; dx <= offsetsRadius; dx++)
      for (let dy = -offsetsRadius; dy <= offsetsRadius; dy++)
        if ((dx !== 0 || dy !== 0) && dx * dx + dy * dy <= offsetsRadius * offsetsRadius) found.push([dx, dy]);
    found.sort(byDistanceThenAngle);
    offsets.length = 0;
    offsets.push(...found);
  }
}

/**
 * Where the planet with system-local ordinal `k` sits from its star, in anchor units: the `k`th lattice point away from
 * the origin, nearest first. The first four are one cell away (the client's innermost orbit), the next four a diagonal
 * away, and so on outward, so the client reads orbit and start angle from the anchor as it always has.
 */
export function planetOffset(ordinal: number): Point {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new RangeError('An ordinal is a whole number from 0.');
  growOffsets(ordinal + 1);
  const [dx, dy] = offsets[ordinal]!;
  return { x: dx * FINE_SPACING, y: dy * FINE_SPACING };
}
