import { describe, expect, it } from 'vitest';
import type { ObservationRecord } from './reading-summary.js';
import { summariseReel } from './reel-summary.js';
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
