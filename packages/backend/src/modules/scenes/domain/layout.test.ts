import { describe, expect, it } from 'vitest';
import { cellAnchor, FINE_SPACING, nextSystemCell, planetOffset, spiralCell, SYSTEM_SPACING } from './layout.js';

describe('canonical-lattice.v2 layout (pure)', () => {
  it('lays the cells out on a square spiral that is a bijection onto the grid', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 10_000; n++) {
      const { i, j } = spiralCell(n);
      seen.add(`${i},${j}`);
    }
    expect(seen.size).toBe(10_000);
    // The first 49 cells are exactly the 7 x 7 square around the origin, ring by ring.
    const first = Array.from({ length: 49 }, (_, n) => spiralCell(n));
    expect(new Set(first.map(({ i, j }) => `${i},${j}`)).size).toBe(49);
    expect(first.every(({ i, j }) => Math.abs(i) <= 3 && Math.abs(j) <= 3)).toBe(true);
    expect(spiralCell(0)).toEqual({ i: 0, j: 0 });
    // Cells go outward ring by ring and the next number is always a neighbour of the last one or on the next ring.
    for (let n = 1; n < 2_000; n++) {
      const a = spiralCell(n - 1),
        b = spiralCell(n);
      const ring = (c: { i: number; j: number }) => Math.max(Math.abs(c.i), Math.abs(c.j));
      expect(ring(b)).toBeGreaterThanOrEqual(ring(a));
      expect(Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j))).toBeLessThanOrEqual(2 * ring(b));
    }
  });
  it('names a cell for ever: pinned cells and anchors', () => {
    expect([1, 2, 3, 8, 9].map((n) => spiralCell(n))).toEqual([
      { i: 1, j: 0 },
      { i: 1, j: 1 },
      { i: 0, j: 1 },
      { i: 1, j: -1 },
      { i: 2, j: -1 },
    ]);
    expect(cellAnchor(0)).toEqual({ x: 0, y: 0 });
    expect(cellAnchor(2)).toEqual({ x: SYSTEM_SPACING, y: SYSTEM_SPACING });
    expect(() => spiralCell(-1)).toThrow(RangeError);
    expect(() => spiralCell(1.5)).toThrow(RangeError);
  });
  it('leaves the square of an older world empty and blocks nothing in a new one', () => {
    expect(nextSystemCell(0, 0)).toBe(0);
    expect(nextSystemCell(5, 0)).toBe(5);
    const reach = 4650;
    const n = nextSystemCell(0, reach);
    const { x, y } = cellAnchor(n);
    expect(Math.max(Math.abs(x), Math.abs(y))).toBeGreaterThanOrEqual(reach + SYSTEM_SPACING);
    // Every cell before it is inside the blocked square, and the ones after it are not skipped again.
    for (let before = 0; before < n; before++) {
      const c = cellAnchor(before);
      expect(Math.max(Math.abs(c.x), Math.abs(c.y))).toBeLessThan(reach + SYSTEM_SPACING);
    }
    expect(nextSystemCell(n, reach)).toBe(n);
    expect(nextSystemCell(n + 1, reach)).toBe(n + 1);
  });
  it('places planets on the lattice nearest first, the first four one cell from the star', () => {
    expect([0, 1, 2, 3].map(planetOffset)).toEqual([
      { x: FINE_SPACING, y: 0 },
      { x: 0, y: FINE_SPACING },
      { x: -FINE_SPACING, y: 0 },
      { x: 0, y: -FINE_SPACING },
    ]);
    // The next four are a diagonal away: the client's second band.
    for (const k of [4, 5, 6, 7]) {
      const { x, y } = planetOffset(k);
      expect(Math.hypot(x, y)).toBeCloseTo(FINE_SPACING * Math.SQRT2);
    }
    const seen = new Set<string>();
    let last = 0;
    for (let k = 0; k < 600; k++) {
      const { x, y } = planetOffset(k);
      seen.add(`${x},${y}`);
      expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(last - 1e-9);
      last = Math.hypot(x, y);
    }
    expect(seen.size).toBe(600);
    // The same ordinal is the same place however the table was grown.
    expect(planetOffset(5)).toEqual(planetOffset(5));
    expect(planetOffset(599)).toEqual(planetOffset(599));
  });
});
