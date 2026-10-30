import { SceneParseError } from '../parse.js';
import { LOOK_LIMITS, WORLD_GENERATOR_VERSION, type Point } from '../types.js';
import { bump, distanceOf, placeContinents, seedsOf, wrapDelta, type Bounds, type Continent } from './continents.js';
import { contours, deriveGrid, makeGrid, type Grid, type Loop } from './contours.js';
import { createNoise, type Noise } from './noise.js';
import { worldStream, type Stream } from './random.js';
import { makePuff } from './puff.js';
import type { GlobeWorld, MapWorld, Puff, SeaMark, Veil, WorldCell, WorldDecor, WorldSpec } from './types.js';

/** The width of the globe's band: it wraps every 480 units. */
const GLOBE_PERIOD = 480;
/** Names are kept this far apart, assuming the widest name, so no name depends on another's length. */
const LABEL_REACH = 120;
const LABEL_GAP = 24;
/** Nodes this far below the coast are in no cell, so no cell work is spent on open sea. */
const DEEP_SEA = -0.3;

interface Layout {
  readonly kind: 'globe' | 'map';
  readonly area: Bounds;
  readonly cell: number;
  readonly period: number | undefined;
  /** Where continents may be centred. */
  readonly spread: Bounds;
  /** How far region borders wander, by planet kind. */
  readonly wander: (archipelago: boolean) => number;
  /** Sizes of the first continents, largest first, by planet kind. */
  readonly sizes: (archipelago: boolean) => readonly number[];
}

const GLOBE: Layout = {
  kind: 'globe',
  area: { x0: -60, y0: 0, x1: 540, y1: 360 },
  cell: 4,
  period: GLOBE_PERIOD,
  spread: { x0: 0, y0: 100, x1: 480, y1: 260 },
  wander: () => 20,
  sizes: (archipelago) => (archipelago ? [44, 42, 40, 37, 37, 33, 33] : [76, 60, 56, 50, 46]),
};

const MAP: Layout = {
  kind: 'map',
  area: { x0: -30, y0: -30, x1: 420, y1: 880 },
  cell: 5,
  period: undefined,
  spread: { x0: 70, y0: 190, x1: 320, y1: 730 },
  wander: (archipelago) => (archipelago ? 14 : 34),
  sizes: (archipelago) => (archipelago ? [62, 58, 56, 52, 50, 46, 44] : [118, 86, 84, 72, 64]),
};

function refuseUnlessValid(spec: WorldSpec): void {
  const valid =
    typeof spec.seed === 'string' &&
    spec.seed.length > 0 &&
    spec.seed.length <= 128 &&
    Number.isInteger(spec.siteCount) &&
    spec.siteCount >= 1 &&
    spec.siteCount <= LOOK_LIMITS.sites &&
    Number.isInteger(spec.variant) &&
    spec.variant >= 0 &&
    spec.variant <= LOOK_LIMITS.variant;
  if (!valid) throw new SceneParseError();
}

/** The first `count` sizes of a table, carried on a step smaller each time and shrunk when there are many. */
function continentSizes(table: readonly number[], count: number): number[] {
  const sizes: number[] = [];
  for (let index = 0; index < count; index++) {
    const previous = sizes[index - 1] ?? 40;
    sizes.push(table[index] ?? Math.max(26, previous * 0.92));
  }
  const shrink = count > 6 ? Math.sqrt(6 / count) : 1;
  return sizes.map((size) => Math.max(24, size * shrink));
}

/** Everything the cells of one world are cut from. */
interface Terrain {
  readonly layout: Layout;
  readonly noise: Noise;
  /** A planet's offset into the noise, so no two planets share a pattern. */
  readonly grain: number;
  readonly wander: number;
  readonly continents: readonly Continent[];
  /** The sites' seeds in site order, then one for each decorative continent. */
  readonly seeds: readonly Point[];
  /** The continent each seed grows in. */
  readonly continentOf: readonly number[];
  readonly land: Grid;
  readonly owners: Owners;
}

/** Which seed each land node is nearest to, how near, and how near the next one is. */
interface Owners {
  readonly owner: Int16Array;
  readonly nearest: Float64Array;
  readonly second: Float64Array;
  readonly warpX: Float64Array;
  readonly warpY: Float64Array;
}

/** Continents and the seeds of every cell, from the planet's seed and its site count only. */
function layOut(layout: Layout, spec: WorldSpec) {
  const archipelago = spec.type === 'ocean';
  const stream = worldStream(spec.seed, `${layout.kind}-layout`, spec.variant);
  const siteContinents = archipelago ? spec.siteCount : Math.ceil(spec.siteCount / 4);
  const decorCount = archipelago ? 2 + Math.floor(stream() * 2) : 1 + Math.floor(stream() * 3);
  const sizes = continentSizes(layout.sizes(archipelago), siteContinents + decorCount);
  const continents = placeContinents(stream, sizes, layout.spread, layout.period);
  const seeds: Point[] = [];
  const continentOf: number[] = [];
  let remaining = spec.siteCount;
  for (let index = 0; index < siteContinents; index++) {
    const count = Math.ceil(remaining / (siteContinents - index));
    const start = Math.floor(stream() * 64);
    const continent = continents[index];
    if (!continent) break;
    for (const seed of seedsOf(continent, count, start)) {
      seeds.push(seed);
      continentOf.push(index);
    }
    remaining -= count;
  }
  continents.slice(siteContinents).forEach((continent, offset) => {
    seeds.push({ x: continent.x, y: continent.y });
    continentOf.push(siteContinents + offset);
  });
  return { continents, seeds, continentOf };
}

/** How high the land stands at a point: positive is land, negative sea. */
function landFunction(
  layout: Layout,
  spec: WorldSpec,
  continents: readonly Continent[],
  noise: Noise,
  grain: number,
): (x: number, y: number) => number {
  const soft = spec.type === 'gas';
  return (x, y) => {
    const wx = x + noise.at(x, y, 110, grain + 1.1) * 48;
    const wy = y + noise.at(x, y, 110, grain + 2.3) * 48;
    let base = -Infinity;
    for (const continent of continents) base = Math.max(base, bump(continent, wx, wy, layout.period));
    const detail = soft
      ? noise.at(wx, wy, 80, grain + 3) * 0.35 + noise.at(wx, wy, 34, grain + 4) * 0.14
      : noise.at(wx, wy, 70, grain + 3) * 0.42 +
        noise.at(wx, wy, 30, grain + 4) * 0.26 +
        noise.at(wx, wy, 13, grain + 5) * 0.16 +
        noise.at(wx, wy, 6, grain + 6) * 0.09;
    return base + detail - 0.12;
  };
}

function assignOwners(
  layout: Layout,
  land: Grid,
  seeds: readonly Point[],
  noise: Noise,
  grain: number,
  wander: number,
): Owners {
  const count = land.values.length;
  const owners: Owners = {
    owner: new Int16Array(count).fill(-1),
    nearest: new Float64Array(count),
    second: new Float64Array(count),
    warpX: new Float64Array(count),
    warpY: new Float64Array(count),
  };
  for (let node = 0; node < count; node++) {
    if ((land.values[node] ?? -1) < DEEP_SEA) continue;
    const x = land.x0 + (node % land.columns) * land.cell;
    const y = land.y0 + Math.floor(node / land.columns) * land.cell;
    const warpX = noise.at(x, y, 60, 9.1 + grain) * wander + noise.at(x, y, 22, 5.5 + grain) * wander * 0.35;
    const warpY = noise.at(x, y, 60, 4.7 + grain) * wander + noise.at(x, y, 22, 6.6 + grain) * wander * 0.35;
    let nearest = Infinity;
    let second = Infinity;
    let owner = -1;
    seeds.forEach((seed, index) => {
      const gap = distanceOf(wrapDelta(x + warpX - seed.x, layout.period), y + warpY - seed.y);
      if (gap < nearest) {
        second = nearest;
        nearest = gap;
        owner = index;
      } else if (gap < second) second = gap;
    });
    owners.owner[node] = owner;
    owners.nearest[node] = nearest;
    owners.second[node] = second;
    owners.warpX[node] = warpX;
    owners.warpY[node] = warpY;
  }
  return owners;
}

function createTerrain(layout: Layout, spec: WorldSpec): Terrain {
  const archipelago = spec.type === 'ocean';
  const noise = createNoise(worldStream(spec.seed, `${layout.kind}-noise`, spec.variant), layout.period);
  const grain = worldStream(spec.seed, `${layout.kind}-grain`, spec.variant)() * 50;
  const wander = layout.wander(archipelago);
  const { continents, seeds, continentOf } = layOut(layout, spec);
  const { area, cell } = layout;
  const land = makeGrid(area.x0, area.y0, area.x1, area.y1, cell, landFunction(layout, spec, continents, noise, grain));
  const owners = assignOwners(layout, land, seeds, noise, grain, wander);
  return { layout, noise, grain, wander, continents, seeds, continentOf, land, owners };
}

/** The part of the world one cell can reach: the nodes it owns on land, with a margin. */
interface CellField {
  readonly field: Grid;
  readonly width: number;
  readonly height: number;
}

/**
 * Where seed `index` rules, as a field that is above zero inside its region: the land, or how far
 * nearer this seed is than any other, whichever is lower. Only the nodes round the region are visited.
 */
function cellField(terrain: Terrain, index: number): CellField | undefined {
  const { land, owners, seeds, layout } = terrain;
  let firstColumn = land.columns;
  let lastColumn = -1;
  let firstRow = land.rows;
  let lastRow = -1;
  for (let node = 0; node < owners.owner.length; node++) {
    if (owners.owner[node] !== index || (land.values[node] ?? -1) <= 0) continue;
    const column = node % land.columns;
    const row = Math.floor(node / land.columns);
    firstColumn = Math.min(firstColumn, column);
    lastColumn = Math.max(lastColumn, column);
    firstRow = Math.min(firstRow, row);
    lastRow = Math.max(lastRow, row);
  }
  if (lastColumn < 0) return undefined;
  firstColumn = Math.max(0, firstColumn - 2);
  firstRow = Math.max(0, firstRow - 2);
  lastColumn = Math.min(land.columns - 1, lastColumn + 2);
  lastRow = Math.min(land.rows - 1, lastRow + 2);
  const seed = seeds[index];
  if (!seed) return undefined;
  const columns = lastColumn - firstColumn + 1;
  const rows = lastRow - firstRow + 1;
  const values = new Float64Array(columns * rows).fill(-1);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const node = (firstRow + row) * land.columns + firstColumn + column;
      const owner = owners.owner[node] ?? -1;
      if (owner < 0) continue;
      let mine = owners.nearest[node] ?? 0;
      let other = owners.second[node] ?? 0;
      if (owner !== index) {
        const x = land.x0 + (firstColumn + column) * land.cell;
        const y = land.y0 + (firstRow + row) * land.cell;
        other = owners.nearest[node] ?? 0;
        mine = distanceOf(
          wrapDelta(x + (owners.warpX[node] ?? 0) - seed.x, layout.period),
          y + (owners.warpY[node] ?? 0) - seed.y,
        );
      }
      values[row * columns + column] = Math.min(land.values[node] ?? -1, (other - mine) / 30);
    }
  const field: Grid = {
    columns,
    rows,
    values,
    x0: land.x0 + firstColumn * land.cell,
    y0: land.y0 + firstRow * land.cell,
    cell: land.cell,
  };
  return { field, width: (lastColumn - firstColumn) * land.cell, height: (lastRow - firstRow) * land.cell };
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

/** A point well inside a region, close to the middle of its land. */
function deepest(field: Grid): Point {
  let highest = -9;
  let sumColumn = 0;
  let sumRow = 0;
  let count = 0;
  field.values.forEach((value, node) => {
    if (value > highest) highest = value;
    if (value > 0) {
      sumColumn += node % field.columns;
      sumRow += Math.floor(node / field.columns);
      count++;
    }
  });
  if (count === 0) return { x: field.x0, y: field.y0 };
  const middleColumn = sumColumn / count;
  const middleRow = sumRow / count;
  let best = 0;
  let bestGap = Infinity;
  field.values.forEach((value, node) => {
    if (value < highest * 0.35) return;
    const gap = distanceOf((node % field.columns) - middleColumn, Math.floor(node / field.columns) - middleRow);
    if (gap < bestGap) {
      bestGap = gap;
      best = node;
    }
  });
  return {
    x: tenth(field.x0 + (best % field.columns) * field.cell),
    y: tenth(field.y0 + Math.floor(best / field.columns) * field.cell),
  };
}

/**
 * Keeps names apart by moving them up or down. It looks only at where the cells are, assuming the
 * widest name, so a name sits in the same place whatever the other regions are called and whichever
 * have formed.
 */
function separateLabels(points: readonly Point[], period: number | undefined): Point[] {
  const moved = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < 6; pass++)
    moved.forEach((first, i) =>
      moved.forEach((second, j) => {
        if (j >= i) return;
        const across = wrapDelta(first.x - second.x, period);
        const down = first.y - second.y;
        if (Math.abs(across) >= LABEL_REACH || Math.abs(down) >= LABEL_GAP) return;
        const push = (LABEL_GAP - Math.abs(down)) / 2 + 1;
        const sign = down >= 0 ? 1 : -1;
        first.y += push * sign;
        second.y -= push * sign;
      }),
    );
  return moved.map((point) => ({ x: tenth(point.x), y: tenth(point.y) }));
}

function veilOf(stream: Stream, centre: Point, rx: number, ry: number): Veil {
  const puffs = [0, 1].map(() =>
    makePuff(
      stream,
      centre.x + (stream() - 0.5) * rx * 1.3,
      centre.y + (stream() - 0.5) * ry * 1.1,
      0.5 + stream() * 0.35,
    ),
  );
  return { at: centre, rx: tenth(rx), ry: tenth(ry), puffs };
}

interface Shape {
  readonly loops: readonly Loop[];
  readonly label: Point;
  readonly reach: { readonly rx: number; readonly ry: number };
}

/** The outline, label point and extent of every seed's region, in seed order. */
function shapesOf(terrain: Terrain): Shape[] {
  return terrain.seeds.map((seed, index) => {
    const built = cellField(terrain, index);
    if (!built) return { loops: [], label: { x: tenth(seed.x), y: tenth(seed.y) }, reach: { rx: 24, ry: 24 } };
    return {
      loops: contours(built.field, 0, 1),
      label: deepest(built.field),
      reach: { rx: Math.max(24, (built.width / 2) * 1.1), ry: Math.max(24, (built.height / 2) * 1.1) },
    };
  });
}

interface Cut {
  readonly cells: WorldCell[];
  readonly decor: WorldDecor[];
}

function cutCells(terrain: Terrain, spec: WorldSpec, veils: boolean): Cut {
  const shapes = shapesOf(terrain);
  const sites = shapes.slice(0, spec.siteCount);
  const labels = separateLabels(
    sites.map((shape) => shape.label),
    terrain.layout.period,
  );
  const stream = worldStream(spec.seed, `${terrain.layout.kind}-veils`, spec.variant);
  const veilFor = (centre: Point, reach: Shape['reach']): { veil?: Veil } =>
    veils ? { veil: veilOf(stream, centre, reach.rx, reach.ry) } : {};
  const cells = sites.map((shape, site): WorldCell => {
    const label = labels[site] ?? shape.label;
    return { site, loops: shape.loops, label, ...veilFor(shape.label, shape.reach) };
  });
  const decor = shapes.slice(spec.siteCount).map((shape): WorldDecor => ({
    loops: shape.loops,
    ...veilFor(shape.label, shape.reach),
  }));
  return { cells, decor };
}

/** Coasts, shallows and the cartoon patches of land: the same whichever regions have formed. */
function coastsOf(terrain: Terrain, spec: WorldSpec) {
  const { land, noise, grain } = terrain;
  const highland = deriveGrid(land, (value, x, y) => Math.min(value - 0.06, noise.at(x, y, 90, 3.3 + grain) - 0.16));
  const lowland = deriveGrid(land, (value, x, y) => Math.min(value - 0.04, -noise.at(x, y, 80, 7.9 + grain) - 0.2));
  return {
    land: contours(land, 0, 1),
    shallow: contours(land, -0.07),
    shallowWide: contours(land, -0.15),
    highland: contours(highland),
    lowland: contours(lowland),
    generator: WORLD_GENERATOR_VERSION,
    siteCount: spec.siteCount,
  };
}

/** Places on open water, for waves, floes, bubbles and craters. */
function seaMarks(terrain: Terrain, spec: WorldSpec): SeaMark[] {
  const stream = worldStream(spec.seed, 'map-marks', spec.variant);
  const { land } = terrain;
  const landAt = (x: number, y: number): number => {
    const column = Math.round((x - land.x0) / land.cell);
    const row = Math.round((y - land.y0) / land.cell);
    return column < 0 || row < 0 || column >= land.columns || row >= land.rows
      ? -1
      : (land.values[row * land.columns + column] ?? -1);
  };
  const marks: SeaMark[] = [];
  for (let gy = -60; gy < 900; gy += 54)
    for (let gx = -40; gx < 430; gx += 54) {
      if (stream() > 0.62) continue;
      const x = gx + stream() * 70;
      const y = gy + stream() * 70;
      const size = 7 + stream() * 5;
      const turn = stream() * 22 - 11;
      if (landAt(x, y) > -0.14) continue;
      marks.push({ x: tenth(x), y: tenth(y), size: tenth(size), turn: tenth(turn) });
    }
  return marks;
}

/** Clouds along the screen's edge, kept out of the middle where the land is. */
function framingClouds(spec: WorldSpec) {
  const stream = worldStream(spec.seed, 'map-frame', spec.variant);
  const puffs: Puff[] = [];
  const place = (px: number, py: number) => {
    const x = px + stream() * 30 - 15;
    const y = py + stream() * 30 - 15;
    const scale = 0.9 + stream() * 0.5;
    const centre = x > 50 && x < 340 && y > 150 && y < 760;
    const puff = makePuff(stream, x, y, scale);
    if (y >= 66 && !centre) puffs.push(puff);
  };
  const { x0, y0, x1, y1 } = { x0: -30, y0: 0, x1: 420, y1: 900 };
  for (let x = x0; x <= x1; x += 80) {
    place(x, y0);
    place(x, y1);
  }
  for (let y = y0 + 95; y < y1 - 47.5; y += 95) {
    place(x0, y);
    place(x1, y);
  }
  return puffs;
}

/** The cloud fields of a globe: three contour levels of one noise field. */
function globeClouds(terrain: Terrain, spec: WorldSpec) {
  const { noise } = terrain;
  const layer = worldStream(spec.seed, 'globe-clouds', spec.variant)() * 9;
  const field = makeGrid(
    -60,
    0,
    540,
    360,
    5,
    (x, y) =>
      noise.at(x, y, 50, layer) * 0.9 +
      noise.at(x, y, 20, layer + 4) * 0.35 +
      noise.at(x, y, 8, layer + 7) * 0.12 -
      0.32,
  );
  return { body: contours(field), middle: contours(field, 0.1), core: contours(field, 0.2) };
}

/**
 * The band of land a globe turns under its clouds. Every continent is drawn in colour: the globe
 * never shows which land is reached. Pure and pinned (`worldmap.v1`): the same planet gives the
 * same numbers on every engine.
 *
 * @throws SceneParseError when the spec is outside the bounds of a look.
 */
export function buildGlobe(spec: WorldSpec): GlobeWorld {
  refuseUnlessValid(spec);
  const terrain = createTerrain(GLOBE, spec);
  const { cells, decor } = cutCells(terrain, spec, false);
  return {
    kind: 'globe',
    width: GLOBE_PERIOD,
    height: 360,
    ...coastsOf(terrain, spec),
    cells,
    decor,
    clouds: globeClouds(terrain, spec),
  };
}

/**
 * The flat map a person lands on: every site's cell with irregular borders, the decorative
 * continents, and what frames them. The same planet gives the same numbers on every engine.
 *
 * @throws SceneParseError when the spec is outside the bounds of a look.
 */
export function buildMap(spec: WorldSpec): MapWorld {
  refuseUnlessValid(spec);
  const terrain = createTerrain(MAP, spec);
  const { cells, decor } = cutCells(terrain, spec, true);
  return {
    kind: 'map',
    width: 390,
    height: 844,
    ...coastsOf(terrain, spec),
    cells,
    decor,
    marks: seaMarks(terrain, spec),
    frame: framingClouds(spec),
  };
}
