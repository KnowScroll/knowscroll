import { describe, expect, it } from 'vitest';
import {
  emptyRecordingCredit,
  recordingCredit,
  RecordingCreditSchema,
  type RecordingCreditSource,
} from './recording-credit.js';
import { activity } from './activity.js';
import { summariseRecordingReading, type ObservationRecord } from './reading-summary.js';
import { SCROLL_RECORDING_QUALIFICATION_POLICY } from './policy.js';
import { summariseReel } from './reel-summary.js';
const ref = { id: '11111111-1111-4111-8111-111111111111', recordingGeneration: 1, revision: 1 };
const source = (q: number | null, qualified = false): RecordingCreditSource => ({
  channels: { q, L: false, B: false, S: 0, H: false, R: false },
  measured: q !== null,
  qualified,
  qualification: q === null ? null : ref,
});
const reduce = (
  base = emptyRecordingCredit(),
  q: number | null = null,
  likedOverride: boolean | null = null,
  savedOverride: boolean | null = null,
) =>
  recordingCredit({
    base,
    previous: emptyRecordingCredit(),
    domain: 'session',
    source: source(q, q !== null && q >= 0.6),
    likedOverride,
    savedOverride,
  });
describe('recording-credit.v1 fixed one-exposure reducer', () => {
  it('carries only the previous EFFECTIVE value across toggles and makes explicit false suppress older true', () => {
    const g1 = reduce(emptyRecordingCredit(), 0.8, true, true);
    const g3 = reduce(g1, null, false, false);
    const g5 = reduce(g3, null);
    expect(g1.channels).toMatchObject({ q: 0.8, L: true, B: true });
    expect(g3.channels).toMatchObject({ q: 0.8, L: false, B: false });
    expect(g5.channels).toEqual(g3.channels);
    expect(g5.qualified).toBe(true);
    expect(g5.segment?.qualified).toBe(false);
    expect(g5.segment?.qualification).toBeNull();
  });
  it('combines factual results from separate clock slots without adding q or counting another encounter', () => {
    const legacy = recordingCredit({
      base: emptyRecordingCredit(),
      previous: emptyRecordingCredit(),
      domain: 'legacy',
      source: source(0.7, true),
      likedOverride: null,
      savedOverride: null,
    });
    const both = recordingCredit({
      base: emptyRecordingCredit(),
      previous: legacy,
      domain: 'session',
      source: source(0.9, true),
      likedOverride: true,
      savedOverride: true,
    });
    expect(both.channels.q).toBe(0.9);
    expect(both.qualified).toBe(true);
    expect(activity(both.channels)).toBe(2.9);
    expect(Object.keys(both).sort()).toEqual(
      ['channels', 'legacy', 'measured', 'qSource', 'qualified', 'qualifiedSource', 'segment', 'version'].sort(),
    );
    expect(RecordingCreditSchema.parse(JSON.parse(JSON.stringify(both)))).toEqual(both);
  });
  it('keeps H/R, caps the unchanged activity arithmetic at three, and rejects qualification without measured proof', () => {
    const retained = reduce();
    const withSignals = { ...retained, channels: { ...retained.channels, H: true, R: true } };
    const resumed = reduce(withSignals, 1, true, true);
    expect(resumed.channels).toMatchObject({ H: true, R: true });
    expect(activity(resumed.channels)).toBe(3);
    expect(() =>
      recordingCredit({
        base: retained,
        previous: retained,
        domain: 'session',
        source: { ...source(null), qualified: true },
        likedOverride: null,
        savedOverride: null,
      }),
    ).toThrow('RECORDING_CREDIT_SOURCE_INVALID');
  });
});
const facts = {
  v: 2 as const,
  totalWeight: 1,
  estimatedReadingMs: 10000,
  blocks: [{ id: 'paragraph', type: 'paragraph' as const, weight: 1 }],
  nested: [],
};
const observation = (sessionId: string, seq: number, body: ObservationRecord['body']): ObservationRecord => ({
  sessionId,
  seq,
  deviceSequence: seq,
  instrumentationVersion: 1,
  body,
});
describe('recording session clock isolation', () => {
  it('cannot intersect one session visibility with another session active dwell', () => {
    const result = summariseRecordingReading(
      [
        observation('one', 1, {
          kind: 'scroll.block_coverage',
          blocks: [{ blockId: 'paragraph', intervalsMs: [[0, 2000]], peakFraction: 1 }],
        }),
        observation('two', 2, { kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 2000]] }),
      ],
      facts,
      SCROLL_RECORDING_QUALIFICATION_POLICY,
      2000,
    );
    expect(result.seenBlocks).toEqual([]);
    expect(result.coverage).toBe(0);
    expect(result.activeDwellMs).toBe(2000);
  });
  it('adds independently observed session dwell only under the one server elapsed ceiling', () => {
    const rows = ['one', 'two'].flatMap((sessionId, i) => [
      observation(sessionId, i * 2 + 1, {
        kind: 'scroll.block_coverage',
        blocks: [{ blockId: 'paragraph', intervalsMs: [[0, 2000]], peakFraction: 1 }],
      }),
      observation(sessionId, i * 2 + 2, { kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 2000]] }),
    ]);
    const result = summariseRecordingReading(rows, facts, SCROLL_RECORDING_QUALIFICATION_POLICY, 2500);
    expect(result.seenBlocks).toEqual(['paragraph']);
    expect(result.activeDwellMs).toBe(2500);
    expect(result.coverage).toBe(1);
  });
  it('does not collapse two Reel session clocks into one interval or exceed server elapsed time', () => {
    const rows = ['one', 'two'].map((sessionId, i) =>
      observation(sessionId, i + 1, {
        kind: 'reel.playback',
        samples: [{ activeMs: [0, 2000], mediaMs: [i * 2000, (i + 1) * 2000] }],
      }),
    );
    expect(summariseReel(rows, 4000, 3000).activeDwellMs).toBe(3000);
    expect(summariseReel(rows, 4000).activeDwellMs).toBe(2000);
  });
});
