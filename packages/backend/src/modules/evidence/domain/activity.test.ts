import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { activity, decay, replaceContribution, ACTIVITY_POLICY } from './activity.js';
describe('activity.v0 independent channels and same-time replacement', () => {
  it('keeps absent measurements absent and caps positive activity without inventing qualification', () => {
    expect(activity({ q: null, L: true, B: false, S: 0, H: false, R: false })).toBe(0.5);
    expect(activity({ q: 1, L: true, B: true, S: 0, H: true, R: true })).toBe(3);
    expect(decay(0, ACTIVITY_POLICY.halfLifeMs)).toBe(0.5);
    expect(() => activity({ q: NaN, L: false, B: false, S: 0, H: false, R: false })).toThrow('ACTIVITY_INVALID');
  });
  test.prop([
    fc.double({ min: 0, max: 3, noNaN: true }),
    fc.double({ min: 0, max: 3, noNaN: true }),
    fc.double({ min: 0, max: 3, noNaN: true }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 31, max: 90 }),
  ])('late corrections equal full recomputation at one evaluation time', (before, after, other, d1, d2) => {
    const day = 86400000,
      at = d1 * day,
      t = d2 * day;
    const aggregate = before * decay(0, at) + other;
    const replaced = replaceContribution({
      aggregate,
      aggregateAt: at,
      evaluatedAt: t,
      encounterAt: 0,
      previous: before,
      next: after,
    });
    expect(replaced).toBeCloseTo(after * decay(0, t) + other * decay(at, t), 10);
    expect(
      replaceContribution({
        aggregate: replaced,
        aggregateAt: t,
        evaluatedAt: t,
        encounterAt: 0,
        previous: after,
        next: after,
      }),
    ).toBeCloseTo(replaced, 12);
  });
});
