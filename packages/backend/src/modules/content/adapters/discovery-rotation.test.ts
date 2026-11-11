import { describe, expect, it } from 'vitest';
import { rotationCursor } from './discovery-store.js';

describe('the cursor a decision seed picks in each lane’s random order', () => {
  it('is the beginning without a seed, so a caller with none still reads the stable random order', () => {
    expect(rotationCursor(undefined)).toBe(0);
    expect(rotationCursor('')).toBe(0);
  });

  it('is the same point for the same seed and a point in [0, 1) for any seed', () => {
    expect(rotationCursor('seed')).toBe(rotationCursor('seed'));
    for (const seed of ['a', 'buffer:session:3:offer', 'ce1c2c9e-0a5f-4c1e-9d2b-7f6f2f6f3b11']) {
      expect(rotationCursor(seed)).toBeGreaterThanOrEqual(0);
      expect(rotationCursor(seed)).toBeLessThan(1);
    }
  });

  it('differs between seeds and spreads over the whole range, so decisions read different slices', () => {
    const cursors = Array.from({ length: 200 }, (_, n) => rotationCursor(`command-${String(n)}`));
    expect(new Set(cursors).size).toBe(200);
    const tenths = new Set(cursors.map((c) => Math.floor(c * 10)));
    expect(tenths.size).toBe(10);
  });
});
