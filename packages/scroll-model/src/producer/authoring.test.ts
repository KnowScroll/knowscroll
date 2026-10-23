import { describe, expect, it } from 'vitest';
import { compileAuthored } from './authoring.js';
import { AuthoredScroll, type AuthoredBlockType } from './authoring-schema.js';
import type { AuthoringEvidence } from './authoring-bind.js';
import type { DraftProvenance } from './draft.js';

// Every passage, claim and document below is an authored CI fixture about an invented harbour pump,
// never product content and never real evidence.
const passages = [
  'The brass harbour pump lifts water from the tidal basin into the cistern above the quay.',
  'In 1893 the harbour board fitted the pump with a second piston, which doubled its steady output.',
  'The cistern holds 4,200 litres, and keepers drain it every evening before the night frost arrives.',
  'Because the intake sits below the lowest tide, the pump keeps working even when the basin is almost empty.',
  'A leather washer seals each piston and wears out slowly, so the keepers replace it each spring.',
];
const claimIds = passages.map((_, index) => `claim-${index + 1}`);
const evidence: AuthoringEvidence = {
  claimIdOf: new Map(claimIds.map((id, index) => [`e${index + 1}`, id])),
  quoteOf: new Map(claimIds.map((id, index) => [id, passages[index] ?? ''])),
  minDistinctCitations: 4,
};
const provenance = (extra: Partial<DraftProvenance> = {}): DraftProvenance => ({
  schemaVersion: 'scroll-draft-provenance.v1',
  publication: {
    assetId: 'fixture-harbour-pump',
    revision: 1,
    language: 'en',
    explanationUnitId: 'fixture-harbour-pump-unit',
    template: 'editorial',
    theme: { family: 'worlds' },
    kicker: 'A closer look',
    framing: { kind: 'factual' },
    corrections: [],
  },
  claims: claimIds.map((claimId, index) => ({
    claimId,
    statement: passages[index] ?? '',
    quote: passages[index] ?? '',
    sourceId: 'src-fixture',
    truthState: 'documented' as const,
  })),
  sources: [
    {
      sourceId: 'src-fixture',
      title: 'Fixture source',
      url: 'https://fixture.invalid/harbour-pump',
      snapshotSha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
      retrievedAt: '2026-10-19T00:00:00Z',
    },
  ],
  material: passages,
  offeredMedia: [],
  production: { kind: 'fixture', label: 'authoring.test.ts fixture' },
  ...extra,
});

type Block = AuthoredScroll['blocks'][number];
const prose = (text: string, cites = ['e1', 'e2']): Block => ({ type: 'paragraph', cites, text });
const intro: Block[] = [
  prose('A small pump at a quiet quay does a steady job without anyone watching it closely.', ['e1', 'e2']),
  prose('Its keepers know the rhythm of the tide and plan their chores around the water that comes and goes.', [
    'e3',
    'e4',
  ]),
];
function scroll(blocks: Block[], header: Partial<AuthoredScroll> = {}): AuthoredScroll {
  return AuthoredScroll.parse({
    title: 'How a harbour pump works',
    dek: 'A small invented pump explains lifting water in simple steps.',
    blocks: [{ type: 'heading', text: 'The pump' }, ...intro, ...blocks],
    ...header,
  });
}
const compile = (authored: AuthoredScroll, extra: Partial<DraftProvenance> = {}) =>
  compileAuthored(authored, provenance(extra), evidence);
const refusal = (outcome: ReturnType<typeof compile>) =>
  outcome.kind === 'refused' ? { stage: outcome.stage, issues: outcome.issues } : null;

describe('compileAuthored: plain text in, canonical document out', () => {
  it('turns strings into one-span text and binds every block to the passages it cites', () => {
    const outcome = compile(
      scroll([
        { type: 'list', cites: ['e5'], items: ['A piston pushes the water up', 'A washer keeps the seal tight'] },
        {
          type: 'callout',
          cites: ['e4'],
          kind: 'limit',
          title: 'Limits',
          text: 'The picture ignores friction in the pipe.',
        },
      ]),
    );
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const blocks = outcome.document.sections[0]?.blocks ?? [];
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'list', 'callout']);
    expect(blocks[0]).toMatchObject({ data: { spans: [{ text: expect.stringContaining('quiet quay') }] } });
    const bound = outcome.internalProvenance.bindings.filter((binding) => binding.kind === 'block');
    expect(bound.map((binding) => [binding.claimId, 'blockId' in binding ? binding.blockId : ''])).toEqual(
      expect.arrayContaining([
        ['claim-5', blocks[2]?.id],
        ['claim-4', blocks[3]?.id],
      ]),
    );
    // Only claims the document rests on are recorded.
    expect(outcome.internalProvenance.claims.map((claim) => claim.claimId).sort()).toEqual([
      'claim-1',
      'claim-2',
      'claim-3',
      'claim-4',
      'claim-5',
    ]);
  });

  it('starts a section at each heading block and reports findings at the block the writer wrote', () => {
    const outcome = compile(
      AuthoredScroll.parse({
        title: 'How a harbour pump works',
        dek: 'A small invented pump explains lifting water in simple steps.',
        blocks: [
          prose('An opening before any heading.', ['e1', 'e2']),
          { type: 'heading', text: 'Second part' },
          prose('The keepers drain the water each evening.', ['e3', 'e4']),
          { type: 'heading', text: 'Third part' },
          prose('Read more at www.example.org about the keepers and their chores.', ['e5']),
        ],
      }),
    );
    expect(refusal(outcome)?.issues).toEqual([{ code: 'text_mentions_web_address', path: 'blocks.4' }]);
    const fine = compile(
      AuthoredScroll.parse({
        title: 'How a harbour pump works',
        dek: 'A small invented pump explains lifting water in simple steps.',
        blocks: [
          prose('An opening before any heading.', ['e1', 'e2']),
          { type: 'heading', text: 'Second part' },
          prose('The keepers drain the water each evening.', ['e3', 'e4']),
          { type: 'heading', text: 'Third part' },
          prose('Leather washers are replaced in spring by the keepers.', ['e5']),
        ],
      }),
    );
    if (fine.kind !== 'compiled') throw new Error(JSON.stringify(fine));
    expect(fine.document.sections.map((section) => section.heading)).toEqual([null, 'Second part', 'Third part']);
    expect(fine.document.sections.map((section) => section.blocks.length)).toEqual([1, 1, 1]);
  });

  it('refuses a heading that no block follows, at the heading', () => {
    const outcome = compile(scroll([{ type: 'heading', text: 'Nothing follows' }]));
    expect(refusal(outcome)).toEqual({
      stage: 'structure',
      issues: [{ code: 'authoring_empty_section', path: 'blocks.3' }],
    });
  });

  it('compiles the same input to byte-identical output', () => {
    const authored = scroll([{ type: 'callout', cites: ['e3'], kind: 'note', text: 'Keepers drain it nightly.' }]);
    expect(JSON.stringify(compile(authored))).toBe(JSON.stringify(compile(authored)));
  });

  it('anchors a stated figure to a cited passage that contains it, and only then', () => {
    const stated = prose('The cistern holds 4,200 litres when it is full to the brim.', ['e3']);
    const outcome = compile(
      scroll([stated, prose('Two more points close the argument without any figures here.', ['e5'])]),
    );
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const anchor = outcome.internalProvenance.bindings.find((binding) => binding.kind === 'passage');
    expect(anchor).toMatchObject({ claimId: 'claim-3', field: 'text' });

    // The figure is in passage e3, but this block cites e5 only: the figure is not in its evidence.
    const uncited = compile(
      scroll([prose('The cistern holds 4,200 litres when it is full to the brim.', ['e5', 'e1'])]),
    );
    expect(refusal(uncited)).toEqual({
      stage: 'evidence',
      issues: [{ code: 'authoring_number_not_in_evidence', path: 'blocks.3' }],
    });
    // A figure that no passage contains.
    const invented = compile(scroll([prose('The cistern holds 9,999 litres when it is full to the brim.', ['e3'])]));
    expect(refusal(invented)?.issues).toEqual([{ code: 'authoring_number_not_in_evidence', path: 'blocks.3' }]);
  });

  it('lets a header state a figure that any cited passage contains', () => {
    const body = prose('The keepers drain the water each evening.', ['e3']);
    const outcome = compile(scroll([body], { title: 'A cistern of 4,200 litres' }));
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    expect(outcome.internalProvenance.bindings).toContainEqual(
      expect.objectContaining({ kind: 'header', field: 'title', claimId: 'claim-3' }),
    );
    expect(refusal(compile(scroll([body], { title: 'A cistern of 77 litres' })))?.issues).toEqual([
      { code: 'authoring_number_not_in_evidence', path: 'title' },
    ]);
  });

  it('refuses unknown handles and a document that cites too few passages, at the block that cites them', () => {
    const unknown = compile(scroll([prose('The keepers drain the water each evening.', ['e9'])]));
    expect(refusal(unknown)?.issues).toContainEqual({ code: 'authoring_cite_unknown', path: 'blocks.3' });
    const thin = AuthoredScroll.parse({
      title: 'How a harbour pump works',
      dek: 'A small invented pump explains lifting water in simple steps.',
      blocks: [prose('A short note grounded in one passage only.', ['e1'])],
    });
    expect(refusal(compile(thin))?.issues).toContainEqual({ code: 'authoring_too_few_cites', path: '$' });
  });

  it('refuses nine copied words with the block that holds them, and web addresses', () => {
    const copied = compile(
      scroll([
        prose('The brass harbour pump lifts water from the tidal basin into the cistern above the quay.', ['e1']),
      ]),
    );
    expect(refusal(copied)).toEqual({
      stage: 'evidence',
      issues: [{ code: 'copied_passage', path: 'blocks.3' }],
    });
    const address = compile(
      scroll([prose('Read more at www.example.org about the keepers and their chores.', ['e1'])]),
    );
    expect(refusal(address)?.issues).toEqual([{ code: 'text_mentions_web_address', path: 'blocks.3' }]);
  });

  it('reports the reading length against the brief at the document', () => {
    const outcome = compile(scroll([]), {
      publication: { ...provenance().publication, targetMinutes: [3, 5] },
    });
    expect(refusal(outcome)).toEqual({
      stage: 'brief',
      issues: [{ code: 'reading_length_out_of_brief', path: '$' }],
    });
  });
});

describe('compileAuthored: the interactive blocks', () => {
  const diagram: Block = {
    type: 'diagram',
    cites: ['e1', 'e4'],
    title: 'A harbour pump',
    layout: 'flow-lr',
    nodes: [
      { id: 'basin', label: 'Tidal basin' },
      { label: 'Pump', kind: 'process' },
      { id: 'cistern', label: 'Cistern' },
    ],
    edges: [
      { from: 'basin', to: 'Pump', label: 'Intake' },
      { id: 'lift', from: 'Pump', to: 'cistern', dashed: true },
    ],
    frames: [
      {
        label: 'High tide',
        description: 'The basin is full and the intake is deep under water.',
        highlight: ['basin', 'Pump > cistern'],
      },
      {
        label: 'Low tide',
        description: 'The basin is nearly empty but the intake still reaches water.',
        highlight: ['lift'],
        hide: ['basin>pump'],
      },
    ],
  };

  it('compiles a diagram whose frames name nodes by id or label and edges as from>to', () => {
    const outcome = compile(scroll([diagram]));
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const block = outcome.document.sections[0]?.blocks.at(-1);
    expect(block).toMatchObject({
      type: 'diagram',
      gesture: 'none',
      data: {
        interaction: { kind: 'toggle' },
        nodes: [{ id: 'basin' }, { id: 'pump', kind: 'process' }, { id: 'cistern' }],
        frames: [
          { id: 'high-tide', emphasis: ['basin', 'lift'], hidden: [] },
          { id: 'low-tide', emphasis: ['lift'], hidden: ['basin-pump'] },
        ],
      },
    });
    expect(block?.a11y.label).toBe('A harbour pump');
    expect(block?.type === 'diagram' && block.fallbackText).toContain('High tide: The basin is full');
  });

  it('names the block whose frame or edge references a node or edge that does not exist', () => {
    const broken = structuredClone(diagram);
    if (broken.type !== 'diagram') throw new Error('fixture');
    broken.frames[1] = {
      label: 'Low tide',
      description: 'The basin is nearly empty but the intake still reaches water.',
      highlight: ['valve'],
    };
    broken.edges[0] = { from: 'basin', to: 'nowhere' };
    expect(refusal(compile(scroll([broken])))?.issues).toEqual([
      { code: 'authoring_reference_unknown', path: 'blocks.3' },
    ]);
  });

  it('aligns a simulation’s maximum and default with its grid, marks it illustrative and needs no bindings', () => {
    const outcome = compile(
      scroll([
        {
          type: 'simulation',
          cites: ['e2'],
          title: 'Pump strokes',
          params: [{ key: 'strokes', label: 'Strokes per minute', min: 0, max: 10.4, step: 2, default: 3.1 }],
          constants: [{ key: 'cup', label: 'Water per stroke', value: 0.5, unit: 'litres' }],
          outputs: [
            {
              key: 'flow',
              label: 'Flow',
              unit: 'litres/min',
              formula: { kind: 'product', factors: ['strokes', 'cup'] },
            },
          ],
          view: 'plot',
          readout: 'At {strokes} strokes the pump moves {flow} litres per minute.',
          note: 'A simple model with invented numbers that ignores friction.',
        },
      ]),
    );
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const block = outcome.document.sections[0]?.blocks.at(-1);
    if (block?.type !== 'simulation') throw new Error('expected a simulation');
    expect(block.gesture).toBe('horizontal');
    expect(block.data.illustrative).toEqual({ notice: 'Illustrative' });
    expect(block.data.params[0]).toMatchObject({ min: 0, max: 10, step: 2, default: 4, control: 'slider' });
    expect(block.data.view).toMatchObject({ kind: 'plot', x: 'strokes', y: 'flow' });
    expect(block.data.display.kind).toBe('plot');
  });

  it('reports a simulation the canonical proof refuses, at the block', () => {
    const outcome = compile(
      scroll([
        {
          type: 'simulation',
          cites: ['e2'],
          title: 'Pump strokes',
          params: [{ key: 'strokes', label: 'Strokes per minute', min: 0, max: 10, step: 1, default: 3 }],
          outputs: [
            { key: 'flow', label: 'Flow', formula: { kind: 'ratio', numerator: 'strokes', denominator: 'strokes' } },
          ],
          note: 'A simple model with invented numbers that ignores friction.',
        },
      ]),
    );
    expect(refusal(outcome)).toEqual({
      stage: 'computation',
      issues: [{ code: 'sim_output_not_finite', path: 'blocks.3' }],
    });
  });

  it.each<[AuthoredBlockType, Block]>([
    [
      'comparison',
      {
        type: 'comparison',
        cites: ['e4'],
        title: 'Two intakes',
        columns: [
          { label: 'High', points: ['Deep water'] },
          { label: 'Low', points: ['Shallow water'] },
        ],
      },
    ],
    [
      'timeline',
      {
        type: 'timeline',
        cites: ['e2'],
        title: 'The pump over time',
        events: [
          { when: 'Later', title: 'A second piston', detail: 'Output doubles.' },
          { when: 'Earlier', title: 'One piston only' },
        ],
      },
    ],
    [
      'sequence',
      {
        type: 'sequence',
        cites: ['e5'],
        title: 'Each spring',
        steps: [
          { title: 'Drain', text: 'Empty the pump.' },
          { title: 'Swap', text: 'Fit a new washer.' },
        ],
      },
    ],
    [
      'bar-chart',
      {
        type: 'bar-chart',
        cites: ['e3'],
        title: 'Cistern',
        categories: ['Full', 'Drained'],
        series: [{ label: 'Litres', values: [4200, 0] }],
        axisLabel: 'Litres',
      },
    ],
    [
      'line-chart',
      {
        type: 'line-chart',
        cites: ['e3'],
        title: 'Level',
        xLabel: 'Hour',
        yLabel: 'Litres',
        series: [
          {
            label: 'Cistern',
            points: [
              [0, 4200],
              [4200, 0],
            ],
          },
        ],
      },
    ],
  ])('compiles a %s from plain strings', (type, block) => {
    const outcome = compile(scroll([block]));
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    const last = outcome.document.sections[0]?.blocks.at(-1);
    expect(last?.type).toBe(type === 'bar-chart' || type === 'line-chart' ? 'chart' : type);
    expect(last && 'fallbackText' in last ? last.fallbackText.length : 40).toBeGreaterThanOrEqual(40);
  });

  it('refuses chart figures no cited passage contains, so a chart cannot invent data', () => {
    const chart = (cites: string[], value: number): Block => ({
      type: 'bar-chart',
      cites,
      title: 'Cistern',
      categories: ['Full'],
      series: [{ label: 'Litres', values: [value] }],
      axisLabel: 'Litres',
    });
    expect(compile(scroll([chart(['e3'], 4200)])).kind).toBe('compiled');
    expect(refusal(compile(scroll([chart(['e5'], 4200)])))?.issues).toEqual([
      { code: 'authoring_number_not_in_evidence', path: 'blocks.3' },
    ]);
    expect(refusal(compile(scroll([chart(['e3'], 4300)])))?.issues).toEqual([
      { code: 'authoring_number_not_in_evidence', path: 'blocks.3' },
    ]);
  });
});

describe('AuthoredScroll: structure the harness can name', () => {
  it('requires citations on every block and refuses unknown block types', () => {
    const base = { title: 'How a harbour pump works', dek: 'A small invented pump explains lifting water.' };
    const missing = AuthoredScroll.safeParse({
      ...base,
      blocks: [{ type: 'paragraph', text: 'No cites.' }],
    });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['blocks', 0, 'cites']);
    const unknown = AuthoredScroll.safeParse({
      ...base,
      blocks: [{ type: 'carousel', cites: ['e1'] }],
    });
    expect(unknown.success).toBe(false);
  });

  it('ignores members it does not define and trims text', () => {
    const parsed = AuthoredScroll.parse({
      title: '  How a harbour pump works ',
      dek: 'A small invented pump explains lifting water.',
      note: 'ignored',
      blocks: [{ type: 'paragraph', cites: ['e1'], text: ' A line. ', id: 'x' }],
    });
    expect(parsed.title).toBe('How a harbour pump works');
    expect(parsed.blocks[0]).toEqual({ type: 'paragraph', cites: ['e1'], text: 'A line.' });
  });
});
