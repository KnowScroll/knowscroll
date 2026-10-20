import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalSize } from './canonical.js';
import {
  createPassageLocator,
  LIMITS,
  validateDocument,
  validateLocator,
  type Block,
  type ScrollDocument,
} from './index.js';
import { arrange, make, seal, type SimulationInput } from './test-support/arbitraries.js';

const codes = (outcome: ReturnType<typeof validateDocument>) =>
  outcome.kind === 'invalid' ? outcome.issues.map((issue) => issue.code) : [];

const paragraph = (text = 'A plain sentence for counting.') => make('paragraph', { spans: [{ text }] });
const sequence = () =>
  make('sequence', {
    title: 'Steps',
    steps: [
      { id: 'step-a', title: 'First', spans: [{ text: 'Begin here.' }] },
      { id: 'step-b', title: 'Second', spans: [{ text: 'Then go on.' }] },
    ],
  });
const simulation = (params: number): Block => {
  const data: SimulationInput = {
    title: 'Many dials',
    params: Array.from({ length: params }, (_, index) => ({
      key: `p${index}`,
      label: `Dial ${'abcdef'.charAt(index)}`,
      min: 1,
      max: 10,
      step: 1,
      default: 1,
      control: 'stepper' as const,
      format: { decimals: 0, grouping: false, approximate: false },
    })),
    constants: [],
    outputs: [
      {
        key: 'total',
        label: 'Total',
        formula: { kind: 'linear', x: 'p0', a: 1, b: 1 },
        format: { decimals: 0, grouping: false, approximate: false },
      },
    ],
    view: { kind: 'readout', primary: 'total' },
    modelNote: 'Counts dials for a limits test.',
    illustrative: { notice: 'Illustrative' },
  };
  return make('simulation', data);
};

/** Spreads blocks over as few sections as possible (each section holds at most 30 here). */
function documentOf(blocks: Block[]): ScrollDocument {
  const sections: Array<{ heading: string; blocks: Block[] }> = [];
  for (let index = 0; index < blocks.length; index += 30)
    sections.push({ heading: `part ${'abc'.charAt(index / 30)}`, blocks: blocks.slice(index, index + 30) });
  return seal(arrange(sections));
}

describe('scroll-limits.v1', () => {
  it('blocks: up to 80 are accepted, more are refused with too_many_blocks', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 90 }), (count) => {
        const outcome = validateDocument(documentOf(Array.from({ length: count }, () => paragraph())));
        if (count <= LIMITS.blocks) expect(outcome.kind).toBe('valid');
        else expect(codes(outcome)).toContain('too_many_blocks');
      }),
      { numRuns: 40 },
    );
  });

  it('sections: up to 12 are accepted, more fail the schema', () => {
    for (const count of [1, 12, 13]) {
      const sections = Array.from({ length: count }, (_, index) => ({
        heading: `part ${index}`.replace(/\d+/u, 'n'),
        blocks: [paragraph()],
      }));
      const outcome = validateDocument(seal(arrange(sections)));
      if (count <= LIMITS.sections) expect(outcome.kind).toBe('valid');
      else expect(outcome).toMatchObject({ kind: 'invalid', issues: [{ code: 'schema_too_big', path: 'sections' }] });
    }
  });

  it('interactive blocks: up to 8 are accepted, more are refused', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 14 }), (count) => {
        const blocks = [paragraph(), ...Array.from({ length: count }, () => sequence())];
        // `arrange` would replace extra interactive blocks, so seal the sections directly.
        const sections = arrange([{ heading: 'only', blocks: [paragraph()] }]).map((section) => ({
          ...section,
          blocks: blocks.map((block, index) => ({ ...block, id: `block-${index}` })),
        }));
        const outcome = validateDocument(seal(sections));
        if (count <= LIMITS.interactiveBlocks) expect(outcome.kind).toBe('valid');
        else expect(codes(outcome)).toEqual(['too_many_interactive']);
      }),
      { numRuns: 30 },
    );
  });

  it('parameters: at most 4 per simulation and 16 in total', () => {
    expect(validateDocument(documentOf([simulation(4)])).kind).toBe('valid');
    expect(codes(validateDocument(documentOf([simulation(5)])))).toContain('schema_too_big');
    const five = Array.from({ length: 5 }, () => simulation(4));
    const sections = arrange([{ heading: 'only', blocks: [paragraph()] }]).map((section) => ({
      ...section,
      blocks: five.map((block, index) => ({ ...block, id: `block-${index}` })),
    }));
    expect(codes(validateDocument(seal(sections)))).toEqual(['too_many_params']);
  });

  it('simulation grids: at most 10,000 points over all parameters', () => {
    const grid = (points: readonly number[]) => {
      const block = simulation(points.length);
      if (block.type !== 'simulation') throw new Error('not a simulation');
      return {
        ...block,
        data: {
          ...block.data,
          params: block.data.params.map((param, index) => ({ ...param, max: points[index] ?? 1 })),
        },
      };
    };
    // 100 × 100 = 10,000 points; 101 × 100 = 10,100.
    expect(validateDocument(documentOf([grid([100, 100])])).kind).toBe('valid');
    expect(codes(validateDocument(documentOf([grid([101, 100])])))).toEqual(['sim_grid_too_large']);
  });

  it('visible text: up to 24,000 characters are accepted, more are refused', () => {
    const long = (length: number) => paragraph(`${'Word '.repeat(Math.floor(length / 5)).trim()}.`);
    const within = validateDocument(documentOf(Array.from({ length: 19 }, () => long(1_190))));
    expect(within.kind).toBe('valid');
    const over = validateDocument(documentOf(Array.from({ length: 21 }, () => long(1_190))));
    expect(codes(over)).toEqual(['visible_text_too_long']);
  });

  it('document size: a stored revision over 128 KiB is refused, before anything else is checked', () => {
    // Code blocks with long spoken descriptions: heavy in bytes, light in visible text.
    const heavy = () => ({
      ...make('code', { language: 'text', code: `${'x = 1 '.repeat(330).trim()}` }),
      a11y: { label: 'Code', description: `${'Long description '.repeat(35).trim()}.` },
      fallbackText: `${'Fallback words '.repeat(79).trim()}.`,
    });
    const blocks = Array.from({ length: 70 }, heavy);
    const document = seal([
      { id: 'only', heading: null, blocks: blocks.map((block, index) => ({ ...block, id: `block-${index}` })) },
    ]);
    expect(canonicalSize(document)).toBeGreaterThan(LIMITS.documentBytes);
    expect(codes(validateDocument(document))).toEqual(['document_too_large']);
  });

  it('charts: at most 200 data points', () => {
    const line = (perSeries: number) =>
      make('chart', {
        title: 'Lines',
        spec: {
          kind: 'line',
          x: { label: 'x', scale: 'linear' },
          y: { label: 'y', scale: 'linear' },
          series: Array.from({ length: 4 }, (_, series) => ({
            id: `series-${'abcd'.charAt(series)}`,
            label: 'series',
            points: Array.from({ length: perSeries }, (_, index): [number, number] => [index, series]),
          })),
        },
      });
    expect(validateDocument(documentOf([line(50)])).kind).toBe('valid');
    expect(codes(validateDocument(documentOf([line(51)])))).toEqual(['chart_too_many_points']);
  });

  it('diagrams: at most 16 nodes, 24 edges and 8 frames', () => {
    const diagram = (nodes: number, edges: number, frames: number) =>
      make('diagram', {
        title: 'Big',
        layout: 'radial',
        nodes: Array.from({ length: nodes }, (_, index) => ({
          id: `node-${index}`,
          label: 'node',
          kind: 'entity' as const,
        })),
        edges: Array.from({ length: edges }, (_, index) => ({
          id: `edge-${index}`,
          from: `node-${index % nodes}`,
          to: `node-${(index + 1) % nodes}`,
          directed: false,
          style: 'solid' as const,
        })),
        groups: [],
        frames: Array.from({ length: frames }, (_, index) => ({
          id: `frame-${index}`,
          label: 'frame',
          description: 'A frame of the big diagram.',
          emphasis: [],
          hidden: [],
          weights: [],
        })),
        interaction: { kind: 'steps' },
      });
    expect(validateDocument(documentOf([diagram(16, 24, 8)])).kind).toBe('valid');
    for (const [nodes, edges, frames] of [
      [17, 24, 8],
      [16, 25, 8],
      [16, 24, 9],
    ] as const) {
      expect(
        codes(validateDocument(documentOf([diagram(nodes, edges, frames)]))),
        `${nodes}/${edges}/${frames}`,
      ).toContain('schema_too_big');
    }
  });

  it('tables: at most 5 columns and 12 rows', () => {
    const table = (columns: number, rows: number) =>
      make('table', {
        caption: 'Cells',
        columns: Array.from({ length: columns }, () => ({ label: 'column', align: 'start' as const })),
        rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => 'cell')),
        rowHeader: false,
      });
    expect(validateDocument(documentOf([table(5, 12)])).kind).toBe('valid');
    expect(codes(validateDocument(documentOf([table(6, 12)])))).toContain('schema_too_big');
    expect(codes(validateDocument(documentOf([table(5, 13)])))).toContain('schema_too_big');
  });

  it('code: at most 4,000 characters', () => {
    const code = (characters: number) => {
      const line = 'x'.repeat(79);
      const lines = Array.from({ length: Math.ceil(characters / 80) }, () => line).join('\n');
      return make('code', { language: 'text', code: lines.slice(0, characters) });
    };
    expect(validateDocument(documentOf([code(4_000)])).kind).toBe('valid');
    expect(codes(validateDocument(documentOf([code(4_001)])))).toContain('schema_too_big');
  });

  it('passages: at most 600 characters', () => {
    const document = documentOf([paragraph(`${'Word '.repeat(200).trim()}.`)]);
    const blockId = document.sections[0]?.blocks[0]?.id ?? '';
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 900 }), (length) => {
        const outcome = createPassageLocator(document, blockId, 0, length);
        if (length <= LIMITS.passageChars) expect(outcome.kind).toBe('locator');
        else expect(outcome).toEqual({ kind: 'invalid', reason: 'range-too-long' });
      }),
      { numRuns: 60 },
    );
  });

  it('block state: a snapshot over 1 KiB is refused', () => {
    const document = documentOf([simulation(2)]);
    const block = document.sections[0]?.blocks[0];
    const params: Record<string, number> = {};
    for (let index = 0; index < 120; index += 1) params[`extraKey${index}`] = index;
    const outcome = validateLocator(document, {
      kind: 'scroll_block',
      assetId: document.assetId,
      revision: document.revision,
      blockId: block?.id ?? '',
      blockType: 'simulation',
      blockVersion: 1,
      state: { state: { type: 'simulation', params }, personalIncluded: false },
    });
    expect(outcome).toEqual({ kind: 'invalid', reason: 'state-too-large' });
  });
});
