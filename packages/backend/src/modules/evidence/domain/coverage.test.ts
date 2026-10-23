import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import type { ReadingFacts, CoverageHead } from '../../content/public.js';
import { observedBindings, type CoverageEvidence } from './coverage.js';
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
