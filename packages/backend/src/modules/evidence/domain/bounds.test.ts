import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { boundIntervals, boundOccurredAt, elapsedCapMs } from './bounds.js';
import { OBSERVATION_BOUNDS_V1 as bounds } from './policy.js';

const at = (iso: string) => new Date(iso);

describe('bounding client claims against the server clock', () => {
  it('clamps a future occurredAt to the receive time and refuses an event older than the maximum age', () => {
    const received = at('2026-10-20T10:00:00Z');
    expect(boundOccurredAt(at('2026-10-20T09:59:00Z'), received, bounds)).toEqual({
      kind: 'ok',
      occurredAt: at('2026-10-20T09:59:00Z'),
      clamped: false,
    });
    // A little skew into the future is tolerated; a lot is clamped.
    expect(boundOccurredAt(at('2026-10-20T10:02:00Z'), received, bounds)).toMatchObject({ clamped: false });
    expect(boundOccurredAt(at('2026-10-20T12:00:00Z'), received, bounds)).toEqual({
      kind: 'ok',
      occurredAt: received,
      clamped: true,
    });
    expect(boundOccurredAt(at('2026-10-10T10:00:00Z'), received, bounds)).toEqual({ kind: 'too_old' });
  });

  it('allows no offset beyond the wall time since activation plus the allowance', () => {
    expect(elapsedCapMs(at('2026-10-20T10:00:00Z'), at('2026-10-20T10:00:30Z'), bounds)).toBe(32_000);
    // Activation can never be in the receipt's future; the cap is still non-negative.
    expect(elapsedCapMs(at('2026-10-20T10:01:00Z'), at('2026-10-20T10:00:00Z'), bounds)).toBe(2_000);
  });

  it('clips intervals to the cap and reports when it did', () => {
    expect(
      boundIntervals(
        [
          [0, 1_000],
          [2_000, 9_000],
          [9_500, 12_000],
        ],
        5_000,
      ),
    ).toEqual({
      intervals: [
        [0, 1_000],
        [2_000, 5_000],
      ],
      bounded: true,
    });
    expect(boundIntervals([[0, 1_000]], 5_000)).toEqual({ intervals: [[0, 1_000]], bounded: false });
  });

  test.prop([
    fc.array(
      fc
        .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }))
        .map(([from, length]): [number, number] => [from, from + length]),
      { maxLength: 10 },
    ),
    fc.integer({ min: 0, max: 150_000 }),
  ])('no bounded interval ever ends past the cap, and none is lengthened', (list, cap) => {
    const bounded = boundIntervals(list, cap);
    for (const [from, to] of bounded.intervals) {
      expect(to).toBeLessThanOrEqual(cap);
      expect(to).toBeGreaterThan(from);
    }
    expect(bounded.intervals.reduce((sum, [from, to]) => sum + to - from, 0)).toBeLessThanOrEqual(
      list.reduce((sum, [from, to]) => sum + to - from, 0),
    );
  });
});
