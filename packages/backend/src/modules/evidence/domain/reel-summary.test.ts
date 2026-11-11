import { describe, expect, it } from 'vitest';
import type { ObservationRecord } from './reading-summary.js';
import { REEL_WATCHED_POLICY, summariseReel, watchedMedia } from './reel-summary.js';
function observation(seq: number, from: number, to: number): ObservationRecord {
  return {
    seq,
    sessionId: 'fixture',
    deviceSequence: seq,
    instrumentationVersion: 1,
    body: { kind: 'reel.playback', samples: [{ activeMs: [from, to], mediaMs: [from, to] }] },
  };
}
describe('Reel qualification is unique visible media over duration', () => {
  it('does not count overlapping, duplicated or looped media twice', () => {
    const report = observation(1, 0, 15000);
    const loop: ObservationRecord = {
      ...observation(2, 0, 15000),
      body: { kind: 'reel.playback', samples: [{ activeMs: [15000, 30000], mediaMs: [0, 15000] }] },
    };
    expect(summariseReel([report, report, loop], 30000)).toMatchObject({
      q: 0.5,
      activeDwellMs: 30000,
      qualification: 'not_qualified',
    });
  });
  it('caps coverage by active time, ignores Scroll bodies, and leaves missing/gapped measurement unknown', () => {
    expect(summariseReel([], 30000).qualification).toBe('unknown');
    expect(
      summariseReel([{ ...observation(1, 0, 1000), body: { kind: 'reel.playback', samples: [] } }], 30000)
        .qualification,
    ).toBe('unknown');
    expect(summariseReel([observation(2, 0, 1000)], 30000).qualification).toBe('unknown');
    expect(summariseReel([observation(1, 0, 20000)], 30000)).toMatchObject({ q: 0.6667, qualification: 'qualified' });
    const inflated = observation(1, 0, 20000);
    expect(
      summariseReel(
        [{ ...inflated, body: { kind: 'reel.playback', samples: [{ activeMs: [0, 1000], mediaMs: [0, 20000] }] } }],
        30000,
      ).q,
    ).toBe(0.0333);
  });
});

describe('which media a Reel summary says was watched (#674, slice 5.1)', () => {
  const sample = (activeMs: [number, number], mediaMs: [number, number]) => ({
    activeMs,
    mediaMs,
  });
  const report = (seq: number, ...samples: ReturnType<typeof sample>[]): ObservationRecord => ({
    seq,
    sessionId: 'fixture',
    deviceSequence: seq,
    instrumentationVersion: 1,
    body: { kind: 'reel.playback', samples },
  });

  it('records the unique media windows beside q, without changing q or the qualification', () => {
    const summary = summariseReel([observation(1, 0, 12_000), observation(2, 20_000, 28_000)], 30_000);
    expect(summary.summary).toMatchObject({
      v: 2,
      durationMs: 30_000,
      reports: 2,
      watched: [
        [0, 12_000],
        [20_000, 28_000],
      ],
    });
    expect(summary).toMatchObject({ q: 0.6667, qualification: 'qualified' });
  });

  it('merges overlaps, duplicates and a loop into the windows that were met once', () => {
    const loop = report(3, sample([15_000, 16_000], [0, 1000]));
    const summary = summariseReel(
      [observation(1, 0, 8000), observation(2, 6000, 14_000), observation(1, 0, 8000), loop],
      30_000,
    );
    expect(summary.summary.watched).toEqual([[0, 14_000]]);
  });

  it('rounds each window inward to the grid, so what is recorded is never more than was watched', () => {
    const summary = summariseReel(
      [report(1, sample([0, 1000], [130, 1090]), sample([1000, 2000], [1090, 1930]))],
      30_000,
    );
    // 130 to 1930 merges into one window; rounded inward it is 200 to 1900.
    expect(summary.summary.watched).toEqual([[200, 1900]]);
  });

  it('attributes no position to media that more than the active time could have produced', () => {
    const inflated = report(
      1,
      sample([0, 1000], [0, 1000]),
      sample([0, 1000], [20_000, 21_000]),
      sample([0, 1000], [10_000, 11_000]),
    );
    expect(summariseReel([inflated], 30_000).summary.watched).toEqual([]);
    expect(watchedMedia([[0, 30_000]], 1000)).toEqual([]);
    expect(watchedMedia([[0, 30_000]], 30_000)).toEqual([[0, 30_000]]);
  });

  it('keeps at most the policy’s number of windows, the longest, in order', () => {
    const windows: [number, number][] = Array.from({ length: 40 }, (_, index) => [
      index * 1000,
      index * 1000 + 500 + index * 10,
    ]);
    const watched = watchedMedia(windows, 60_000);
    expect(watched).toHaveLength(REEL_WATCHED_POLICY.maxIntervals);
    // Rounded inward the ten shortest are equal, so the later eight of them are dropped; the rest stay in order.
    const starts = watched.map(([from]) => from);
    expect(starts.slice(0, 3)).toEqual([0, 1000, 10_000]);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
