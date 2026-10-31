import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import {
  activity,
  ACTIVITY_POLICY,
  ACTIVITY_POLICY_V0,
  continuationCredit,
  decay,
  replaceContribution,
} from './activity.js';
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

describe('activity.v1: a continuation credits its source only when the source was read enough (D-191)', () => {
  const move = (coverage: number | null) => ({ horizontal: true, coverage });

  it('is the rule new revisions are written under, and v0 stays available for old ones', () => {
    expect(ACTIVITY_POLICY.version).toBe('activity.v1');
    expect(ACTIVITY_POLICY_V0.version).toBe('activity.v0');
    expect(ACTIVITY_POLICY.continuationMinCoverage).toBe(0.5);
    expect(ACTIVITY_POLICY_V0.continuationMinCoverage).toBeNull();
  });

  it('v0 credits every continuation; v1 credits it from a coverage of 0.5', () => {
    for (const coverage of [null, 0, 0.49]) {
      expect(continuationCredit(ACTIVITY_POLICY_V0, move(coverage))).toBe(true);
      expect(continuationCredit(ACTIVITY_POLICY, move(coverage))).toBe(false);
    }
    for (const coverage of [0.5, 0.9, 1]) expect(continuationCredit(ACTIVITY_POLICY, move(coverage))).toBe(true);
  });

  it('gives nothing when there was no continuation, whatever the coverage', () => {
    for (const policy of [ACTIVITY_POLICY_V0, ACTIVITY_POLICY])
      expect(continuationCredit(policy, { horizontal: false, coverage: 1 })).toBe(false);
  });

  it('a swipe through Parts 1, 2 and 3 with no reading adds nothing under v1, and 4.5 under v0', () => {
    const swipedThrough = (policy: typeof ACTIVITY_POLICY_V0) =>
      [null, null, null]
        .map((coverage) =>
          activity({ q: null, L: false, B: false, S: 0, H: continuationCredit(policy, move(coverage)), R: false }),
        )
        .reduce((sum, value) => sum + value, 0);
    expect(swipedThrough(ACTIVITY_POLICY_V0)).toBe(4.5);
    expect(swipedThrough(ACTIVITY_POLICY)).toBe(0);
  });

  it('a part read through and then left still earns its credit, and the sum stays within the cap of 3', () => {
    const readThrough = activity({
      q: 0.8,
      L: false,
      B: false,
      S: 0,
      H: continuationCredit(ACTIVITY_POLICY, move(0.8)),
      R: false,
    });
    expect(readThrough).toBeCloseTo(2.3);
    expect(activity({ q: 1, L: true, B: true, S: 0, H: continuationCredit(ACTIVITY_POLICY, move(1)), R: true })).toBe(
      3,
    );
  });

  test.prop([fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), fc.boolean()])(
    'the gate is monotone: more coverage never takes the credit away',
    (coverage, horizontal, extra) => {
      const credited = continuationCredit(ACTIVITY_POLICY, { horizontal, coverage });
      const more = continuationCredit(ACTIVITY_POLICY, {
        horizontal,
        coverage: Math.min(1, coverage + (extra ? 0.1 : 0)),
      });
      expect(!credited || more).toBe(true);
    },
  );
});
