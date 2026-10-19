import { describe, expect, it } from 'vitest';
import type { Block, Section } from '../index.js';
import { arrange, make } from '../test-support/arbitraries.js';
import { fixture } from '../test-support/fixtures.js';
import { bindingIssues, honestyIssues, STRUCTURAL_LITERALS, type ProvenanceBinding } from './index.js';

const claims = [{ claimId: 'clm-a' }];
const sectionsOf = (...blocks: Block[]): Section[] => arrange([{ heading: 'only', blocks }]);
const codes = (sections: Section[], bindings: ProvenanceBinding[]) =>
  honestyIssues(sections, { claims, bindings }).map((issue) => issue.code);

describe('honesty checks', () => {
  it('pass for every fixture with its compiled provenance', () => {
    for (const name of ['attention-slowly', 'weight-other-worlds', 'spring-neap-tides'] as const) {
      const item = fixture(name);
      expect(honestyIssues(item.document.sections, item.internal), name).toEqual([]);
    }
  });

  it('require each sentence with a number to overlap a passage binding', () => {
    const sections = sectionsOf(
      make('paragraph', { spans: [{ text: 'Mars pulls weakly. A scale there reads 23 kg. That is all.' }] }),
    );
    const id = sections[0]?.blocks[0]?.id ?? '';
    expect(codes(sections, [])).toEqual(['numeric_sentence_unbound']);
    expect(codes(sections, [{ kind: 'passage', claimId: 'clm-a', blockId: id, start: 0, end: 17 }])).toEqual([
      'numeric_sentence_unbound',
    ]);
    expect(codes(sections, [{ kind: 'passage', claimId: 'clm-a', blockId: id, start: 30, end: 36 }])).toEqual([]);
  });

  it('require a binding for other blocks that show numbers, and for every chart', () => {
    const timeline = make('timeline', {
      title: 'Dates',
      events: [
        { id: 'first', when: '1687', title: 'Principia' },
        { id: 'second', when: 'Later', title: 'Tides explained' },
      ],
    });
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
    const code = make('code', { language: 'python', code: 'x = 42' });
    const sections = sectionsOf(timeline, chart, code);
    expect(codes(sections, [])).toEqual(['numeric_block_unbound', 'numeric_block_unbound']);
    const [first, second] = sections[0]?.blocks ?? [];
    expect(
      codes(sections, [
        { kind: 'block', claimId: 'clm-a', blockId: first?.id ?? '' },
        { kind: 'block', claimId: 'clm-a', blockId: second?.id ?? '' },
      ]),
    ).toEqual([]);
  });

  it('require every constant of a non-illustrative simulation to be bound, and forbid empirical literals in any simulation', () => {
    const weight = fixture('weight-other-worlds');
    const withoutSimulation = weight.internal.bindings.filter((binding) => binding.blockId !== 'weight-sim');
    expect(
      honestyIssues(weight.document.sections, { claims: weight.internal.claims, bindings: withoutSimulation }).map(
        (issue) => issue.code,
      ),
    ).toEqual(['numeric_block_unbound', 'constant_unbound', 'constant_unbound', 'constant_unbound']);
    const attention = fixture('attention-slowly');
    const sections = structuredClone(attention.document.sections);
    const sim = sections[1]?.blocks[2];
    if (sim?.type !== 'simulation') throw new Error('fixture changed');
    sim.data.outputs[0] = {
      ...sim.data.outputs[0]!,
      formula: { kind: 'power', x: 'len', base: 512, exponent: 2, scale: 1 },
    };
    expect(honestyIssues(sections, attention.internal).map((issue) => issue.code)).toEqual(['literal_not_declared']);
    expect([...STRUCTURAL_LITERALS].sort((a, b) => a - b)).toEqual([-1, 0, 0.5, 1, 2]);
  });

  it('check that bindings name existing claims, blocks, ranges and constants', () => {
    const sections = sectionsOf(make('paragraph', { spans: [{ text: 'Plain words only.' }] }));
    const id = sections[0]?.blocks[0]?.id ?? '';
    const issues = bindingIssues(sections, {
      claims,
      bindings: [
        { kind: 'block', claimId: 'clm-missing', blockId: id },
        { kind: 'block', claimId: 'clm-a', blockId: 'no-block' },
        { kind: 'passage', claimId: 'clm-a', blockId: id, start: 5, end: 500 },
        { kind: 'constant', claimId: 'clm-a', blockId: id, constantKey: 'gMoon' },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      'binding_claim_unknown',
      'binding_block_unknown',
      'binding_range_invalid',
      'binding_constant_unknown',
    ]);
  });
});
