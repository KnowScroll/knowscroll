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

/**
 * Resolves an operand to a slot: a key's slot, a slot holding the literal, or the shared NaN slot
 * for an unknown key. Every operand is then one typed-array read, with no call per operand.
 */
type SlotOf = (operand: Operand) => number;

function compileFormula(formula: Formula, slot: SlotOf): Run {
  switch (formula.kind) {
    case 'linear': {
      const [x, a, b] = [slot(formula.x), slot(formula.a), slot(formula.b)];
      return (s) => s[a]! * s[x]! + s[b]!;
    }
    case 'product': {
      const factors = formula.factors.map(slot);
      const [f0 = 0, f1 = 0, f2, f3] = factors;
      if (f2 === undefined) return (s) => s[f0]! * s[f1]!;
      if (f3 === undefined) return (s) => s[f0]! * s[f1]! * s[f2]!;
      return (s) => s[f0]! * s[f1]! * s[f2]! * s[f3]!;
    }
    case 'ratio': {
      const [numerator, denominator] = [slot(formula.numerator), slot(formula.denominator)];
      return (s) => s[numerator]! / s[denominator]!;
    }
    case 'power': {
      const [x, base, scale] = [slot(formula.x), slot(formula.base), slot(formula.scale)];
      const exponent = formula.exponent;
      return (s) => s[scale]! * (s[x]! / s[base]!) ** exponent;
    }
    case 'exponential': {
      const [x, rate, initial] = [slot(formula.x), slot(formula.rate), slot(formula.initial)];
      return (s) => s[initial]! * Math.exp(s[rate]! * s[x]!);
    }
    case 'inverse-square': {
      const [r, k] = [slot(formula.r), slot(formula.k)];
      return (s) => s[k]! / (s[r]! * s[r]!);
    }
    case 'lookup': {
      const input = slot(formula.input);
      const at = Float64Array.from(formula.table.map((entry) => entry.at));
      const values = Int32Array.from(formula.table.map((entry) => slot(entry.value)));
      const interpolate = formula.mode === 'interpolate';
      const last = at.length - 1;
      return (s) => {
        const x = s[input]!;
        if (Number.isNaN(x) || last < 1) return Number.NaN;
        if (x <= at[0]!) return s[values[0]!]!;
        if (x >= at[last]!) return s[values[last]!]!;
        for (let index = 0; index < last; index += 1) {
          const low = at[index]!;
          const high = at[index + 1]!;
          if (x >= low && x < high) {
            const lowValue = s[values[index]!]!;
            if (!interpolate) return lowValue;
            return lowValue + ((s[values[index + 1]!]! - lowValue) * (x - low)) / (high - low);
          }
        }
        return Number.NaN;
      };
    }
  }
}

/** Slot allocation for one compiled simulation or formula: keys first, then literals, then NaN. */
class SlotTable {
  private readonly keys = new Map<string, number>();
  private readonly literals = new Map<number, number>();
  readonly initial: number[] = [];

  key(name: string): number {
    const existing = this.keys.get(name);
    if (existing !== undefined) return existing;
    this.keys.set(name, this.initial.length);
    this.initial.push(Number.NaN);
    return this.initial.length - 1;
  }

  has(name: string): boolean {
    return this.keys.has(name);
  }

  literal(value: number): number {
    const existing = this.literals.get(value);
    if (existing !== undefined) return existing;
    this.literals.set(value, this.initial.length);
    this.initial.push(value);
    return this.initial.length - 1;
  }
}

/** Evaluates one formula against parameter, constant and earlier output values. */
export function evaluateFormula(formula: Formula, scope: ReadonlyMap<string, number>): number {
  const table = new SlotTable();
  for (const [key, value] of scope) table.initial[table.key(key)] = value;
  const unknown = table.literal(Number.NaN);
  const run = compileFormula(formula, (operand) =>
    typeof operand === 'number' ? table.literal(operand) : table.has(operand) ? table.key(operand) : unknown,
  );
  return run(Float64Array.from(table.initial));
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
  /** Evaluates every output in order, writing each (bounded; NaN for null) into its slot. */
  run(): void;
  /**
   * Re-evaluates only the outputs that depend (directly or through earlier outputs) on a parameter
   * in `changed` (a bit mask of parameter positions); the others keep their values.
   */
  runChanged(changed: number): void;
  /** After `run` or `runChanged`: true when every re-evaluated output was finite and within ±1e15. */
  readonly finite: boolean;
}

const compiledCache = new WeakMap<object, CompiledSimulation>();
const MAGNITUDE = FIELD_LIMITS.numberMagnitude;

/** Compiles (and caches per data object) a simulation's formulas into slot closures. */
export function compileSimulation(data: SimulationCore): CompiledSimulation {
  const cached = compiledCache.get(data);
  if (cached !== undefined) return cached;
  const table = new SlotTable();
  const paramSlots = data.params.map((param) => table.key(param.key));
  const constantSlots = data.constants.map((constant) => table.key(constant.key));
  const defined = new Set<string>([
    ...data.params.map((param) => param.key),
    ...data.constants.map((constant) => constant.key),
  ]);
  const unknown = table.literal(Number.NaN);
  const runs: Run[] = [];
  const outputSlotList: number[] = [];
  // Which parameters each output depends on, directly or through earlier outputs (bit per position).
  const dependsOn = new Map<string, number>(data.params.map((param, position) => [param.key, 1 << position]));
  const masks: number[] = [];
  for (const output of data.outputs) {
    runs.push(
      compileFormula(output.formula, (operand) =>
        typeof operand === 'number' ? table.literal(operand) : defined.has(operand) ? table.key(operand) : unknown,
      ),
    );
    const mask = formulaReferences(output.formula).reduce((bits, key) => bits | (dependsOn.get(key) ?? 0), 0);
    masks.push(mask);
    dependsOn.set(output.key, mask);
    outputSlotList.push(table.key(output.key));
    defined.add(output.key);
  }
  const slots = Float64Array.from(table.initial);
  data.constants.forEach((constant, position) => {
    slots[constantSlots[position] ?? 0] = constant.value;
  });
  const outputs = Int32Array.from(outputSlotList);
  const dependencies = Int32Array.from(masks);
  const count = runs.length;
  const compiled = {
    slots,
    paramSlots,
    outputSlots: outputSlotList,
    finite: true,
    runChanged(changed: number) {
      let finite = true;
      for (let index = 0; index < count; index += 1) {
        // An output of constants only (mask 0) is evaluated whenever everything is (`changed` = -1).
        if ((dependencies[index]! & changed) === 0 && changed !== -1) continue;
        const value = runs[index]!(slots);
        // `value - value === 0` is false exactly for NaN and ±Infinity.
        if (value - value === 0 && value <= MAGNITUDE && value >= -MAGNITUDE) slots[outputs[index]!] = value;
        else {
          slots[outputs[index]!] = Number.NaN;
          finite = false;
        }
      }
      compiled.finite = finite;
    },
    run() {
      compiled.runChanged(-1);
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

/**
 * The x positions of a curve: values of the parameter's own grid (all of them, or 200 evenly
 * spread ones), so a plot is drawn only at values a reader can set and the full-grid proof covers
 * every point it draws.
 */
export function curveSamples(param: SimulationParam): number[] {
  const values = gridValues(param);
  const count = Math.min(values.length, curveSampleCount(param));
  if (count < 2) return values;
  return Array.from(
    { length: count },
    (_, index) => values[Math.round((index * (values.length - 1)) / (count - 1))] ?? param.min,
  );
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
 * Visits every point of the full parameter grid (the caller bounds its size); `visit` returns
 * false to stop. Curve samples are grid values, so they are among the points visited.
 */
export function forEachGridPoint(data: SimulationCore, visit: (compiled: CompiledSimulation) => boolean): void {
  const compiled = compileSimulation(data);
  const axes = data.params.map((param) => gridValues(param));
  if (axes.some((axis) => axis.length === 0)) return;
  const positions = axes.map(() => 0);
  const slots = compiled.slots;
  const paramSlots = compiled.paramSlots;
  const write = (position: number) => {
    slots[paramSlots[position]!] = axes[position]![positions[position]!]!;
  };
  for (let position = 0; position < axes.length; position += 1) write(position);
  compiled.run();
  for (;;) {
    if (!visit(compiled)) return;
    // Odometer: the first parameter changes fastest; only the parameters that change are written,
    // and only the outputs that depend on them are re-evaluated.
    let carry = 0;
    while (carry < positions.length) {
      const next = positions[carry]! + 1;
      if (next < axes[carry]!.length) {
        positions[carry] = next;
        write(carry);
        break;
      }
      positions[carry] = 0;
      write(carry);
      carry += 1;
    }
    if (carry === positions.length) return;
    compiled.runChanged((2 << carry) - 1);
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
  forEachGridPoint(data, (compiled) => {
    const value = compiled.slots[compiled.outputSlots[position] ?? -1] ?? Number.NaN;
    if (!Number.isNaN(value)) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
    return true;
  });
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
