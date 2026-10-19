import { describe, expect, it } from 'vitest';
import type { Block, ScrollDocument } from '../index.js';
import { arrange, make, seal } from '../test-support/arbitraries.js';
import { fixture } from '../test-support/fixtures.js';
import { bindingIssues, honestyIssues, STRUCTURAL_LITERALS, type ProvenanceBinding } from './index.js';

const claims = [{ claimId: 'clm-a' }];
const documentOf = (...blocks: Block[]): ScrollDocument => seal(arrange([{ heading: 'only', blocks }]));
const codes = (document: ScrollDocument, bindings: ProvenanceBinding[]) =>
  honestyIssues(document, { claims, bindings }).map((issue) => issue.code);
const firstId = (document: ScrollDocument) => document.sections[0]?.blocks[0]?.id ?? '';

describe('honesty checks', () => {
  it('pass for every fixture with its compiled provenance', () => {
    for (const name of ['attention-slowly', 'weight-other-worlds', 'spring-neap-tides'] as const) {
      const item = fixture(name);
      expect(honestyIssues(item.document, item.internal), name).toEqual([]);
    }
  });

  it('require every numeric token to lie inside an anchor — not merely in a bound sentence', () => {
    const document = documentOf(
      make('paragraph', { spans: [{ text: 'Mars has a day of 24.6 hours and a year of 687 days.' }] }),
    );
    const id = firstId(document);
    expect(codes(document, [])).toEqual(['number_unbound', 'number_unbound']);
    // An anchor on "Mars" overlaps the sentence but covers neither number.
    expect(
      codes(document, [{ kind: 'passage', claimId: 'clm-a', blockId: id, field: 'text', start: 0, end: 4 }]),
    ).toEqual(['number_unbound', 'number_unbound']);
    // "a day of 24.6 hours" covers one token; the other stays unbound.
    expect(
      codes(document, [{ kind: 'passage', claimId: 'clm-a', blockId: id, field: 'text', start: 9, end: 28 }]),
    ).toEqual(['number_unbound']);
    expect(
      codes(document, [{ kind: 'passage', claimId: 'clm-a', blockId: id, field: 'text', start: 0, end: 52 }]),
    ).toEqual([]);
  });

  it('refuse an anchor that crosses a sentence boundary', () => {
    const document = documentOf(
      make('paragraph', { spans: [{ text: 'Venus spins once in 243 days. Mercury needs 59 days.' }] }),
    );
    const id = firstId(document);
    expect(
      codes(document, [{ kind: 'passage', claimId: 'clm-a', blockId: id, field: 'text', start: 20, end: 46 }]),
    ).toEqual(['binding_anchor_crosses_sentence', 'number_unbound', 'number_unbound']);
  });

  it('count Unicode number forms, and check every reader-facing field except a code body', () => {
    const paragraph = make('paragraph', {
      spans: [{ text: 'Mars pulls about ⅜ as hard, and the pull falls with distance².' }],
    });
    const code = {
      ...make('code', {
        language: 'python',
        title: 'g = 3.71 on Mars',
        code: 'print(9.81 * ratio)',
        caption: 'Earth pulls 9.81.',
      }),
      a11y: { label: 'Code for 2 worlds', description: 'Prints 1 value.' },
    };
    const document = documentOf(paragraph, code);
    expect(honestyIssues(document, { claims, bindings: [] }).map((issue) => issue.path)).toEqual([
      'sections.0.blocks.0.text@17',
      'sections.0.blocks.0.text@60',
      'sections.0.blocks.1.a11y.label@9',
      'sections.0.blocks.1.a11y.description@7',
      'sections.0.blocks.1.data.title@4',
      'sections.0.blocks.1.data.caption@12',
    ]);
  });

  it('check the title, dek, kicker and section headings, which are bindable', () => {
    const base = documentOf(make('paragraph', { spans: [{ text: 'Plain words only.' }] }));
    const document = seal(
      base.sections.map((section) => ({ ...section })),
      {
        title: 'Why 3 bodies are hard',
        dek: 'Gravity with two bodies is solved; with three it is not.',
        kicker: 'Physics',
      },
    );
    expect(codes(document, [])).toEqual(['number_unbound']);
    expect(codes(document, [{ kind: 'header', claimId: 'clm-a', field: 'title', start: 4, end: 5 }])).toEqual([]);
    const headed = seal([
      ...base.sections,
      {
        id: 'second',
        heading: 'The 2 tides',
        blocks: [make('paragraph', { spans: [{ text: 'More words.' }] })].map((block) => ({ ...block, id: 'more' })),
      },
    ]);
    expect(codes(headed, [])).toEqual(['number_unbound']);
    expect(codes(headed, [{ kind: 'heading', claimId: 'clm-a', sectionId: 'second', start: 4, end: 5 }])).toEqual([]);
  });

  it('require a binding for every chart', () => {
    const chart = make('chart', {
      title: 'Bars',
      spec: {
        kind: 'bar',
        orientation: 'vertical',
        categories: ['a'],
        series: [{ id: 'only', label: 'only', values: [1] }],
        valueAxis: { label: 'v', scale: 'linear' },
      },
    });
    const document = documentOf(chart);
    expect(codes(document, [])).toEqual(['numeric_block_unbound']);
    expect(codes(document, [{ kind: 'block', claimId: 'clm-a', blockId: firstId(document) }])).toEqual([]);
  });

  it('require a non-illustrative simulation to bind every number it states', () => {
    const weight = fixture('weight-other-worlds');
    const withoutSimulation = weight.internal.bindings.filter(
      (binding) => !('blockId' in binding) || binding.blockId !== 'weight-sim',
    );
    expect(
      honestyIssues(weight.document, { claims: weight.internal.claims, bindings: withoutSimulation }).map(
        (issue) => issue.code,
      ),
    ).toEqual([
      'number_unbound',
      'number_unbound',
      'number_unbound',
      'number_unbound',
      'simulation_unbound',
      'simulation_number_unbound',
      'simulation_number_unbound',
      'simulation_number_unbound',
      'constant_unbound',
      'constant_unbound',
      'constant_unbound',
    ]);
    expect([...STRUCTURAL_LITERALS].sort((a, b) => a - b)).toEqual([-1, 0, 0.5, 1, 2]);
  });

  it('let an illustrative simulation state numbers without bindings', () => {
    const attention = fixture('attention-slowly');
    const sim = attention.document.sections[1]?.blocks[2];
    if (sim?.type !== 'simulation') throw new Error('fixture changed');
    expect(sim.data.illustrative).toEqual({ notice: 'Illustrative' });
    const others = attention.internal.bindings.filter(
      (binding) => !('blockId' in binding) || binding.blockId !== sim.id,
    );
    expect(honestyIssues(attention.document, { claims: attention.internal.claims, bindings: others })).toEqual([]);
  });

  it('check that bindings name existing claims, blocks, fields, ranges, constants and values', () => {
    const document = documentOf(make('paragraph', { spans: [{ text: 'Plain words only.' }] }));
    const id = firstId(document);
    const issues = bindingIssues(document, {
      claims,
      bindings: [
        { kind: 'block', claimId: 'clm-missing', blockId: id },
        { kind: 'block', claimId: 'clm-a', blockId: 'no-block' },
        { kind: 'passage', claimId: 'clm-a', blockId: id, field: 'text', start: 5, end: 500 },
        { kind: 'passage', claimId: 'clm-a', blockId: id, field: 'data.caption', start: 0, end: 1 },
        { kind: 'constant', claimId: 'clm-a', blockId: id, constantKey: 'gMoon' },
        { kind: 'value', claimId: 'clm-a', blockId: id, path: 'params.0.max' },
        { kind: 'heading', claimId: 'clm-a', sectionId: 'nowhere', start: 0, end: 1 },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      'binding_claim_unknown',
      'binding_block_unknown',
      'binding_range_invalid',
      'binding_field_unknown',
      'binding_constant_unknown',
      'binding_value_unknown',
      'binding_section_unknown',
    ]);
  });
});
