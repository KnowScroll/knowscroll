import { describe, expect, it } from 'vitest';
import {
  CALL_VIEW_MS,
  MIN_UNIT_VIEW_MS,
  planReelWatch,
  planScrollReading,
  readingWindow,
  reelSamplesInWindow,
  REEL_TICK_MS,
  type Interval,
  type ReadingUnit,
} from './reading-plan.js';

const units: readonly ReadingUnit[] = [
  { id: 'stop-1', kind: 'read', nominalMs: 40_000 },
  { id: 'stop-2', kind: 'read', nominalMs: 30_000 },
  { id: 'call-1', kind: 'call', nominalMs: 10_000 },
  { id: 'stop-3', kind: 'read', nominalMs: 200 },
];

const total = (intervals: readonly Interval[]) => intervals.reduce((sum, [from, to]) => sum + (to - from), 0);

describe('canary Scroll reading plan', () => {
  it('reads each unit one after another for its share of the time its words take', () => {
    const plan = planScrollReading(units, 0.5);
    expect(plan.segments.map((segment) => [segment.unitId, segment.fromMs, segment.toMs])).toEqual([
      ['stop-1', 0, 20_000],
      ['stop-2', 20_000, 35_000],
      ['call-1', 35_000, 35_000 + CALL_VIEW_MS],
      ['stop-3', 35_000 + CALL_VIEW_MS, 35_000 + CALL_VIEW_MS + MIN_UNIT_VIEW_MS],
    ]);
    expect(plan.durationMs).toBe(35_000 + CALL_VIEW_MS + MIN_UNIT_VIEW_MS);
  });

  it('shows a unit for at least the floor above the 500 ms policy minimum, and a stop for more than 40% of its words', () => {
    const plan = planScrollReading(units, 0.5);
    for (const segment of plan.segments) expect(segment.toMs - segment.fromMs).toBeGreaterThan(500);
    const stop = plan.segments[0]!;
    expect((stop.toMs - stop.fromMs) / 40_000).toBeGreaterThan(0.4);
  });

  it('locks a call in, then reveals it, inside the time it is on screen', () => {
    const plan = planScrollReading(units, 1);
    const call = plan.segments.find((segment) => segment.unitId === 'call-1')!;
    expect(plan.interactions.map((interaction) => interaction.kind)).toEqual(['locked', 'revealed']);
    for (const interaction of plan.interactions) {
      expect(interaction.atMs).toBeGreaterThan(call.fromMs);
      expect(interaction.atMs).toBeLessThanOrEqual(call.toMs);
    }
  });

  it('tiles time: the windows of consecutive reports together say exactly what the plan says, once', () => {
    const plan = planScrollReading(units, 0.5);
    const windows = [0, 15_000, 30_000, plan.durationMs]
      .slice(0, -1)
      .map((from, index, all) => readingWindow(plan, from, all[index + 1] ?? plan.durationMs));
    const last = readingWindow(plan, 30_000, plan.durationMs);
    const everything = [windows[0]!, windows[1]!, last];
    const perUnit = new Map<string, number>();
    for (const window of everything)
      for (const block of window.coverage)
        perUnit.set(block.unitId, (perUnit.get(block.unitId) ?? 0) + total(block.intervalsMs));
    for (const segment of plan.segments) expect(perUnit.get(segment.unitId)).toBe(segment.toMs - segment.fromMs);
    expect(everything.flatMap((window) => window.interactions)).toEqual(plan.interactions);
    expect(total(everything.flatMap((window) => window.dwell))).toBe(plan.durationMs);
  });

  it('merges contiguous active time into one dwell interval and clips a unit at the window edge', () => {
    const plan = planScrollReading(units, 0.5);
    const window = readingWindow(plan, 5_000, 25_000);
    expect(window.dwell).toEqual([[5_000, 25_000]]);
    expect(window.coverage).toEqual([
      { unitId: 'stop-1', intervalsMs: [[5_000, 20_000]] },
      { unitId: 'stop-2', intervalsMs: [[20_000, 25_000]] },
    ]);
  });

  it('says nothing for a window past the end', () => {
    const plan = planScrollReading(units, 0.5);
    expect(readingWindow(plan, plan.durationMs, plan.durationMs + 15_000)).toEqual({
      coverage: [],
      dwell: [],
      interactions: [],
    });
  });
});

describe('canary Reel watch plan', () => {
  it('plays continuously at 1x in one-second samples for the share of the Reel', () => {
    const plan = planReelWatch(30_000, 0.7);
    expect(plan.durationMs).toBe(21_000);
    expect(plan.samples).toHaveLength(21);
    expect(plan.samples[0]).toEqual({ activeMs: [0, 1_000], mediaMs: [0, 1_000] });
    expect(plan.samples.at(-1)).toEqual({ activeMs: [20_000, 21_000], mediaMs: [20_000, 21_000] });
  });

  it('keeps every sample inside what the recorder and the contract allow', () => {
    for (const duration of [20_000, 27_345, 60_000]) {
      const plan = planReelWatch(duration, 0.7);
      for (const sample of plan.samples) {
        const active = sample.activeMs[1] - sample.activeMs[0];
        const media = sample.mediaMs[1] - sample.mediaMs[0];
        expect(active).toBeGreaterThan(0);
        expect(active).toBeLessThanOrEqual(1_500);
        expect(media).toBeLessThanOrEqual(active + 100);
        expect(media).toBeGreaterThanOrEqual(active * 0.7);
        expect(sample.mediaMs[1]).toBeLessThanOrEqual(duration);
      }
      expect(plan.durationMs / duration).toBeGreaterThan(0.6);
    }
  });

  it('never watches past the Reel, and gives each sample to exactly one report', () => {
    const plan = planReelWatch(20_000, 1);
    expect(plan.durationMs).toBe(20_000);
    const first = reelSamplesInWindow(plan, 0, 15_000);
    const second = reelSamplesInWindow(plan, 15_000, 30_000);
    expect(first).toHaveLength(15_000 / REEL_TICK_MS);
    expect(second).toHaveLength(5_000 / REEL_TICK_MS);
    expect([...first, ...second]).toEqual(plan.samples);
  });
});
