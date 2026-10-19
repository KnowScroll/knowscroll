import type {
  Formula,
  NumberFormat,
  Operand,
  SimulationData,
  SimulationParam,
  SimulationReadout,
} from '../blocks/simulation.js';
import { templateKeys } from '../blocks/simulation.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';

/**
 * Pure, bounded and deterministic evaluation of a simulation (what the renderer calls). Every
 * formula kind runs in constant time (lookup: at most 12 entries), a simulation has at most six
 * outputs, and a curve has at most 200 samples. A non-finite result, or one beyond ±1e15,
 * becomes `null` and renders as "—"; evaluation never throws.
 */

type Scope = ReadonlyMap<string, number>;

function operand(value: Operand, scope: Scope): number {
  return typeof value === 'number' ? value : (scope.get(value) ?? Number.NaN);
}

/** Evaluates one formula against parameter, constant and earlier output values. */
export function evaluateFormula(formula: Formula, scope: Scope): number {
  switch (formula.kind) {
    case 'linear':
      return operand(formula.a, scope) * operand(formula.x, scope) + operand(formula.b, scope);
    case 'product':
      return formula.factors.reduce<number>((product, factor) => product * operand(factor, scope), 1);
    case 'ratio':
      return operand(formula.numerator, scope) / operand(formula.denominator, scope);
    case 'power':
      return (
        operand(formula.scale, scope) * (operand(formula.x, scope) / operand(formula.base, scope)) ** formula.exponent
      );
    case 'exponential':
      return operand(formula.initial, scope) * Math.exp(operand(formula.rate, scope) * operand(formula.x, scope));
    case 'inverse-square': {
      const r = operand(formula.r, scope);
      return operand(formula.k, scope) / (r * r);
    }
    case 'lookup':
      return evaluateLookup(formula, scope);
  }
}

function evaluateLookup(formula: Extract<Formula, { kind: 'lookup' }>, scope: Scope): number {
  const input = scope.get(formula.input) ?? Number.NaN;
  if (Number.isNaN(input)) return Number.NaN;
  const table = formula.table;
  const first = table[0];
  const last = table[table.length - 1];
  if (first === undefined || last === undefined) return Number.NaN;
  if (input <= first.at) return operand(first.value, scope);
  if (input >= last.at) return operand(last.value, scope);
  for (let index = 0; index + 1 < table.length; index += 1) {
    const low = table[index];
    const high = table[index + 1];
    if (low === undefined || high === undefined) break;
    if (input >= low.at && input < high.at) {
      const lowValue = operand(low.value, scope);
      if (formula.mode === 'step') return lowValue;
      const highValue = operand(high.value, scope);
      return lowValue + ((highValue - lowValue) * (input - low.at)) / (high.at - low.at);
    }
  }
  return Number.NaN;
}

/** Keys a formula reads. */
export function formulaReferences(formula: Formula): string[] {
  const keys = (...values: Operand[]) => values.filter((value): value is string => typeof value === 'string');
  switch (formula.kind) {
    case 'linear':
      return keys(formula.x, formula.a, formula.b);
    case 'product':
      return keys(...formula.factors);
    case 'ratio':
      return keys(formula.numerator, formula.denominator);
    case 'power':
      return keys(formula.x, formula.base, formula.scale);
    case 'exponential':
      return keys(formula.x, formula.rate, formula.initial);
    case 'inverse-square':
      return keys(formula.r, formula.k);
    case 'lookup':
      return [formula.input, ...keys(...formula.table.map((entry) => entry.value))];
  }
}

/**
 * Literal numbers a formula computes with. Structural fields are excluded: a power's exponent and
 * a lookup's `at` breakpoints describe the shape of the formula, not a quantity.
 */
export function formulaLiterals(formula: Formula): number[] {
  const literals = (...values: Operand[]) => values.filter((value): value is number => typeof value === 'number');
  switch (formula.kind) {
    case 'linear':
      return literals(formula.x, formula.a, formula.b);
    case 'product':
      return literals(...formula.factors);
    case 'ratio':
      return literals(formula.numerator, formula.denominator);
    case 'power':
      return literals(formula.x, formula.base, formula.scale);
    case 'exponential':
      return literals(formula.x, formula.rate, formula.initial);
    case 'inverse-square':
      return literals(formula.r, formula.k);
    case 'lookup':
      return literals(...formula.table.map((entry) => entry.value));
  }
}

function decimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  const text = String(value);
  const exponent = /e-(\d+)$/u.exec(text);
  const mantissa = text.split('e')[0] ?? '';
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  return exponent ? fraction + Number(exponent[1]) : fraction;
}

/** Number of grid positions `(max − min) / step` (not necessarily an integer for invalid params). */
export function gridPositions(param: Pick<SimulationParam, 'min' | 'max' | 'step'>): number {
  return (param.max - param.min) / param.step;
}

/** The nearest value on the parameter's grid, clamped to `[min, max]`; NaN becomes the default. */
export function snapToGrid(param: SimulationParam, value: number): number {
  if (!Number.isFinite(value)) return param.default;
  const clamped = Math.min(param.max, Math.max(param.min, value));
  const steps = Math.round((clamped - param.min) / param.step);
  const precision = Math.min(12, Math.max(decimalPlaces(param.min), decimalPlaces(param.step)));
  const snapped = Number((param.min + steps * param.step).toFixed(precision));
  return Math.min(param.max, Math.max(param.min, snapped));
}

/** True when the value lies on the parameter's grid within `[min, max]`. */
export function isOnGrid(param: SimulationParam, value: number): boolean {
  if (!Number.isFinite(value) || value < param.min || value > param.max) return false;
  return Math.abs(snapToGrid(param, value) - value) <= 1e-9 * Math.max(1, Math.abs(value));
}

/** Parameter values to evaluate: defaults, overridden by given values snapped onto the grid. */
export function resolveParams(
  data: Pick<SimulationData, 'params'>,
  values: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const param of data.params) {
    const given = Object.hasOwn(values, param.key) ? values[param.key] : undefined;
    resolved[param.key] = given === undefined ? param.default : snapToGrid(param, given);
  }
  return resolved;
}

export interface SimulationValues {
  readonly params: Readonly<Record<string, number>>;
  readonly outputs: Readonly<Record<string, number | null>>;
}

function bounded(value: number): number | null {
  return Number.isFinite(value) && Math.abs(value) <= FIELD_LIMITS.numberMagnitude ? value : null;
}

/**
 * Evaluates every output in declaration order. Values for unknown keys are ignored; missing
 * parameters take their defaults; given values are snapped onto the grid.
 */
export function evaluateSimulation(
  data: Pick<SimulationData, 'params' | 'constants' | 'outputs'>,
  values: Readonly<Record<string, number>> = {},
): SimulationValues {
  const params = resolveParams(data, values);
  const scope = new Map<string, number>();
  for (const param of data.params) scope.set(param.key, params[param.key] ?? param.default);
  for (const constant of data.constants) scope.set(constant.key, constant.value);
  const outputs: Record<string, number | null> = {};
  for (const output of data.outputs) {
    const value = bounded(evaluateFormula(output.formula, scope));
    outputs[output.key] = value;
    scope.set(output.key, value ?? Number.NaN);
  }
  return { params, outputs };
}

/** Number of samples a `plot` view draws over a parameter's range (at most `LIMITS.chartPoints`). */
export function curveSampleCount(param: SimulationParam): number {
  const positions = Math.round(gridPositions(param));
  return Math.max(2, Math.min(LIMITS.chartPoints, positions + 1));
}

/** The curve of output `y` as parameter `x` sweeps its range, other parameters held at `values`. */
export function sampleCurve(
  data: Pick<SimulationData, 'params' | 'constants' | 'outputs'>,
  values: Readonly<Record<string, number>>,
  xKey: string,
  yKey: string,
): Array<{ readonly x: number; readonly y: number | null }> {
  const param = data.params.find((candidate) => candidate.key === xKey);
  if (param === undefined) return [];
  const count = curveSampleCount(param);
  const points: Array<{ x: number; y: number | null }> = [];
  for (let index = 0; index < count; index += 1) {
    const x = param.min + ((param.max - param.min) * index) / (count - 1);
    const scope = new Map<string, number>();
    for (const other of data.params) {
      const given = Object.hasOwn(values, other.key) ? values[other.key] : undefined;
      scope.set(other.key, other.key === xKey ? x : given === undefined ? other.default : snapToGrid(other, given));
    }
    for (const constant of data.constants) scope.set(constant.key, constant.value);
    let y: number | null = null;
    for (const output of data.outputs) {
      const value = bounded(evaluateFormula(output.formula, scope));
      scope.set(output.key, value ?? Number.NaN);
      if (output.key === yKey) y = value;
    }
    points.push({ x, y });
  }
  return points;
}

const MINUS = '−';

/**
 * Deterministic number formatting (`number-format.v1`): fixed decimals, `,` thousands grouping,
 * `.` decimal point, U+2212 minus, `~` when approximate, then the suffix. `null` renders "—".
 */
export function formatNumber(value: number | null, format: NumberFormat): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const fixed = Math.abs(value).toFixed(format.decimals);
  const [integer = '0', fraction] = fixed.split('.');
  const grouped = format.grouping ? integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',') : integer;
  const negative = value < 0 && /[1-9]/u.test(fixed);
  const digits = fraction === undefined ? grouped : `${grouped}.${fraction}`;
  return `${format.approximate ? '~' : ''}${negative ? MINUS : ''}${digits}${format.suffix ?? ''}`;
}

const CONSTANT_FORMAT: NumberFormat = { decimals: 0, grouping: true, approximate: false };

function constantFormat(value: number): NumberFormat {
  return { ...CONSTANT_FORMAT, decimals: Math.min(4, decimalPlaces(value)) };
}

/** A value with its unit, as spoken by a slider ("4,096 words", "90°"). */
export function formatWithUnit(value: number | null, format: NumberFormat, unit: string | undefined): string {
  const number = formatNumber(value, format);
  if (unit === undefined) return number;
  return /^[°%′″]$/u.test(unit) ? `${number}${unit}` : `${number} ${unit}`;
}

/** Fills a template's `{key}` placeholders with formatted parameter, constant and output values. */
export function renderTemplate(
  template: string,
  data: Pick<SimulationData, 'params' | 'constants' | 'outputs'>,
  values: SimulationValues,
): string {
  const formatted = new Map<string, string>();
  for (const param of data.params)
    formatted.set(param.key, formatNumber(values.params[param.key] ?? null, param.format));
  for (const constant of data.constants)
    formatted.set(constant.key, formatNumber(constant.value, constantFormat(constant.value)));
  for (const output of data.outputs)
    formatted.set(output.key, formatNumber(values.outputs[output.key] ?? null, output.format));
  let text = template;
  for (const key of new Set(templateKeys(template))) text = text.split(`{${key}}`).join(formatted.get(key) ?? '—');
  return text;
}

/** The first band whose range (`min ≤ value < max`) contains its output's value, or null. */
export function readoutBand(readout: SimulationReadout, values: SimulationValues): string | null {
  for (const band of readout.bands) {
    const value = values.outputs[band.output];
    if (value === null || value === undefined) continue;
    if (band.min !== undefined && value < band.min) continue;
    if (band.max !== undefined && value >= band.max) continue;
    return band.text;
  }
  return null;
}
