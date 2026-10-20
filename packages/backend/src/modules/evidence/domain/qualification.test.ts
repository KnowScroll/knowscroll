import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { SCROLL_QUALIFICATION_POLICY_V0 as policy, type ScrollQualificationPolicy } from './policy.js';
import { qualifyScrollReading } from './qualification.js';
import {
  summariseReading,
  type ObservationBody,
  type ObservationRecord,
  type ReadingFacts,
} from './reading-summary.js';

/** Four top-level blocks of weights 10, 10, 20 and 60 (word-equivalents) and one nested in the third. */
const facts: ReadingFacts = {
  totalWeight: 100,
  estimatedReadingMs: 100_000,
  blocks: [
    { id: 'a', weight: 10 },
    { id: 'b', weight: 10 },
    { id: 'c', weight: 20 },
    { id: 'd', weight: 60 },
  ],
  nested: [{ id: 'c-child', owner: 'c' }],
};

let seq = 0;
function observation(
  body: ObservationBody,
  options: { sessionId?: string; deviceSequence?: number; instrumentationVersion?: number } = {},
): ObservationRecord {
  seq += 1;
  return {
    seq,
    sessionId: options.sessionId ?? 's1',
    deviceSequence: options.deviceSequence ?? seq,
    instrumentationVersion: options.instrumentationVersion ?? 1,
    body,
  };
}

function reading(
  blocksSeen: readonly [string, number, number][],
  active: readonly [number, number][],
): ObservationRecord[] {
  // Sequence numbers restart at 1 for each reading, like a recorder session.
  seq = 0;
  return [
    observation({
      kind: 'scroll.block_coverage',
      blocks: blocksSeen.map(([blockId, from, to]) => ({ blockId, intervalsMs: [[from, to]], peakFraction: 1 })),
    }),
    observation({ kind: 'scroll.active_dwell', activeIntervalsMs: active }),
  ];
}

const qualify = (records: readonly ObservationRecord[], p: ScrollQualificationPolicy = policy) =>
  qualifyScrollReading(summariseReading(records, facts, p), p);

describe('Scroll qualification (blueprint §8), as pure functions of the observations', () => {
  it('computes q = 0.5 · weighted coverage + 0.5 · min(1, dwell / estimate)', () => {
    // Blocks c and d seen: (20 + 60) / 100 = 0.8; dwell 50 s of an estimated 100 s = 0.5.
    const result = qualify(
      reading(
        [
          ['c', 0, 5_000],
          ['d', 5_000, 50_000],
        ],
        [[0, 50_000]],
      ),
    );
    expect(result).toMatchObject({ coverage: 0.8, dwellRatio: 0.5, q: 0.65, qualification: 'qualified', reasons: [] });
  });

  it('weights coverage by content size: many tiny blocks do not dominate', () => {
    const result = qualify(
      reading(
        [
          ['a', 0, 5_000],
          ['b', 5_000, 10_000],
        ],
        [[0, 100_000]],
      ),
    );
    // Dwell is complete and q = 0.5 · 0.2 + 0.5 · 1 = 0.6, but coverage 0.2 is below 0.5.
    expect(result).toMatchObject({
      coverage: 0.2,
      q: 0.6,
      qualification: 'not_qualified',
      reasons: ['coverage_below_minimum'],
    });
  });

  it('needs q of at least 0.6, coverage of at least 0.5 and some visibility', () => {
    const d: [string, number, number][] = [['d', 0, 5_000]];
    // Coverage 0.6, dwell ratio 0.1: q = 0.35.
    expect(qualify(reading(d, [[0, 10_000]]))).toMatchObject({
      qualification: 'not_qualified',
      reasons: ['q_below_minimum'],
    });
    // The same coverage with enough dwell passes.
    expect(qualify(reading(d, [[0, 100_000]]))).toMatchObject({ qualification: 'qualified' });
    // Nothing visible at all.
    expect(qualify(reading([], [[0, 100_000]]))).toMatchObject({
      qualification: 'not_qualified',
      reasons: ['no_visibility'],
    });
  });

  it('counts only time while the article was active: background visibility adds no coverage', () => {
    const result = qualify(reading([['d', 0, 40_000]], [[100_000, 140_000]]));
    expect(result.coverage).toBe(0);
  });

  it('counts a nested block for the block that owns it, and ignores a block the revision does not have', () => {
    const summary = summariseReading(
      reading(
        [
          ['c-child', 0, 5_000],
          ['ghost', 0, 5_000],
        ],
        [[0, 5_000]],
      ),
      facts,
      policy,
    );
    expect(summary.seenBlocks).toEqual(['c']);
    expect(summary.coverage).toBe(0.2);
  });

  it('requires a block to be visible long enough, and to have reached the peak fraction', () => {
    const records = reading([['d', 0, policy.minBlockVisibleMs - 1]], [[0, 100_000]]);
    expect(summariseReading(records, facts, policy).seenBlocks).toEqual([]);
    const faint: ObservationRecord[] = [
      observation({
        kind: 'scroll.block_coverage',
        blocks: [{ blockId: 'd', intervalsMs: [[0, 9_000]], peakFraction: 0.4 }],
      }),
      observation({ kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 9_000]] }),
    ];
    expect(summariseReading(faint, facts, policy).seenBlocks).toEqual([]);
  });

  it('leaves the result unknown, not negative, when instrumentation is missing', () => {
    seq = 0;
    const onlyCoverage = [
      observation({
        kind: 'scroll.block_coverage',
        blocks: [{ blockId: 'a', intervalsMs: [[0, 4_000]], peakFraction: 1 }],
      }),
    ];
    expect(qualify(onlyCoverage)).toMatchObject({ qualification: 'unknown' });
    expect(qualify(onlyCoverage).reasons).toContain('instrumentation_missing');
    seq = 0;
    const onlyDwell = [observation({ kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 4_000]] })];
    expect(qualify(onlyDwell)).toMatchObject({ qualification: 'unknown' });
  });

  it('leaves a short reading unknown when device sequence numbers are missing, but keeps a qualified one', () => {
    seq = 0;
    const withGap = [
      observation(
        { kind: 'scroll.block_coverage', blocks: [{ blockId: 'a', intervalsMs: [[0, 4_000]], peakFraction: 1 }] },
        { deviceSequence: 1 },
      ),
      observation({ kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 4_000]] }, { deviceSequence: 4 }),
    ];
    const short = qualify(withGap);
    expect(short.qualification).toBe('unknown');
    expect(short.reasons).toContain('sequence_gaps');
    seq = 0;
    const long = [
      observation(
        { kind: 'scroll.block_coverage', blocks: [{ blockId: 'd', intervalsMs: [[0, 90_000]], peakFraction: 1 }] },
        { deviceSequence: 1 },
      ),
      observation({ kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 90_000]] }, { deviceSequence: 4 }),
    ];
    expect(qualify(long).qualification).toBe('qualified');
  });

  it('takes every parameter from the versioned policy record', () => {
    const lenient: ScrollQualificationPolicy = {
      ...policy,
      version: 'scroll-qualification.test',
      minQ: 0.2,
      minCoverage: 0.1,
    };
    const records = reading([['a', 0, 5_000]], [[0, 10_000]]);
    expect(qualify(records, policy).qualification).toBe('not_qualified');
    expect(qualify(records, lenient).qualification).toBe('qualified');
    expect(policy.version).toBe('scroll-qualification.v0');
    expect([policy.coverageWeight, policy.dwellWeight, policy.minQ, policy.minCoverage]).toEqual([0.5, 0.5, 0.6, 0.5]);
  });

  test.prop([
    fc.array(
      fc.record({
        block: fc.constantFrom('a', 'b', 'c', 'd', 'c-child'),
        from: fc.integer({ min: 0, max: 100_000 }),
        length: fc.integer({ min: 1, max: 60_000 }),
      }),
      { maxLength: 8 },
    ),
    fc.array(fc.tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 60_000 })), { maxLength: 6 }),
  ])('q and coverage stay in [0, 1], and the same observations always give the same result', (shown, active) => {
    const records = reading(
      shown.map((entry): [string, number, number] => [entry.block, entry.from, entry.from + entry.length]),
      active.map(([from, length]): [number, number] => [from, from + length]),
    );
    const first = qualify(records);
    expect(first.q).toBeGreaterThanOrEqual(0);
    expect(first.q).toBeLessThanOrEqual(1);
    expect(first.coverage).toBeLessThanOrEqual(1);
    expect(qualify([...records].reverse())).toEqual(first);
    // Reporting everything a second time under new sequence numbers adds nothing.
    const again = [
      ...records,
      ...records.map((record, index) => ({ ...record, seq: 100 + index, deviceSequence: 100 + index })),
    ];
    expect(qualify(again).coverage).toBe(first.coverage);
    expect(qualify(again).activeDwellMs).toBe(first.activeDwellMs);
  });
});
