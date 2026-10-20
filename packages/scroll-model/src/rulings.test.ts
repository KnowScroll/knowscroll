/**
 * The coordinator's rulings on the review of #254 that are about what the schema leaves out: no
 * chart "inspect" interaction and no comparison glyphs in v1, one document-level
 * `explanationUnitId` with an optional series reference, and text blocks that store no fallback
 * text. A member the schema does not define is refused (every object is strict).
 */
import { describe, expect, it } from 'vitest';
import { INTERACTION_KINDS, isInteractiveBlock, validateDocument, type Block, type ScrollDocument } from './index.js';
import { make, seal } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';

type Loose = Record<string, unknown>;

const weight = fixture('weight-other-worlds').document;

function refusals(document: unknown): Array<{ code: string; path: string }> {
  const outcome = validateDocument(document);
  return outcome.kind === 'invalid' ? outcome.issues.map(({ code, path }) => ({ code, path })) : [];
}

function documentWith(block: Block): ScrollDocument {
  return seal([{ id: 'only', heading: null, blocks: [{ ...block, id: 'only-block' }] }]);
}

describe('no chart "inspect" interaction and no comparison glyphs in v1', () => {
  it('declares no inspect interaction, and a chart is not an interactive block', () => {
    expect(INTERACTION_KINDS.chart).toEqual(['text-version-opened']);
    for (const kinds of Object.values(INTERACTION_KINDS)) expect(kinds).not.toContain('inspect');
    const chart = weight.sections[1]?.blocks[0];
    if (chart?.type !== 'chart') throw new Error('fixture changed');
    expect(isInteractiveBlock(chart)).toBe(false);
  });

  it('refuses an inspect or glyph member on a chart, its spec or its axes', () => {
    const where = [['data'], ['data', 'spec'], ['data', 'spec', 'valueAxis']];
    for (const member of ['inspect', 'inspectable', 'glyph', 'glyphs', 'marker']) {
      for (const path of where) {
        const document = structuredClone(weight) as unknown as { sections: Array<{ blocks: Loose[] }> };
        let node: Loose | undefined = document.sections[1]?.blocks[0];
        for (const step of path) node = node?.[step] as Loose | undefined;
        if (node === undefined) throw new Error('fixture changed');
        node[member] = '▲';
        expect(refusals(document), `${member} in ${path.join('.')}`).toContainEqual({
          code: 'schema_unrecognized_keys',
          path: ['sections.1.blocks.0', ...path].join('.'),
        });
      }
    }
  });

  it('refuses a glyph member on a comparison or one of its columns', () => {
    const comparison = make('comparison', {
      title: 'Two views',
      columns: [
        { label: 'One', points: [[{ text: 'A plain point.' }]] },
        { label: 'Two', points: [[{ text: 'Another plain point.' }]] },
      ],
    });
    expect(refusals(documentWith(comparison))).toEqual([]);
    for (const [path, expected] of [
      [['data'], 'sections.0.blocks.0.data'],
      [['data', 'columns', '0'], 'sections.0.blocks.0.data.columns.0'],
    ] as const) {
      const document = structuredClone(documentWith(comparison)) as unknown as { sections: Array<{ blocks: Loose[] }> };
      let node: Loose | undefined = document.sections[0]?.blocks[0];
      for (const step of path) node = node?.[step] as Loose | undefined;
      if (node === undefined) throw new Error('block changed');
      node['glyph'] = '▲';
      expect(refusals(document)).toContainEqual({ code: 'schema_unrecognized_keys', path: expected });
    }
  });
});

describe('one explanation unit per Scroll, with an optional series reference', () => {
  it('requires a single explanationUnitId and refuses a list of them', () => {
    expect(typeof weight.explanationUnitId).toBe('string');
    const list = { ...weight, explanationUnitId: [weight.explanationUnitId, 'second-unit'] };
    expect(refusals(list)).toContainEqual({ code: 'schema_invalid_type', path: 'explanationUnitId' });
    const plural = { ...weight, explanationUnitIds: [weight.explanationUnitId] };
    expect(refusals(plural)).toContainEqual({ code: 'schema_unrecognized_keys', path: '$' });
    const { explanationUnitId: _removed, ...without } = weight;
    expect(refusals(without)).toContainEqual({ code: 'schema_invalid_type', path: 'explanationUnitId' });
  });

  it('accepts a series reference or none, and nothing else in its place', () => {
    const sections = weight.sections;
    const alone = seal(sections, { ...weight });
    expect(alone.series).toBeUndefined();
    expect(validateDocument(alone).kind).toBe('valid');
    const inSeries = seal(sections, { ...weight, series: { seriesId: 'series-one', part: 2 } });
    expect(validateDocument(inSeries).kind).toBe('valid');
    expect(refusals({ ...inSeries, series: { seriesId: 'series-one', part: 2, units: ['a', 'b'] } })).toContainEqual({
      code: 'schema_unrecognized_keys',
      path: 'series',
    });
    expect(refusals({ ...inSeries, series: [{ seriesId: 'series-one', part: 2 }] })).toContainEqual({
      code: 'schema_invalid_type',
      path: 'series',
    });
  });
});

describe('text blocks store no fallback text', () => {
  it('refuses a stored fallbackText on a paragraph, which is derived when it is needed', () => {
    const paragraph = weight.sections[0]?.blocks.find((block) => block.type === 'paragraph');
    if (paragraph === undefined) throw new Error('fixture changed');
    const document = structuredClone(weight) as unknown as { sections: Array<{ blocks: Loose[] }> };
    const index = weight.sections[0]?.blocks.indexOf(paragraph) ?? -1;
    const target = document.sections[0]?.blocks[index];
    if (target === undefined) throw new Error('fixture changed');
    target['fallbackText'] = 'This paragraph carries a copy of its own text which must never be stored.';
    expect(refusals(document)).toContainEqual({
      code: 'schema_unrecognized_keys',
      path: `sections.0.blocks.${index}`,
    });
  });
});
