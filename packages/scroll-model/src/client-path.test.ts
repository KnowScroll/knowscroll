/**
 * The two validation paths (coordinator ruling on M1): ADMISSION proves every simulation over its
 * whole grid; the CLIENT path (what a renderer runs on the device) does structure, bounds and
 * cheap checks only and guards a single evaluated point at runtime.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  admitBlock,
  admitDocument,
  curveUsable,
  evaluateSimulation,
  FIELD_LIMITS,
  formatNumber,
  formatWithUnit,
  negotiate,
  outputsUsable,
  parseBlock,
  parseDocument,
  renderTemplate,
  sampleCurve,
  validateDocument,
  type Block,
  type ScrollDocument,
  type SimulationData,
} from './index.js';
import { make, seal } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';
import { wildSimulation } from './test-support/wild-simulation.js';
import { worstDocument, worstSimulation } from './test-support/worst-case.js';

const format = { decimals: 2, grouping: false, approximate: false };

/** `1 / (five − distance)` over distance 0…10: a pole at distance 5 that the declarations do not show. */
function poleData(): SimulationData {
  return {
    title: 'A pole in the middle of the range',
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
        format,
      },
    ],
    constants: [{ key: 'five', label: 'Where the wall stands', value: 5 }],
    outputs: [
      { key: 'gap', label: 'Gap', formula: { kind: 'linear', x: 'distance', a: -1, b: 'five' }, format },
      { key: 'pull', label: 'Pull', formula: { kind: 'ratio', numerator: 1, denominator: 'gap' }, format },
    ],
    view: { kind: 'plot', x: 'distance', y: 'pull', yLabel: 'Pull' },
    readout: { template: 'Pull {pull} at {distance}', bands: [] },
    modelNote: 'A teaching model with a pole at the wall.',
    illustrative: { notice: 'Illustrative' },
  };
}

function poleBlock(): Block {
  return { ...make('simulation', poleData()), id: 'pole-sim' };
}

function poleDocument(): ScrollDocument {
  return seal([{ id: 'only', heading: null, blocks: [poleBlock()] }]);
}

describe('the client path never walks a simulation grid', () => {
  it('parses a block that only the grid proof can refuse, which admission refuses', () => {
    const block = poleBlock();
    expect(parseBlock(block).kind).toBe('block');
    expect(admitBlock(block)).toMatchObject({ kind: 'invalid', issues: [{ code: 'sim_output_not_finite' }] });
  });

  it('parses a document that only the grid proof can refuse, which admission refuses', () => {
    const document = poleDocument();
    expect(parseDocument(document).kind).toBe('valid');
    expect(validateDocument(document, { purpose: 'rendition' }).kind).toBe('valid');
    for (const outcome of [
      admitDocument(document),
      validateDocument(document),
      validateDocument(document, { purpose: 'stored' }),
    ]) {
      expect(outcome).toMatchObject({ kind: 'invalid', issues: [{ code: 'sim_output_not_finite' }] });
    }
  });

  it('still refuses what the declarations show, on both paths', () => {
    const cases: Array<[string, (data: SimulationData) => void]> = [
      [
        'sim_reference_unknown',
        (data) =>
          void (data.outputs[1] = {
            ...data.outputs[1]!,
            formula: { kind: 'ratio', numerator: 1, denominator: 'nothing' },
          }),
      ],
      ['sim_param_range', (data) => void (data.params[0] = { ...data.params[0]!, step: 0 })],
      ['sim_param_default', (data) => void (data.params[0] = { ...data.params[0]!, default: 2.5 })],
      [
        'sim_grid_too_large',
        (data) =>
          void (data.params = [
            { ...data.params[0]!, max: 1_000 },
            { ...data.params[0]!, key: 'width', max: 1_000 },
          ]),
      ],
      ['sim_view_invalid', (data) => void (data.view = { kind: 'plot', x: 'distance', y: 'nothing', yLabel: 'Pull' })],
    ];
    for (const [code, change] of cases) {
      const data = poleData();
      change(data);
      const block = { ...make('simulation', data), id: 'pole-sim' };
      expect(parseBlock(block), code).toMatchObject({ kind: 'invalid', issues: [{ code }] });
      expect(admitBlock(block), code).toMatchObject({ kind: 'invalid', issues: [{ code }] });
    }
  });

  it('keeps a fully proven simulation valid on both paths', () => {
    const block = worstSimulation('heaviest');
    expect(parseBlock(block).kind).toBe('block');
    expect(admitBlock(block).kind).toBe('block');
    const document = worstDocument();
    expect(parseDocument(document).kind).toBe('valid');
    expect(admitDocument(document).kind).toBe('valid');
  });

  it('parseDocument still checks the structure and the limits; the hash only when asked', () => {
    const document = fixture('weight-other-worlds').document;
    const tampered = { ...document, integrity: { ...document.integrity, sha256: '0'.repeat(64) } };
    // The SHA-256 is linear in the document and costly on Hermes: a device asks for it deliberately.
    expect(parseDocument(tampered).kind).toBe('valid');
    expect(parseDocument(tampered, { verify: true })).toMatchObject({
      kind: 'invalid',
      issues: [{ code: 'integrity_mismatch' }],
    });
    expect(validateDocument(tampered, { purpose: 'rendition' })).toMatchObject({
      kind: 'invalid',
      issues: [{ code: 'integrity_mismatch' }],
    });
    expect(admitDocument(tampered)).toMatchObject({ kind: 'invalid', issues: [{ code: 'integrity_mismatch' }] });
    expect(parseDocument(document, { verify: true }).kind).toBe('valid');
    expect(parseDocument({ ...document, schemaVersion: 'scroll-document.v2' })).toEqual({
      kind: 'unsupported-version',
      schemaVersion: 'scroll-document.v2',
    });
    expect(parseDocument(null)).toMatchObject({ kind: 'invalid', issues: [{ code: 'document_not_object' }] });
    expect(parseDocument({ ...document, title: 'No' })).toMatchObject({ kind: 'invalid' });
  });

  it('parseDocument checks the rendition link without hashing, and the hash with verify', () => {
    const lean = seal([
      { id: 'only', heading: null, blocks: [{ ...make('code', { language: 'text', code: 'x' }), id: 'code-x' }] },
    ]);
    const caps = {
      documentSchemas: ['scroll-document.v1'],
      blocks: { paragraph: [1], subheading: [1], fallback: [1] },
    };
    const negotiated = negotiate(lean, caps);
    if (negotiated.kind !== 'negotiated' || negotiated.document.rendition === undefined)
      throw new Error('no rendition');
    const rendition = negotiated.document;
    expect(parseDocument(rendition, { verify: true }).kind).toBe('valid');
    expect(parseDocument(rendition).kind).toBe('valid');
    const wrongLink = { ...rendition, rendition: { ...rendition.rendition!, of: '1'.repeat(64) } };
    expect(parseDocument(wrongLink)).toMatchObject({
      kind: 'invalid',
      issues: [{ code: 'rendition_integrity_mismatch' }],
    });
    const wrongHash = { ...rendition, rendition: { ...rendition.rendition!, sha256: '1'.repeat(64) } };
    expect(parseDocument(wrongHash).kind).toBe('valid');
    expect(parseDocument(wrongHash, { verify: true })).toMatchObject({
      kind: 'invalid',
      issues: [{ code: 'rendition_integrity_mismatch' }],
    });
    expect(validateDocument(wrongHash, { purpose: 'rendition' }).kind).toBe('invalid');
  });
});

describe('a single evaluated point stays guarded at runtime (client)', () => {
  it('turns the pole into a null output, an unusable result, and never into NaN or Infinity text', () => {
    const data = poleData();
    const atPole = evaluateSimulation(data, { distance: 5 });
    expect(atPole.outputs['pull']).toBeNull();
    expect(outputsUsable(atPole)).toBe(false);
    const text = renderTemplate(data.readout?.template ?? '', data, atPole);
    expect(text).toBe('Pull — at 5.00');
    expect(`${text}${formatNumber(atPole.outputs['pull'] ?? null, format)}`).not.toMatch(/NaN|Infinity/u);
    const away = evaluateSimulation(data, { distance: 2 });
    expect(away.outputs['pull']).toBeCloseTo(1 / 3, 12);
    expect(outputsUsable(away)).toBe(true);
  });

  it('flags a curve that crosses the pole', () => {
    const data = poleData();
    const curve = sampleCurve(data, {}, 'distance', 'pull');
    expect(curve.some((point) => point.y === null)).toBe(true);
    expect(curveUsable(curve)).toBe(false);
    const clear = sampleCurve({ ...data, params: [{ ...data.params[0]!, max: 4 }] }, {}, 'distance', 'pull');
    expect(curveUsable(clear)).toBe(true);
  });

  it('never renders NaN or Infinity, for any value of any valid-looking simulation', () => {
    const wild = fc.double({ min: -FIELD_LIMITS.numberMagnitude, max: FIELD_LIMITS.numberMagnitude, noNaN: true });
    fc.assert(
      fc.property(wildSimulation, fc.dictionary(fc.constantFrom('p0', 'p1', 'other'), wild), (data, values) => {
        const result = evaluateSimulation(data, values);
        const everyOutputPresent = Object.values(result.outputs).every((value) => value !== null);
        expect(outputsUsable(result)).toBe(everyOutputPresent);
        const rendered = [
          ...Object.values(result.outputs).map((value) => formatNumber(value, format)),
          ...Object.values(result.outputs).map((value) => formatWithUnit(value, format, 'm')),
          renderTemplate(['{missing}', ...data.outputs.map((output) => `{${output.key}}`)].join(' '), data, result),
        ];
        for (const text of rendered) expect(text).not.toMatch(/NaN|Infinity/u);
      }),
      { numRuns: 150 },
    );
    // Non-finite values themselves format as a dash.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null])
      expect(formatNumber(value, format)).toBe('—');
  });
});
