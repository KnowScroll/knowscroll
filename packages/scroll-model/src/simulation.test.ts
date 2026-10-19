import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  curveSampleCount,
  evaluateFormula,
  evaluateSimulation,
  FIELD_LIMITS,
  formatNumber,
  isOnGrid,
  LIMITS,
  readoutBand,
  renderTemplate,
  sampleCurve,
  SimulationData,
  snapToGrid,
  type Formula,
  type Operand,
  type SimulationParam,
} from './index.js';
import { simulationIssues } from './simulation/checks.js';
import { simulationData } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';

const KEYS = ['p0', 'p1', 'c0', 'c1', 'o0', 'o1', 'o2', 'missing'] as const;
const wildNumber = fc.oneof(
  fc.double({ min: -FIELD_LIMITS.numberMagnitude, max: FIELD_LIMITS.numberMagnitude, noNaN: true }),
  fc.constantFrom(0, -0, 1, -1, 1e-300, 1e15, -1e15),
);
const operand: fc.Arbitrary<Operand> = fc.oneof(wildNumber, fc.constantFrom(...KEYS));
const formula: fc.Arbitrary<Formula> = fc.oneof(
  fc.record({ kind: fc.constant('linear' as const), x: operand, a: operand, b: operand }),
  fc.record({ kind: fc.constant('product' as const), factors: fc.array(operand, { minLength: 2, maxLength: 4 }) }),
  fc.record({ kind: fc.constant('ratio' as const), numerator: operand, denominator: operand }),
  fc.record({
    kind: fc.constant('power' as const),
    x: operand,
    base: operand,
    exponent: fc.double({ min: -4, max: 4, noNaN: true }),
    scale: operand,
  }),
  fc.record({ kind: fc.constant('exponential' as const), x: operand, rate: operand, initial: operand }),
  fc.record({ kind: fc.constant('inverse-square' as const), r: operand, k: operand }),
  fc.record({
    kind: fc.constant('lookup' as const),
    input: fc.constantFrom(...KEYS),
    mode: fc.constantFrom('step' as const, 'interpolate' as const),
    table: fc.array(fc.record({ at: wildNumber, value: operand }), { minLength: 2, maxLength: 12 }),
  }),
);
const wildParam = fc.record({ min: wildNumber, max: wildNumber, step: wildNumber, default: wildNumber });

/** Schema-valid simulations with arbitrary numbers and references, most of which validation would refuse. */
const wildSimulation = fc
  .record({
    params: fc.array(wildParam, { minLength: 1, maxLength: 2 }),
    constants: fc.array(wildNumber, { maxLength: 2 }),
    outputs: fc.array(formula, { minLength: 1, maxLength: 3 }),
  })
  .map(({ params, constants, outputs }) => ({
    params: params.map((param, index): SimulationParam => ({
      key: `p${index}`,
      label: 'Dial',
      control: 'slider',
      format: { decimals: 2, grouping: true, approximate: false },
      ...param,
    })),
    constants: constants.map((value, index) => ({ key: `c${index}`, label: 'Constant', value })),
    outputs: outputs.map((item, index) => ({
      key: `o${index}`,
      label: 'Output',
      formula: item,
      format: { decimals: 2, grouping: true, approximate: false },
    })),
  }));

const bounded = (value: number | null) =>
  value === null || (Number.isFinite(value) && Math.abs(value) <= FIELD_LIMITS.numberMagnitude);

describe('simulation evaluation (what the renderer calls)', () => {
  it('stays finite and bounded, never throws and is deterministic, for any schema-valid simulation and any values', () => {
    fc.assert(
      fc.property(wildSimulation, fc.dictionary(fc.constantFrom('p0', 'p1', 'other'), wildNumber), (data, values) => {
        const first = evaluateSimulation(data, values);
        for (const value of Object.values(first.outputs)) expect(bounded(value)).toBe(true);
        expect(evaluateSimulation(data, values)).toEqual(first);
        const curve = sampleCurve(data, values, 'p0', 'o0');
        expect(curve.length).toBeLessThanOrEqual(LIMITS.chartPoints);
        for (const point of curve) expect(bounded(point.y)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('gives finite outputs at every parameter value of a simulation the validator accepts', () => {
    fc.assert(
      fc.property(
        simulationData,
        fc.array(fc.double({ min: -1e3, max: 1e3, noNaN: true }), { minLength: 4, maxLength: 4 }),
        (data, raw) => {
          expect(SimulationData.safeParse(data).success).toBe(true);
          expect(simulationIssues(data, '$')).toEqual([]);
          const values = Object.fromEntries(data.params.map((param, index) => [param.key, raw[index] ?? 0]));
          const outcome = evaluateSimulation(data, values);
          for (const param of data.params) expect(isOnGrid(param, outcome.params[param.key] ?? Number.NaN)).toBe(true);
          for (const value of Object.values(outcome.outputs)) {
            expect(value).not.toBeNull();
            expect(bounded(value)).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('evaluates each closed formula kind', () => {
    const scope = new Map([
      ['x', 3],
      ['y', 4],
    ]);
    expect(evaluateFormula({ kind: 'linear', x: 'x', a: 2, b: 1 }, scope)).toBe(7);
    expect(evaluateFormula({ kind: 'product', factors: ['x', 'y', 0.5] }, scope)).toBe(6);
    expect(evaluateFormula({ kind: 'ratio', numerator: 'y', denominator: 2 }, scope)).toBe(2);
    expect(evaluateFormula({ kind: 'power', x: 'y', base: 2, exponent: 2, scale: 1 }, scope)).toBe(4);
    expect(evaluateFormula({ kind: 'exponential', x: 'x', rate: 0, initial: 'y' }, scope)).toBe(4);
    expect(evaluateFormula({ kind: 'inverse-square', r: 2, k: 'y' }, scope)).toBe(1);
    const table = [
      { at: 0, value: 10 },
      { at: 2, value: 20 },
      { at: 4, value: 40 },
    ];
    expect(evaluateFormula({ kind: 'lookup', input: 'x', mode: 'step', table }, scope)).toBe(20);
    expect(evaluateFormula({ kind: 'lookup', input: 'x', mode: 'interpolate', table }, scope)).toBe(30);
    expect(evaluateFormula({ kind: 'lookup', input: 'y', mode: 'interpolate', table }, scope)).toBe(40);
    expect(evaluateFormula({ kind: 'lookup', input: 'missing', mode: 'step', table }, scope)).toBeNaN();
    expect(evaluateFormula({ kind: 'ratio', numerator: 'nothing', denominator: 1 }, scope)).toBeNaN();
  });

  it('snaps values onto the parameter grid and keeps them in range', () => {
    const param: SimulationParam = {
      key: 'share',
      label: 'Share',
      min: 0,
      max: 0.9,
      step: 0.02,
      default: 0.46,
      control: 'slider',
      format: { decimals: 2, grouping: false, approximate: false },
    };
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (value) => {
        const snapped = snapToGrid(param, value);
        expect(isOnGrid(param, snapped)).toBe(true);
        expect(snapToGrid(param, snapped)).toBe(snapped);
      }),
    );
    expect(snapToGrid(param, 0.465)).toBe(0.46);
    expect(snapToGrid(param, Number.NaN)).toBe(0.46);
    expect(curveSampleCount(param)).toBe(46);
    expect(curveSampleCount({ ...param, step: 0.001 })).toBe(LIMITS.chartPoints);
  });

  it('formats numbers deterministically', () => {
    expect(formatNumber(4_096, { decimals: 0, grouping: true, approximate: false })).toBe('4,096');
    expect(formatNumber(64, { decimals: 0, grouping: true, approximate: true, suffix: '×' })).toBe('~64×');
    expect(formatNumber(-1.5, { decimals: 2, grouping: false, approximate: false })).toBe('−1.50');
    expect(formatNumber(-0.0001, { decimals: 0, grouping: false, approximate: false })).toBe('0');
    expect(formatNumber(1_234_567.891, { decimals: 1, grouping: true, approximate: false })).toBe('1,234,567.9');
    expect(formatNumber(null, { decimals: 0, grouping: false, approximate: false })).toBe('—');
  });

  it('renders the fixtures’ readouts and bands', () => {
    const attention = fixture('attention-slowly').document.sections[1]?.blocks[2];
    if (attention?.type !== 'simulation' || attention.data.readout === undefined) throw new Error('fixture changed');
    const at = (len: number) => evaluateSimulation(attention.data, { len });
    expect(renderTemplate(attention.data.readout.template, attention.data, at(4_096))).toBe(
      '~64× the work of 512 words',
    );
    expect(readoutBand(attention.data.readout, at(512))).toBe('Same length, same work.');
    expect(readoutBand(attention.data.readout, at(4_096))).toMatch(/^Eight times longer/u);

    const weight = fixture('weight-other-worlds').document.sections[0]?.blocks[0];
    if (weight?.type !== 'simulation') throw new Error('fixture changed');
    expect(evaluateSimulation(weight.data, { weightKg: 60 }).outputs).toEqual({
      moonKg: 60 * 0.165,
      marsKg: 60 * 0.38,
      earthKg: 60,
      jupiterKg: 60 * 2.53,
    });
  });
});

describe('simulation validation (computation stage)', () => {
  const valid = (): SimulationData => {
    const block = fixture('spring-neap-tides').document.sections[1]?.blocks[1];
    if (block?.type !== 'simulation') throw new Error('fixture changed');
    return structuredClone(block.data);
  };
  const issueCodes = (data: SimulationData) => simulationIssues(data, '$').map((issue) => issue.code);

  it('accepts the fixture simulation', () => {
    expect(issueCodes(valid())).toEqual([]);
  });

  it('refuses each broken declaration with its own code', () => {
    const cases: Array<[string, (data: SimulationData) => void]> = [
      ['sim_param_range', (data) => void (data.params[0] = { ...data.params[0]!, step: 0 })],
      ['sim_param_range', (data) => void (data.params[0] = { ...data.params[0]!, step: 0.07 })],
      ['sim_param_range', (data) => void (data.params[0] = { ...data.params[0]!, step: 0.0001 })],
      ['sim_param_default', (data) => void (data.params[0] = { ...data.params[0]!, default: 0.47 })],
      ['sim_key_duplicate', (data) => void (data.outputs[1] = { ...data.outputs[1]!, key: 'spring' })],
      [
        'sim_reference_unknown',
        (data) =>
          void (data.outputs[0] = {
            ...data.outputs[0]!,
            formula: { kind: 'ratio', numerator: 'ratio', denominator: 2 },
          }),
      ],
      [
        'sim_lookup_table',
        (data) =>
          void (data.outputs[0] = {
            ...data.outputs[0]!,
            formula: {
              kind: 'lookup',
              input: 'sunShare',
              mode: 'step',
              table: [
                { at: 1, value: 1 },
                { at: 1, value: 2 },
              ],
            },
          }),
      ],
      ['sim_view_invalid', (data) => void (data.view = { kind: 'readout', primary: 'sunShare' })],
      [
        'sim_view_invalid',
        (data) => void (data.view = { kind: 'plot', x: 'spring', y: 'ratio', yLabel: 'y', yDomain: [0, 1] }),
      ],
      ['sim_template_key_unknown', (data) => void (data.readout = { template: 'Look at {nothing}', bands: [] })],
      [
        'sim_band_invalid',
        (data) =>
          void (data.readout = { template: 'Fine', bands: [{ output: 'ratio', min: 2, max: 1, text: 'Odd.' }] }),
      ],
      ['sim_output_not_finite', (data) => void (data.params[0] = { ...data.params[0]!, max: 1, default: 0.46 })],
      [
        'sim_plot_out_of_domain',
        (data) => void (data.view = { kind: 'plot', x: 'sunShare', y: 'spring', yLabel: 'Range', yDomain: [0, 1.5] }),
      ],
      [
        'sim_view_out_of_range',
        (data) =>
          void (data.outputs[1] = { ...data.outputs[1]!, formula: { kind: 'linear', x: 'sunShare', a: -2, b: 1 } }),
      ],
    ];
    for (const [code, change] of cases) {
      const data = valid();
      change(data);
      expect(issueCodes(data), code).toContain(code);
    }
  });
});
