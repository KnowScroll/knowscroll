import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_POLICY } from './activity.js';
import {
  applyCountedChanges,
  parseCounted,
  RollupAccumulator,
  EMPTY_CHANNELS,
  type CountedState,
  type RollupValue,
} from './interest-rollup.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const state = (a: number, t: number, extra: Partial<CountedState> = {}): CountedState => ({
  a,
  t,
  ch: { ...EMPTY_CHANNELS, q: a },
  rm: 0,
  rq: 0,
  sm: 1,
  sq: 1,
  ...extra,
});
const decayed = (a: number, from: number, to: number) => a * Math.pow(2, -(to - from) / ACTIVITY_POLICY.halfLifeMs);

describe('a roll-up changes by what a topic was counted as and what it is now (D-420)', () => {
  it('adds a topic nothing had counted, to a roll-up that has no row yet', () => {
    const { value, consistent } = applyCountedChanges(undefined, [{ previous: undefined, next: state(2, T0) }], T0);
    expect(consistent).toBe(true);
    expect(value).toMatchObject({ a: 2, t: T0, sm: 1, sq: 1 });
  });

  it('replaces what a topic was counted as, at the later time, and counts the difference', () => {
    const first = applyCountedChanges(undefined, [{ previous: undefined, next: state(2, T0) }], T0).value;
    const { value, consistent } = applyCountedChanges(
      first,
      [{ previous: state(2, T0), next: state(2.5, T0 + 14 * DAY, { sm: 2, sq: 2 }) }],
      T0 + 14 * DAY,
    );
    expect(consistent).toBe(true);
    // 2 decayed by one half life (1) is taken away, 2.5 is added, on top of the roll-up's own decayed 1.
    expect(value.a).toBeCloseTo(decayed(2, T0, T0 + 14 * DAY) - decayed(2, T0, T0 + 14 * DAY) + 2.5, 12);
    expect(value).toMatchObject({ sm: 2, sq: 2 });
  });

  it('never subtracts what it did not add: a topic an older binary wrote is not taken away from a roll-up that never had it', () => {
    // Another topic is counted at 3. A second topic, never counted (previous undefined), is replaced: only its new state is added.
    const rollup = applyCountedChanges(undefined, [{ previous: undefined, next: state(3, T0) }], T0).value;
    const { value, consistent } = applyCountedChanges(rollup, [{ previous: undefined, next: state(1, T0) }], T0);
    expect(consistent).toBe(true);
    expect(value.a).toBe(4);
  });

  it('corrects a topic an older binary changed since it was counted: the stale counted state goes, the current one comes', () => {
    const rollup = applyCountedChanges(undefined, [{ previous: undefined, next: state(2, T0) }], T0).value;
    // The older binary made the topic 5 and left what was counted (2) alone. The new binary writes it again as 5.4.
    const { value, consistent } = applyCountedChanges(
      rollup,
      [{ previous: state(2, T0), next: state(5.4, T0 + DAY) }],
      T0 + DAY,
    );
    expect(consistent).toBe(true);
    expect(value.a).toBeCloseTo(5.4, 12);
  });

  it('says it is not consistent when asked to take away what a missing or smaller roll-up never held, and stores no negative', () => {
    const missing = applyCountedChanges(undefined, [{ previous: state(2, T0), next: state(2, T0) }], T0);
    expect(missing.consistent).toBe(false);
    const small = applyCountedChanges(
      { a: 0.5, t: T0, ch: { ...EMPTY_CHANNELS, q: 0.5 }, rm: 0, rq: 0, sm: 1, sq: 1 },
      [{ previous: state(3, T0), next: state(0, T0, { sm: 0, sq: 0 }) }],
      T0,
    );
    expect(small.consistent).toBe(false);
    expect(small.value.a).toBe(0);
    expect(small.value.ch.q).toBe(0);
    const counts = applyCountedChanges(
      { a: 3, t: T0, ch: EMPTY_CHANNELS, rm: 0, rq: 0, sm: 0, sq: 0 },
      [{ previous: state(1, T0), next: state(1, T0, { sm: 0, sq: 0 }) }],
      T0,
    );
    expect(counts.consistent).toBe(false);
    expect(counts.value.sm).toBe(0);
  });

  it('treats the float noise of exactly cancelling terms as consistent', () => {
    const rollup = applyCountedChanges(undefined, [{ previous: undefined, next: state(0.1 + 0.2, T0) }], T0).value;
    const { consistent, value } = applyCountedChanges(
      rollup,
      [{ previous: state(0.3, T0), next: state(0, T0, { sm: 0, sq: 0 }) }],
      T0,
    );
    expect(consistent).toBe(true);
    expect(value.a).toBeGreaterThanOrEqual(0);
  });

  it('keeps qualified no higher than measured', () => {
    const { value } = applyCountedChanges(
      undefined,
      [{ previous: undefined, next: state(1, T0, { sm: 1, sq: 3 }) }],
      T0,
    );
    expect(value.sq).toBeLessThanOrEqual(value.sm);
  });

  test.prop([
    fc.array(
      fc.record({
        a: fc.double({ min: 0, max: 5, noNaN: true }),
        day: fc.integer({ min: 0, max: 60 }),
        sm: fc.integer({ min: 0, max: 4 }),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  ])('a sequence of replacements equals summing the final topic states, however the writes were ordered', (topics) => {
    // Each topic is written three times at increasing times, counted as the previous write was; the roll-up ends as the sum of the last states.
    let rollup: RollupValue | undefined;
    const last = new Map<number, CountedState>();
    for (let round = 0; round < 3; round += 1)
      topics.forEach((topic, index) => {
        const at = T0 + (topic.day + round * 20) * DAY;
        const next = state(topic.a * (round + 1), at, { sm: topic.sm + round, sq: Math.min(topic.sm + round, 1) });
        const result = applyCountedChanges(rollup, [{ previous: last.get(index), next }], at);
        expect(result.consistent).toBe(true);
        rollup = result.value;
        last.set(index, next);
      });
    const sum = new RollupAccumulator();
    for (const row of last.values()) sum.add(row);
    expect(rollup!.a).toBeCloseTo(
      sum.result!.a * Math.pow(2, (rollup!.t - sum.result!.t) / ACTIVITY_POLICY.halfLifeMs) * 1,
      6,
    );
  });
});

describe('the sum a rebuild streams', () => {
  it('is the same whatever order the rows arrive in, as of the latest row', () => {
    const rows = [state(2, T0), state(1, T0 + 7 * DAY), state(3, T0 + 21 * DAY), state(0.5, T0 + 3 * DAY)];
    const forward = new RollupAccumulator();
    for (const row of rows) forward.add(row);
    const reverse = new RollupAccumulator();
    for (const row of [...rows].reverse()) reverse.add(row);
    expect(forward.result!.t).toBe(T0 + 21 * DAY);
    expect(reverse.result!.t).toBe(forward.result!.t);
    expect(reverse.result!.a).toBeCloseTo(forward.result!.a, 12);
    expect(forward.result!.a).toBeCloseTo(
      rows.reduce((sum, r) => sum + decayed(r.a, r.t, T0 + 21 * DAY), 0),
      12,
    );
    expect(forward.result!.sm).toBe(4);
  });

  it('has no result for no rows', () => {
    expect(new RollupAccumulator().result).toBeUndefined();
  });
});

describe('the stored counted state is parsed, never trusted', () => {
  it('reads a state and refuses anything else', () => {
    expect(parseCounted(state(1, T0))).toEqual(state(1, T0));
    for (const bad of [
      null,
      undefined,
      {},
      { ...state(1, T0), a: -1 },
      { ...state(1, T0), extra: 1 },
      'x',
      { ...state(1, T0), rm: 1.5 },
    ])
      expect(parseCounted(bad)).toBeUndefined();
  });
});
