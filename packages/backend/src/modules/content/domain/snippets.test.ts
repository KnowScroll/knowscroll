import { describe, expect, it } from 'vitest';
import { reelRangeHolds } from './snippets.js';

describe('reelRangeHolds', () => {
  const duration = 58_000;
  const minMs = 1_000;
  it('accepts a moment inside the Reel, up to the whole of it', () => {
    expect(reelRangeHolds(18_000, 31_000, duration, minMs)).toBe(true);
    expect(reelRangeHolds(0, 1_000, duration, minMs)).toBe(true);
    expect(reelRangeHolds(duration - 1_000, duration, duration, minMs)).toBe(true);
    expect(reelRangeHolds(0, duration, duration, minMs)).toBe(true);
  });
  it('refuses a range past the end, backwards, empty or too short', () => {
    expect(reelRangeHolds(50_000, 58_001, duration, minMs)).toBe(false);
    expect(reelRangeHolds(31_000, 18_000, duration, minMs)).toBe(false);
    expect(reelRangeHolds(18_000, 18_000, duration, minMs)).toBe(false);
    expect(reelRangeHolds(18_000, 18_999, duration, minMs)).toBe(false);
    expect(reelRangeHolds(-1, 5_000, duration, minMs)).toBe(false);
  });
  it('refuses values that are not whole milliseconds', () => {
    expect(reelRangeHolds(1.5, 5_000, duration, minMs)).toBe(false);
    expect(reelRangeHolds(0, Number.NaN, duration, minMs)).toBe(false);
  });
});
