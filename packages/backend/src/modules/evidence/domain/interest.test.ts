import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { ACTIVITY_POLICY, decay } from './activity.js';
import { decayedActivity, logWeightFloor, logWeightOf } from './interest.js';

const DAY = 86_400_000;
const EPOCH = Date.parse('2026-11-01T00:00:00Z');

describe('log_weight orders rows by decayed activity at any time (D-420)', () => {
  it('is null for no activity and refuses what is not a measurement', () => {
    expect(logWeightOf(0, EPOCH)).toBeNull();
    expect(() => logWeightOf(-1, EPOCH)).toThrow('INTEREST_LOG_WEIGHT_INVALID');
    expect(() => logWeightOf(Number.NaN, EPOCH)).toThrow('INTEREST_LOG_WEIGHT_INVALID');
    expect(() => logWeightOf(1, Number.POSITIVE_INFINITY)).toThrow('INTEREST_LOG_WEIGHT_INVALID');
  });

  it('puts a recent small activity above an old large one exactly when it is larger after decay', () => {
    // 3.0 stored 56 days ago is 3 / 16 now; 0.5 stored today is 0.5.
    const old = logWeightOf(3, EPOCH - 56 * DAY)!;
    const fresh = logWeightOf(0.5, EPOCH)!;
    expect(fresh).toBeGreaterThan(old);
    expect(decayedActivity(3, EPOCH - 56 * DAY, EPOCH)).toBeCloseTo(0.1875, 10);
    expect(decayedActivity(0.5, EPOCH, EPOCH)).toBe(0.5);
  });

  test.prop([
    fc.double({ min: 0.001, max: 50, noNaN: true }),
    fc.double({ min: 0.001, max: 50, noNaN: true }),
    fc.integer({ min: 0, max: 120 }),
    fc.integer({ min: 0, max: 120 }),
    fc.integer({ min: 0, max: 400 }),
  ])('log_weight order equals decayed-activity order at every later time', (a, b, dayA, dayB, laterDays) => {
    const atA = EPOCH + dayA * DAY;
    const atB = EPOCH + dayB * DAY;
    const now = Math.max(atA, atB) + laterDays * DAY;
    const byKey = logWeightOf(a, atA)! - logWeightOf(b, atB)!;
    const byValue = decayedActivity(a, atA, now) - decayedActivity(b, atB, now);
    // The two orders agree except where the values are equal to within the double precision of the key.
    if (Math.abs(byKey) > 1e-9) expect(Math.sign(byKey)).toBe(Math.sign(byValue));
  });

  test.prop([
    fc.double({ min: 0.001, max: 50, noNaN: true }),
    fc.integer({ min: 0, max: 120 }),
    fc.integer({ min: 0, max: 200 }),
  ])(
    'the floor key admits a row exactly when its decayed activity is at least the floor',
    (value, storedDays, laterDays) => {
      const stored = EPOCH + storedDays * DAY;
      const now = stored + laterDays * DAY;
      const floor = 0.05;
      const admitted = logWeightOf(value, stored)! >= logWeightFloor(floor, now)!;
      const decayed = decayedActivity(value, stored, now);
      if (Math.abs(decayed - floor) / floor > 1e-9) expect(admitted).toBe(decayed >= floor);
    },
  );

  it('has no bound for a floor that asks for nothing', () => {
    expect(logWeightFloor(0, EPOCH)).toBeNull();
    expect(logWeightFloor(-1, EPOCH)).toBeNull();
  });

  it('decays by the half life of activity.v1 and never grows a row stored in the future', () => {
    expect(decayedActivity(2, EPOCH, EPOCH + ACTIVITY_POLICY.halfLifeMs)).toBeCloseTo(1, 12);
    expect(decayedActivity(2, EPOCH, EPOCH + ACTIVITY_POLICY.halfLifeMs)).toBeCloseTo(
      2 * decay(EPOCH, EPOCH + ACTIVITY_POLICY.halfLifeMs),
      12,
    );
    expect(decayedActivity(2, EPOCH + DAY, EPOCH)).toBe(2);
  });
});
