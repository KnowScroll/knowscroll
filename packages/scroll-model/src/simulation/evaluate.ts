import type {
  Formula,
  NumberFormat,
  Operand,
  SimulationCore,
  SimulationParam,
  SimulationReadout,
  SimulationView,
} from '../blocks/simulation.js';
import { templateKeys } from '../blocks/simulation.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';

/**
 * Pure, bounded and deterministic evaluation of a simulation (what the renderer calls). A
 * simulation is compiled once into closures over a `Float64Array` of slots (parameters, constants,
 * outputs), so evaluating a point allocates nothing; every formula kind runs in constant time
 * (lookup: at most 12 entries), a simulation has at most six outputs, its grid at most 10,000
 * points and a curve at most 200 samples. A non-finite result, or one beyond ±1e15, becomes `null`
 * and renders as "—"; evaluation never throws.
 */

type Slots = Float64Array;
type Run = (slots: Slots) => number;

function compileOperand(operand: Operand, slotOf: (key: string) => number): Run {
  if (typeof operand === 'number') return () => operand;
  const slot = slotOf(operand);
  return slot < 0 ? () => Number.NaN : (slots) => slots[slot] ?? Number.NaN;
}

function compileFormula(formula: Formula, slotOf: (key: string) => number): Run {
  const operand = (value: Operand) => compileOperand(value, slotOf);
  switch (formula.kind) {
    case 'linear': {
      const [x, a, b] = [operand(formula.x), operand(formula.a), operand(formula.b)];
      return (slots) => a(slots) * x(slots) + b(slots);
    }
    case 'product': {
      const factors = formula.factors.map(operand);
      return (slots) => {
        let product = 1;
        for (const factor of factors) product *= factor(slots);
        return product;
      };
    }
    case 'ratio': {
      const [numerator, denominator] = [operand(formula.numerator), operand(formula.denominator)];
      return (slots) => numerator(slots) / denominator(slots);
    }
    case 'power': {
      const [x, base, scale] = [operand(formula.x), operand(formula.base), operand(formula.scale)];
      const exponent = formula.exponent;
      return (slots) => scale(slots) * (x(slots) / base(slots)) ** exponent;
    }
    case 'exponential': {
      const [x, rate, initial] = [operand(formula.x), operand(formula.rate), operand(formula.initial)];
      return (slots) => initial(slots) * Math.exp(rate(slots) * x(slots));
    }
    case 'inverse-square': {
      const [r, k] = [operand(formula.r), operand(formula.k)];
      return (slots) => {
        const distance = r(slots);
        return k(slots) / (distance * distance);
      };
    }
    case 'lookup': {
      const input = compileOperand(formula.input, slotOf);
      const at = formula.table.map((entry) => entry.at);
      const values = formula.table.map((entry) => operand(entry.value));
      const interpolate = formula.mode === 'interpolate';
      return (slots) => {
        const x = input(slots);
        const last = at.length - 1;
        if (Number.isNaN(x) || last < 1) return Number.NaN;
        if (x <= (at[0] ?? Number.NaN)) return values[0]?.(slots) ?? Number.NaN;
        if (x >= (at[last] ?? Number.NaN)) return values[last]?.(slots) ?? Number.NaN;
        for (let index = 0; index < last; index += 1) {
          const low = at[index] ?? Number.NaN;
          const high = at[index + 1] ?? Number.NaN;
          if (x >= low && x < high) {
            const lowValue = values[index]?.(slots) ?? Number.NaN;
            if (!interpolate) return lowValue;
            const highValue = values[index + 1]?.(slots) ?? Number.NaN;
            return lowValue + ((highValue - lowValue) * (x - low)) / (high - low);
          }
        }
        return Number.NaN;
      };
    }
  }
}

/** Evaluates one formula against parameter, constant and earlier output values. */
export function evaluateFormula(formula: Formula, scope: ReadonlyMap<string, number>): number {
  const keys = [...scope.keys()];
  const slots = Float64Array.from(keys.map((key) => scope.get(key) ?? Number.NaN));
  return compileFormula(formula, (key) => keys.indexOf(key))(slots);
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

function bounded(value: number): number | null {
  return Number.isFinite(value) && Math.abs(value) <= FIELD_LIMITS.numberMagnitude ? value : null;
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

function hasUsableGrid(param: SimulationParam): boolean {
  return (
    Number.isFinite(param.min) &&
    Number.isFinite(param.max) &&
    Number.isFinite(param.step) &&
    param.step > 0 &&
    param.min <= param.max
  );
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The nearest value on the parameter's grid, clamped to `[min, max]`. Never NaN: a non-finite
 * value means the default, and a parameter without a usable grid (which validation refuses)
 * yields its default, its minimum or 0, in that order of preference.
 */
export function snapToGrid(param: SimulationParam, value: number): number {
  const fallback = finiteOr(param.default, finiteOr(param.min, 0));
  if (!hasUsableGrid(param)) return fallback;
  const target = Number.isFinite(value) ? value : fallback;
  const clamped = Math.min(param.max, Math.max(param.min, target));
  const steps = Math.round((clamped - param.min) / param.step);
  const precision = Math.min(12, Math.max(decimalPlaces(param.min), decimalPlaces(param.step)));
  const snapped = Number((param.min + steps * param.step).toFixed(precision));
  return Number.isFinite(snapped) ? Math.min(param.max, Math.max(param.min, snapped)) : param.min;
}

/** True when the value lies on the parameter's grid within `[min, max]`. */
export function isOnGrid(param: SimulationParam, value: number): boolean {
  if (!hasUsableGrid(param) || !Number.isFinite(value) || value < param.min || value > param.max) return false;
  return Math.abs(snapToGrid(param, value) - value) <= 1e-9 * Math.max(1, Math.abs(value));
}

/** Number of values on the parameter's grid, or 0 when it has no usable grid. */
export function gridSize(param: SimulationParam): number {
  if (!hasUsableGrid(param)) return 0;
  const positions = gridPositions(param);
  return Number.isFinite(positions) ? Math.round(positions) + 1 : 0;
}

/** Every value of the parameter's grid, in order (empty beyond `sliderPositions` positions). */
export function gridValues(param: SimulationParam): number[] {
  const size = gridSize(param);
  if (size === 0 || size > FIELD_LIMITS.sliderPositions + 1) return [];
  return Array.from({ length: size }, (_, index) => snapToGrid(param, param.min + index * param.step));
}

/** Points of the full parameter grid (product of the parameters' grid sizes). */
export function simulationGridPoints(data: Pick<SimulationCore, 'params'>): number {
  return data.params.reduce((points, param) => points * gridSize(param), 1);
}

/** Parameter values to evaluate: defaults, overridden by given values snapped onto the grid. */
export function resolveParams(
  data: Pick<SimulationCore, 'params'>,
  values: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const param of data.params) {
    const given = Object.hasOwn(values, param.key) ? values[param.key] : undefined;
    resolved[param.key] = snapToGrid(param, given ?? param.default);
  }
  return resolved;
}

/** A simulation compiled for repeated evaluation. */
export interface CompiledSimulation {
  readonly slots: Slots;
  readonly paramSlots: readonly number[];
  readonly outputSlots: readonly number[];
  /** Evaluates every output in order, writing each (bounded, NaN for null) into its slot. */
  run(): void;
}

const compiledCache = new WeakMap<object, CompiledSimulation>();

/** Compiles (and caches per data object) a simulation's formulas into slot closures. */
export function compileSimulation(data: SimulationCore): CompiledSimulation {
  const cached = compiledCache.get(data);
  if (cached !== undefined) return cached;
  const index = new Map<string, number>();
  const claim = (key: string) => {
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    index.set(key, index.size);
    return index.size - 1;
  };
  const paramSlots = data.params.map((param) => claim(param.key));
  const constantSlots = data.constants.map((constant) => claim(constant.key));
  const runs: Array<{ slot: number; run: Run }> = [];
  const defined = new Set<string>([
    ...data.params.map((param) => param.key),
    ...data.constants.map((constant) => constant.key),
  ]);
  for (const output of data.outputs) {
    const run = compileFormula(output.formula, (key) => (defined.has(key) ? (index.get(key) ?? -1) : -1));
    const slot = claim(output.key);
    defined.add(output.key);
    runs.push({ slot, run });
  }
  const slots = new Float64Array(index.size);
  data.constants.forEach((constant, position) => {
    slots[constantSlots[position] ?? 0] = constant.value;
  });
  const compiled: CompiledSimulation = {
    slots,
    paramSlots,
    outputSlots: runs.map((entry) => entry.slot),
    run() {
      for (const { slot, run } of runs) {
        const value = run(slots);
        slots[slot] = bounded(value) ?? Number.NaN;
      }
    },
  };
  compiledCache.set(data, compiled);
  return compiled;
}

export interface SimulationValues {
  readonly params: Readonly<Record<string, number>>;
  readonly outputs: Readonly<Record<string, number | null>>;
}

/**
 * Evaluates every output in declaration order. Values for unknown keys are ignored; missing
 * parameters take their defaults; given values are snapped onto the grid.
 */
export function evaluateSimulation(
  data: SimulationCore,
  values: Readonly<Record<string, number>> = {},
): SimulationValues {
  const params = resolveParams(data, values);
  const compiled = compileSimulation(data);
  data.params.forEach((param, position) => {
    compiled.slots[compiled.paramSlots[position] ?? 0] = params[param.key] ?? Number.NaN;
  });
  compiled.run();
  const outputs: Record<string, number | null> = {};
  data.outputs.forEach((output, position) => {
    const value = compiled.slots[compiled.outputSlots[position] ?? 0] ?? Number.NaN;
    outputs[output.key] = Number.isNaN(value) ? null : value;
  });
  return { params, outputs };
}

/** Number of samples a `plot` view draws over a parameter's range (at most `LIMITS.chartPoints`). */
export function curveSampleCount(param: SimulationParam): number {
  return Math.max(2, Math.min(LIMITS.chartPoints, gridSize(param)));
}

/** The x positions of a curve over a parameter's range. */
export function curveSamples(param: SimulationParam): number[] {
  const count = curveSampleCount(param);
  if (!hasUsableGrid(param)) return [];
  return Array.from({ length: count }, (_, index) => param.min + ((param.max - param.min) * index) / (count - 1));
}

/** The curve of output `y` as parameter `x` sweeps its range, other parameters held at `values`. */
export function sampleCurve(
  data: SimulationCore,
  values: Readonly<Record<string, number>>,
  xKey: string,
  yKey: string,
): Array<{ readonly x: number; readonly y: number | null }> {
  const xIndex = data.params.findIndex((param) => param.key === xKey);
  const yIndex = data.outputs.findIndex((output) => output.key === yKey);
  const xParam = data.params[xIndex];
  if (xParam === undefined || yIndex < 0) return [];
  const params = resolveParams(data, values);
  const compiled = compileSimulation(data);
  data.params.forEach((param, position) => {
    compiled.slots[compiled.paramSlots[position] ?? 0] = params[param.key] ?? Number.NaN;
  });
  const xSlot = compiled.paramSlots[xIndex] ?? 0;
  const ySlot = compiled.outputSlots[yIndex] ?? 0;
  return curveSamples(xParam).map((x) => {
    compiled.slots[xSlot] = x;
    compiled.run();
    const y = compiled.slots[ySlot] ?? Number.NaN;
    return { x, y: Number.isNaN(y) ? null : y };
  });
}

/**
 * Visits every point of the full parameter grid (the caller bounds its size) and, for a plot,
 * every curve sample for each combination of the other parameters. `visit` returns false to stop.
 */
export function forEachGridPoint(
  data: SimulationCore,
  visit: (compiled: CompiledSimulation) => boolean,
  options: { plotX?: string } = {},
): void {
  const compiled = compileSimulation(data);
  const axes = data.params.map((param) => gridValues(param));
  if (axes.some((axis) => axis.length === 0)) return;
  const positions = axes.map(() => 0);
  const plotIndex = options.plotX === undefined ? -1 : data.params.findIndex((param) => param.key === options.plotX);
  const plotParam = data.params[plotIndex];
  const samples = plotParam === undefined ? [] : curveSamples(plotParam);
  for (;;) {
    axes.forEach((axis, position) => {
      compiled.slots[compiled.paramSlots[position] ?? 0] = axis[positions[position] ?? 0] ?? Number.NaN;
    });
    compiled.run();
    if (!visit(compiled)) return;
    if (plotParam !== undefined && (positions[plotIndex] ?? 0) === 0) {
      const xSlot = compiled.paramSlots[plotIndex] ?? 0;
      for (const x of samples) {
        compiled.slots[xSlot] = x;
        compiled.run();
        if (!visit(compiled)) return;
      }
    }
    let carry = 0;
    while (carry < positions.length) {
      const next = (positions[carry] ?? 0) + 1;
      if (next < (axes[carry]?.length ?? 0)) {
        positions[carry] = next;
        break;
      }
      positions[carry] = 0;
      carry += 1;
    }
    if (carry === positions.length) return;
  }
}

/** Largest card value over the grid: the value that fills a bar (`cards` view). */
export function cardsScale(data: SimulationCore & { view: SimulationView }): number {
  const view = data.view;
  if (view.kind !== 'cards') return 1;
  const slots = view.items.map((item) => data.outputs.findIndex((output) => output.key === item.output));
  let largest = 0;
  forEachGridPoint(data, (compiled) => {
    for (const position of slots) {
      const value = compiled.slots[compiled.outputSlots[position] ?? -1] ?? Number.NaN;
      if (value > largest) largest = value;
    }
    return true;
  });
  return largest > 0 ? largest : 1;
}

/** The y range of a plot over its whole grid and every curve sample: `[min(0, lowest), highest]`. */
export function plotRange(data: SimulationCore & { view: SimulationView }): readonly [number, number] {
  const view = data.view;
  if (view.kind !== 'plot') return [0, 1];
  const position = data.outputs.findIndex((output) => output.key === view.y);
  let low = 0;
  let high = Number.NEGATIVE_INFINITY;
  forEachGridPoint(
    data,
    (compiled) => {
      const value = compiled.slots[compiled.outputSlots[position] ?? -1] ?? Number.NaN;
      if (!Number.isNaN(value)) {
        if (value < low) low = value;
        if (value > high) high = value;
      }
      return true;
    },
    { plotX: view.x },
  );
  return high > low ? [low, high] : [low, low + 1];
}

const MINUS = '−';

/**
 * Deterministic number formatting (`number-format.v1`, English only in v1): fixed decimals, `,`
 * thousands grouping, `.` decimal point, U+2212 minus, `~` when approximate, then the suffix.
 * `null` renders "—".
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
export function renderTemplate(template: string, data: SimulationCore, values: SimulationValues): string {
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
