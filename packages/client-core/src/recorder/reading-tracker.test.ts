import { OBSERVATION_LIMITS } from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import { ReadingTracker } from './reading-tracker';

/** Times are monotonic milliseconds; the recorder started at 1000, so offsets are `at - 1000`. */
const START = 1_000;
const tracker = () => new ReadingTracker({ startedAt: START });
const see = (t: ReadingTracker, blockId: string, visibleFraction: number, at: number) =>
  t.visibility({ blockId, visibleFraction, at });

describe('the reading tracker (summaries, never frames)', () => {
  it('records visible intervals at the threshold, relative to the recorder start', () => {
    const t = tracker();
    see(t, 'a', 0.2, 1_500);
    see(t, 'a', 0.6, 2_000);
    see(t, 'a', 1, 3_000);
    see(t, 'a', 0.3, 5_000);
    const report = t.report(6_000);
    expect(report.blocks).toEqual([{ blockId: 'a', intervalsMs: [[1_000, 4_000]], peakFraction: 1 }]);
    expect(report.activeIntervalsMs).toEqual([[1_000, 4_000]]);
  });

  it('counts no time while the article is inactive: background, a hidden tab or an overlay', () => {
    const t = tracker();
    see(t, 'a', 1, 2_000);
    t.activity({ active: false, at: 4_000 });
    // Nothing visible changes while inactive; the block is still on screen when the reader returns.
    see(t, 'b', 1, 5_000);
    t.activity({ active: true, at: 9_000 });
    t.activity({ active: false, at: 10_000 });
    const report = t.report(20_000);
    expect(report.blocks.find((block) => block.blockId === 'a')?.intervalsMs).toEqual([
      [1_000, 3_000],
      [8_000, 9_000],
    ]);
    // `b` became visible during the inactive stretch: only the active second after return counts.
    expect(report.blocks.find((block) => block.blockId === 'b')?.intervalsMs).toEqual([[8_000, 9_000]]);
    expect(report.activeIntervalsMs).toEqual([
      [1_000, 3_000],
      [8_000, 9_000],
    ]);
  });

  it('counts active dwell once while several blocks overlap, and only while one is visible', () => {
    const t = tracker();
    see(t, 'a', 1, 2_000);
    see(t, 'b', 1, 3_000);
    see(t, 'a', 0, 4_000);
    see(t, 'b', 0, 6_000);
    const report = t.report(10_000);
    expect(report.activeIntervalsMs).toEqual([[1_000, 5_000]]);
  });

  it('reports an interval still open as it goes and keeps it open', () => {
    const t = tracker();
    see(t, 'a', 1, 2_000);
    expect(t.report(5_000).blocks[0]?.intervalsMs).toEqual([[1_000, 4_000]]);
    expect(t.report(9_000).blocks[0]?.intervalsMs).toEqual([[4_000, 8_000]]);
    see(t, 'a', 0, 9_500);
    expect(t.report(12_000).blocks[0]?.intervalsMs).toEqual([[8_000, 8_500]]);
    expect(t.hasContent()).toBe(false);
  });

  it('drops an interval that rounds to nothing and clamps fractions to [0, 1]', () => {
    const t = tracker();
    see(t, 'a', 7, 2_000);
    see(t, 'a', Number.NaN, 2_000.2);
    see(t, 'b', -3, 2_000);
    const report = t.report(3_000);
    expect(report.blocks).toEqual([]);
    expect(report.activeIntervalsMs).toEqual([]);
  });

  it("keeps what exceeds one event's bounds for the next report instead of sending too much", () => {
    const t = tracker();
    const intervals = OBSERVATION_LIMITS.maxIntervalsPerBlock + 3;
    for (let index = 0; index < intervals; index += 1) {
      see(t, 'a', 1, 2_000 + index * 100);
      see(t, 'a', 0, 2_050 + index * 100);
    }
    const first = t.report(10_000);
    expect(first.blocks[0]?.intervalsMs).toHaveLength(OBSERVATION_LIMITS.maxIntervalsPerBlock);
    expect(t.hasMore()).toBe(true);
    const second = t.report(10_000);
    expect(second.blocks[0]?.intervalsMs).toHaveLength(3);
    expect(t.hasMore()).toBe(false);
  });

  it("limits one coverage report to the contract's block count", () => {
    const t = tracker();
    for (let index = 0; index < OBSERVATION_LIMITS.maxBlocksPerCoverage + 2; index += 1) {
      see(t, `block-${String(index)}`, 1, 2_000);
      see(t, `block-${String(index)}`, 0, 3_000);
    }
    expect(t.report(5_000).blocks).toHaveLength(OBSERVATION_LIMITS.maxBlocksPerCoverage);
    expect(t.hasMore()).toBe(true);
    expect(t.report(5_000).blocks).toHaveLength(2);
  });

  it('keeps a deliberate interaction once per block and kind, with no value, and ignores unknown kinds', () => {
    const t = tracker();
    t.interaction({ blockId: 'sim-1', kind: 'control', at: 2_000 });
    t.interaction({ blockId: 'sim-1', kind: 'control', at: 2_500 });
    t.interaction({ blockId: 'sim-1', kind: 'step', at: 3_000 });
    t.interaction({ blockId: 'sim-1', kind: 'slider' as never, at: 3_000 });
    expect(t.report(4_000).interactions).toEqual([
      { blockId: 'sim-1', kind: 'control', atMs: 1_000 },
      { blockId: 'sim-1', kind: 'step', atMs: 2_000 },
    ]);
    // Reported once for the session: the same interaction again adds nothing new.
    t.interaction({ blockId: 'sim-1', kind: 'control', at: 5_000 });
    expect(t.report(6_000).interactions).toEqual([]);
  });
});
