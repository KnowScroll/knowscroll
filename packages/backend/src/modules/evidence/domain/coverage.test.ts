import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { REEL_COVERAGE_POLICY, type ReadingFacts, type CoverageHead } from '../../content/public.js';
import {
  observedBindings,
  observedReelBindings,
  REEL_MAPPING_POLICY,
  reelBindingWatched,
  reelSegmentSeen,
  type CoverageEvidence,
} from './coverage.js';
const hash = 'a'.repeat(64);
const facts: ReadingFacts = {
  v: 2,
  measuresVersion: 'fixture',
  totalWeight: 10,
  estimatedReadingMs: 1000,
  blocks: [
    { id: 'one', type: 'paragraph', weight: 5 },
    { id: 'two', type: 'callout', weight: 5 },
  ],
  nested: [{ id: 'hidden', owner: 'disclosure', type: 'paragraph' }],
};
const binding = {
  topicId: 'earth.seasons',
  facetId: 'earth.seasons.axial-tilt',
  meaningSha256: hash,
  requiredBlockIds: ['one', 'two'],
};
const head = { mapping: { readingFactsSha256: hash, bindings: [binding] } } as CoverageHead;
const evidence = (seenBlocks: string[]): CoverageEvidence => ({
  id: '10000000-0000-4000-8000-000000000001',
  revision: 1,
  inputWatermark: 2,
  policyVersion: 'scroll-qualification.v0',
  assetId: '20000000-0000-4000-8000-000000000001',
  assetRevision: 1,
  qualification: 'qualified',
  q: 1,
  coverage: 1,
  estimatedReadingMs: 1000,
  summary: {
    v: 1,
    seenBlocks,
    seenWeight: 10,
    totalWeight: 10,
    dwellRatio: 1,
    interactions: [],
    coverageEvents: 1,
    dwellEvents: 1,
    instrumentationVersion: 1,
    sequenceGaps: 0,
    reasons: [],
  },
});
describe('observed static coverage, labelled source fixtures', () => {
  it('requires ALL-OF actual seen leaves independently of whole-article qualification', () => {
    expect(observedBindings(evidence(['one']), facts, head, () => hash)).toEqual([]);
    expect(observedBindings(evidence(['one', 'two']), facts, head, () => hash)).toEqual([binding]);
    expect(observedBindings(evidence(['foreign']), facts, head, () => hash)).toBeUndefined();
    expect(
      observedBindings({ ...evidence(['one', 'two']), qualification: 'unknown' }, facts, head, () => hash),
    ).toBeUndefined();
    expect(
      observedBindings({ ...evidence(['one', 'two']), policyVersion: 'foreign' }, facts, head, () => hash),
    ).toBeUndefined();
    expect(
      observedBindings(evidence(['one', 'two']), { ...facts, reelDurationMs: 1000 }, head, () => hash),
    ).toBeUndefined();
    expect(observedBindings(evidence(['one', 'two']), facts, head, () => 'b'.repeat(64))).toBeUndefined();
  });
  test.prop([fc.constantFrom('subheading', 'disclosure', 'simulation', 'diagram', 'comparison')])(
    'never promotes unsupported surface types despite seen IDs',
    (type) => {
      expect(
        observedBindings(
          evidence(['one', 'two']),
          { ...facts, blocks: [{ id: 'one', type, weight: 5 }, facts.blocks[1]!] },
          head,
          () => hash,
        ),
      ).toEqual([]);
    },
  );
  it('never promotes descendants or duplicated malformed seen evidence', () => {
    expect(
      observedBindings(
        evidence(['one', 'two']),
        { ...facts, nested: [...facts.nested, { id: 'one', owner: 'disclosure', type: 'paragraph' }] },
        head,
        () => hash,
      ),
    ).toEqual([]);
    expect(observedBindings(evidence(['one', 'one', 'two']), facts, head, () => hash)).toBeUndefined();
  });
});

describe('observed Reel coverage, labelled source fixtures (#674, slice 5.1)', () => {
  const durationMs = 30_000;
  const reelFacts: ReadingFacts = {
    v: 2,
    reelDurationMs: durationMs,
    measuresVersion: 'reel-duration.v1',
    totalWeight: 0,
    estimatedReadingMs: durationMs,
    blocks: [],
    nested: [],
  };
  // First, middle and last segment of a 30 s Reel cut into six.
  const required = {
    requiredBlockIds: ['s1', 's3', 's6'],
    requiredSpans: [
      [0, 4000],
      [10_000, 14_000],
      [24_000, 30_000],
    ] as const,
  };
  const reelBinding = {
    ...binding,
    requiredBlockIds: required.requiredBlockIds,
    requiredSpans: required.requiredSpans,
  };
  const reelHead = { mapping: { readingFactsSha256: hash, bindings: [reelBinding] } } as unknown as CoverageHead;
  const reelEvidence = (watched: [number, number][], over: Partial<CoverageEvidence> = {}): CoverageEvidence => ({
    id: '10000000-0000-4000-8000-000000000002',
    revision: 1,
    inputWatermark: 2,
    policyVersion: 'reel-qualification.v0',
    assetId: '20000000-0000-4000-8000-000000000002',
    assetRevision: 1,
    qualification: 'qualified',
    q: 1,
    coverage: 1,
    estimatedReadingMs: durationMs,
    summary: {
      v: 2,
      uniqueMediaMs: watched.reduce((sum, [from, to]) => sum + to - from, 0),
      durationMs,
      instrumentationVersion: 1,
      sequenceGaps: 0,
      reports: 1,
      watched,
    },
    ...over,
  });
  const bindingsOf = (evidence: CoverageEvidence, facts: ReadingFacts = reelFacts, h: CoverageHead = reelHead) =>
    observedReelBindings(evidence, facts, h, () => hash);

  it('names the same policy as Content, so a Reel exposure is judged only against a Reel mapping', () => {
    expect(REEL_MAPPING_POLICY).toBe(REEL_COVERAGE_POLICY);
  });

  it('binds a facet whose every required segment was watched, including the margin around it', () => {
    expect(bindingsOf(reelEvidence([[0, 30_000]]))).toEqual([reelBinding]);
    expect(
      bindingsOf(
        reelEvidence([
          [0, 5000],
          [9000, 15_000],
          [23_000, 30_000],
        ]),
      ),
    ).toEqual([reelBinding]);
  });

  it('binds nothing for a segment that was not watched: partial watching credits only what it covered', () => {
    // Watched through 26 s: the last segment (24 to 30 s) is not met, so the primary facet is not bound.
    expect(bindingsOf(reelEvidence([[0, 26_000]]))).toEqual([]);
    // Skipped the middle segment.
    expect(
      bindingsOf(
        reelEvidence([
          [0, 5000],
          [15_000, 30_000],
        ]),
      ),
    ).toEqual([]);
    // The segment itself without the margin before it: the window is an estimate, so its neighbours must be seen too.
    expect(
      bindingsOf(
        reelEvidence([
          [0, 4000],
          [10_000, 14_000],
          [24_000, 30_000],
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps a supporting binding that the watching covered when the primary one was not', () => {
    const supporting = {
      ...reelBinding,
      facetId: 'earth.seasons.hemispheres',
      requiredBlockIds: ['s6'],
      requiredSpans: [[24_000, 30_000]],
    };
    const both = {
      mapping: { readingFactsSha256: hash, bindings: [reelBinding, supporting] },
    } as unknown as CoverageHead;
    expect(bindingsOf(reelEvidence([[20_000, 30_000]]), reelFacts, both)).toEqual([supporting]);
  });

  it('binds nothing from evidence that is not a qualified Reel summary of the facts the mapping was decided on', () => {
    const watched: [number, number][] = [[0, 30_000]];
    expect(bindingsOf({ ...reelEvidence(watched), qualification: 'unknown' })).toBeUndefined();
    expect(bindingsOf({ ...reelEvidence(watched), qualification: 'not_qualified' })).toBeUndefined();
    expect(bindingsOf({ ...reelEvidence(watched), q: 0.5 })).toBeUndefined();
    expect(bindingsOf({ ...reelEvidence(watched), policyVersion: 'scroll-qualification.v0' })).toBeUndefined();
    expect(bindingsOf({ ...reelEvidence(watched), policyVersion: 'foreign' })).toBeUndefined();
    // Written before positions were recorded: v1 has no watched windows.
    expect(
      bindingsOf({
        ...reelEvidence(watched),
        summary: { v: 1, uniqueMediaMs: 30_000, durationMs, instrumentationVersion: 1, sequenceGaps: 0, reports: 1 },
      }),
    ).toBeUndefined();
    expect(bindingsOf(reelEvidence([]))).toBeUndefined();
    expect(bindingsOf(reelEvidence(watched), { ...reelFacts, reelDurationMs: 40_000 })).toBeUndefined();
    expect(bindingsOf(reelEvidence(watched), { ...reelFacts, estimatedReadingMs: 1 })).toBeUndefined();
    expect(bindingsOf(reelEvidence(watched), { ...reelFacts, blocks: facts.blocks })).toBeUndefined();
    expect(observedReelBindings(reelEvidence(watched), reelFacts, reelHead, () => 'b'.repeat(64))).toBeUndefined();
    // A Scroll's facts and summary are never a Reel's.
    expect(bindingsOf(evidence(['one', 'two']), facts)).toBeUndefined();
    expect(observedBindings(reelEvidence(watched), reelFacts, reelHead, () => hash)).toBeUndefined();
  });

  it('binds nothing for a binding that carries no windows', () => {
    const noSpans = {
      mapping: { readingFactsSha256: hash, bindings: [{ ...binding, requiredBlockIds: ['s1'] }] },
    } as unknown as CoverageHead;
    expect(bindingsOf(reelEvidence([[0, 30_000]]), reelFacts, noSpans)).toEqual([]);
    expect(
      reelBindingWatched({ requiredBlockIds: ['s1', 's2'], requiredSpans: [[0, 4000]] }, [[0, 30_000]], durationMs),
    ).toBe(false);
  });

  test.prop([fc.integer({ min: 0, max: 29_000 }), fc.integer({ min: 100, max: 30_000 })])(
    'a segment is never seen by watching less of its widened window than the policy allows',
    (start, length) => {
      const end = Math.min(durationMs, start + length);
      const span: [number, number] = [10_000, 14_000];
      const from = Math.max(0, span[0] - 1000);
      const to = Math.min(durationMs, span[1] + 1000);
      const covered = Math.max(0, Math.min(end, to) - Math.max(start, from));
      expect(reelSegmentSeen([[start, end]], span, durationMs)).toBe(covered >= (to - from) * 0.95);
    },
  );
});

describe('a viewer who starts and ends where a player does (#674, slice 5.1)', () => {
  const durationMs = 30_000;
  // First, middle and last segment of a 30 s Reel cut into six, as the mapping stores them.
  const spans = [
    [0, 4286],
    [10_714, 12_857],
    [21_429, 30_000],
  ] as const;

  it('does not require the first and last half second of the Reel, which a player starts after and a recorder ends before', () => {
    expect(spans.every((span) => reelSegmentSeen([[300, 29_650]], span, durationMs))).toBe(true);
    expect(spans.every((span) => reelSegmentSeen([[480, 29_520]], span, durationMs))).toBe(true);
  });

  it('still requires the opening and the close of the Reel when the viewer is well short of them', () => {
    expect(reelSegmentSeen([[1500, 30_000]], spans[0], durationMs)).toBe(false);
    expect(reelSegmentSeen([[0, 28_000]], spans[2], durationMs)).toBe(false);
    expect(reelSegmentSeen([[0, 27_000]], spans[2], durationMs)).toBe(false);
  });

  it('applies the tolerance to the ends of the Reel only, not to the inside of a window', () => {
    // 600 ms missing in the middle of the middle segment's window (4.1 s) is more than the 5% allowed.
    expect(
      reelSegmentSeen(
        [
          [0, 11_300],
          [11_900, 30_000],
        ],
        spans[1],
        durationMs,
      ),
    ).toBe(false);
    expect(
      reelSegmentSeen(
        [
          [0, 11_300],
          [11_450, 30_000],
        ],
        spans[1],
        durationMs,
      ),
    ).toBe(true);
  });

  it('judges a window that spans a short Reel entirely inside the edges as not seen', () => {
    expect(reelSegmentSeen([[0, 800]], [0, 800], 800)).toBe(false);
  });
});
