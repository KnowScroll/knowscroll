import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { intersectIntervals, intervalsLength, mergeIntervals, type Interval } from './intervals.js';

const interval = fc
  .tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 5_000 }))
  .map(([from, length]): Interval => [from, from + length]);
const intervals = fc.array(interval, { maxLength: 12 });

describe('interval arithmetic behind unique visible time', () => {
  it('merges overlapping and touching intervals, and drops empty ones', () => {
    expect(
      mergeIntervals([
        [10, 20],
        [0, 5],
        [5, 8],
        [15, 30],
        [40, 40],
      ]),
    ).toEqual([
      [0, 8],
      [10, 30],
    ]);
    expect(
      intervalsLength(
        mergeIntervals([
          [0, 10],
          [0, 10],
          [5, 10],
        ]),
      ),
    ).toBe(10);
  });

  test.prop([intervals])('merging is idempotent and yields sorted disjoint intervals', (list) => {
    const merged = mergeIntervals(list);
    expect(mergeIntervals(merged)).toEqual(merged);
    for (let index = 1; index < merged.length; index += 1)
      expect(merged[index]?.[0] ?? 0).toBeGreaterThan(merged[index - 1]?.[1] ?? Infinity);
  });

  test.prop([intervals, intervals])(
    'a duplicated report never adds time: the union is at most the sum and ignores order',
    (a, b) => {
      const once = intervalsLength(mergeIntervals([...a, ...b]));
      const twice = intervalsLength(mergeIntervals([...a, ...b, ...a, ...b]));
      expect(twice).toBe(once);
      expect(intervalsLength(mergeIntervals([...b, ...a]))).toBe(once);
      expect(once).toBeLessThanOrEqual(
        a.reduce((sum, [from, to]) => sum + to - from, 0) + b.reduce((sum, [from, to]) => sum + to - from, 0),
      );
    },
  );

  test.prop([intervals, intervals])('the overlap is symmetric and never longer than either side', (a, b) => {
    const left = mergeIntervals(a);
    const right = mergeIntervals(b);
    const both = intersectIntervals(left, right);
    expect(intervalsLength(both)).toBe(intervalsLength(intersectIntervals(right, left)));
    expect(intervalsLength(both)).toBeLessThanOrEqual(Math.min(intervalsLength(left), intervalsLength(right)));
  });

  it('intersects as a sweep', () => {
    expect(
      intersectIntervals(
        [
          [0, 10],
          [20, 30],
        ],
        [
          [5, 25],
          [28, 40],
        ],
      ),
    ).toEqual([
      [5, 10],
      [20, 25],
      [28, 30],
    ]);
  });
});
