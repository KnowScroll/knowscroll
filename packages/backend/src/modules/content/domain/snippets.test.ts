import { describe, expect, it } from 'vitest';
import { reelRangeHolds } from './snippets.js';

describe('reelRangeHolds', () => {
  const duration = 58_000;
  const limits = { minMs: 1_000, maxMs: 90_000 };
  it('accepts a moment inside the Reel', () => {
    expect(reelRangeHolds(18_000, 31_000, duration, limits)).toBe(true);
    expect(reelRangeHolds(0, 1_000, duration, limits)).toBe(true);
    expect(reelRangeHolds(duration - 1_000, duration, duration, limits)).toBe(true);
  });
  it('refuses a range past the end, backwards, empty, too short or too long', () => {
    expect(reelRangeHolds(50_000, 58_001, duration, limits)).toBe(false);
    expect(reelRangeHolds(31_000, 18_000, duration, limits)).toBe(false);
    expect(reelRangeHolds(18_000, 18_000, duration, limits)).toBe(false);
    expect(reelRangeHolds(18_000, 18_999, duration, limits)).toBe(false);
    expect(reelRangeHolds(0, 90_001, 200_000, limits)).toBe(false);
    expect(reelRangeHolds(-1, 5_000, duration, limits)).toBe(false);
  });
  it('refuses values that are not whole milliseconds', () => {
    expect(reelRangeHolds(1.5, 5_000, duration, limits)).toBe(false);
    expect(reelRangeHolds(0, Number.NaN, duration, limits)).toBe(false);
  });
});
