import type { PictureOfKind, PictureState, PlanCell } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, PictureShape, TextShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import {
  BOLD_SLACK,
  inner,
  isLit,
  itemOpacity,
  LABEL_LINE_HEIGHT,
  labelShape,
  MARGIN,
  RECEDED,
  toneRole,
} from './common';

type PlanPicture = PictureOfKind<'plan'>;
type Place = PlanPicture['places'][number];

/** The least a label is shrunk to; below this it would stop being text. */
const SMALLEST_LABEL = 9;
/** Clearance kept between a label and what it must not touch, and between a label and the box's edge. */
const CLEARANCE = 1.5;
const EDGE = 3;
/** How strongly a region's cells are tinted. */
const REGION_OPACITY = 0.16;
/** What a label pays to sit over a tally, a way or a route instead of in clear ground. */
const OVERLAP_COST = 4;
/** Bars of a tally stack that stand side by side before the stack grows upward. */
const BARS_PER_ROW = 4;
const MONO_ADVANCE = 0.6;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Area extends Point {
  readonly width: number;
  readonly height: number;
}

/** A straight stroke a label should keep off: its end points and half its width. */
interface Segment {
  readonly from: Point;
  readonly to: Point;
  readonly half: number;
}

/** The grid, fitted to the box: square cells, centred. */
interface Frame {
  readonly cell: number;
  readonly left: number;
  readonly top: number;
}

function gridFrame(picture: PlanPicture, box: PictureBox): Frame {
  const room = inner(box);
  const { columns, rows } = picture.size;
  const cell = Math.max(0, Math.min(room.width / columns, room.height / rows));
  return {
    cell,
    left: room.x + (room.width - cell * columns) / 2,
    top: room.y + (room.height - cell * rows) / 2,
  };
}

const centreOf = (frame: Frame, at: PlanCell): Point => ({
  x: frame.left + (at.column + 0.5) * frame.cell,
  y: frame.top + (at.row + 0.5) * frame.cell,
});

const cellKey = (at: PlanCell): string => `${at.column}/${at.row}`;

// ---- Regions ---------------------------------------------------------------------------------------------------

/** Every cell nearer (by centre, Euclidean) to the region's place than to any other place it is compared with. */
function regionCells(picture: PlanPicture, region: PlanPicture['regions'][number]): PlanCell[] {
  const at = (id: string): PlanCell | undefined => picture.places.find((place) => place.id === id)?.at;
  const distance = (from: PlanCell, column: number, row: number): number =>
    (from.column - column) ** 2 + (from.row - row) ** 2;
  const home = at(region.nearest);
  const rivals = region.among.filter((id) => id !== region.nearest).flatMap((id) => at(id) ?? []);
  if (home === undefined) return [];
  const cells: PlanCell[] = [];
  for (let row = 0; row < picture.size.rows; row += 1)
    for (let column = 0; column < picture.size.columns; column += 1)
      if (rivals.every((rival) => distance(home, column, row) < distance(rival, column, row)))
        cells.push({ column, row });
  return cells;
}

/**
 * One tinted rect per cell of every region, so each state has the same keys and a switch of region fades one in and the
 * other out; only the region the state names is visible.
 */
function regionShapes(picture: PlanPicture, state: PictureState, frame: Frame): PictureShape[] {
  return picture.regions.flatMap((region) =>
    regionCells(picture, region).map((at): PictureShape => ({
      type: 'rect',
      key: `region-${region.id}-${at.column}-${at.row}`,
      part: region.id,
      x: frame.left + at.column * frame.cell,
      y: frame.top + at.row * frame.cell,
      width: frame.cell,
      height: frame.cell,
      cornerRadius: 0,
      fill: 'mark',
      stroke: 'none',
      strokeWidth: 0,
      opacity: state.region === region.id ? REGION_OPACITY : 0,
    })),
  );
}

// ---- Ways and routes --------------------------------------------------------------------------------------------

const wayWidth = (frame: Frame): number => Math.max(2, frame.cell / 3);

function wayShapes(picture: PlanPicture, state: PictureState, frame: Frame): PictureShape[] {
  return picture.ways.map((way): PictureShape => {
    const from = centreOf(frame, way.from);
    const to = centreOf(frame, way.to);
    return {
      type: 'line',
      key: `way-${way.id}`,
      part: way.id,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      stroke: isLit(state, way.id) ? 'mark' : 'rule',
      strokeWidth: wayWidth(frame),
      dashed: false,
      arrow: false,
      opacity: itemOpacity(state, way.id),
    };
  });
}

/** The two ends of a route, at the centres of the places it joins; undefined when a place is missing. */
function routeEnds(picture: PlanPicture, frame: Frame, route: PlanPicture['routes'][number]) {
  const from = picture.places.find((place) => place.id === route.from);
  const to = picture.places.find((place) => place.id === route.to);
  return from === undefined || to === undefined
    ? undefined
    : { from: centreOf(frame, from.at), to: centreOf(frame, to.at) };
}

function routeShapes(picture: PlanPicture, state: PictureState, frame: Frame): PictureShape[] {
  return picture.routes.flatMap((route): PictureShape[] => {
    const ends = routeEnds(picture, frame, route);
    if (ends === undefined) return [];
    const lit = isLit(state, route.id);
    return [
      {
        type: 'line',
        key: `route-${route.id}`,
        part: route.id,
        x1: ends.from.x,
        y1: ends.from.y,
        x2: ends.to.x,
        y2: ends.to.y,
        stroke: lit ? 'mark' : 'ink2',
        strokeWidth: lit ? 2.5 : 1.5,
        dashed: true,
        arrow: false,
        opacity: itemOpacity(state, route.id),
      },
    ];
  });
}

// ---- Tallies ----------------------------------------------------------------------------------------------------

/** A tally's bars arrive with its step: those after the state's step wait at opacity 0, the rest are drawn. */
function tallyOpacity(state: PictureState, step: number | undefined): number {
  const arrived = step === undefined || state.step === undefined || step <= state.step;
  if (!arrived) return 0;
  return state.lit === undefined ? 1 : RECEDED;
}

/** How many bars each cell holds in all steps, so a cell's stack is the same size (and its bars the same place) always. */
function barsPerCell(picture: PlanPicture): Map<string, number> {
  const totals = new Map<string, number>();
  for (const tally of picture.tallies)
    totals.set(cellKey(tally.at), (totals.get(cellKey(tally.at)) ?? 0) + tally.count);
  return totals;
}

/** How one cell's bars are arranged: a block at the foot of the cell, rows growing upward. */
interface Stack {
  readonly area: Area;
  readonly perRow: number;
  readonly rows: number;
  readonly pitch: number;
  readonly slot: number;
}

function stackOf(frame: Frame, at: PlanCell, total: number): Stack {
  const pad = frame.cell * 0.1;
  const area = {
    x: frame.left + at.column * frame.cell + pad,
    y: frame.top + at.row * frame.cell + pad,
    width: frame.cell - 2 * pad,
    height: frame.cell - 2 * pad,
  };
  // A cell that holds many bars gets wider rows rather than more of them than it has room to stack.
  const perRow = Math.max(BARS_PER_ROW, Math.ceil(total / 8));
  const rows = Math.max(1, Math.ceil(total / perRow));
  return { area, perRow, rows, pitch: Math.min(area.height / rows, frame.cell * 0.2), slot: area.width / perRow };
}

/**
 * The bars of every tally, `tally-<index>-<n>`: small ink rects in a tidy block at the foot of their cell, four to a
 * row, rows growing upward. Several tallies on one cell continue the same stack in the order the picture lists them, so
 * no two bars overlap and a bar never moves when later tallies arrive.
 */
function tallyShapes(picture: PlanPicture, state: PictureState, frame: Frame): PictureShape[] {
  const totals = barsPerCell(picture);
  const filled = new Map<string, number>();
  return picture.tallies.flatMap((tally, index) => {
    const key = cellKey(tally.at);
    const { area, perRow, pitch, slot } = stackOf(frame, tally.at, totals.get(key) ?? 0);
    const start = filled.get(key) ?? 0;
    filled.set(key, start + tally.count);
    const barHeight = pitch * 0.6;
    return Array.from({ length: tally.count }, (_, bar): PictureShape => {
      const position = start + bar;
      return {
        type: 'rect',
        key: `tally-${index}-${bar}`,
        x: area.x + (position % perRow) * slot + slot * 0.07,
        y: area.y + area.height - (Math.floor(position / perRow) + 1) * pitch + (pitch - barHeight) / 2,
        width: slot * 0.86,
        height: barHeight,
        cornerRadius: 0,
        fill: 'ink',
        stroke: 'none',
        strokeWidth: 0,
        opacity: tallyOpacity(state, tally.step),
      };
    });
  });
}

/** Where tally bars can appear: the block each cell's full stack takes, for labels to keep clear of. */
function tallyAreas(picture: PlanPicture, frame: Frame): Area[] {
  return [...barsPerCell(picture)].flatMap(([key, total]) => {
    const [column, row] = key.split('/').map(Number);
    if (column === undefined || row === undefined) return [];
    const { area, perRow, rows, pitch, slot } = stackOf(frame, { column, row }, total);
    const height = rows * pitch;
    return [{ x: area.x, y: area.y + area.height - height, width: Math.min(total, perRow) * slot, height }];
  });
}

// ---- Places -----------------------------------------------------------------------------------------------------

interface Marker {
  readonly shape: PictureShape;
  /** The room the marker takes, lit or not, so labels clear it in every state. */
  readonly area: Area;
}

function around(centre: Point, half: number): Area {
  return { x: centre.x - half, y: centre.y - half, width: 2 * half, height: 2 * half };
}

/** A dot, a block about two thirds of a cell, or a ring with the plate's fill (a pump); lit ones take a `mark` stroke. */
function markerOf(place: Place, state: PictureState, frame: Frame): Marker {
  const centre = centreOf(frame, place.at);
  const lit = isLit(state, place.id);
  const base = {
    key: `place-${place.id}`,
    part: place.id,
    opacity: itemOpacity(state, place.id),
  };
  const tone = toneRole(place.tone);
  if (place.mark === 'dot') {
    const radius = Math.max(2.5, frame.cell * 0.17);
    const drawn = lit ? radius * 1.3 : radius;
    return {
      shape: {
        type: 'circle',
        ...base,
        cx: centre.x,
        cy: centre.y,
        r: drawn,
        fill: tone,
        stroke: lit ? 'mark' : 'none',
        strokeWidth: lit ? 2 : 0,
      },
      area: around(centre, radius * 1.3 + 2),
    };
  }
  if (place.mark === 'block') {
    const side = (frame.cell * 2) / 3;
    return {
      shape: {
        type: 'rect',
        ...base,
        x: centre.x - side / 2,
        y: centre.y - side / 2,
        width: side,
        height: side,
        cornerRadius: Math.min(3, side * 0.12),
        fill: 'raised',
        stroke: lit ? 'mark' : place.tone === undefined ? 'ink2' : tone,
        strokeWidth: lit ? 2.5 : 1.5,
      },
      area: around(centre, side / 2 + 2),
    };
  }
  const radius = frame.cell * 0.27;
  const width = Math.max(2, frame.cell * 0.11);
  return {
    shape: {
      type: 'circle',
      ...base,
      cx: centre.x,
      cy: centre.y,
      r: radius,
      fill: 'raised',
      stroke: lit ? 'mark' : tone,
      strokeWidth: lit ? width + 1 : width,
    },
    area: around(centre, radius + width / 2 + 2),
  };
}

// ---- Label placement --------------------------------------------------------------------------------------------

type Anchor = TextShape['anchor'];

/** One place a label could stand: the room its words take, how it is anchored and what it costs. */
interface Candidate {
  readonly area: Area;
  readonly anchor: Anchor;
  readonly lines: readonly string[];
  readonly cost: number;
}

/** What a label must stay clear of: hard things never, soft things only when nothing else is free. */
interface Context {
  readonly bounds: Area;
  readonly hard: readonly Area[];
  readonly hardSegments: readonly Segment[];
  readonly soft: readonly Area[];
  readonly softSegments: readonly Segment[];
}

const separate = (a: Area, b: Area, pad: number): boolean =>
  a.x + a.width + pad <= b.x ||
  b.x + b.width + pad <= a.x ||
  a.y + a.height + pad <= b.y ||
  b.y + b.height + pad <= a.y;

/** Whether a stroke touches an area, found by walking along it: strokes are straight and short, so this is exact enough. */
function touches(area: Area, segment: Segment): boolean {
  const length = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  const steps = Math.max(1, Math.ceil(length / 2));
  const reach = segment.half + CLEARANCE;
  for (let step = 0; step <= steps; step += 1) {
    const x = segment.from.x + ((segment.to.x - segment.from.x) * step) / steps;
    const y = segment.from.y + ((segment.to.y - segment.from.y) * step) / steps;
    if (x > area.x - reach && x < area.x + area.width + reach && y > area.y - reach && y < area.y + area.height + reach)
      return true;
  }
  return false;
}

const insideBounds = (area: Area, bounds: Area): boolean =>
  area.x >= bounds.x &&
  area.y >= bounds.y &&
  area.x + area.width <= bounds.x + bounds.width &&
  area.y + area.height <= bounds.y + bounds.height;

/** A candidate's cost in a context, or undefined when it breaks a hard rule. */
function costIn(candidate: Candidate, context: Context): number | undefined {
  const { area } = candidate;
  if (!insideBounds(area, context.bounds)) return undefined;
  if (!context.hard.every((other) => separate(area, other, CLEARANCE))) return undefined;
  if (context.hardSegments.some((segment) => touches(area, segment))) return undefined;
  const crossed =
    context.soft.filter((other) => !separate(area, other, 0)).length +
    context.softSegments.filter((segment) => touches(area, segment)).length;
  return candidate.cost + crossed * OVERLAP_COST;
}

/** The cheapest candidate that breaks no hard rule; the earlier one when costs tie. */
function cheapest(candidates: readonly Candidate[], context: Context): Candidate | undefined {
  let best: Candidate | undefined;
  let bestCost = Infinity;
  for (const candidate of candidates) {
    const cost = costIn(candidate, context);
    if (cost !== undefined && cost < bestCost) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

/** The room some lines of text take at a size, measured as bold so a lit label never outgrows its room. */
function measure(lines: readonly string[], size: number): { width: number; height: number } {
  return {
    width: Math.max(0, ...lines.map((line) => textWidth(line, size * BOLD_SLACK))),
    height: lines.length * size * LABEL_LINE_HEIGHT,
  };
}

type Direction = readonly [number, number];
const BESIDE_FIRST: readonly Direction[] = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
];
const ABOVE_FIRST: readonly Direction[] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
  [1, -1],
  [-1, 1],
  [1, 1],
  [-1, -1],
];

/** Candidates touching a point from each side and corner, `gap` away, nearest to the first direction first. */
function aroundPoint(
  point: Point,
  gap: number,
  lines: readonly string[],
  size: number,
  directions: readonly Direction[],
  baseCost: number,
): Candidate[] {
  const { width, height } = measure(lines, size);
  return directions.map(([dx, dy], index) => ({
    area: {
      x: point.x + dx * gap - (dx < 0 ? width : dx === 0 ? width / 2 : 0),
      y: point.y + dy * gap - (dy < 0 ? height : dy === 0 ? height / 2 : 0),
      width,
      height,
    },
    anchor: dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle',
    lines,
    cost: baseCost + index,
  }));
}

/** The label split into one, two or three lines, each wrap as a separate way to stand, dearer the more lines. */
function wrapOptions(text: string, size: number): string[][] {
  const whole = textWidth(text, size * BOLD_SLACK);
  const options = [
    [text],
    wrapText(text, whole * 0.62, size * BOLD_SLACK, 3),
    wrapText(text, whole * 0.45, size * BOLD_SLACK, 3),
  ];
  return options.filter((lines, index) => options.findIndex((other) => other.join('|') === lines.join('|')) === index);
}

/** Every place a place's label could stand at a size, beside its marker first. */
function placeCandidates(marker: Marker, text: string, size: number): Candidate[] {
  const centre = { x: marker.area.x + marker.area.width / 2, y: marker.area.y + marker.area.height / 2 };
  const gap = marker.area.width / 2 + CLEARANCE + 0.5;
  return wrapOptions(text, size).flatMap((lines, index) =>
    aroundPoint(centre, gap, lines, size, BESIDE_FIRST, index * 3),
  );
}

/**
 * Free spots found by scanning the box, nearest to the point first, for a label that has no room beside its marker. A
 * spot further than `reach` from the point is not offered.
 */
function scanCandidates(point: Point, text: string, size: number, bounds: Area, reach: number): Candidate[] {
  const found: Candidate[] = [];
  wrapOptions(text, size).forEach((lines, option) => {
    const { width, height } = measure(lines, size);
    for (let y = bounds.y; y + height <= bounds.y + bounds.height; y += height / 2)
      for (let x = bounds.x; x + width <= bounds.x + bounds.width; x += Math.max(4, width / 4)) {
        const distance = Math.hypot(x + width / 2 - point.x, y + height / 2 - point.y);
        if (distance <= reach)
          found.push({ area: { x, y, width, height }, anchor: 'start', lines, cost: distance / 10 + option * 3 });
      }
  });
  return found;
}

// ---- Putting the labels together ---------------------------------------------------------------------------------

/** The text of the step the state is at (or the last step), with the room it is given in the top-left corner. */
function stepText(picture: PlanPicture, state: PictureState): string | undefined {
  const steps = picture.steps;
  if (steps === undefined || steps.length === 0) return undefined;
  return steps[Math.min(state.step ?? steps.length - 1, steps.length - 1)];
}

/** The corner the step's name may take at a size: its longest, so the room never changes between states. */
function stepArea(picture: PlanPicture, size: number): Area | undefined {
  const longest = Math.max(0, ...(picture.steps ?? []).map((step) => step.length));
  if (longest === 0) return undefined;
  return { x: MARGIN, y: MARGIN, width: longest * size * MONO_ADVANCE, height: size * LABEL_LINE_HEIGHT };
}

/** What the labels are placed among: markers, tally blocks, strokes and the box they must stay inside. */
interface Layers {
  readonly markers: readonly Marker[];
  readonly tallies: readonly Area[];
  readonly ways: readonly Segment[];
  readonly routes: readonly Segment[];
  readonly bounds: Area;
  /** The grid's cell, which is how far from its marker a label may be called near it. */
  readonly cell: number;
}

interface PlaceLabels {
  readonly size: number;
  /** In the order of the picture's places; undefined only for a place with nowhere at all (a degenerate box). */
  readonly chosen: readonly (Candidate | undefined)[];
  readonly complete: boolean;
}

const centreOfArea = (area: Area): Point => ({ x: area.x + area.width / 2, y: area.y + area.height / 2 });

/** How far from its marker a label may stand and still read as its label, in cells; a forced label may go anywhere. */
const NEAR_CELLS = 2.5;

/**
 * Where one place's label goes, trying in turn: beside its marker clear of tallies; a free spot near it clear of
 * tallies; and, when `forced`, the same crossing tallies, then a free spot anywhere, then beside the marker regardless.
 */
function spotFor(
  marker: Marker,
  text: string,
  size: number,
  layers: Layers,
  contexts: { readonly strict: Context; readonly relaxed: Context },
  forced: boolean,
): Candidate | undefined {
  const options = placeCandidates(marker, text, size);
  const centre = centreOfArea(marker.area);
  const near = layers.cell * NEAR_CELLS;
  const strict =
    cheapest(options, contexts.strict) ??
    cheapest(scanCandidates(centre, text, size, layers.bounds, near), contexts.strict);
  if (strict !== undefined || !forced) return strict;
  return (
    cheapest(options, contexts.relaxed) ??
    cheapest(scanCandidates(centre, text, size, layers.bounds, Infinity), contexts.relaxed) ??
    options[0]
  );
}

/** How many spots are left beside a marker, so the most hemmed-in label can be placed first. */
function roomAround(marker: Marker, text: string, size: number, context: Context): number {
  return placeCandidates(marker, text, size).filter((candidate) => costIn(candidate, context) !== undefined).length;
}

/**
 * Every place's label at one size. The most hemmed-in label goes first, so a crowded corner is settled before the easy
 * ones take its room. A label that finds no spot makes the attempt fail so the size can come down, unless `forced`.
 */
function placeAllLabels(picture: PlanPicture, layers: Layers, size: number, forced: boolean): PlaceLabels {
  const corner = stepArea(picture, size);
  const taken: Area[] = [...layers.markers.map((marker) => marker.area), ...(corner === undefined ? [] : [corner])];
  // Tallies are hard in the strict context only; both lists grow as labels are placed.
  const strictTaken = [...taken, ...layers.tallies];
  const softSegments = [...layers.ways, ...layers.routes];
  const strict: Context = { bounds: layers.bounds, hard: strictTaken, hardSegments: [], soft: [], softSegments };
  const relaxed: Context = { bounds: layers.bounds, hard: taken, hardSegments: [], soft: layers.tallies, softSegments };
  const chosen: (Candidate | undefined)[] = picture.places.map(() => undefined);
  const pending = new Set(picture.places.keys());
  while (pending.size > 0) {
    const room = (index: number): number => {
      const place = picture.places[index];
      const marker = layers.markers[index];
      return place === undefined || marker === undefined ? 0 : roomAround(marker, place.label, size, strict);
    };
    const next = [...pending].reduce((best, index) => (room(index) < room(best) ? index : best));
    pending.delete(next);
    const marker = layers.markers[next];
    const place = picture.places[next];
    if (marker === undefined || place === undefined) continue;
    const found = spotFor(marker, place.label, size, layers, { strict, relaxed }, forced);
    if (found === undefined) return { size, chosen, complete: false };
    chosen[next] = found;
    taken.push(found.area);
    strictTaken.push(found.area);
  }
  return { size, chosen, complete: true };
}

/** One size for every place label: the largest up to the reader's own at which all find room near their marker. */
function fitPlaceLabels(picture: PlanPicture, layers: Layers, nominal: number): PlaceLabels {
  for (let size = nominal; size > SMALLEST_LABEL; size -= 0.5) {
    const attempt = placeAllLabels(picture, layers, size, false);
    if (attempt.complete) return attempt;
  }
  const smallest = placeAllLabels(picture, layers, SMALLEST_LABEL, false);
  return smallest.complete ? smallest : placeAllLabels(picture, layers, SMALLEST_LABEL, true);
}

const anchorX = (candidate: Candidate): number =>
  candidate.anchor === 'start'
    ? candidate.area.x
    : candidate.anchor === 'end'
      ? candidate.area.x + candidate.area.width
      : candidate.area.x + candidate.area.width / 2;

/** A label at its candidate: the first baseline a size below the top of its room. */
function labelAt(candidate: Candidate, key: string, part: string, size: number, opacity: number, bold: boolean) {
  return labelShape({
    key,
    part,
    x: anchorX(candidate),
    y: candidate.area.y + size,
    lines: candidate.lines,
    size,
    bold,
    anchor: candidate.anchor,
    opacity,
  });
}

/** A small secondary label (a way's, a route's): regular, in `ink2`. */
const quietLabel = (candidate: Candidate, key: string, part: string, size: number, opacity: number): TextShape => ({
  ...labelAt(candidate, key, part, size, opacity, false),
  fill: 'ink2',
});

/** The step's name in mono, top-left; its room was kept clear in every state. */
function stepShape(picture: PlanPicture, state: PictureState, size: number): TextShape | undefined {
  const text = stepText(picture, state);
  const corner = stepArea(picture, size);
  if (text === undefined || corner === undefined) return undefined;
  return {
    type: 'text',
    key: 'step',
    x: corner.x,
    y: corner.y + size,
    lines: [text],
    size,
    lineHeight: size * LABEL_LINE_HEIGHT,
    weight: 'regular',
    anchor: 'start',
    fill: 'ink2',
    family: 'mono',
    opacity: 1,
  };
}

/** Candidates for a route's label at the middle of the line, then either side of the middle, clear of the line. */
function routeCandidates(ends: { from: Point; to: Point }, text: string, size: number): Candidate[] {
  return [0.5, 0.4, 0.6, 0.3, 0.7].flatMap((along, index) =>
    aroundPoint(
      { x: ends.from.x + (ends.to.x - ends.from.x) * along, y: ends.from.y + (ends.to.y - ends.from.y) * along },
      3,
      [text],
      size,
      ABOVE_FIRST,
      index * 2,
    ),
  );
}

/**
 * Candidates for a way's label: along the way from its start, on one side or the other, horizontal. A horizontal way
 * carries it above or below; a vertical one, to its right or left.
 */
function wayCandidates(from: Point, to: Point, half: number, text: string, size: number): Candidate[] {
  const { width, height } = measure([text], size);
  const horizontal = from.y === to.y;
  const start = horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y);
  const length = horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
  const pace = Math.max(4, size);
  const gap = half + 2;
  const found: Candidate[] = [];
  for (let offset = 0; offset <= length; offset += pace)
    for (const side of [-1, 1]) {
      const cost = offset / pace / 2 + (side > 0 ? 0.25 : 0);
      const x = horizontal ? start + offset : side > 0 ? from.x + gap : from.x - gap - width;
      const y = horizontal ? (side > 0 ? from.y + gap : from.y - gap - height) : start + offset - height / 2;
      found.push({ area: { x, y, width, height }, anchor: 'start', lines: [text], cost });
    }
  return found;
}

/** What a way's or a route's label must stay clear of: what is already placed, and the tally blocks. */
const clearOf = (layers: Layers, placed: readonly Area[]): Area[] => [
  ...layers.markers.map((marker) => marker.area),
  ...placed,
  ...layers.tallies,
];

/**
 * The route labels, each at the middle of its line when it fits, else near it; a route with no room goes without. A
 * label never touches any route line, and it keeps off the ways unless nothing else is free.
 */
function routeLabels(
  picture: PlanPicture,
  state: PictureState,
  frame: Frame,
  layers: Layers,
  placed: Area[],
  size: number,
): TextShape[] {
  return picture.routes.flatMap((route): TextShape[] => {
    const ends = routeEnds(picture, frame, route);
    if (route.label === undefined || ends === undefined) return [];
    const found = cheapest(routeCandidates(ends, route.label, size), {
      bounds: layers.bounds,
      hard: clearOf(layers, placed),
      hardSegments: layers.routes,
      soft: [],
      softSegments: layers.ways,
    });
    if (found === undefined) return [];
    placed.push(found.area);
    return [quietLabel(found, `route-${route.id}-label`, route.id, size, itemOpacity(state, route.id))];
  });
}

/** The way labels, each near the start of its way, off to one side; a way with no clear room goes without a label. */
function wayLabels(
  picture: PlanPicture,
  state: PictureState,
  frame: Frame,
  layers: Layers,
  placed: Area[],
  size: number,
): TextShape[] {
  return picture.ways.flatMap((way, index): TextShape[] => {
    if (way.label === undefined) return [];
    const found = cheapest(
      wayCandidates(centreOf(frame, way.from), centreOf(frame, way.to), wayWidth(frame) / 2, way.label, size),
      {
        bounds: layers.bounds,
        hard: clearOf(layers, placed),
        hardSegments: [...layers.routes, ...layers.ways.filter((_, other) => other !== index)],
        soft: [],
        softSegments: [],
      },
    );
    if (found === undefined) return [];
    placed.push(found.area);
    return [quietLabel(found, `way-${way.id}-label`, way.id, size, itemOpacity(state, way.id))];
  });
}

function segmentsOf(picture: PlanPicture, frame: Frame): { ways: Segment[]; routes: Segment[] } {
  const ways = picture.ways.map((way) => ({
    from: centreOf(frame, way.from),
    to: centreOf(frame, way.to),
    half: wayWidth(frame) / 2,
  }));
  const routes = picture.routes.flatMap((route) => {
    const ends = routeEnds(picture, frame, route);
    return ends === undefined ? [] : [{ ...ends, half: 1 }];
  });
  return { ways, routes };
}

/**
 * Every label of a plan. Place labels come first, at one size shrunk (to 9 px at most) until all stand beside their
 * markers, and are never dropped. Route labels and way labels are secondary: a little smaller, placed in what room is
 * left, and when there is none they are dropped, ways' first (they are placed last, so they are the first to find the
 * room gone) and then routes'. What is dropped is dropped in every state, so the keys of the states stay the same.
 */
function labelShapes(
  picture: PlanPicture,
  state: PictureState,
  frame: Frame,
  box: PictureBox,
  markers: readonly Marker[],
): PictureShape[] {
  const { ways, routes } = segmentsOf(picture, frame);
  const bounds = {
    x: EDGE,
    y: EDGE,
    width: Math.max(0, box.width - 2 * EDGE),
    height: Math.max(0, box.height - 2 * EDGE),
  };
  const layers: Layers = { markers, tallies: tallyAreas(picture, frame), ways, routes, bounds, cell: frame.cell };
  const { size, chosen } = fitPlaceLabels(picture, layers, labelSize(box.height, box.textScale) * 0.9);
  const placed: Area[] = chosen.flatMap((candidate) => (candidate === undefined ? [] : [candidate.area]));
  const corner = stepArea(picture, size);
  if (corner !== undefined) placed.push(corner);
  const places = picture.places.flatMap((place, index): TextShape[] => {
    const candidate = chosen[index];
    if (candidate === undefined) return [];
    return [
      labelAt(
        candidate,
        `place-${place.id}-label`,
        place.id,
        size,
        itemOpacity(state, place.id),
        isLit(state, place.id),
      ),
    ];
  });
  const quiet = Math.max(SMALLEST_LABEL, size * 0.85);
  // Routes before ways: a route's label is meant to sit at the middle of a line the reader follows between places.
  const routeShapesOut = routeLabels(picture, state, frame, layers, placed, quiet);
  const step = stepShape(picture, state, size);
  return [
    ...places,
    ...(step === undefined ? [] : [step]),
    ...routeShapesOut,
    ...wayLabels(picture, state, frame, layers, placed, quiet),
  ];
}

/**
 * Lays a plan out: the grid fits the box in square cells, centred, with no lines drawn (the ground is the plate).
 * From the bottom up: the tinted region (only the state's), the ways, the routes, the places' marks, the tally bars,
 * then the labels, so a label is never covered. A plan is a schematic, so nothing here is to scale.
 */
export function layoutPlan(picture: PlanPicture, state: PictureState, box: PictureBox): PictureScene {
  const frame = gridFrame(picture, box);
  const markers = picture.places.map((place) => markerOf(place, state, frame));
  const shapes: PictureShape[] = [
    ...regionShapes(picture, state, frame),
    ...wayShapes(picture, state, frame),
    ...routeShapes(picture, state, frame),
    ...markers.map((marker) => marker.shape),
    ...tallyShapes(picture, state, frame),
    ...labelShapes(picture, state, frame, box, markers),
  ];
  return { pictureId: picture.id, width: box.width, height: box.height, shapes };
}
