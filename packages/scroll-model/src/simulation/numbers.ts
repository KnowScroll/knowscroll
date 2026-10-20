import type { Formula, Operand, SimulationData } from '../blocks/simulation.js';

/** One number written in a simulation, by its path in the block's data. */
export interface SimulationNumber {
  /** Dotted path inside `data`: `params.0.max`, `constants.1.value`, `outputs.2.formula.exponent` … */
  readonly path: string;
  readonly value: number;
  /** The constant whose value this is, when it is one. */
  readonly constantKey?: string;
}

function formulaNumbers(formula: Formula, path: string): SimulationNumber[] {
  const numbers: SimulationNumber[] = [];
  const operand = (name: string, value: Operand) => {
    if (typeof value === 'number') numbers.push({ path: `${path}.${name}`, value });
  };
  switch (formula.kind) {
    case 'linear':
      operand('x', formula.x);
      operand('a', formula.a);
      operand('b', formula.b);
      break;
    case 'product':
      formula.factors.forEach((factor, index) => operand(`factors.${index}`, factor));
      break;
    case 'ratio':
      operand('numerator', formula.numerator);
      operand('denominator', formula.denominator);
      break;
    case 'power':
      operand('x', formula.x);
      operand('base', formula.base);
      operand('scale', formula.scale);
      numbers.push({ path: `${path}.exponent`, value: formula.exponent });
      break;
    case 'exponential':
      operand('x', formula.x);
      operand('rate', formula.rate);
      operand('initial', formula.initial);
      break;
    case 'inverse-square':
      operand('r', formula.r);
      operand('k', formula.k);
      break;
    case 'lookup':
      formula.table.forEach((entry, index) => {
        numbers.push({ path: `${path}.table.${index}.at`, value: entry.at });
        operand(`table.${index}.value`, entry.value);
      });
      break;
  }
  return numbers;
}

/**
 * Every number a simulation states, wherever it is written: parameter ranges, steps and defaults,
 * constants, every literal operand, power exponents, lookup breakpoints and readout band
 * thresholds. (Display precision — `format.decimals` — is not a quantity.) A simulation that is
 * not illustrative binds each of these to a claim unless it is one of the structural numbers.
 */
export function simulationNumbers(
  data: Pick<SimulationData, 'params' | 'constants' | 'outputs' | 'readout'>,
): SimulationNumber[] {
  const numbers: SimulationNumber[] = [];
  data.params.forEach((param, index) => {
    for (const field of ['min', 'max', 'step', 'default'] as const) {
      numbers.push({ path: `params.${index}.${field}`, value: param[field] });
    }
  });
  data.constants.forEach((constant, index) =>
    numbers.push({ path: `constants.${index}.value`, value: constant.value, constantKey: constant.key }),
  );
  data.outputs.forEach((output, index) => numbers.push(...formulaNumbers(output.formula, `outputs.${index}.formula`)));
  data.readout?.bands.forEach((band, index) => {
    if (band.min !== undefined) numbers.push({ path: `readout.bands.${index}.min`, value: band.min });
    if (band.max !== undefined) numbers.push({ path: `readout.bands.${index}.max`, value: band.max });
  });
  return numbers;
}
