/**
 * Regression tests for the independent review of PR #254 (`agents/review-254/review.md`). Each
 * `p<n>` reproduces the reviewer's proof-of-concept input and asserts the corrected behaviour.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BlockState,
  buildBlockStateSnapshot,
  canonicalJson,
  createPassageLocator,
  deriveAnchorMap,
  evaluateSimulation,
  FULL_V1_CAPABILITIES,
  LIMITS,
  negotiate,
  parseBlock,
  parseCapabilities,
  quoteHash,
  repointLocator,
  snapToGrid,
  utf8ByteLength,
  validateDocument,
  validateLocator,
  visibleTexts,
  walkBlocks,
  type Block,
  type ScrollDocument,
  type SimulationParam,
} from './index.js';
import { compileDraft, draftFromDocument, validateDraft } from './producer/index.js';
import { normaliseDraftInput } from './producer/normalise.js';
import { make, seal } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';
import { fastestMs } from './test-support/timing.js';

type DraftBlockValue = Record<string, unknown> & { data: Record<string, unknown> };
type DraftValue = Record<string, unknown> & {
  dek: string;
  sections: Array<{ heading: string | null; blocks: DraftBlockValue[] }>;
  bindings: unknown[];
};

const weight = fixture('weight-other-worlds');
const attention = fixture('attention-slowly');
const weightDraft = () => structuredClone(weight.draft) as DraftValue;
const compile = (draft: unknown) => compileDraft(draft, weight.provenance);
const refusalCodes = (draft: unknown) => {
  const outcome = compile(draft);
  return outcome.kind === 'refused' ? outcome.issues.map((issue) => issue.code) : [];
};
const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', data: { spans: text } });

describe('review-254 p1: a validated simulation cannot be infinite at a reachable grid point', () => {
  it('refuses 1 / (five − distance) over distance 0…10', () => {
    const draft = weightDraft();
    const sim = draft.sections[0]?.blocks[0];
    if (sim === undefined) throw new Error('fixture changed');
    sim.data = {
      ...sim.data,
      params: [
        {
          key: 'distance',
          label: 'Distance',
          unit: 'm',
          min: 0,
          max: 10,
          step: 1,
          default: 2,
          control: 'slider',
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      constants: [{ key: 'five', label: 'Where the wall stands', value: 5 }],
      outputs: [
        {
          key: 'gap',
          label: 'Gap',
          formula: { kind: 'linear', x: 'distance', a: -1, b: 'five' },
          format: { decimals: 1, grouping: false, approximate: false },
        },
        {
          key: 'pull',
          label: 'Pull',
          formula: { kind: 'ratio', numerator: 1, denominator: 'gap' },
          format: { decimals: 2, grouping: false, approximate: false },
        },
      ],
      view: { kind: 'readout', primary: 'pull' },
      readout: { template: 'Pull {pull}', bands: [] },
      illustrative: true,
    };
    draft.bindings = draft.bindings.filter((binding) => (binding as { blockId?: string }).blockId !== 'weight-sim');
    expect(compile(draft)).toMatchObject({
      kind: 'refused',
      stage: 'computation',
      issues: [{ code: 'sim_output_not_finite' }],
    });
  });
});

describe('review-254 p2: negotiate never produces a rendition the validator refuses', () => {
  it('counts each substitutable block at its longer of text and fallback text when validating the stored revision', () => {
    const document = structuredClone(attention.document);
    const words = 'Attention compares every word with every other word in the passage it reads. ';
    const last = document.sections[document.sections.length - 1];
    if (last === undefined) throw new Error('fixture changed');
    // Pad the visible text to just under 24,000 characters, as the reviewer did.
    const visible = () =>
      document.kicker.length +
      document.title.length +
      document.dek.length +
      document.sections.reduce((total, section) => total + (section.heading?.length ?? 0), 0) +
      [...walkBlocks(document.sections)].reduce(
        (total, visit) => total + visibleTexts(visit.block).reduce((sum, text) => sum + text.length, 0),
        0,
      );
    let padding = 0;
    while (visible() < 23_800) {
      const room = Math.min(1_150, 23_800 - visible());
      const text = words
        .repeat(Math.ceil(room / words.length))
        .slice(0, room)
        .trim();
      last.blocks.push({
        ...make('paragraph', { spans: [{ text: text.length > 0 ? text : 'Word.' }] }),
        id: `pad-${padding}`,
      });
      padding += 1;
    }
    expect(visible()).toBeLessThan(LIMITS.visibleChars);
    const code = {
      ...make('code', { language: 'text', code: 'x' }),
      id: 'pad-code',
      essential: true,
      fallbackText: `${'This code computes the score of every pair of words. '.repeat(22).slice(0, 1_150).trim()}`,
    };
    last.blocks.push(code);
    const stored = seal(document.sections, document);
    const outcome = validateDocument(stored);
    // The worst rendition (a client without `code`) would exceed 24,000 visible characters, so the
    // stored revision is refused instead of producing an invalid rendition later.
    expect(outcome.kind === 'invalid' && outcome.issues.map((issue) => issue.code)).toContain('visible_text_too_long');
    const lean = seal(
      document.sections.map((section) => ({
        ...section,
        blocks: section.blocks.filter((block) => !block.id.startsWith('pad-') || block.id === 'pad-code'),
      })),
      document,
    );
    expect(validateDocument(lean).kind).toBe('valid');
    const caps = structuredClone(FULL_V1_CAPABILITIES);
    delete caps.blocks['code'];
    const negotiated = negotiate(lean, caps);
    if (negotiated.kind !== 'negotiated') throw new Error(negotiated.kind);
    expect(negotiated.degradedEssential.map((entry) => entry.blockId)).toContain('pad-code');
    expect(validateDocument(negotiated.document, { purpose: 'rendition' }).kind).toBe('valid');
  });
});

describe('review-254 p3: re-pointing reports every change', () => {
  it('reports a rewritten paragraph as changed and resets state when a personal flag flips', () => {
    const rev1 = weight.document;
    const rewritten = structuredClone(rev1);
    const block = rewritten.sections[0]?.blocks.find((candidate) => candidate.id === 'scales-p1');
    if (block?.type !== 'paragraph') throw new Error('fixture changed');
    block.data = { spans: [{ text: 'An entirely different claim now lives under this id.' }] };
    const rev2 = seal(rewritten.sections, { ...rewritten, revision: 2 });
    const map = deriveAnchorMap(rev1, rev2);
    if (map.kind !== 'derived') throw new Error(map.reason);
    const locator = {
      kind: 'scroll_block' as const,
      assetId: rev1.assetId,
      revision: 1,
      blockId: 'scales-p1',
      blockType: 'paragraph',
      blockVersion: 1,
    };
    const outcome = repointLocator(locator, rev1, rev2, map.map);
    expect(outcome.kind).not.toBe('same');
    expect(outcome).toMatchObject({ kind: 'remapped', change: 'text-changed' });

    const sim = rev1.sections[0]?.blocks[0];
    if (sim?.type !== 'simulation') throw new Error('fixture changed');
    const snapshot = buildBlockStateSnapshot(
      sim,
      { type: 'simulation', params: { weightKg: 80 } },
      { includePersonal: true },
    );
    if (snapshot.kind !== 'snapshot') throw new Error(snapshot.kind);
    const simLocator = {
      kind: 'scroll_block' as const,
      assetId: rev1.assetId,
      revision: 1,
      blockId: sim.id,
      blockType: 'simulation',
      blockVersion: 1,
      state: snapshot.snapshot,
    };
    const flipped = structuredClone(rev1);
    const flippedSim = flipped.sections[0]?.blocks[0];
    if (flippedSim?.type !== 'simulation') throw new Error('fixture changed');
    flippedSim.data.params = flippedSim.data.params.map(({ personal: _personal, ...param }) => param);
    const rev3 = seal(flipped.sections, { ...flipped, revision: 3 });
    const map3 = deriveAnchorMap(rev1, rev3);
    if (map3.kind !== 'derived') throw new Error(map3.reason);
    const repointed = repointLocator(simLocator, rev1, rev3, map3.map);
    expect(repointed).toMatchObject({ kind: 'state-reset' });
    if (repointed.kind === 'state-reset') expect(validateLocator(rev3, repointed.locator).kind).toBe('valid');
  });
});

describe('review-254 p4: empirical numbers cannot reach readers unbound', () => {
  it('(a) checks the dek and section headings', () => {
    const draft = weightDraft();
    draft.dek = 'Mars pulls with 38% of the force of Earth, the Moon with 16.5%.';
    const section = draft.sections[1];
    if (section !== undefined) section.heading = 'Jupiter pulls 2.53 times harder';
    expect(refusalCodes(draft)).toEqual(['number_unbound', 'number_unbound', 'number_unbound']);
  });

  it('(b) needs the anchor to cover the number, not just the sentence', () => {
    const draft = weightDraft();
    draft.sections[0]?.blocks.push(paragraph('mars-p', 'Mars has a day of 24.6 hours and a year of 687 days.'));
    draft.bindings.push({ kind: 'passage', claimId: 'clm-gravity-moon', blockId: 'mars-p', anchorText: 'Mars' });
    expect(refusalCodes(draft)).toEqual(['number_unbound', 'number_unbound']);
  });

  it('(c) refuses an anchor that straddles a sentence break', () => {
    const draft = weightDraft();
    draft.sections[0]?.blocks.push(paragraph('two-p', 'Venus spins once in 243 days. Mercury needs 59 days.'));
    draft.bindings.push({ kind: 'passage', claimId: 'clm-gravity-moon', blockId: 'two-p', anchorText: '. M' });
    expect(refusalCodes(draft)).toEqual(['binding_anchor_crosses_sentence', 'number_unbound', 'number_unbound']);
  });

  it('(d) refuses an empirical exponent, lookup breakpoints and band thresholds in a non-illustrative simulation', () => {
    const draft = weightDraft();
    const sim = draft.sections[0]?.blocks[0];
    if (sim === undefined) throw new Error('fixture changed');
    sim.data = {
      title: 'How fast an animal burns energy',
      params: [
        {
          key: 'mass',
          label: 'Body mass',
          unit: 'kg',
          min: 1,
          max: 100,
          step: 1,
          default: 70,
          control: 'slider',
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      constants: [],
      outputs: [
        {
          key: 'rate',
          label: 'Energy use',
          formula: { kind: 'power', x: 'mass', base: 1, exponent: 0.75, scale: 1 },
          format: { decimals: 1, grouping: false, approximate: false },
        },
        {
          key: 'risk',
          label: 'Risk band',
          formula: {
            kind: 'lookup',
            input: 'mass',
            mode: 'step',
            table: [
              { at: 18.5, value: 0 },
              { at: 25, value: 1 },
              { at: 30, value: 2 },
            ],
          },
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      view: { kind: 'readout', primary: 'rate', secondary: 'risk' },
      readout: {
        template: 'Energy use {rate}',
        bands: [
          { output: 'rate', max: 20, text: 'A small animal.' },
          { output: 'rate', min: 20, text: 'A large animal.' },
        ],
      },
      modelNote: 'Energy use grows with mass to the three-quarter power.',
      illustrative: false,
    };
    sim['fallbackText'] =
      'Text version: energy use grows more slowly than body mass, so a large animal burns less per kilogram.';
    draft.bindings = draft.bindings.filter((binding) => (binding as { blockId?: string }).blockId !== 'weight-sim');
    const issues = compile(draft);
    expect(issues.kind).toBe('refused');
    if (issues.kind !== 'refused') return;
    const paths = issues.issues.map((issue) => `${issue.code} ${issue.path}`);
    for (const path of [
      'simulation_unbound sections.0.blocks.0',
      'simulation_number_unbound sections.0.blocks.0.data.params.0.max',
      'simulation_number_unbound sections.0.blocks.0.data.params.0.default',
      'simulation_number_unbound sections.0.blocks.0.data.outputs.0.formula.exponent',
      'simulation_number_unbound sections.0.blocks.0.data.outputs.1.formula.table.0.at',
      'simulation_number_unbound sections.0.blocks.0.data.outputs.1.formula.table.1.at',
      'simulation_number_unbound sections.0.blocks.0.data.outputs.1.formula.table.2.at',
      'simulation_number_unbound sections.0.blocks.0.data.readout.bands.0.max',
      'simulation_number_unbound sections.0.blocks.0.data.readout.bands.1.min',
    ]) {
      expect(paths).toContain(path);
    }
  });

  it('(e) checks a non-text block\\u2019s a11y label', () => {
    const draft = weightDraft();
    draft.sections[2]?.blocks.push({
      id: 'fig-d',
      type: 'diagram',
      a11y: { label: 'Mars pulls 38% as hard as Earth' },
      fallbackText: 'Text version: a diagram showing that Mars pulls on you less hard than Earth does.',
      data: {
        title: 'Two worlds',
        layout: 'flow-lr',
        nodes: [
          { id: 'earth', label: 'Earth', kind: 'entity' },
          { id: 'mars', label: 'Mars', kind: 'entity' },
        ],
        edges: [{ id: 'e-1', from: 'earth', to: 'mars', directed: true, style: 'solid' }],
        groups: [],
        frames: [],
        interaction: { kind: 'static' },
      },
    });
    expect(refusalCodes(draft)).toEqual(['number_unbound']);
  });

  it('(f) checks digits in a number format suffix, even in an illustrative simulation', () => {
    const draft = weightDraft();
    const sim = draft.sections[0]?.blocks[0];
    if (sim === undefined) throw new Error('fixture changed');
    sim.data['illustrative'] = true;
    const outputs = sim.data['outputs'] as Array<{ format: Record<string, unknown> }>;
    if (outputs[0] !== undefined) outputs[0].format['suffix'] = '×10⁸ km';
    // "10⁸" is one token: digits and a superscript.
    expect(refusalCodes(draft)).toEqual(['number_unbound']);
  });
});

describe('review-254 p5: prototype keys, deep nesting and lone surrogates', () => {
  const raw = JSON.stringify(weight.draft);
  it('never lets an own __proto__ key become a prototype, and refuses it as an unknown member', () => {
    const hidden = JSON.parse(
      raw.replace('"id":"scales-p1"', '"__proto__":{"gesture":"two-axis","version":9},"id":"scales-p1"'),
    ) as DraftValue;
    const normalised = normaliseDraftInput(hidden) as DraftValue;
    const block = normalised.sections[0]?.blocks[1];
    expect(block !== undefined && Object.getPrototypeOf(block)).toBeNull();
    expect(block !== undefined && Object.hasOwn(block, '__proto__')).toBe(true);
    expect(validateDraft(hidden, weight.provenance)).toMatchObject({
      kind: 'refused',
      stage: 'schema',
      issues: [{ code: 'schema_unrecognized_keys' }],
    });
    const top = JSON.parse(raw.replace('"draftVersion"', '"__proto__":{"anything":1},"draftVersion"')) as unknown;
    expect(validateDraft(top, weight.provenance)).toMatchObject({ kind: 'refused', stage: 'schema' });
    const document = JSON.parse(
      JSON.stringify(weight.document).replace('"assetId"', '"__proto__":{"x":1},"assetId"'),
    ) as unknown;
    expect(validateDocument(document).kind).toBe('invalid');
  });

  it('refuses deep nesting with its own code, without throwing', () => {
    const deep = JSON.parse(raw) as DraftValue;
    const block = deep.sections[0]?.blocks[1];
    if (block !== undefined)
      block.data['extra'] = JSON.parse(`${'['.repeat(120_000)}${']'.repeat(120_000)}`) as unknown;
    expect(validateDraft(deep, weight.provenance)).toEqual({
      kind: 'refused',
      stage: 'envelope',
      issues: [{ code: 'draft_too_deep', path: '$' }],
    });
    const deepDocument = {
      ...weight.document,
      sections: JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`) as unknown,
    };
    expect(validateDocument(deepDocument)).toEqual({
      kind: 'invalid',
      issues: [{ code: 'document_too_deep', path: '$' }],
    });
    expect(parseBlock(JSON.parse(`${'['.repeat(50_000)}${']'.repeat(50_000)}`))).toMatchObject({ kind: 'invalid' });
  });

  it('refuses lone surrogates, so two different quotes can never hash alike', () => {
    expect(quoteHash('\uD800')).toBe(quoteHash('\uFFFD'));
    const draft = weightDraft();
    const block = draft.sections[0]?.blocks[1];
    if (block !== undefined) block.data['spans'] = [{ text: 'Lone \uD800 surrogate here.' }];
    expect(refusalCodes(draft)).toEqual(['text_not_plain']);
  });
});

describe('review-254 p6: smaller checks', () => {
  it('(a) refuses a log axis whose domain reaches zero or below', () => {
    const chart = structuredClone(weight.document.sections[1]?.blocks.find((block) => block.type === 'chart'));
    if (chart?.type !== 'chart' || chart.data.spec.kind !== 'bar') throw new Error('fixture changed');
    chart.data.spec.valueAxis = { ...chart.data.spec.valueAxis, scale: 'log', domain: [-5, 10] };
    expect(parseBlock(chart)).toMatchObject({ kind: 'invalid', issues: [{ code: 'chart_log_scale' }] });
  });

  it('(b) never lets a passage split a letter from its combining mark', () => {
    const document = seal([
      { id: 'only', heading: null, blocks: [{ ...make('paragraph', { spans: [{ text: 'q̇ and x' }] }), id: 'p-x' }] },
    ]);
    expect(validateDocument(document).kind).toBe('valid');
    expect(createPassageLocator(document, 'p-x', 0, 1)).toEqual({ kind: 'invalid', reason: 'range-splits-character' });
    expect(createPassageLocator(document, 'p-x', 0, 2).kind).toBe('locator');
  });

  it('(c) ignores hostile keys in values and clamps them onto the grid', () => {
    const sim = weight.document.sections[0]?.blocks[0];
    if (sim?.type !== 'simulation') throw new Error('fixture changed');
    const hostile = JSON.parse(
      '{"__proto__":{"weightKg":1e300},"constructor":5,"toString":7,"weightKg":1e308}',
    ) as Record<string, number>;
    const values = evaluateSimulation(sim.data, hostile);
    expect(values.params).toEqual({ weightKg: 200 });
    for (const value of Object.values(values.outputs)) expect(Number.isFinite(value)).toBe(true);
  });

  it('(d, e) refuses a snapshot with unknown keys and reserved parameter keys', () => {
    const sim = weight.document.sections[0]?.blocks[0];
    if (sim === undefined) throw new Error('fixture changed');
    const big = {
      type: 'simulation' as const,
      params: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`k${index}`, index])),
    };
    expect(buildBlockStateSnapshot(sim, big)).toMatchObject({ kind: 'invalid-state' });
    expect(BlockState.safeParse({ type: 'simulation', params: { constructor: 1 } }).success).toBe(false);
  });

  it('(f) refuses a huge capability key set cheaply', () => {
    const blocks = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, index) => [`type-x${index.toString(36).replace(/\d/gu, 'y')}`, [1]]),
    );
    const input = { documentSchemas: ['scroll-document.v1'], blocks };
    expect(parseCapabilities(input).kind).toBe('invalid');
    expect(negotiate(weight.document, input).kind).toBe('invalid-capabilities');
    expect(
      fastestMs(() => {
        parseCapabilities(input);
        negotiate(weight.document, input);
      }),
    ).toBeLessThan(250);
  });
});

describe('review-254 p7: validation cost is bounded and front-loads the cheap checks', () => {
  const format = { decimals: 0, grouping: false, approximate: false };
  const heavy = (id: string): Block => ({
    ...make('simulation', {
      title: 'Heavy',
      params: [
        { key: 'a', label: 'Dial a', min: 0, max: 1_000, step: 1, default: 0, control: 'slider', format },
        { key: 'b', label: 'Dial b', min: 0, max: 8, step: 1, default: 0, control: 'slider', format },
      ],
      constants: Array.from({ length: 12 }, (_, index) => ({
        key: `k${'abcdefghijkl'.charAt(index)}`,
        label: 'K',
        value: 1,
      })),
      outputs: Array.from({ length: 6 }, (_, index) => ({
        key: `o${'abcdef'.charAt(index)}`,
        label: 'O',
        formula: { kind: 'product' as const, factors: ['a', 'b', 'ka', 'kb'] },
        format,
      })),
      view: { kind: 'plot', x: 'a', y: 'oa', yLabel: 'y' },
      modelNote: 'Illustrative only here.',
      illustrative: { notice: 'Illustrative' },
      // What the proof would compute (a·b at most 1,000 · 8); given, so 960 blocks need no sweep.
      display: { kind: 'plot', range: [0, 8_000] },
    }),
    id,
  });

  it('refuses a 2 MB document on its size before any block is checked', () => {
    const document: ScrollDocument = structuredClone(weight.document);
    const sections = Array.from({ length: 12 }, (_, section) => ({
      id: `sec-${section}`.replace(/\d+/u, (n) => 'abcdefghijkl'.charAt(Number(n))),
      heading: section === 0 ? null : 'Heading',
      blocks: Array.from({ length: 80 }, (_, block) =>
        heavy(`s-${section}-${block}`.replace(/\d/gu, (n) => 'abcdefghij'.charAt(Number(n)))),
      ),
    }));
    const huge = { ...document, sections };
    expect(utf8ByteLength(canonicalJson(huge))).toBeGreaterThan(1_000_000);
    expect(validateDocument(huge)).toEqual({ kind: 'invalid', issues: [{ code: 'document_too_large', path: '$' }] });
    expect(fastestMs(() => validateDocument(huge), 3)).toBeLessThan(500);
  });

  it('skips simulation evaluation once a counted limit fails, in drafts too', () => {
    const draft = weightDraft();
    const block = (index: number) => {
      const sim = heavy(
        `sim-${'abcdefghijklmnopqrstuvwxyz'.charAt(index % 26)}${'abcdefghijklmnopqrstuvwxyz'.charAt(Math.floor(index / 26))}`,
      );
      const { version: _version, gesture: _gesture, ...rest } = sim;
      // A draft never carries the display scale: code sets it.
      const { display: _display, ...data } = rest.data as Record<string, unknown>;
      return { ...rest, data: { ...data, illustrative: true } } as unknown as DraftBlockValue;
    };
    draft.sections = [{ heading: null, blocks: Array.from({ length: 60 }, (_, index) => block(index)) }];
    draft.bindings = [];
    const outcome = validateDraft(draft, weight.provenance);
    expect(fastestMs(() => validateDraft(draft, weight.provenance), 3)).toBeLessThan(1_000);
    expect(outcome).toMatchObject({ kind: 'refused', stage: 'structure' });
    if (outcome.kind === 'refused') expect(outcome.issues.map((issue) => issue.code)).toContain('too_many_interactive');
  });
});

describe('review-254 p8: the fixtures stay idempotent', () => {
  it('compiles every fixture idempotently', () => {
    for (const item of [attention, weight, fixture('spring-neap-tides')]) {
      const once = compileDraft(item.draft, item.provenance);
      if (once.kind !== 'compiled') throw new Error(JSON.stringify(once));
      const twice = compileDraft(draftFromDocument(once.document, once.internalProvenance.bindings), item.provenance);
      expect(twice.kind === 'compiled' && canonicalJson(twice.document)).toBe(canonicalJson(once.document));
      expect(once.document.integrity.sha256).toBe(item.document.integrity.sha256);
    }
  });
});

describe('review-254 p9: the copy check covers every reader-facing text', () => {
  const excerpt =
    'the gravitational acceleration at the surface of a planet depends on its mass and on its radius squared';
  const copied =
    'The gravitational acceleration at the surface of a planet depends on its mass and on its radius squared.';
  const run = (mutate: (draft: DraftValue) => void) => {
    const draft = weightDraft();
    mutate(draft);
    const outcome = compileDraft(draft, { ...weight.provenance, material: [excerpt] });
    return outcome.kind === 'refused' ? outcome.issues.map((issue) => issue.code) : [];
  };
  it('refuses copied runs in a11y descriptions, alt text and transcripts as in prose', () => {
    expect(run((draft) => draft.sections[0]?.blocks.push(paragraph('cp', copied)))).toEqual(['copied_passage']);
    expect(
      run((draft) => {
        const block = draft.sections[0]?.blocks[0];
        if (block !== undefined) block['a11y'] = { label: 'Your weight on four worlds', description: copied };
      }),
    ).toEqual(['copied_passage']);
    expect(
      run((draft) => {
        const block = draft.sections[1]?.blocks[0];
        if (block !== undefined) block['a11y'] = { label: 'Surface gravity compared with Earth', description: copied };
      }),
    ).toEqual(['copied_passage']);
  });
});

describe('review-254 p10: number forms and code captions', () => {
  it('(a) treats ⅜ and ² as numbers', () => {
    const draft = weightDraft();
    draft.sections[0]?.blocks.push(
      paragraph('n2', 'Mars pulls about ⅜ as hard as Earth, and the pull falls with distance².'),
    );
    expect(refusalCodes(draft)).toEqual(['number_unbound', 'number_unbound']);
  });

  it('(b) checks a code block\\u2019s caption and title but not its body', () => {
    const draft = weightDraft();
    draft.sections[2]?.blocks.push({
      id: 'c1',
      type: 'code',
      a11y: { label: 'Code' },
      fallbackText: 'Text version: the program multiplies a weight by the ratio between two worlds.',
      data: {
        language: 'python',
        title: 'g = 3.71 on Mars',
        code: 'print(weight * 3.71)',
        caption: 'Mars surface gravity is 3.71 m/s², Earth’s 9.81 m/s².',
      },
    });
    const outcome = compile(draft);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    const paths = outcome.issues.map((issue) => issue.path);
    expect(paths.some((path) => path.includes('data.title@'))).toBe(true);
    expect(paths.some((path) => path.includes('data.caption@'))).toBe(true);
    expect(paths.some((path) => path.includes('data.code'))).toBe(false);
  });
});

describe('review-254 p11: snapToGrid never returns NaN', () => {
  it('returns a finite value for any parameter, even one validation would refuse', () => {
    const format = { decimals: 0, grouping: false, approximate: false };
    const finiteOrNot = fc.oneof(
      fc.double(),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0),
    );
    fc.assert(
      fc.property(
        finiteOrNot,
        finiteOrNot,
        finiteOrNot,
        finiteOrNot,
        finiteOrNot,
        (min, max, step, fallback, value) => {
          const param: SimulationParam = {
            key: 'x',
            label: 'X',
            min,
            max,
            step,
            default: fallback,
            control: 'slider',
            format,
          };
          expect(Number.isNaN(snapToGrid(param, value))).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
    const data = {
      params: [{ key: 'x', label: 'X', min: 0, max: 10, step: 0, default: 5, control: 'slider' as const, format }],
      constants: [],
      outputs: [{ key: 'y', label: 'Y', formula: { kind: 'product' as const, factors: ['x', 2] }, format }],
    };
    expect(evaluateSimulation(data, { x: 3 })).toEqual({ params: { x: 5 }, outputs: { y: 10 } });
  });
});
