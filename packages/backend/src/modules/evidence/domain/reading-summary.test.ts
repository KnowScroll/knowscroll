import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { mergeIntervals, type Interval } from './intervals.js';
import {
  SCROLL_QUALIFICATION_POLICY_V0,
  SCROLL_RECORDING_QUALIFICATION_POLICY,
  SCROLL_SHARED_QUALIFICATION_POLICY,
  type ScrollQualificationPolicy,
} from './policy.js';
import { qualifyScrollReading } from './qualification.js';
import { sharedVisibleMs, summariseReading, type ObservationRecord, type ReadingFacts } from './reading-summary.js';

/** What `sharedVisibleMs` is given for one unit: its reported visible intervals and its peak fraction. */
const shown = (...intervals: Interval[]) => ({ intervals, peak: 1 });
const equalWeights = () => 1;

describe('the shared clock: sharedVisibleMs divides each moment between the units on screen (#761)', () => {
  it('gives a unit on its own all of its time', () => {
    const earned = sharedVisibleMs(new Map([['a', shown([0, 4_000])]]), [[0, 10_000]], equalWeights);
    expect(earned.get('a')).toBe(4_000);
  });

  it('gives two units of equal weight that are fully on screen together half each', () => {
    const earned = sharedVisibleMs(
      new Map([
        ['a', shown([0, 4_000])],
        ['b', shown([0, 4_000])],
      ]),
      [[0, 4_000]],
      equalWeights,
    );
    expect([earned.get('a'), earned.get('b')]).toEqual([2_000, 2_000]);
  });

  it('splits a moment in proportion to the weights, so a unit of 1 against a unit of 3 gets a quarter', () => {
    const earned = sharedVisibleMs(
      new Map([
        ['light', shown([0, 4_000])],
        ['heavy', shown([0, 4_000])],
      ]),
      [[0, 4_000]],
      (id) => (id === 'light' ? 1 : 3),
    );
    expect([earned.get('light'), earned.get('heavy')]).toEqual([1_000, 3_000]);
  });

  it('shares only the part of the screen time two units have in common', () => {
    const earned = sharedVisibleMs(
      new Map([
        ['a', shown([0, 3_000])],
        ['b', shown([1_000, 2_000])],
      ]),
      [[0, 3_000]],
      equalWeights,
    );
    // a: 1 s alone, 1 s shared (0.5 s), 1 s alone. b: 0.5 s.
    expect([earned.get('a'), earned.get('b')]).toEqual([2_500, 500]);
  });

  it('earns nothing for a moment outside the active time, however long the unit was on screen', () => {
    const earned = sharedVisibleMs(new Map([['a', shown([0, 10_000])]]), [[2_000, 5_000]], equalWeights);
    expect(earned.get('a')).toBe(3_000);
    expect(sharedVisibleMs(new Map([['a', shown([0, 10_000])]]), [], equalWeights).size).toBe(0);
  });

  it('lets a unit of no weight still take a share of the moment, as a unit of weight 1', () => {
    // A screen of headings is not free reading: a weightless unit is not skipped from the divisor.
    expect(sharedVisibleMs(new Map([['a', shown([0, 1_000])]]), [[0, 1_000]], () => 0).get('a')).toBe(1_000);
    const withEqual = sharedVisibleMs(
      new Map([
        ['empty', shown([0, 2_000])],
        ['one', shown([0, 2_000])],
      ]),
      [[0, 2_000]],
      (id) => (id === 'empty' ? 0 : 1),
    );
    expect([withEqual.get('empty'), withEqual.get('one')]).toEqual([1_000, 1_000]);
    const withThree = sharedVisibleMs(
      new Map([
        ['empty', shown([0, 4_000])],
        ['three', shown([0, 4_000])],
      ]),
      [[0, 4_000]],
      (id) => (id === 'empty' ? 0 : 3),
    );
    expect([withThree.get('empty'), withThree.get('three')]).toEqual([1_000, 3_000]);
  });

  it('adds the time of disjoint intervals', () => {
    const earned = sharedVisibleMs(new Map([['a', shown([0, 1_000], [5_000, 6_000])]]), [[0, 10_000]], equalWeights);
    expect(earned.get('a')).toBe(2_000);
  });

  it('counts touching intervals once, without a gap or a double count at the join', () => {
    const earned = sharedVisibleMs(new Map([['a', shown([0, 1_000], [1_000, 2_000])]]), [[0, 5_000]], equalWeights);
    expect(earned.get('a')).toBe(2_000);
  });

  it('adds nothing for a duplicate or overlapping report, alone or beside another unit', () => {
    const alone = sharedVisibleMs(
      new Map([['a', shown([0, 1_000], [0, 1_000], [500, 1_500])]]),
      [[0, 5_000]],
      equalWeights,
    );
    expect(alone.get('a')).toBe(1_500);
    // A duplicate of a's report must not make a count twice in the divisor.
    const beside = sharedVisibleMs(
      new Map([
        ['a', shown([0, 1_000], [0, 1_000])],
        ['b', shown([0, 1_000])],
      ]),
      [[0, 1_000]],
      equalWeights,
    );
    expect([beside.get('a'), beside.get('b')]).toEqual([500, 500]);
  });

  // Small ranges, because the oracle below counts millisecond cells.
  const traces = fc.array(
    fc.record({
      unit: fc.constantFrom('a', 'b', 'c', 'd'),
      from: fc.integer({ min: 0, max: 500 }),
      length: fc.integer({ min: 1, max: 300 }),
    }),
    { maxLength: 12 },
  );
  const activeTraces = fc.array(
    fc.record({ from: fc.integer({ min: 0, max: 500 }), length: fc.integer({ min: 1, max: 400 }) }),
    { maxLength: 4 },
  );
  const cellsOf = (intervals: readonly Interval[]): Set<number> => {
    const cells = new Set<number>();
    for (const [from, to] of intervals) for (let ms = from; ms < to; ms += 1) cells.add(ms);
    return cells;
  };
  test.prop([traces, activeTraces, fc.integer({ min: 0, max: 5 })])(
    'shares every active moment out in full: the shares add up to the length of the visible time that was active',
    (reports, active, weightSeed) => {
      const visible = new Map<string, { intervals: Interval[]; peak: number }>();
      for (const report of reports) {
        const entry = visible.get(report.unit) ?? { intervals: [], peak: 1 };
        entry.intervals.push([report.from, report.from + report.length]);
        visible.set(report.unit, entry);
      }
      // The caller passes the merged union of the active intervals, as summariseReading does.
      const activeUnion = mergeIntervals(active.map((a): Interval => [a.from, a.from + a.length]));
      const earned = sharedVisibleMs(visible, activeUnion, (id) => (id.charCodeAt(0) + weightSeed) % 4);
      const visibleCells = cellsOf(reports.map((r): Interval => [r.from, r.from + r.length]));
      const activeCells = cellsOf(activeUnion);
      const expected = [...visibleCells].filter((ms) => activeCells.has(ms)).length;
      const total = [...earned.values()].reduce((sum, ms) => sum + ms, 0);
      expect(total).toBeCloseTo(expected, 6);
      for (const ms of earned.values()) expect(ms).toBeGreaterThan(0);
    },
  );
});

/**
 * The worked example of the design (Folio README 7.2): an essay of 13 beats of 35 words, 455 words, with an estimated
 * reading time of about 119 s. A beat needs 40 % of the time its words take at 230 words a minute, about 3.65 s.
 */
const BEAT_COUNT = 13;
const BEAT_WORDS = 35;
const WORDS_PER_MINUTE = 230;
// Computed here, not imported, so a change to content's rule shows as a failure of this fixture's assumption.
const BEAT_MIN_VISIBLE_MS = Math.round(((BEAT_WORDS * 60_000) / WORDS_PER_MINUTE) * 0.4);
const beatIds = Array.from({ length: BEAT_COUNT }, (_, index) => `beat-${index + 1}`);
const essay: ReadingFacts = {
  totalWeight: BEAT_COUNT * BEAT_WORDS,
  estimatedReadingMs: 119_000,
  blocks: beatIds.map((id) => ({
    id,
    weight: BEAT_WORDS,
    seen: { kind: 'visible', minVisibleMs: BEAT_MIN_VISIBLE_MS },
  })),
  nested: [],
};

/** One stretch of reading: which beats were on screen (by index), from when to when. */
interface Screen {
  readonly beats: readonly number[];
  readonly from: number;
  readonly to: number;
}

/** The observations of a reading made of screens: a coverage report of each beat and the active time they span. */
function readingOf(screens: readonly Screen[], peakFraction = 1): ObservationRecord[] {
  const intervals = new Map<string, Interval[]>();
  for (const screen of screens)
    for (const beat of screen.beats) {
      const id = beatIds[beat] ?? `missing-${beat}`;
      intervals.set(id, [...(intervals.get(id) ?? []), [screen.from, screen.to]]);
    }
  return [
    {
      seq: 1,
      sessionId: 's1',
      deviceSequence: 1,
      instrumentationVersion: 1,
      body: {
        kind: 'scroll.block_coverage',
        blocks: [...intervals].map(([blockId, intervalsMs]) => ({ blockId, intervalsMs, peakFraction })),
      },
    },
    {
      seq: 2,
      sessionId: 's1',
      deviceSequence: 2,
      instrumentationVersion: 1,
      body: { kind: 'scroll.active_dwell', activeIntervalsMs: screens.map((s): Interval => [s.from, s.to]) },
    },
  ];
}

/**
 * Four beats a screen over four screens. The last screen is the end of the page, so it shows beats 10 to 13 and the
 * three before the last stay on screen for two screens.
 */
const fourToAScreen = (msPerScreen: number): Screen[] => [
  { beats: [0, 1, 2, 3], from: 0, to: msPerScreen },
  { beats: [4, 5, 6, 7], from: msPerScreen, to: 2 * msPerScreen },
  { beats: [8, 9, 10, 11], from: 2 * msPerScreen, to: 3 * msPerScreen },
  { beats: [9, 10, 11, 12], from: 3 * msPerScreen, to: 4 * msPerScreen },
];
/** One beat on screen at a time, each for `msPerBeat`: a reader who gives every beat its own screen. */
const oneAtATime = (msPerBeat: number): Screen[] =>
  beatIds.map((_, index) => ({ beats: [index], from: index * msPerBeat, to: (index + 1) * msPerBeat }));

const judge = (records: readonly ObservationRecord[], policy: ScrollQualificationPolicy) => {
  const summary = summariseReading(records, essay, policy);
  return { summary, result: qualifyScrollReading(summary, policy) };
};

describe('the worked example of the design (Folio README 7.2): 13 beats of 35 words, estimated reading 119 s', () => {
  it('needs about 3.65 s for a beat of 35 words', () => {
    expect(BEAT_MIN_VISIBLE_MS).toBe(3_652);
  });

  it('skimmer, four beats a screen at six seconds a screen: the per-unit clock credits every beat and qualifies it, the shared clock credits none', () => {
    const records = readingOf(fourToAScreen(6_000));

    const perUnit = judge(records, SCROLL_RECORDING_QUALIFICATION_POLICY);
    expect(perUnit.summary.seenBlocks).toEqual(beatIds);
    expect(perUnit.result).toMatchObject({
      qualification: 'qualified',
      coverage: 1,
      activeDwellMs: 24_000,
    });
    expect(perUnit.result.dwellRatio).toBeCloseTo(0.2, 2);
    expect(perUnit.result.q).toBeCloseTo(0.6, 2);

    // Each beat earns about 1.5 s of every six, so even the three that stay for two screens (3 s) fall short of 3.65 s.
    const shared = judge(records, SCROLL_SHARED_QUALIFICATION_POLICY);
    expect(shared.summary.seenBlocks).toEqual([]);
    expect(shared.result).toMatchObject({
      qualification: 'not_qualified',
      coverage: 0,
      reasons: ['no_visibility'],
    });
  });

  it('fast reader, 48 s in all with each beat alone on screen for 3.7 s: the shared clock gives each beat its 40 % and qualifies the reading', () => {
    const records = readingOf(oneAtATime(3_700));

    const shared = judge(records, SCROLL_SHARED_QUALIFICATION_POLICY);
    expect(shared.summary.seenBlocks).toEqual(beatIds);
    expect(shared.result).toMatchObject({ qualification: 'qualified', coverage: 1, activeDwellMs: 48_100 });
    expect(shared.result.q).toBeCloseTo(0.7, 2);

    // Alone on screen a beat earns the same on either clock, so this reading qualifies on both.
    expect(judge(records, SCROLL_RECORDING_QUALIFICATION_POLICY).result).toMatchObject({
      qualification: 'qualified',
      coverage: 1,
      q: shared.result.q,
    });
  });

  it('fast reader, the same 48 s with four beats a screen: the shared clock does not qualify it', () => {
    // 12 s a screen is 3 s a beat. The speed is the same as above; what changed is how much is on screen at once.
    const shared = judge(readingOf(fourToAScreen(12_000)), SCROLL_SHARED_QUALIFICATION_POLICY);
    expect(shared.result.qualification).toBe('not_qualified');
    expect(shared.result.activeDwellMs).toBe(48_000);
  });

  it('careful reader at 230 words a minute, 119 s over four screens: qualified on both clocks with coverage and q of 1', () => {
    const records = readingOf(fourToAScreen(29_750));
    for (const policy of [SCROLL_RECORDING_QUALIFICATION_POLICY, SCROLL_SHARED_QUALIFICATION_POLICY]) {
      const { summary, result } = judge(records, policy);
      expect(summary.seenBlocks, policy.version).toEqual(beatIds);
      expect(result, policy.version).toMatchObject({
        qualification: 'qualified',
        coverage: 1,
        dwellRatio: 1,
        q: 1,
        reasons: [],
      });
    }
  });
});

describe('the rules of seeing a unit still apply on the shared clock', () => {
  const two: ReadingFacts = {
    totalWeight: 10,
    estimatedReadingMs: 10_000,
    blocks: [
      { id: 'a', weight: 5 },
      { id: 'b', weight: 5 },
    ],
    nested: [],
  };
  const reading = (
    blocks: readonly { blockId: string; intervalsMs: Interval[]; peakFraction: number }[],
    active: Interval[],
  ): ObservationRecord[] => [
    {
      seq: 1,
      sessionId: 's',
      deviceSequence: 1,
      instrumentationVersion: 1,
      body: { kind: 'scroll.block_coverage', blocks },
    },
    {
      seq: 2,
      sessionId: 's',
      deviceSequence: 2,
      instrumentationVersion: 1,
      body: { kind: 'scroll.active_dwell', activeIntervalsMs: active },
    },
  ];
  const seen = (
    records: readonly ObservationRecord[],
    policy: ScrollQualificationPolicy,
    facts: ReadingFacts = two,
  ): readonly string[] => summariseReading(records, facts, policy).seenBlocks;

  it('needs the peak fraction of the policy: a unit that was never half visible is not seen however long it stayed', () => {
    const faint = reading([{ blockId: 'a', intervalsMs: [[0, 20_000]], peakFraction: 0.4 }], [[0, 20_000]]);
    expect(seen(faint, SCROLL_SHARED_QUALIFICATION_POLICY)).toEqual([]);
    const enough = reading([{ blockId: 'a', intervalsMs: [[0, 20_000]], peakFraction: 0.5 }], [[0, 20_000]]);
    expect(seen(enough, SCROLL_SHARED_QUALIFICATION_POLICY)).toEqual(['a']);
  });

  it("applies the 500 ms floor to the unit's share of the screen, not to the time it was on screen", () => {
    // Two units on screen together for 900 ms: 450 ms each on the shared clock, 900 ms each on the per-unit clock.
    const together = (ms: number) =>
      reading(
        [
          { blockId: 'a', intervalsMs: [[0, ms]], peakFraction: 1 },
          { blockId: 'b', intervalsMs: [[0, ms]], peakFraction: 1 },
        ],
        [[0, ms]],
      );
    expect(seen(together(900), SCROLL_SHARED_QUALIFICATION_POLICY)).toEqual([]);
    expect(seen(together(900), SCROLL_RECORDING_QUALIFICATION_POLICY)).toEqual(['a', 'b']);
    expect(seen(together(999), SCROLL_SHARED_QUALIFICATION_POLICY)).toEqual([]);
    expect(seen(together(1_000), SCROLL_SHARED_QUALIFICATION_POLICY)).toEqual(['a', 'b']);
  });

  it("lets a unit's own minimum raise the share it needs, and never lower the floor", () => {
    const own = (minVisibleMs: number): ReadingFacts => ({
      ...two,
      blocks: [{ id: 'a', weight: 5, seen: { kind: 'visible', minVisibleMs } }, two.blocks[1]!],
    });
    const alone = (ms: number) => reading([{ blockId: 'a', intervalsMs: [[0, ms]], peakFraction: 1 }], [[0, ms]]);
    expect(seen(alone(3_651), SCROLL_SHARED_QUALIFICATION_POLICY, own(3_652))).toEqual([]);
    expect(seen(alone(3_652), SCROLL_SHARED_QUALIFICATION_POLICY, own(3_652))).toEqual(['a']);
    // A minimum of 100 ms is under the floor of 500 ms, so 400 ms is still not enough.
    expect(seen(alone(400), SCROLL_SHARED_QUALIFICATION_POLICY, own(100))).toEqual([]);
    expect(seen(alone(500), SCROLL_SHARED_QUALIFICATION_POLICY, own(100))).toEqual(['a']);
  });

  it('counts only active time: a unit on screen while the article was in the background earns no share', () => {
    const background = reading([{ blockId: 'a', intervalsMs: [[0, 20_000]], peakFraction: 1 }], [[30_000, 40_000]]);
    expect(seen(background, SCROLL_SHARED_QUALIFICATION_POLICY)).toEqual([]);
  });
});

describe('a per-unit policy is the clock it always was', () => {
  it('gives the old numbers under the v0 and the recording policy, which differ from the shared policy only in clock and label', () => {
    // Four units on screen together for 3 s: each is credited all 3 s on a per-unit clock.
    const facts: ReadingFacts = {
      totalWeight: 40,
      estimatedReadingMs: 10_000,
      blocks: ['a', 'b', 'c', 'd'].map((id) => ({ id, weight: 10 })),
      nested: [],
    };
    const records: ObservationRecord[] = [
      {
        seq: 1,
        sessionId: 's',
        deviceSequence: 1,
        instrumentationVersion: 1,
        body: {
          kind: 'scroll.block_coverage',
          blocks: ['a', 'b', 'c', 'd'].map((blockId) => ({ blockId, intervalsMs: [[0, 3_000]], peakFraction: 1 })),
        },
      },
      {
        seq: 2,
        sessionId: 's',
        deviceSequence: 2,
        instrumentationVersion: 1,
        body: { kind: 'scroll.active_dwell', activeIntervalsMs: [[0, 3_000]] },
      },
    ];
    const results = [SCROLL_QUALIFICATION_POLICY_V0, SCROLL_RECORDING_QUALIFICATION_POLICY].map((policy) => {
      const summary = summariseReading(records, facts, policy);
      return { summary, result: qualifyScrollReading(summary, policy) };
    });
    for (const { summary, result } of results) {
      expect(summary.seenBlocks).toEqual(['a', 'b', 'c', 'd']);
      expect(result).toMatchObject({ coverage: 1, dwellRatio: 0.3, q: 0.65, qualification: 'qualified' });
    }
    expect(results[0]?.summary).toEqual(results[1]?.summary);
    // The same reading on the shared clock gives each unit 750 ms: above the 500 ms floor, so each is still seen.
    expect(summariseReading(records, facts, SCROLL_SHARED_QUALIFICATION_POLICY).seenBlocks).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(SCROLL_SHARED_QUALIFICATION_POLICY).toMatchObject({
      ...SCROLL_QUALIFICATION_POLICY_V0,
      version: 'scroll-qualification.shared.v1',
      clock: 'shared',
    });
  });
});
