/**
 * Outlines of a scalar field by marching squares, joined into closed loops and rounded off. Pure
 * arithmetic on grid positions: the loops are the same numbers on every engine.
 */

/** A closed outline as x, y, x, y, … rounded to a tenth of a map unit. */
export type Loop = readonly number[];

export interface Grid {
  readonly columns: number;
  readonly rows: number;
  readonly values: Float64Array;
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
}

export function makeGrid(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cell: number,
  sample: (x: number, y: number) => number,
): Grid {
  const columns = Math.ceil((x1 - x0) / cell) + 1;
  const rows = Math.ceil((y1 - y0) / cell) + 1;
  const values = new Float64Array(columns * rows);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      values[row * columns + column] = sample(x0 + column * cell, y0 + row * cell);
  return { columns, rows, values, x0, y0, cell };
}

/** The same grid with each value replaced by `change(value, x, y)`. */
export function deriveGrid(grid: Grid, change: (value: number, x: number, y: number) => number): Grid {
  const values = new Float64Array(grid.values.length);
  for (let index = 0; index < values.length; index++)
    values[index] = change(
      grid.values[index] ?? 0,
      grid.x0 + (index % grid.columns) * grid.cell,
      grid.y0 + Math.floor(index / grid.columns) * grid.cell,
    );
  return { ...grid, values };
}

const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;
type Edge = typeof TOP | typeof RIGHT | typeof BOTTOM | typeof LEFT;
type Segment = readonly [Edge, Edge];

/** Segments of a square by which corners are above the level (top-left 8, top-right 4, bottom-right 2, bottom-left 1). */
const SEGMENTS: Readonly<Record<number, readonly Segment[]>> = {
  1: [[LEFT, BOTTOM]],
  2: [[BOTTOM, RIGHT]],
  3: [[LEFT, RIGHT]],
  4: [[TOP, RIGHT]],
  6: [[TOP, BOTTOM]],
  7: [[TOP, LEFT]],
  8: [[TOP, LEFT]],
  9: [[TOP, BOTTOM]],
  11: [[TOP, RIGHT]],
  12: [[LEFT, RIGHT]],
  13: [[RIGHT, BOTTOM]],
  14: [[LEFT, BOTTOM]],
};

/** The two saddle squares: which way the pairs join depends on the middle of the square. */
function saddle(code: number, middleAbove: boolean): readonly Segment[] {
  const joinedAcross: readonly Segment[] = [
    [TOP, LEFT],
    [RIGHT, BOTTOM],
  ];
  const joinedAlong: readonly Segment[] = [
    [TOP, RIGHT],
    [LEFT, BOTTOM],
  ];
  return (code === 5) === middleAbove ? joinedAcross : joinedAlong;
}

function chaikin(points: readonly number[]): number[] {
  const count = points.length / 2;
  const out = new Array<number>(count * 4);
  for (let at = 0; at < count; at++) {
    const next = (at + 1) % count;
    const ax = points[at * 2] ?? 0;
    const ay = points[at * 2 + 1] ?? 0;
    const bx = points[next * 2] ?? 0;
    const by = points[next * 2 + 1] ?? 0;
    out[at * 4] = ax * 0.75 + bx * 0.25;
    out[at * 4 + 1] = ay * 0.75 + by * 0.25;
    out[at * 4 + 2] = ax * 0.25 + bx * 0.75;
    out[at * 4 + 3] = ay * 0.25 + by * 0.75;
  }
  return out;
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * Closed outlines of the area where the field is above `level`. The grid's own border counts as
 * below it, so every shape closes. `passes` 2 keeps every other point first, for a rounder shape.
 */
export function contours(grid: Grid, level = 0, passes = 2): Loop[] {
  const { columns, rows, values, x0, y0, cell } = grid;
  const at = (column: number, row: number): number =>
    column <= 0 || row <= 0 || column >= columns - 1 || row >= rows - 1
      ? -1
      : (values[row * columns + column] ?? 0) - level;
  const edgeKey = (edge: Edge, column: number, row: number): number =>
    edge === TOP
      ? (row * columns + column) * 2
      : edge === BOTTOM
        ? ((row + 1) * columns + column) * 2
        : edge === LEFT
          ? (row * columns + column) * 2 + 1
          : (row * columns + column + 1) * 2 + 1;
  const positions = new Map<number, readonly [number, number]>();
  const neighbours = new Map<number, number[]>();
  const link = (from: number, to: number) => {
    const fromList = neighbours.get(from) ?? [];
    fromList.push(to);
    neighbours.set(from, fromList);
    const toList = neighbours.get(to) ?? [];
    toList.push(from);
    neighbours.set(to, toList);
  };
  for (let row = 0; row < rows - 1; row++)
    for (let column = 0; column < columns - 1; column++) {
      const a = at(column, row);
      const b = at(column + 1, row);
      const c = at(column + 1, row + 1);
      const d = at(column, row + 1);
      const code = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const point = (edge: Edge): readonly [number, number] =>
        edge === TOP
          ? [column + a / (a - b), row]
          : edge === RIGHT
            ? [column + 1, row + b / (b - c)]
            : edge === BOTTOM
              ? [column + d / (d - c), row + 1]
              : [column, row + a / (a - d)];
      const segments =
        code === 5 || code === 10 ? saddle(code, (a + b + c + d) / 4 > 0) : (SEGMENTS[code] ?? ([] as const));
      for (const [from, to] of segments) {
        const fromKey = edgeKey(from, column, row);
        const toKey = edgeKey(to, column, row);
        positions.set(fromKey, point(from));
        positions.set(toKey, point(to));
        link(fromKey, toKey);
      }
    }
  const seen = new Set<number>();
  const loops: Loop[] = [];
  for (const start of neighbours.keys()) {
    if (seen.has(start)) continue;
    const walked: number[] = [];
    let previous: number | undefined;
    let current: number | undefined = start;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const [px, py] = positions.get(current) ?? [0, 0];
      walked.push(x0 + px * cell, y0 + py * cell);
      const before: number | undefined = previous;
      const options: number[] = neighbours.get(current) ?? [];
      previous = current;
      current = options.find((key) => key !== before && !seen.has(key));
    }
    if (walked.length / 2 <= 5) continue;
    const kept = passes > 1 ? walked.filter((_, index) => Math.floor(index / 2) % 2 === 0) : walked;
    const smooth = passes > 1 ? chaikin(chaikin(kept)) : chaikin(kept);
    loops.push(smooth.map(tenth));
  }
  return loops;
}
