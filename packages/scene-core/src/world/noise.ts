import type { Stream } from './random.js';

/**
 * Gradient noise on a pinned permutation, in two dimensions. Plain double arithmetic only (add,
 * multiply, divide, floor), which is exact and the same on every engine: no `Math.sin`, `Math.cos`,
 * `Math.pow` or `Math.hypot`. The horizontal axis can wrap, which is how the globe's band has no seam.
 */
export interface Noise {
  /**
   * Noise at a point for a feature `size` in world units. `layer` picks a different pattern from the
   * same planet. The result is about [-1, 1].
   */
  at(x: number, y: number, size: number, layer: number): number;
}

const LATTICE = 256;

function permutation(stream: Stream): Uint8Array {
  const order = Array.from({ length: LATTICE }, (_, index) => index);
  for (let last = LATTICE - 1; last > 0; last--) {
    const pick = Math.floor(stream() * (last + 1));
    const kept = order[last] ?? 0;
    order[last] = order[pick] ?? 0;
    order[pick] = kept;
  }
  return Uint8Array.from(order);
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (from: number, to: number, t: number): number => from + (to - from) * t;

function gradient(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0:
      return x + y;
    case 1:
      return y - x;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x;
    case 5:
      return -x;
    case 6:
      return y;
    default:
      return -y;
  }
}

/**
 * @param period When set, the pattern repeats every `period` world units along x, so a band of
 *   that width wraps. Every feature size is rounded so a whole number of lattice cells fits.
 */
export function createNoise(stream: Stream, period?: number): Noise {
  const table = permutation(stream);
  const hashAt = (column: number, row: number): number => table[((table[column] ?? 0) + row) & 255] ?? 0;
  return {
    at(x, y, size, layer) {
      const columns = period === undefined ? LATTICE : Math.max(1, Math.round(period / size));
      const cell = period === undefined ? size : period / columns;
      const u = x / cell + layer * 5.37;
      const v = y / cell + layer * 3.91;
      const column = Math.floor(u);
      const row = Math.floor(v);
      const fx = u - column;
      const fy = v - row;
      const left = ((column % columns) + columns) % columns;
      const right = left + 1 === columns ? 0 : left + 1;
      const top = row & 255;
      const bottom = (row + 1) & 255;
      const sx = fade(fx);
      const sy = fade(fy);
      return mix(
        mix(gradient(hashAt(left, top), fx, fy), gradient(hashAt(right, top), fx - 1, fy), sx),
        mix(gradient(hashAt(left, bottom), fx, fy - 1), gradient(hashAt(right, bottom), fx - 1, fy - 1), sx),
        sy,
      );
    },
  };
}
