import { heldBeatAt, readingLineOf } from './hold-geometry';

describe('the hold (folio README 5.6)', () => {
  it('shows the first beat until another reaches the reading line, then the last one that has', () => {
    const tops = [1000, 1300, 1600];
    expect(heldBeatAt(tops, 900)).toBe(0);
    expect(heldBeatAt(tops, 1299)).toBe(0);
    expect(heldBeatAt(tops, 1300)).toBe(1);
    expect(heldBeatAt(tops, 1700)).toBe(2);
    expect(heldBeatAt(tops, 99_999)).toBe(2);
  });

  it('puts the reading line under the pinned figure, never inside it', () => {
    expect(readingLineOf(844, 320)).toBeGreaterThan(320);
    expect(readingLineOf(844, 320)).toBeLessThan(844);
    expect(readingLineOf(200, 320)).toBe(320);
  });
});
