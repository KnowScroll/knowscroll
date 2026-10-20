/**
 * Regression tests for the independent re-review of PR #254 at `a06b5960`
 * (`agents/review-254b/review.md`): the three majors and the minors that changed behaviour. MA-1
 * (linear text checks) is mostly in `primitives.test.ts` and `performance.test.ts`, where the
 * costs are measured.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as admission from './admission/index.js';
import {
  admitBlock,
  admitDocument,
  deriveAnchorMap,
  displayFraction,
  evaluateSimulation,
  gridValues,
  parseBlock,
  parseDocument,
  repointLocator,
  simulationGridPoints,
  validateDocument,
  walkBlocks,
  type Block,
  type Formula,
  type ScrollDocument,
} from './index.js';
import * as publicEntry from './index.js';
import { honestyIssues } from './internal/index.js';
import { compileDraft } from './producer/index.js';
import { simulationProof } from './simulation/checks.js';
import { sameDisplay } from './simulation/display.js';
import { make, seal, type SimulationInput } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';

type Loose = Record<string, unknown>;

const weight = fixture('weight-other-worlds');
const attention = fixture('attention-slowly');
const format = { decimals: 2, grouping: false, approximate: false };

// ---------------------------------------------------------------------------------------------
// MA-2: sentence breaks

describe('re-review MA-2: one anchor never stands behind two sentences', () => {
  type DraftValue = { sections: Array<{ blocks: unknown[] }>; bindings: unknown[] };
  const compileWith = (text: string, anchors: string[]) => {
    const draft = structuredClone(weight.draft) as DraftValue;
    draft.sections[0]?.blocks.push({ id: 'two-p', type: 'paragraph', data: { spans: text } });
    for (const anchorText of anchors)
      draft.bindings.push({ kind: 'passage', claimId: 'clm-gravity-moon', blockId: 'two-p', anchorText });
    return compileDraft(draft, weight.provenance);
  };
  const codes = (text: string, anchors: string[]) => {
    const outcome = compileWith(text, anchors);
    return outcome.kind === 'refused' ? outcome.issues.map((issue) => issue.code) : [outcome.kind];
  };

  // The first review's B2(c) shape in the natural punctuation of the re-review's PoC p18.
  const breaks: Array<[string, string]> = [
    ['a bracket', 'Venus spins once in 243 days (a very slow turn.) Mercury needs 59 days.'],
    ['a closing quote', 'Venus is said to turn "in 243 days." Mercury needs 59 days.'],
    ['a typographic closing quote', 'Venus is said to turn “in 243 days.” Mercury needs 59 days.'],
    ['an ellipsis', 'Venus spins once in 243 days… Mercury needs 59 days.'],
    ['no space after a period', 'Venus spins once in 243 days.Mercury needs 59 days.'],
    ['a CJK full stop', 'Venus spins once in 243 days。Mercury needs 59 days.'],
    ['an exclamation mark with no space', 'Venus spins once in 243 days!Mercury needs 59 days.'],
    ['a question mark and a bracket', 'Does Venus spin once in 243 days?) Mercury needs 59 days.'],
    ['a period before a digit', 'Venus spins once in 243 days.59 more days pass for Mercury.'],
  ];

  it.each(breaks)('refuses one anchor over %s', (_name, text) => {
    const anchor = text.slice(text.indexOf('243'), text.lastIndexOf('59') + 2);
    expect(codes(text, [anchor])).toContain('binding_anchor_crosses_sentence');
  });

  it('accepts one anchor per sentence in the same texts: the break is not over-eager', () => {
    const text = 'Venus spins once in 243 days (a very slow turn.) Mercury needs 59 days.';
    expect(codes(text, ['243 days (a very slow turn.)', 'Mercury needs 59 days.'])).toEqual(['compiled']);
    const quoted = 'Venus is said to turn "in 243 days." Mercury needs 59 days.';
    expect(codes(quoted, ['"in 243 days."', 'Mercury needs 59 days.'])).toEqual(['compiled']);
  });
});

// ---------------------------------------------------------------------------------------------
// MA-3: a text block's accessibility text is derived and compared

describe('re-review MA-3: a text block’s accessibility text is derived by code, so admission compares it', () => {
  const textBlocks = (document: ScrollDocument) =>
    [...walkBlocks(document.sections)].filter(({ block }) =>
      ['paragraph', 'subheading', 'list', 'quote', 'callout'].includes(block.type),
    );
  const tamper = (document: ScrollDocument, path: string, change: (a11y: Loose) => void): ScrollDocument => {
    const copy = structuredClone(document);
    let node: unknown = copy;
    for (const part of path.split('.')) node = (node as Loose)[part];
    change((node as { a11y: Loose }).a11y);
    // Reseal, so only the label (not the hash) can be what refuses it.
    return seal(copy.sections, copy);
  };

  it('accepts the derived label of every text block in the fixtures', () => {
    const blocks = [weight, attention, fixture('spring-neap-tides')].flatMap((item) => textBlocks(item.document));
    expect(blocks.length).toBeGreaterThan(10);
    expect(new Set(blocks.map(({ block }) => block.type)).size).toBeGreaterThanOrEqual(3);
    for (const item of [weight, attention, fixture('spring-neap-tides')])
      expect(admitDocument(item.document).kind).toBe('valid');
  });

  it('refuses an arbitrary label on any text block, on admission and on the client path', () => {
    for (const item of [weight, attention, fixture('spring-neap-tides')]) {
      for (const { block, path } of textBlocks(item.document)) {
        const forged = tamper(item.document, path, (a11y) => void (a11y['label'] = 'Mars pulls 38% as hard as Earth'));
        for (const outcome of [admitDocument(forged), parseDocument(forged), validateDocument(forged)]) {
          expect(outcome, `${block.type} ${path}`).toMatchObject({
            kind: 'invalid',
            issues: [{ code: 'a11y_label_mismatch', path: `${path}.a11y.label` }],
          });
        }
      }
    }
  });

  it('refuses a description on a text block', () => {
    for (const { block, path } of textBlocks(weight.document)) {
      const forged = tamper(
        weight.document,
        path,
        (a11y) => void (a11y['description'] = 'Read aloud: a secret source says 38 percent.'),
      );
      expect(admitDocument(forged), `${block.type} ${path}`).toMatchObject({
        kind: 'invalid',
        issues: [{ code: 'a11y_description_unexpected', path: `${path}.a11y.description` }],
      });
    }
  });

  it('refuses both on a block the parser reads on its own', () => {
    const paragraph = weight.document.sections[0]?.blocks[1];
    if (paragraph?.type !== 'paragraph') throw new Error('fixture changed');
    expect(parseBlock(paragraph).kind).toBe('block');
    const forged = { ...paragraph, a11y: { label: 'Something else', description: 'And more.' } };
    for (const outcome of [parseBlock(forged), admitBlock(forged)]) {
      expect(outcome).toMatchObject({
        kind: 'invalid',
        issues: [{ code: 'a11y_label_mismatch' }, { code: 'a11y_description_unexpected' }],
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 1: display tolerance has no absolute floor

describe('re-review minor 1: a wrong display scale is refused even for tiny outputs', () => {
  const tiny = (): ScrollDocument => {
    const data: SimulationInput = {
      title: 'A very small effect',
      params: [{ key: 'x', label: 'X', min: 1, max: 3, step: 1, default: 1, control: 'slider', format }],
      constants: [],
      outputs: [
        { key: 'a', label: 'A', formula: { kind: 'product', factors: ['x', 1.3e-10] }, format },
        { key: 'b', label: 'B', formula: { kind: 'product', factors: ['x', 2.6e-10] }, format },
      ],
      view: {
        kind: 'cards',
        items: [
          { id: 'card-a', label: 'A', output: 'a' },
          { id: 'card-b', label: 'B', output: 'b' },
        ],
      },
      modelNote: 'Outputs around a tenth of a nano-unit.',
      illustrative: { notice: 'Illustrative' },
    };
    return seal([{ id: 'only', heading: null, blocks: [{ ...make('simulation', data), id: 'tiny-sim' }] }]);
  };
  const withScale = (document: ScrollDocument, scale: number): ScrollDocument => {
    const copy = structuredClone(document);
    const sim = copy.sections[0]?.blocks[0];
    if (sim?.type !== 'simulation') throw new Error('block changed');
    sim.data.display = { kind: 'cards', scale };
    return seal(copy.sections, copy);
  };

  it('admits the proven scale and one within a relative 1e-9, and refuses anything further off', () => {
    const document = tiny();
    const proven = (document.sections[0]?.blocks[0] as Extract<Block, { type: 'simulation' }>).data.display;
    if (proven.kind !== 'cards') throw new Error('display changed');
    expect(proven.scale).toBeCloseTo(7.8e-10, 20);
    expect(admitDocument(document).kind).toBe('valid');
    expect(admitDocument(withScale(document, proven.scale * (1 + 5e-10))).kind).toBe('valid');
    for (const factor of [1 + 5e-8, 1.1, 5, 500]) {
      expect(admitDocument(withScale(document, proven.scale * factor)), String(factor)).toMatchObject({
        kind: 'invalid',
        issues: [{ code: 'sim_display_mismatch' }],
      });
    }
  });

  it('compares a range against its own magnitude, so a zero low end tolerates a rounding error', () => {
    expect(sameDisplay({ kind: 'plot', range: [0, 9] }, { kind: 'plot', range: [-1e-17, 9] })).toBe(true);
    expect(sameDisplay({ kind: 'plot', range: [0, 9] }, { kind: 'plot', range: [-1e-6, 9] })).toBe(false);
    expect(sameDisplay({ kind: 'plot', range: [0, 1e-10] }, { kind: 'plot', range: [0, 5e-10] })).toBe(false);
    expect(sameDisplay({ kind: 'cards', scale: 1.3e-10 }, { kind: 'cards', scale: 6.5e-10 })).toBe(false);
    expect(sameDisplay({ kind: 'cards', scale: 1e300 }, { kind: 'cards', scale: 1e300 * (1 + 1e-12) })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 2: a clamped fraction

describe('re-review minor 2: displayFraction is always a finite number from 0 to 1', () => {
  const cards = { view: { kind: 'cards' as const, items: [] }, display: { kind: 'cards' as const, scale: 200 } };
  const plot = {
    view: { kind: 'plot' as const, x: 'x', y: 'y', yLabel: 'Y' },
    display: { kind: 'plot' as const, range: [-10, 30] as [number, number] },
  };

  it('is the fraction of the scale or of the range, clamped', () => {
    expect(displayFraction(100, cards)).toBe(0.5);
    expect(displayFraction(400, cards)).toBe(1);
    expect(displayFraction(-4, cards)).toBe(0);
    expect(displayFraction(10, plot)).toBe(0.5);
    expect(displayFraction(-50, plot)).toBe(0);
    expect(displayFraction(99, plot)).toBe(1);
  });

  it('survives a forged scale and a value that is not a number', () => {
    const forged = { ...cards, display: { kind: 'cards' as const, scale: 5e-324 } };
    expect(displayFraction(1, forged)).toBe(1);
    expect(displayFraction(0, forged)).toBe(0);
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(displayFraction(value, cards)).toBe(0);
    // A display of the wrong kind for its view reads as empty.
    expect(displayFraction(100, { view: plot.view, display: cards.display })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 3: values on the odometer path (grids above 1,024 points)

describe('re-review minor 3: the sweep above 1,024 points proves what a direct evaluation finds', () => {
  const dials = (na: number, nb: number): SimulationInput['params'] => [
    { key: 'a', label: 'Dial a', min: 0, max: na - 1, step: 1, default: 0, control: 'slider', format },
    { key: 'b', label: 'Dial b', min: 0, max: nb - 1, step: 1, default: 0, control: 'slider', format },
  ];
  const sim = (na: number, nb: number, outputs: SimulationInput['outputs'], view: SimulationInput['view']) =>
    ({
      title: 'A grid',
      params: dials(na, nb),
      constants: [],
      outputs,
      view,
      modelNote: 'A test grid.',
      illustrative: { notice: 'Illustrative' },
    }) satisfies SimulationInput;
  /** `1 / (axis − wall)`: a pole along the whole line axis = wall. */
  const pole = (axis: 'a' | 'b', wall: number): SimulationInput['outputs'] => [
    {
      key: 'gap',
      label: 'Gap',
      formula: { kind: 'linear', x: axis, a: -1, b: wall } satisfies Formula,
      format,
    },
    { key: 'pull', label: 'Pull', formula: { kind: 'ratio', numerator: 1, denominator: 'gap' }, format },
  ];
  const codesOf = (data: SimulationInput) => simulationProof(data, '$').issues.map((issue) => issue.code);

  it('finds a pole at the first, middle and last value of each axis, whichever axis the sweep rows on', () => {
    for (const [na, nb] of [
      [40, 41],
      [41, 40],
      [33, 33],
      [100, 100],
      [2, 600],
      [600, 2],
    ] as const) {
      expect(na * nb).toBeGreaterThan(1_024);
      for (const axis of ['a', 'b'] as const) {
        const size = axis === 'a' ? na : nb;
        for (const wall of [0, Math.floor(size / 2), size - 1]) {
          const data = sim(na, nb, pole(axis, wall), { kind: 'readout', primary: 'pull' });
          expect(codesOf(data), `${na}x${nb} ${axis}=${wall}`).toEqual(['sim_output_not_finite']);
        }
        // The same simulation with the wall outside the grid is fine.
        expect(codesOf(sim(na, nb, pole(axis, size + 5), { kind: 'readout', primary: 'pull' })), `${na}x${nb}`).toEqual(
          [],
        );
      }
    }
  });

  it('finds a bar that is negative only at the last value of an axis', () => {
    for (const [na, nb] of [
      [40, 41],
      [41, 40],
    ] as const) {
      for (const axis of ['a', 'b'] as const) {
        const last = (axis === 'a' ? na : nb) - 1;
        const outputs: SimulationInput['outputs'] = [
          { key: 'w', label: 'W', formula: { kind: 'linear', x: axis, a: -1, b: last - 0.5 }, format },
        ];
        const data = sim(na, nb, outputs, {
          kind: 'cards',
          items: [
            { id: 'card-a', label: 'A', output: 'w' },
            { id: 'card-b', label: 'B', output: 'w' },
          ],
        });
        expect(codesOf(data), `${na}x${nb} ${axis}`).toEqual(['sim_view_out_of_range']);
      }
    }
  });

  it('agrees with a direct evaluation of every point, verdict and display, on random grids of 1,025 to 4,000 points', () => {
    const shapes = fc
      .integer({ min: 26, max: 100 })
      .chain((na) =>
        fc.record({
          na: fc.constant(na),
          nb: fc.integer({ min: Math.ceil(1_025 / na), max: Math.floor(4_000 / na) }),
          axis: fc.constantFrom('a' as const, 'b' as const),
          wall: fc.nat({ max: 120 }),
          view: fc.constantFrom('cards', 'plot', 'area'),
        }),
      )
      .filter(({ nb }) => nb >= 2);
    fc.assert(
      fc.property(shapes, ({ na, nb, axis, wall, view }) => {
        const outputs: SimulationInput['outputs'] = [
          ...pole(axis, wall),
          { key: 'area', label: 'Area', formula: { kind: 'product', factors: ['a', 'b', 'a'] }, format },
        ];
        const viewSpec: SimulationInput['view'] =
          view === 'cards'
            ? {
                kind: 'cards',
                items: [
                  { id: 'card-a', label: 'A', output: 'area' },
                  { id: 'card-b', label: 'B', output: 'area' },
                ],
              }
            : view === 'plot'
              ? { kind: 'plot', x: 'a', y: 'area', yLabel: 'Area' }
              : { kind: 'area', length: 'a', area: 'area', lengthLabel: 'A', areaLabel: 'Area' };
        const data = sim(na, nb, outputs, viewSpec);
        expect(simulationGridPoints(data)).toBe(na * nb);
        // The direct walk.
        let infinite = false;
        let largest = 0;
        for (const a of gridValues(data.params[0]!)) {
          for (const b of gridValues(data.params[1]!)) {
            const point = evaluateSimulation(data, { a, b });
            if (Object.values(point.outputs).some((value) => value === null)) infinite = true;
            largest = Math.max(largest, point.outputs['area'] ?? 0);
          }
        }
        const proof = simulationProof(data, '$');
        expect(proof.issues.map((issue) => issue.code)).toEqual(infinite ? ['sim_output_not_finite'] : []);
        if (!infinite && view !== 'plot')
          expect(proof.display).toEqual({ kind: view, scale: largest > 0 ? largest : 1 });
        if (!infinite && view === 'plot') expect(proof.display).toEqual({ kind: 'plot', range: [0, largest] });
      }),
      { numRuns: 12 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 5: evaluateFormula is not part of the public entry

describe('re-review minor 5: only guarded evaluators are public', () => {
  it('does not export the raw formula evaluator, which returns Infinity and NaN', () => {
    expect(Object.keys(publicEntry)).not.toContain('evaluateFormula');
    expect(Object.keys(publicEntry)).toEqual(expect.arrayContaining(['evaluateSimulation', 'sampleCurve']));
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 7: unit exponents

describe('re-review minor 7: a superscript exponent on a unit symbol is notation', () => {
  const unitSimulation = (units: { param?: string; constant?: string; output?: string; label?: string }) =>
    seal([
      {
        id: 'only',
        heading: null,
        blocks: [
          {
            ...make('simulation', {
              title: 'Surface gravity',
              params: [
                {
                  key: 'x',
                  label: units.label ?? 'Distance',
                  ...(units.param === undefined ? {} : { unit: units.param }),
                  min: 1,
                  max: 3,
                  step: 1,
                  default: 1,
                  control: 'slider',
                  format,
                },
              ],
              constants: [
                {
                  key: 'g',
                  label: 'Gravity',
                  value: 9.81,
                  ...(units.constant === undefined ? {} : { unit: units.constant }),
                },
              ],
              outputs: [
                {
                  key: 'y',
                  label: 'Pull',
                  ...(units.output === undefined ? {} : { unit: units.output }),
                  formula: { kind: 'product', factors: ['x', 'g'] },
                  format,
                },
              ],
              view: { kind: 'readout', primary: 'y' },
              modelNote: 'A teaching model of a pull.',
              illustrative: { notice: 'Illustrative' },
            }),
            id: 'unit-sim',
          },
        ],
      },
    ]);
  const unbound = (document: ScrollDocument) =>
    honestyIssues(document, { claims: [], bindings: [] })
      .filter((issue) => issue.code === 'number_unbound')
      .map((issue) => issue.path.split('.data.')[1] ?? issue.path);

  it('passes m/s² and km² in a unit field with no binding', () => {
    expect(unbound(unitSimulation({ param: 'km²', constant: 'm/s²', output: 'kg/m³' }))).toEqual([]);
  });

  it('still asks for a binding for any other number', () => {
    expect(unbound(unitSimulation({ param: '10²' }))).toEqual(['params.0.unit@0']);
    expect(unbound(unitSimulation({ constant: 'm ²' }))).toEqual(['constants.0.unit@2']);
    // A superscript outside a unit field (a label) is a number like any other.
    expect(unbound(unitSimulation({ label: 'Area in km²' }))).toEqual(['params.0.label@10']);
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 4: the admission entry

describe('re-review minor 4: admission has its own entry, which clients cannot import', () => {
  it('exports the admission functions, the same ones the public entry still exports', () => {
    expect(Object.keys(admission).sort()).toEqual(['admitBlock', 'admitDocument', 'validateDocument']);
    expect(admission.admitDocument).toBe(publicEntry.admitDocument);
    expect(admission.admitBlock).toBe(publicEntry.admitBlock);
    expect(admission.validateDocument).toBe(publicEntry.validateDocument);
  });

  it('is declared as a package export', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
      sideEffects: boolean;
    };
    expect(manifest.exports['./admission']).toEqual({
      '@knowscroll/source': './src/admission/index.ts',
      types: './dist/admission/index.d.ts',
      default: './dist/admission/index.js',
    });
    // No module has an import-time effect a bundle must keep, so a client bundle may drop admission code.
    expect(manifest.sideEffects).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Minor 6: repointLocator trusts the pairing of ids, not the map's verdict

describe('re-review minor 6: repointLocator checks the anchor map against the blocks', () => {
  const rev1 = weight.document;
  const rewritten = structuredClone(rev1);
  const paragraph = rewritten.sections[0]?.blocks[1];
  if (paragraph?.type !== 'paragraph') throw new Error('fixture changed');
  paragraph.data = { spans: [{ text: 'An entirely different claim now lives under this id.' }] };
  const rev2 = seal(rewritten.sections, { ...rewritten, revision: 2 });
  const locator = {
    kind: 'scroll_block' as const,
    assetId: rev1.assetId,
    revision: 1,
    blockId: 'scales-p1',
    blockType: 'paragraph',
    blockVersion: 1,
  };
  const derived = () => {
    const outcome = deriveAnchorMap(rev1, rev2);
    if (outcome.kind !== 'derived') throw new Error(outcome.reason);
    return outcome.map;
  };

  it('reports a rewritten paragraph honestly with the map derived by code', () => {
    expect(repointLocator(locator, rev1, rev2, derived())).toMatchObject({ kind: 'remapped', change: 'text-changed' });
  });

  it('refuses a stored map that calls the rewritten paragraph the same, or removed', () => {
    const map = derived();
    const forge = (change: 'same' | 'updated' | 'removed') => ({
      ...map,
      entries: map.entries.map((entry) =>
        entry.from === 'scales-p1' ? { ...entry, change, to: change === 'removed' ? null : entry.to } : entry,
      ),
    });
    for (const change of ['same', 'updated', 'removed'] as const) {
      expect(repointLocator(locator, rev1, rev2, forge(change)), change).toEqual({
        kind: 'invalid',
        reason: 'map-mismatch',
      });
    }
  });

  it('refuses a map entry that points at a block the next revision does not have', () => {
    const map = derived();
    const forged = {
      ...map,
      entries: map.entries.map((entry) => (entry.from === 'scales-p1' ? { ...entry, to: 'nothing-here' } : entry)),
    };
    expect(repointLocator(locator, rev1, rev2, forged)).toEqual({ kind: 'invalid', reason: 'map-mismatch' });
  });

  it('still honours a move that the correction workflow declared', () => {
    const moved = structuredClone(rev1);
    const block = moved.sections[0]?.blocks[1];
    if (block === undefined) throw new Error('fixture changed');
    block.id = 'scales-moved';
    const rev3 = seal(moved.sections, { ...moved, revision: 3 });
    const outcome = deriveAnchorMap(rev1, rev3, { moves: [{ from: 'scales-p1', to: 'scales-moved' }] });
    if (outcome.kind !== 'derived') throw new Error(outcome.reason);
    expect(repointLocator(locator, rev1, rev3, outcome.map)).toMatchObject({
      kind: 'remapped',
      moved: true,
      change: 'same',
      locator: { blockId: 'scales-moved' },
    });
  });
});
