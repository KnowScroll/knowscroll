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
 * Pure, bounded and deterministic evaluation of a simulation (what the renderer calls, and what
 * the full-grid proof runs). Every key and literal has a cell in one `Float64Array`; a key that
 * varies along the current row (a parameter laid out along the row, or an output depending on
 * one) has `length` consecutive cells. Each formula is compiled once into a kernel that fills its
 * output's cells in one tight loop, reading each operand at `offset + i·stride` (stride 0 for a
 * cell that is the same all along the row). The same kernels evaluate a single point (`length`
 * 1), a curve (a row of x values) and the full grid (rows of the largest grids), so the proof
 * checks exactly the arithmetic the renderer runs. Every formula kind runs in constant time per
 * value (lookup: at most 12 entries), a simulation has at most six outputs and its grid at most
 * 10,000 points. A non-finite result, or one beyond ±1e15, becomes `null` and renders as "—";
 * evaluation never throws.
 */

/** Where a value lives: `cells[offset + i·stride]` for the i-th value along the row. */
interface Cell {
  readonly offset: number;
  readonly stride: 0 | 1;
}

/** A cell that is never written: reads of a missing operand land here (only for invalid data). */
const NAN_CELL: Cell = { offset: -1, stride: 0 };

/** Fills an output's cells (`length` of them when it varies along the row, else 1). */
type Kernel = (cells: Float64Array, length: number) => void;

/** Resolves an operand to its cell: a key's cell, a literal's own cell or the NaN cell. */
type CellOf = (operand: Operand) => Cell;

function compileKernel(formula: Formula, cell: CellOf, out: number): Kernel {
  switch (formula.kind) {
    case 'linear': {
      const { offset: xo, stride: xs } = cell(formula.x);
      const { offset: ao, stride: as_ } = cell(formula.a);
      const { offset: bo, stride: bs } = cell(formula.b);
      return (c, n) => {
        for (let i = 0; i < n; i += 1) c[out + i] = c[ao + i * as_]! * c[xo + i * xs]! + c[bo + i * bs]!;
      };
    }
    case 'product': {
      const factors = formula.factors.map(cell);
      const [{ offset: fo, stride: fs } = NAN_CELL, { offset: go, stride: gs } = NAN_CELL] = factors;
      const third = factors[2];
      const fourth = factors[3];
      if (third === undefined) {
        return (c, n) => {
          for (let i = 0; i < n; i += 1) c[out + i] = c[fo + i * fs]! * c[go + i * gs]!;
        };
      }
      const { offset: ho, stride: hs } = third;
      if (fourth === undefined) {
        return (c, n) => {
          for (let i = 0; i < n; i += 1) c[out + i] = c[fo + i * fs]! * c[go + i * gs]! * c[ho + i * hs]!;
        };
      }
      const { offset: jo, stride: js } = fourth;
      return (c, n) => {
        for (let i = 0; i < n; i += 1)
          c[out + i] = c[fo + i * fs]! * c[go + i * gs]! * c[ho + i * hs]! * c[jo + i * js]!;
      };
    }
    case 'ratio': {
      const { offset: no, stride: ns } = cell(formula.numerator);
      const { offset: do_, stride: ds } = cell(formula.denominator);
      return (c, n) => {
        for (let i = 0; i < n; i += 1) c[out + i] = c[no + i * ns]! / c[do_ + i * ds]!;
      };
    }
    case 'power': {
      const { offset: xo, stride: xs } = cell(formula.x);
      const { offset: bo, stride: bs } = cell(formula.base);
      const { offset: so, stride: ss } = cell(formula.scale);
      const exponent = formula.exponent;
      return (c, n) => {
        for (let i = 0; i < n; i += 1) c[out + i] = c[so + i * ss]! * (c[xo + i * xs]! / c[bo + i * bs]!) ** exponent;
      };
    }
    case 'exponential': {
      const { offset: xo, stride: xs } = cell(formula.x);
      const { offset: ro, stride: rs } = cell(formula.rate);
      const { offset: io, stride: is } = cell(formula.initial);
      return (c, n) => {
        for (let i = 0; i < n; i += 1) c[out + i] = c[io + i * is]! * Math.exp(c[ro + i * rs]! * c[xo + i * xs]!);
      };
    }
    case 'inverse-square': {
      const { offset: ro, stride: rs } = cell(formula.r);
      const { offset: ko, stride: ks } = cell(formula.k);
      return (c, n) => {
        for (let i = 0; i < n; i += 1) {
          const r = c[ro + i * rs]!;
          c[out + i] = c[ko + i * ks]! / (r * r);
        }
      };
    }
    case 'lookup': {
      const { offset: xo, stride: xs } = cell(formula.input);
      const at = Float64Array.from(formula.table.map((entry) => entry.at));
      const values = formula.table.map((entry) => cell(entry.value));
      const vo = Int32Array.from(values.map((value) => value.offset));
      const vs = Int32Array.from(values.map((value) => value.stride));
      const interpolate = formula.mode === 'interpolate';
      const last = at.length - 1;
      return (c, n) => {
        for (let i = 0; i < n; i += 1) {
          const x = c[xo + i * xs]!;
          let value: number;
          if (Number.isNaN(x) || last < 1) value = Number.NaN;
          else if (x <= at[0]!) value = c[vo[0]! + i * vs[0]!]!;
          else if (x >= at[last]!) value = c[vo[last]! + i * vs[last]!]!;
          else {
            // Binary search for the entry with at[low] <= x < at[low + 1] (the table is increasing).
            let low = 0;
            let high = last;
            while (high - low > 1) {
              const middle = (low + high) >> 1;
              if (at[middle]! <= x) low = middle;
              else high = middle;
            }
            const lowValue = c[vo[low]! + i * vs[low]!]!;
            value = interpolate
              ? lowValue + ((c[vo[high]! + i * vs[high]!]! - lowValue) * (x - at[low]!)) / (at[high]! - at[low]!)
              : lowValue;
          }
          c[out + i] = value;
        }
      };
    }
  }
}

/** Running allocation of cells; values are written once the layout is known. */
class CellLayout {
  readonly initial: number[] = [];

  /** `count` cells holding `value` (a varying cell has `count` = the row length). */
  add(value: number, count = 1): Cell {
    const offset = this.initial.length;
    for (let index = 0; index < count; index += 1) this.initial.push(value);
    return { offset, stride: count > 1 ? 1 : 0 };
  }
}

/** Evaluates one formula against parameter, constant and earlier output values. */
export function evaluateFormula(formula: Formula, scope: ReadonlyMap<string, number>): number {
  const layout = new CellLayout();
  const named = new Map<string, Cell>();
  for (const [key, value] of scope) named.set(key, layout.add(value));
  const unknown = layout.add(Number.NaN);
  const out = layout.add(Number.NaN);
  const kernel = compileKernel(
    formula,
    (operand) => (typeof operand === 'number' ? layout.add(operand) : (named.get(operand) ?? unknown)),
    out.offset,
  );
  const cells = Float64Array.from(layout.initial);
  kernel(cells, 1);
  return cells[out.offset] ?? Number.NaN;
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

/** A simulation compiled for repeated evaluation over rows of `length` values. */
interface CompiledSimulation {
  readonly cells: Float64Array;
  readonly length: number;
  /** Cell of each parameter and each output, by position (writes to parameter cells are the caller's). */
  readonly params: readonly Cell[];
  readonly outputs: readonly Cell[];
  /**
   * Re-evaluates the outputs that depend (directly or through earlier outputs) on a parameter in
   * `changed`, a bit mask of parameter positions; `-1` evaluates every output.
   */
  run(changed: number): void;
  /** After `run`: every output value finite and within ±1e15 (the others are NaN). */
  readonly finite: boolean;
}

const MAGNITUDE = FIELD_LIMITS.numberMagnitude;

/** Turns every non-finite or out-of-range value in the range into NaN; false when there was one. */
function bound(cells: Float64Array, offset: number, count: number): boolean {
  let finite = true;
  for (let index = offset; index < offset + count; index += 1) {
    const value = cells[index]!;
    // `value - value === 0` is false exactly for NaN and ±Infinity.
    if (!(value - value === 0 && value <= MAGNITUDE && value >= -MAGNITUDE)) {
      cells[index] = Number.NaN;
      finite = false;
    }
  }
  return finite;
}

/**
 * Compiles a simulation with the parameters in `rowMask` (bit per position) laid out along a row
 * of `length` values. Unknown keys read NaN; a later definition of a key shadows an earlier one
 * (validation refuses both, but evaluation must not throw on them).
 */
function compileSimulation(data: SimulationCore, rowMask = 0, length = 1): CompiledSimulation {
  const layout = new CellLayout();
  const named = new Map<string, Cell>();
  const dependsOn = new Map<string, number>();
  const params = data.params.map((param, position) => {
    const cell = layout.add(Number.NaN, (rowMask & (1 << position)) === 0 ? 1 : length);
    named.set(param.key, cell);
    dependsOn.set(param.key, 1 << position);
    return cell;
  });
  for (const constant of data.constants) {
    named.set(constant.key, layout.add(constant.value));
    dependsOn.set(constant.key, 0);
  }
  const unknown = layout.add(Number.NaN);
  const resolve: CellOf = (operand) =>
    typeof operand === 'number' ? layout.add(operand) : (named.get(operand) ?? unknown);
  const kernels: Kernel[] = [];
  const masks: number[] = [];
  const outputs = data.outputs.map((output) => {
    const mask = formulaReferences(output.formula).reduce((bits, key) => bits | (dependsOn.get(key) ?? 0), 0);
    const cell = layout.add(Number.NaN, (mask & rowMask) === 0 ? 1 : length);
    kernels.push(compileKernel(output.formula, resolve, cell.offset));
    masks.push(mask);
    named.set(output.key, cell);
    dependsOn.set(output.key, mask);
    return cell;
  });
  const cells = Float64Array.from(layout.initial);
  const count = kernels.length;
  const offsets = Int32Array.from(outputs.map((cell) => cell.offset));
  const lengths = Int32Array.from(outputs.map((cell) => (cell.stride === 1 ? length : 1)));
  const dependencies = Int32Array.from(masks);
  const finiteByOutput = new Uint8Array(count).fill(1);
  let failing = 0;
  const compiled = {
    cells,
    length,
    params,
    outputs,
    finite: true,
    run(changed: number) {
      for (let index = 0; index < count; index += 1) {
        if (changed !== -1 && (dependencies[index]! & changed) === 0) continue;
        kernels[index]!(cells, lengths[index]!);
        const finite = bound(cells, offsets[index]!, lengths[index]!) ? 1 : 0;
        if (finite !== finiteByOutput[index]) {
          finiteByOutput[index] = finite;
          failing += finite === 1 ? -1 : 1;
        }
      }
      compiled.finite = failing === 0;
    },
  };
  return compiled;
}

export interface SimulationValues {
  readonly params: Readonly<Record<string, number>>;
  readonly outputs: Readonly<Record<string, number | null>>;
}

/**
 * CLIENT GUARD (coordinator ruling on M1). The client does not prove a simulation over its grid;
 * the server did when the revision was admitted. At runtime every single-point evaluation is
 * still guarded: a non-finite output (or one beyond ±1e15) comes back as `null`, and when any
 * output is `null` the renderer shows the block's fallback text (`fallbackTextOf(block)`) in place
 * of the view, the readout and the bars. Number text is never `NaN` or `Infinity`.
 */
export function outputsUsable(values: SimulationValues): boolean {
  return Object.values(values.outputs).every((value) => value !== null);
}

/** CLIENT GUARD for a curve: false when any sampled `y` is `null` (the renderer shows the fallback text). */
export function curveUsable(curve: ReadonlyArray<{ readonly y: number | null }>): boolean {
  return curve.every((point) => point.y !== null);
}

/**
 * Evaluates every output in declaration order. Values for unknown keys are ignored; missing
 * parameters take their defaults; given values are snapped onto the grid. One point: constant
 * work per output, safe on the client; guard the result with `outputsUsable`.
 */
export function evaluateSimulation(
  data: SimulationCore,
  values: Readonly<Record<string, number>> = {},
): SimulationValues {
  const params = resolveParams(data, values);
  const compiled = compileSimulation(data);
  data.params.forEach((param, position) => {
    compiled.cells[compiled.params[position]?.offset ?? -1] = params[param.key] ?? Number.NaN;
  });
  compiled.run(-1);
  const outputs: Record<string, number | null> = {};
  data.outputs.forEach((output, position) => {
    const value = compiled.cells[compiled.outputs[position]?.offset ?? -1] ?? Number.NaN;
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
  const samples = curveSamples(xParam);
  const compiled = compileSimulation(data, 1 << xIndex, samples.length);
  data.params.forEach((param, position) => {
    const cell = compiled.params[position];
    if (cell !== undefined && position !== xIndex) compiled.cells[cell.offset] = params[param.key] ?? Number.NaN;
  });
  compiled.cells.set(samples, compiled.params[xIndex]?.offset ?? 0);
  compiled.run(-1);
  const y = compiled.outputs[yIndex] ?? { offset: -1, stride: 0 };
  return samples.map((x, index) => {
    const value = compiled.cells[y.offset + index * y.stride] ?? Number.NaN;
    return { x, y: Number.isNaN(value) ? null : value };
  });
}

/** The full-grid sweep packs the largest grids into one row while it stays within this many values. */
const ROW_VALUES = 1024;

/** One row of the full-grid sweep. */
export interface GridRow {
  /** Every output finite and within ±1e15 at every point of the row. */
  readonly finite: boolean;
  /** Lowest value of the output at `position` along the row, ignoring NaN (NaN when none). */
  lowest(position: number): number;
  /** Highest value of the output at `position` along the row, ignoring NaN (NaN when none). */
  highest(position: number): number;
}

/**
 * Visits the full parameter grid (the caller bounds its size) one row at a time; `visit` returns
 * false to stop. The rows lay out the largest grids (up to 1,024 values per row); an odometer
 * runs over the other parameters, and only the outputs depending on a parameter that changed are
 * re-evaluated. Curve samples are grid values, so a plot's curve is among the points visited.
 */
export function sweepGrid(data: SimulationCore, visit: (row: GridRow) => boolean): void {
  const axes = data.params.map((param) => gridValues(param));
  if (axes.some((axis) => axis.length === 0)) return;
  const bySize = axes.map((_, position) => position).sort((p, q) => axes[q]!.length - axes[p]!.length || p - q);
  const rowAxes: number[] = [];
  let length = 1;
  for (const position of bySize) {
    const size = axes[position]!.length;
    if (rowAxes.length === 0 || length * size <= ROW_VALUES) {
      rowAxes.push(position);
      length *= size;
    }
  }
  const compiled = compileSimulation(
    data,
    rowAxes.reduce((mask, position) => mask | (1 << position), 0),
    length,
  );
  const cells = compiled.cells;
  let repeat = 1;
  for (const position of rowAxes) {
    const axis = axes[position]!;
    const offset = compiled.params[position]!.offset;
    for (let index = 0; index < length; index += 1)
      cells[offset + index] = axis[Math.floor(index / repeat) % axis.length]!;
    repeat *= axis.length;
  }
  const outer = axes.map((_, position) => position).filter((position) => !rowAxes.includes(position));
  const positions = outer.map(() => 0);
  const write = (index: number) => {
    const position = outer[index]!;
    cells[compiled.params[position]!.offset] = axes[position]![positions[index]!]!;
  };
  outer.forEach((_, index) => write(index));
  const extreme = (position: number, highest: boolean): number => {
    const cell = compiled.outputs[position];
    if (cell === undefined) return Number.NaN;
    let best = Number.NaN;
    const count = cell.stride === 1 ? length : 1;
    for (let index = cell.offset; index < cell.offset + count; index += 1) {
      const value = cells[index]!;
      if (Number.isNaN(value)) continue;
      if (Number.isNaN(best) || (highest ? value > best : value < best)) best = value;
    }
    return best;
  };
  const row: GridRow = {
    get finite() {
      return compiled.finite;
    },
    lowest: (position) => extreme(position, false),
    highest: (position) => extreme(position, true),
  };
  compiled.run(-1);
  for (;;) {
    if (!visit(row)) return;
    let carry = 0;
    let changed = 0;
    while (carry < outer.length) {
      changed |= 1 << outer[carry]!;
      const next = positions[carry]! + 1;
      if (next < axes[outer[carry]!]!.length) {
        positions[carry] = next;
        write(carry);
        break;
      }
      positions[carry] = 0;
      write(carry);
      carry += 1;
    }
    if (carry === outer.length) return;
    compiled.run(changed);
  }
}

/**
 * Largest card value over the grid: the value that fills a bar (`cards` view). Walks the whole
 * grid, so call it once per block and keep the result (it depends on the block only).
 */
export function cardsScale(data: SimulationCore & { view: SimulationView }): number {
  const view = data.view;
  if (view.kind !== 'cards') return 1;
  const positions = view.items.map((item) => data.outputs.findIndex((output) => output.key === item.output));
  let largest = 0;
  sweepGrid(data, (row) => {
    for (const position of positions) {
      const value = row.highest(position);
      if (value > largest) largest = value;
    }
    return true;
  });
  return largest > 0 ? largest : 1;
}

/**
 * The y range of a plot over its whole grid (curve samples included): `[min(0, lowest), highest]`.
 * Walks the whole grid, so call it once per block and keep the result (it depends on the block only).
 */
export function plotRange(data: SimulationCore & { view: SimulationView }): readonly [number, number] {
  const view = data.view;
  if (view.kind !== 'plot') return [0, 1];
  const position = data.outputs.findIndex((output) => output.key === view.y);
  let low = 0;
  let high = Number.NEGATIVE_INFINITY;
  sweepGrid(data, (row) => {
    const lowest = row.lowest(position);
    const highest = row.highest(position);
    if (lowest < low) low = lowest;
    if (highest > high) high = highest;
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
