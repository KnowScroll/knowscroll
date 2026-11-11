import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conceptMeaning } from './concepts.js';
import {
  CoverageMappingSchema,
  currentCoverageMapping,
  REEL_COVERAGE_POLICY,
  validateCoverageMapping,
  type CoverageTarget,
} from './coverage.js';
import {
  planReelCoverage,
  ReelCoverageProvenanceSchema,
  reelSegmentsOf,
  segmentIsSupported,
  type ReelCoverageProvenance,
} from './reel-coverage.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recipe = {
  explanationUnitId: 'fixture-unit',
  topicId: 'earth.seasons',
  facetId: 'earth.seasons.axial-tilt',
} as const;
const catalogue = {
  sha256: digest('catalogue'),
  meaningSha256: (topicId: string, facetId: string) =>
    conceptMeaning(topicId, facetId) ? digest([topicId, facetId]) : undefined,
};
const twin = { assetId: '6f1c2b0e-3d6a-4a53-9a8a-0f4a1c9b2d11', assetRevision: 1, explanationUnitId: 'fixture-unit' };

/** A script of `sentences` narration sentences, each citing the claim of its own number. */
function provenanceOf(sentences: readonly string[]): ReelCoverageProvenance {
  return ReelCoverageProvenanceSchema.parse({
    schemaVersion: 'reel-provenance.v1',
    kind: 'cutroom_import',
    fixture: false,
    recipe: 'tides-spring-neap',
    twin,
    brief: {
      version: 1,
      worldId: 'fixture-world',
      narration: sentences.map((text, index) => ({ text, claimIds: [`c${String(index + 1)}`] })),
      claims: sentences.map((_, index) => ({ id: `c${String(index + 1)}`, role: index === 0 ? 'main' : 'supporting' })),
      claimSources: sentences.map((_, index) => ({
        claimId: `c${String(index + 1)}`,
        assetId: twin.assetId,
        assetRevision: twin.assetRevision,
      })),
      criteria: { mustShow: [], mustNotShow: [], depictionPolicyVersion: 'policy-3' },
      style: { id: 'style', version: 1, text: 'plain' },
      title: 'Fixture',
      summary: 'Fixture',
    },
  });
}
const SENTENCES = [
  'One two three four.',
  'One two three four five six.',
  'One two.',
  'One two three.',
  'One two three four five.',
  'One two three four five six seven eight.',
];

function targetOf(provenance: ReelCoverageProvenance, durationMs = 30_000): CoverageTarget {
  return {
    format: 'reel',
    documentSha256: digest('document'),
    provenanceSha256: digest('provenance'),
    explanationUnitId: recipe.explanationUnitId,
    framing: 'factual',
    framingSha256: digest('framing'),
    readingFactsVersion: 2,
    readingFactsSha256: digest('facts'),
    blocks: reelSegmentsOf(provenance.brief, durationMs).map((segment) => ({
      id: segment.id,
      type: 'segment',
      nested: false,
      truthSupported: segmentIsSupported(segment, provenance),
      span: [segment.startMs, segment.endMs] as const,
    })),
  };
}

describe('the segments of a Reel', () => {
  it('are one for each narration sentence and tile the Reel from its first millisecond to its last', () => {
    const segments = reelSegmentsOf(provenanceOf(SENTENCES).brief, 30_000);
    expect(segments.map((segment) => segment.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(segments[0]!.startMs).toBe(0);
    expect(segments.at(-1)!.endMs).toBe(30_000);
    for (let index = 1; index < segments.length; index++)
      expect(segments[index]!.startMs).toBe(segments[index - 1]!.endMs);
    for (const segment of segments) expect(segment.endMs).toBeGreaterThan(segment.startMs);
  });

  it('take their share of the duration from their words', () => {
    // 4, 6, 2, 3, 5 and 8 words: 28 in all.
    const [first, , third, , , last] = reelSegmentsOf(provenanceOf(SENTENCES).brief, 28_000);
    expect(first).toMatchObject({ startMs: 0, endMs: 4000 });
    expect(third).toMatchObject({ startMs: 10_000, endMs: 12_000 });
    expect(last).toMatchObject({ startMs: 20_000, endMs: 28_000 });
  });

  it('are the same for the same script and duration, and differ when the duration does', () => {
    const brief = provenanceOf(SENTENCES).brief;
    expect(reelSegmentsOf(brief, 31_234)).toEqual(reelSegmentsOf(brief, 31_234));
    expect(reelSegmentsOf(brief, 31_234)).not.toEqual(reelSegmentsOf(brief, 31_235));
  });

  it('are supported only when every claim they cite rests on the twin Scroll at its revision', () => {
    const provenance = provenanceOf(SENTENCES);
    const [first] = reelSegmentsOf(provenance.brief, 30_000);
    expect(segmentIsSupported(first!, provenance)).toBe(true);
    const otherRevision = {
      ...provenance,
      brief: {
        ...provenance.brief,
        claimSources: provenance.brief.claimSources.map((source) => ({ ...source, assetRevision: 2 })),
      },
    };
    expect(segmentIsSupported(first!, otherRevision)).toBe(false);
    const unsourced = {
      ...provenance,
      brief: { ...provenance.brief, claimSources: provenance.brief.claimSources.slice(1) },
    };
    expect(segmentIsSupported(first!, unsourced)).toBe(false);
    expect(segmentIsSupported({ ...first!, claimIds: [] }, provenance)).toBe(false);
    expect(segmentIsSupported({ ...first!, claimIds: ['c1', 'unlisted'] }, provenance)).toBe(false);
  });
});

describe('the rule that decides a Reel’s coverage', () => {
  it('binds the primary facet to the first, middle and last segment, each with its window', () => {
    const plan = planReelCoverage(recipe, targetOf(provenanceOf(SENTENCES)), catalogue);
    expect(plan.kind).toBe('planned');
    if (plan.kind !== 'planned') return;
    expect(plan.mapping.version).toBe(REEL_COVERAGE_POLICY);
    expect(plan.mapping.readingFactsVersion).toBe(2);
    expect(plan.mapping.bindings).toHaveLength(1);
    const [binding] = plan.mapping.bindings;
    // Six eligible segments: the first, the third (the middle of 0..5 is index 2) and the last.
    expect(binding!.requiredBlockIds).toEqual(['s1', 's3', 's6']);
    expect(binding!.requiredSpans).toEqual([
      [0, 4286],
      [10_714, 12_857],
      [21_429, 30_000],
    ]);
  });

  it('binds a supporting facet to the last two segments', () => {
    const plan = planReelCoverage(
      { ...recipe, supportingFacetId: 'earth.seasons.hemispheres' },
      targetOf(provenanceOf(SENTENCES)),
      catalogue,
    );
    expect(plan.kind === 'planned' && plan.mapping.bindings.map((b) => [b.facetId, b.requiredBlockIds])).toEqual([
      ['earth.seasons.axial-tilt', ['s1', 's3', 's6']],
      ['earth.seasons.hemispheres', ['s5', 's6']],
    ]);
  });

  it('leaves out a segment whose claims are not documented, so no binding rests on it', () => {
    const provenance = provenanceOf(SENTENCES);
    const unsourced = {
      ...provenance,
      brief: {
        ...provenance.brief,
        claimSources: provenance.brief.claimSources.filter((source) => source.claimId !== 'c1'),
      },
    };
    const plan = planReelCoverage(recipe, targetOf(unsourced), catalogue);
    expect(plan.kind === 'planned' && plan.mapping.bindings[0]!.requiredBlockIds).toEqual(['s2', 's4', 's6']);
  });

  it('binds nothing when fewer than three segments are supported, or the facet is not in the catalogue', () => {
    const provenance = provenanceOf(SENTENCES);
    const target = targetOf(provenance);
    expect(
      planReelCoverage(
        recipe,
        { ...target, blocks: target.blocks.map((block, index) => ({ ...block, truthSupported: index < 2 })) },
        catalogue,
      ),
    ).toEqual({ kind: 'refused', code: 'too_few_segments' });
    expect(planReelCoverage({ ...recipe, facetId: 'earth.seasons.nothing' }, target, catalogue)).toEqual({
      kind: 'refused',
      code: 'facet_not_in_catalogue',
    });
  });

  it('yields a mapping the strict admission accepts, and the read keeps it under a grown catalogue', () => {
    const target = targetOf(provenanceOf(SENTENCES));
    const plan = planReelCoverage(recipe, target, catalogue);
    if (plan.kind !== 'planned') throw new Error('not planned');
    expect(CoverageMappingSchema.safeParse(plan.mapping).success).toBe(true);
    expect(() => validateCoverageMapping(plan.mapping, target, catalogue)).not.toThrow();
    const grown = { ...plan.mapping, catalogueSha256: digest('a grown plan') };
    expect(currentCoverageMapping(grown, target, catalogue).bindings).toEqual(plan.mapping.bindings);
  });
});

describe('a Reel’s mapping is checked against the Reel stored', () => {
  const target = targetOf(provenanceOf(SENTENCES));
  const planned = () => {
    const plan = planReelCoverage(recipe, target, catalogue);
    if (plan.kind !== 'planned') throw new Error('not planned');
    return plan.mapping;
  };

  it('refuses a window other than the stored segment’s, a segment that does not exist and a Scroll’s locators', () => {
    const mapping = planned();
    const first = mapping.bindings[0]!;
    const moved = {
      ...mapping,
      bindings: [{ ...first, requiredSpans: [[1, 4286], ...first.requiredSpans!.slice(1)] }],
    };
    expect(() => validateCoverageMapping(CoverageMappingSchema.parse(moved), target, catalogue)).toThrow(
      'CONTENT_COVERAGE_LOCATOR_INVALID',
    );
    const unknown = { ...mapping, bindings: [{ ...first, requiredBlockIds: ['s1', 's3', 's9'] }] };
    expect(() => validateCoverageMapping(CoverageMappingSchema.parse(unknown), target, catalogue)).toThrow(
      'CONTENT_COVERAGE_LOCATOR_INVALID',
    );
    const scrollTarget = { ...target, blocks: target.blocks.map((block) => ({ ...block, type: 'paragraph' })) };
    expect(() => validateCoverageMapping(mapping, scrollTarget, catalogue)).toThrow();
  });

  it('refuses a Reel mapping on a Scroll target and a Scroll mapping on a Reel target', () => {
    const mapping = planned();
    const { format: _format, ...scrollTarget } = target;
    expect(() => validateCoverageMapping(mapping, scrollTarget, catalogue)).toThrow(
      'CONTENT_COVERAGE_IDENTITY_MISMATCH',
    );
    const scrollMapping = {
      ...mapping,
      version: 'scroll-static-coverage.v1' as const,
      bindings: mapping.bindings.map(({ requiredSpans: _spans, ...binding }) => binding),
    };
    expect(() => validateCoverageMapping(scrollMapping, target, catalogue)).toThrow(
      'CONTENT_COVERAGE_IDENTITY_MISMATCH',
    );
  });

  it('requires a window for every segment of a Reel binding and none on a Scroll binding', () => {
    const mapping = planned();
    const first = mapping.bindings[0]!;
    const withoutSpans = { ...mapping, bindings: [{ ...first, requiredSpans: undefined }] };
    expect(CoverageMappingSchema.safeParse(JSON.parse(JSON.stringify(withoutSpans))).success).toBe(false);
    const short = { ...mapping, bindings: [{ ...first, requiredSpans: first.requiredSpans!.slice(1) }] };
    expect(CoverageMappingSchema.safeParse(short).success).toBe(false);
    const scrollWithSpans = { ...mapping, version: 'scroll-static-coverage.v1' };
    expect(CoverageMappingSchema.safeParse(scrollWithSpans).success).toBe(false);
  });
});
