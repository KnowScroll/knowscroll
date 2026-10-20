import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  curveSampleCount,
  evaluateFormula,
  evaluateSimulation,
  FIELD_LIMITS,
  formatNumber,
  gridValues,
  isOnGrid,
  LIMITS,
  readoutBand,
  renderTemplate,
  sampleCurve,
  SimulationData,
  snapToGrid,
  type SimulationParam,
} from './index.js';
import { simulationIssues, simulationProof } from './simulation/checks.js';
import { displayScale } from './simulation/display.js';
import { simulationData, type SimulationInput } from './test-support/arbitraries.js';
import { formula, wildNumber, wildSimulation } from './test-support/wild-simulation.js';
import { fixture } from './test-support/fixtures.js';

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
      ['sim_view_invalid', (data) => void (data.view = { kind: 'plot', x: 'spring', y: 'ratio', yLabel: 'y' })],
      ['sim_template_key_unknown', (data) => void (data.readout = { template: 'Look at {nothing}', bands: [] })],
      [
        'sim_band_invalid',
        (data) =>
          void (data.readout = { template: 'Fine', bands: [{ output: 'ratio', min: 2, max: 1, text: 'Odd.' }] }),
      ],
      ['sim_output_not_finite', (data) => void (data.params[0] = { ...data.params[0]!, max: 1, default: 0.46 })],
      [
        'sim_grid_too_large',
        (data) =>
          void (data.params = [
            { ...data.params[0]!, step: 0.001 },
            {
              key: 'extra',
              label: 'Extra',
              min: 0,
              max: 100,
              step: 1,
              default: 0,
              control: 'slider',
              format: data.params[0]!.format,
            },
          ]),
      ],
      [
        'sim_view_out_of_range',
        (data) =>
          // Neap range 0.5 − 2·share: negative from 0.26 on, never zero on the grid (0.25 is not on it).
          void (data.outputs[1] = { ...data.outputs[1]!, formula: { kind: 'linear', x: 'sunShare', a: -2, b: 0.5 } }),
      ],
    ];
    for (const [code, change] of cases) {
      const data = valid();
      change(data);
      expect(issueCodes(data), code).toContain(code);
    }
  });
});

const integerGridParam = fc
  .record({
    min: fc.integer({ min: -10, max: 10 }),
    step: fc.constantFrom(1, 0.5, 2),
    positions: fc.integer({ min: 1, max: 20 }),
    at: fc.nat(),
  })
  .map(({ min, step, positions, at }) => ({
    min,
    step,
    max: min + step * positions,
    default: min + step * (at % (positions + 1)),
  }));

/** Simulations with small valid grids and arbitrary formulas: some have poles, overflows or negative bars. */
const smallGridSimulation = fc
  .record({
    params: fc.array(integerGridParam, { minLength: 1, maxLength: 2 }),
    constants: fc.array(fc.oneof(fc.integer({ min: -10, max: 10 }), fc.double({ min: -1e3, max: 1e3, noNaN: true })), {
      maxLength: 2,
    }),
    outputs: fc.array(formula, { minLength: 1, maxLength: 3 }),
    view: fc.constantFrom('readout', 'cards'),
  })
  .map(({ params, constants, outputs, view }) => {
    const data: SimulationInput = {
      title: 'Wild',
      params: params.map((param, index) => ({
        key: `p${index}`,
        label: 'Dial',
        control: 'slider',
        format: { decimals: 2, grouping: false, approximate: false },
        ...param,
      })),
      constants: constants.map((value, index) => ({ key: `c${index}`, label: 'Constant', value })),
      outputs: outputs.map((item, index) => ({
        key: `o${index}`,
        label: 'Output',
        formula: item,
        format: { decimals: 2, grouping: false, approximate: false },
      })),
      view:
        view === 'cards' && outputs.length >= 2
          ? {
              kind: 'cards',
              items: [
                { id: 'card-a', label: 'A', output: 'o0' },
                { id: 'card-b', label: 'B', output: 'o1' },
              ],
            }
          : { kind: 'readout', primary: 'o0' },
      modelNote: 'Generated for a property test.',
      illustrative: { notice: 'Illustrative' },
    };
    return data;
  });

/** Every point of the grid, enumerated independently of the validator. */
function everyGridPoint(data: Pick<SimulationData, 'params'>): Array<Record<string, number>> {
  let points: Array<Record<string, number>> = [{}];
  for (const param of data.params) {
    const values: number[] = [];
    for (let value = param.min; value <= param.max + 1e-9; value += param.step) values.push(snapToGrid(param, value));
    points = points.flatMap((point) => values.map((value) => ({ ...point, [param.key]: value })));
  }
  return points;
}

describe('the full-grid proof (M2)', () => {
  it('accepts a simulation only if every output is finite, and every bar non-negative, at every grid point', () => {
    let refused = 0;
    fc.assert(
      fc.property(smallGridSimulation, (data) => {
        const issues = simulationIssues(data, '$').map((issue) => issue.code);
        if (issues.length > 0) {
          refused += 1;
          return;
        }
        for (const point of everyGridPoint(data)) {
          const { outputs } = evaluateSimulation(data, point);
          for (const value of Object.values(outputs)) expect(value, JSON.stringify(point)).not.toBeNull();
          if (data.view.kind === 'cards') {
            for (const item of data.view.items) expect(outputs[item.output] ?? -1).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { numRuns: 400 },
    );
    // The generator must also produce simulations the validator refuses, or the property proves nothing.
    expect(refused).toBeGreaterThan(20);
  });

  it('refuses a simulation with a pole at any single grid point, wherever it is', () => {
    fc.assert(
      fc.property(integerGridParam, fc.nat(), (range, pick) => {
        const param: SimulationParam = {
          key: 'distance',
          label: 'Distance',
          control: 'slider',
          format: { decimals: 1, grouping: false, approximate: false },
          ...range,
        };
        const values = gridValues(param);
        const wall = values[pick % values.length] ?? param.min;
        const data: SimulationInput = {
          title: 'A wall somewhere',
          params: [param],
          constants: [{ key: 'wall', label: 'Where the wall stands', value: wall }],
          outputs: [
            {
              key: 'gap',
              label: 'Gap',
              formula: { kind: 'linear', x: 'distance', a: -1, b: 'wall' },
              format: param.format,
            },
            {
              key: 'pull',
              label: 'Pull',
              formula: { kind: 'ratio', numerator: 1, denominator: 'gap' },
              format: param.format,
            },
          ],
          view: { kind: 'readout', primary: 'pull' },
          modelNote: 'A pole at one grid point.',
          illustrative: { notice: 'Illustrative' },
        };
        expect(simulationIssues(data, '$').map((issue) => issue.code)).toEqual(['sim_output_not_finite']);
      }),
      { numRuns: 200 },
    );
  });

  it('computes the display scale from the grid in the proof pass instead of taking a model-written number', () => {
    const weight = fixture('weight-other-worlds').document.sections[0]?.blocks[0];
    if (weight?.type !== 'simulation') throw new Error('fixture changed');
    expect(simulationProof(weight.data, '$').display).toEqual(weight.data.display);
    expect(displayScale(weight.data)).toBeCloseTo(200 * 2.53);
    const square = (view: SimulationInput['view']): SimulationInput => ({
      title: 'Square',
      params: [
        {
          key: 'x',
          label: 'X',
          min: -2,
          max: 3,
          step: 1,
          default: 0,
          control: 'slider',
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      constants: [],
      outputs: [
        {
          key: 'y',
          label: 'Y',
          formula: { kind: 'product', factors: ['x', 'x'] },
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      view,
      modelNote: 'A parabola for a test.',
      illustrative: { notice: 'Illustrative' },
    });
    const proof = (view: SimulationInput['view']) => simulationProof(square(view), '$');
    expect(proof({ kind: 'plot', x: 'x', y: 'y', yLabel: 'Y' })).toEqual({
      issues: [],
      display: { kind: 'plot', range: [0, 9] },
    });
    expect(proof({ kind: 'area', length: 'x', area: 'y', lengthLabel: 'X', areaLabel: 'Y' }).display).toEqual({
      kind: 'area',
      scale: 9,
    });
    expect(proof({ kind: 'readout', primary: 'y' }).display).toEqual({ kind: 'none' });
    // A bar view whose output is never positive scales to 1, and a flat plot still has a range.
    const zero = { ...square({ kind: 'plot', x: 'x', y: 'y', yLabel: 'Y' }) };
    zero.outputs = [{ ...zero.outputs[0]!, formula: { kind: 'product', factors: ['x', 0] } }];
    expect(simulationProof(zero, '$').display).toEqual({ kind: 'plot', range: [0, 1] });
  });
});
