import { describe, expect, it } from 'vitest';
import { LIMITS_V2 } from '@knowscroll/scroll-model';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { seedSnapshot } from './catalogue/seed.js';
import { LIBRARY_SYSTEMS } from './library/index.js';
import { validateCoverageMapping, type CoverageTarget } from './coverage.js';
import { MIN_BODY_BLOCKS, planRecipeCoverage } from './recipe-coverage.js';

const hash = 'a'.repeat(64);
const meaningHash = 'b'.repeat(64);
const plan = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);
const catalogue = {
  sha256: hash,
  meaningSha256: (topicId: string, facetId: string) => (plan.meaning(topicId, facetId) ? meaningHash : undefined),
  acceptsMeaning: (topicId: string, facetId: string, sha256: string) =>
    plan.meaning(topicId, facetId) !== undefined && sha256 === meaningHash,
};
const recipe = { topicId: 'earth.seasons', facetId: 'earth.seasons.axial-tilt' } as const;

type Block = CoverageTarget['blocks'][number];
const body = (id: string, overrides: Partial<Block> = {}): Block => ({
  id,
  type: 'paragraph',
  nested: false,
  truthSupported: true,
  ...overrides,
});
function targetOf(blocks: readonly Block[]): CoverageTarget {
  return {
    documentSha256: hash,
    provenanceSha256: hash,
    explanationUnitId: 'fixture-unit',
    framing: 'factual',
    framingSha256: hash,
    readingFactsVersion: 2,
    readingFactsSha256: hash,
    blocks,
  };
}
const sixBodyBlocks = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((id) => body(id));

function plannedBindings(plan: ReturnType<typeof planRecipeCoverage>) {
  if (plan.kind !== 'planned') throw new Error(`expected a plan, got ${plan.code}`);
  return plan.mapping.bindings;
}

describe('recipe coverage rule (synthetic targets, no stored data)', () => {
  it('binds the primary facet to the first, middle and last eligible blocks', () => {
    const plan = planRecipeCoverage(recipe, targetOf(sixBodyBlocks), catalogue);
    expect(plannedBindings(plan)).toEqual([
      {
        topicId: 'earth.seasons',
        facetId: 'earth.seasons.axial-tilt',
        meaningSha256: meaningHash,
        requiredBlockIds: ['b1', 'b3', 'b6'],
      },
    ]);
  });

  it('skips headings, nested, unsupported and non-prose blocks when choosing blocks', () => {
    const blocks = [
      body('heading', { type: 'subheading' }),
      body('a'),
      body('nested-child', { nested: true }),
      body('figure', { type: 'diagram' }),
      body('unsupported', { truthSupported: false }),
      body('b', { type: 'quote' }),
      body('c', { type: 'callout' }),
    ];
    expect(plannedBindings(planRecipeCoverage(recipe, targetOf(blocks), catalogue))[0]?.requiredBlockIds).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('binds a declared supporting facet to the closing two blocks and nothing else', () => {
    const withSupport = { ...recipe, supportingFacetId: 'earth.seasons.hemispheres' };
    const bindings = plannedBindings(planRecipeCoverage(withSupport, targetOf(sixBodyBlocks), catalogue));
    expect(bindings.map((binding) => [binding.facetId, binding.requiredBlockIds])).toEqual([
      ['earth.seasons.axial-tilt', ['b1', 'b3', 'b6']],
      ['earth.seasons.hemispheres', ['b5', 'b6']],
    ]);
  });

  it('ignores a supporting facet that repeats the primary one', () => {
    const repeated = { ...recipe, supportingFacetId: recipe.facetId };
    expect(plannedBindings(planRecipeCoverage(repeated, targetOf(sixBodyBlocks), catalogue))).toHaveLength(1);
  });

  it('takes every block of the smallest admissible document once', () => {
    const three = ['x', 'y', 'z'].map((id) => body(id));
    expect(MIN_BODY_BLOCKS).toBe(3);
    expect(plannedBindings(planRecipeCoverage(recipe, targetOf(three), catalogue))[0]?.requiredBlockIds).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it('claims nothing when too few blocks could be met', () => {
    const plan = planRecipeCoverage(recipe, targetOf(sixBodyBlocks.slice(0, 2)), catalogue);
    expect(plan).toEqual({ kind: 'refused', code: 'too_few_body_blocks' });
    const unsupported = sixBodyBlocks.map((block) => ({ ...block, truthSupported: false }));
    expect(planRecipeCoverage(recipe, targetOf(unsupported), catalogue)).toEqual({
      kind: 'refused',
      code: 'too_few_body_blocks',
    });
  });

  it('refuses a facet the catalogue does not hold', () => {
    const plan = planRecipeCoverage(
      { ...recipe, facetId: 'earth.seasons.unknown' },
      targetOf(sixBodyBlocks),
      catalogue,
    );
    expect(plan).toEqual({ kind: 'refused', code: 'facet_not_in_catalogue' });
  });

  it('plans a mapping the shared admission validator accepts for the same target', () => {
    const target = targetOf(sixBodyBlocks);
    const withSupport = { ...recipe, supportingFacetId: 'earth.seasons.hemispheres' };
    const plan = planRecipeCoverage(withSupport, target, catalogue);
    if (plan.kind !== 'planned') throw new Error('expected a plan');
    expect(() => validateCoverageMapping(plan.mapping, target, catalogue)).not.toThrow();
  });
});

describe('recipe coverage rule v2 (the units of a scroll-document.v2)', () => {
  const unit = (id: string, type: string, overrides: Partial<Block> = {}) => body(id, { type, ...overrides });
  /** Eight stops with a call after the second, the fourth and the last, as a v2 Scroll is laid out. */
  const units = [
    unit('s1', 'stop'),
    unit('s2', 'call_it'),
    unit('s3', 'stop'),
    unit('s4', 'stop'),
    unit('s5', 'call_it'),
    unit('s6', 'stop'),
    unit('s7', 'stop'),
    unit('s8', 'stop'),
    unit('s9', 'final_call'),
  ];
  const v2Target = (blocks: readonly Block[]): CoverageTarget => ({
    ...targetOf(blocks),
    readingFactsVersion: 3,
  });

  it('binds the first, middle and last read stop, and never a call', () => {
    const plan = planRecipeCoverage(recipe, v2Target(units), catalogue);
    if (plan.kind !== 'planned') throw new Error('expected a plan');
    expect(plan.rule).toBe('scroll-recipe-coverage.v2');
    expect(plan.mapping.readingFactsVersion).toBe(3);
    // Eligible stops are s1, s3, s4, s6, s7 and s8: first s1, middle s4, last s8.
    expect(plannedBindings(plan)[0]?.requiredBlockIds).toEqual(['s1', 's4', 's8']);
  });

  it('can never refuse a published v2 Scroll for too few stops: the document validator asks for as many read stops', () => {
    expect(LIMITS_V2.minReadStops).toBe(MIN_BODY_BLOCKS);
  });

  it('keeps the v1 rule and label for a v1 target', () => {
    const plan = planRecipeCoverage(recipe, targetOf(sixBodyBlocks), catalogue);
    if (plan.kind !== 'planned') throw new Error('expected a plan');
    expect(plan.rule).toBe('scroll-recipe-coverage.v1');
    expect(plan.mapping.readingFactsVersion).toBe(2);
  });

  it('needs the same three bound units, counted over stops that have documented claims', () => {
    const fewStops = [unit('s1', 'stop'), unit('s2', 'call_it'), unit('s3', 'stop'), unit('s4', 'final_call')];
    expect(planRecipeCoverage(recipe, v2Target(fewStops), catalogue)).toEqual({
      kind: 'refused',
      code: 'too_few_body_blocks',
    });
    const unsupported = units.map((block) => (block.type === 'stop' ? { ...block, truthSupported: false } : block));
    expect(planRecipeCoverage(recipe, v2Target(unsupported), catalogue)).toEqual({
      kind: 'refused',
      code: 'too_few_body_blocks',
    });
  });

  it('admits only mappings that name stops: a binding to a call is refused', () => {
    const target = v2Target(units);
    const plan = planRecipeCoverage(recipe, target, catalogue);
    if (plan.kind !== 'planned') throw new Error('expected a plan');
    expect(() => validateCoverageMapping(plan.mapping, target, catalogue)).not.toThrow();
    const onCall = {
      ...plan.mapping,
      bindings: [{ ...plan.mapping.bindings[0]!, requiredBlockIds: ['s2', 's4', 's8'] }],
    };
    expect(() => validateCoverageMapping(onCall, target, catalogue)).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
  });
});

describe('recipe coverage rule v3 (the beats of a scroll-document.v3)', () => {
  const beat = (id: string, overrides: Partial<Block> = {}) => body(id, { type: 'beat', ...overrides });
  const beats = (count: number) => Array.from({ length: count }, (_, index) => beat(`b${String(index + 1)}`));
  const v3Target = (blocks: readonly Block[]): CoverageTarget => ({ ...targetOf(blocks), readingFactsVersion: 4 });
  const withSupport = { ...recipe, supportingFacetId: 'earth.seasons.hemispheres' };

  it('labels its plan scroll-recipe-coverage.v3 and stores facts version 4 in the mapping', () => {
    const plan = planRecipeCoverage(recipe, v3Target(beats(12)), catalogue);
    if (plan.kind !== 'planned') throw new Error('expected a plan');
    expect(plan.rule).toBe('scroll-recipe-coverage.v3');
    expect(plan.mapping.readingFactsVersion).toBe(4);
  });

  it('binds the main facet to the first, middle and last beat', () => {
    // Twelve beats: the middle one is the sixth, as for any list (index floor((n - 1) / 2)).
    expect(plannedBindings(planRecipeCoverage(recipe, v3Target(beats(12)), catalogue))[0]?.requiredBlockIds).toEqual([
      'b1',
      'b6',
      'b12',
    ]);
  });

  it('binds a supporting facet to the last two beats and nothing else', () => {
    const bindings = plannedBindings(planRecipeCoverage(withSupport, v3Target(beats(12)), catalogue));
    expect(bindings.map((binding) => [binding.facetId, binding.requiredBlockIds])).toEqual([
      ['earth.seasons.axial-tilt', ['b1', 'b6', 'b12']],
      ['earth.seasons.hemispheres', ['b11', 'b12']],
    ]);
  });

  it('claims nothing when only two beats are eligible, however many beats there are', () => {
    const twoEligible = beats(6).map((block, index) => (index < 2 ? block : { ...block, truthSupported: false }));
    expect(planRecipeCoverage(recipe, v3Target(twoEligible), catalogue)).toEqual({
      kind: 'refused',
      code: 'too_few_body_blocks',
    });
    expect(planRecipeCoverage(recipe, v3Target(beats(2)), catalogue)).toEqual({
      kind: 'refused',
      code: 'too_few_body_blocks',
    });
  });

  it('never binds a beat that cites a claim that is not documented', () => {
    // b1, b6 and b12 would be picked by position, so the unsupported beats must move the picks onto supported ones.
    const blocks = beats(12).map((block) =>
      ['b1', 'b6', 'b12'].includes(block.id) ? { ...block, truthSupported: false } : block,
    );
    const bindings = plannedBindings(planRecipeCoverage(withSupport, v3Target(blocks), catalogue));
    const bound = bindings.flatMap((binding) => binding.requiredBlockIds);
    expect(bound).toEqual(['b2', 'b7', 'b11', 'b10', 'b11']);
    expect(bound).not.toContain('b1');
  });

  it('does not count a unit of another document version: a stop is not a beat', () => {
    const stops = Array.from({ length: 6 }, (_, index) => body(`s${String(index + 1)}`, { type: 'stop' }));
    expect(planRecipeCoverage(recipe, v3Target(stops), catalogue)).toEqual({
      kind: 'refused',
      code: 'too_few_body_blocks',
    });
  });

  it('plans a mapping the shared admission validator accepts, and refuses one that binds a paragraph', () => {
    const target = v3Target(beats(12));
    const plan = planRecipeCoverage(withSupport, target, catalogue);
    if (plan.kind !== 'planned') throw new Error('expected a plan');
    expect(() => validateCoverageMapping(plan.mapping, target, catalogue)).not.toThrow();
    const mixed = v3Target([...beats(12), body('p1')]);
    const onParagraph = {
      ...plan.mapping,
      bindings: [{ ...plan.mapping.bindings[0]!, requiredBlockIds: ['p1', 'b6', 'b12'] }],
    };
    expect(() => validateCoverageMapping(onParagraph, mixed, catalogue)).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
  });
});
