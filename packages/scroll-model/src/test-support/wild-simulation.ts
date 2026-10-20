/**
 * Schema-valid simulations with arbitrary numbers and references, most of which validation would
 * refuse: for tests of evaluation, which must stay bounded, deterministic and non-throwing for any
 * input the schema accepts.
 */
import fc from 'fast-check';
import { FIELD_LIMITS, type Formula, type Operand, type SimulationParam } from '../index.js';

const KEYS = ['p0', 'p1', 'c0', 'c1', 'o0', 'o1', 'o2', 'missing'] as const;
export const wildNumber = fc.oneof(
  fc.double({ min: -FIELD_LIMITS.numberMagnitude, max: FIELD_LIMITS.numberMagnitude, noNaN: true }),
  fc.constantFrom(0, -0, 1, -1, 1e-300, 1e15, -1e15),
);
export const operand: fc.Arbitrary<Operand> = fc.oneof(wildNumber, fc.constantFrom(...KEYS));
export const formula: fc.Arbitrary<Formula> = fc.oneof(
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

export const wildSimulation = fc
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
