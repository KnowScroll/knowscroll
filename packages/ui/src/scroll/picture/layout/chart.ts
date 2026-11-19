import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import { figureValue } from '../../model';
import type { PictureBox, PictureRole, PictureScene, PictureShape, TextShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import { inner, RECEDED, toneRole } from './common';

type ChartPicture = PictureOfKind<'chart'>;
type Room = ReturnType<typeof inner>;

const MIN_SIZE = 9;
const LINE_HEIGHT = 1.2;
/** Bold text is wider than the estimate, which measures regular text; labels are made room for as if lit. */
const BOLD_WIDTH = 1.08;
/** The room kept between the edge of the box and any label. */
const EDGE = 2;
/** The room kept between two labels on a row. */
const LABEL_GAP = 6;
/** The widest a bar grows, however few there are. */
const MAX_BAR_WIDTH = 64;
const DOT_RADIUS = 3;
/** Between the last mark label and the top of the plot, so a mark's line has some length to it. */
const MARK_DROP = 10;
const MAX_MARK_LINES = 2;

/** A label's place along the row it sits in. */
interface Extent {
  readonly centre: number;
  readonly width: number;
}

const overlaps = (a: Extent, b: Extent): boolean => Math.abs(a.centre - b.centre) < (a.width + b.width) / 2 + LABEL_GAP;

/** The centre nearest `centre` that keeps a label of `width` inside the box. */
function keepInside(centre: number, width: number, boxWidth: number): number {
  if (width >= boxWidth - 2 * EDGE) return boxWidth / 2;
  return Math.min(Math.max(centre, EDGE + width / 2), boxWidth - EDGE - width / 2);
}

/**
 * Which of a row of labels to show so that none overlaps another: every k-th for the smallest k that works, and always
 * those marked `keep`. A kept label that cannot clear another kept label is dropped: two marked neighbours cannot both
 * be kept without overlapping.
 */
function thinLabels(labels: readonly (Extent & { readonly keep: boolean })[]): boolean[] {
  const clear = (shown: readonly boolean[]): boolean =>
    labels.every((a, i) => !shown[i] || labels.every((b, j) => j <= i || !shown[j] || !overlaps(a, b)));
  for (let step = 1; step <= labels.length; step += 1) {
    const shown = labels.map(
      (label, index) =>
        label.keep ||
        (index % step === 0 && !labels.some((other) => other.keep && other !== label && overlaps(label, other))),
    );
    if (clear(shown)) return shown;
  }
  const shown = labels.map(() => false);
  for (const wanted of [true, false])
    labels.forEach((label, index) => {
      if (label.keep === wanted && labels.every((other, j) => !shown[j] || !overlaps(label, other)))
        shown[index] = true;
    });
  return shown;
}

/** The text of a mark placed above the plot, in a tier of its own where it would meet another. */
interface MarkLabel extends Extent {
  readonly point: string;
  readonly index: number;
  readonly lines: readonly string[];
  readonly tier: number;
}

/** Mark labels left to right, each in the first row (from the top) where it clears the ones already there. */
function placeMarks(
  picture: ChartPicture,
  centres: readonly number[],
  size: number,
  room: Room,
  box: PictureBox,
): MarkLabel[] {
  const wrapWidth = Math.max(60, room.width * 0.45);
  const placed: MarkLabel[] = [];
  const marks = picture.marks
    .flatMap((mark) => {
      const index = picture.points.findIndex((point) => point.id === mark.point);
      return index < 0 ? [] : [{ mark, index }];
    })
    .sort((a, b) => a.index - b.index);
  for (const { mark, index } of marks) {
    const lines = wrapText(mark.label, wrapWidth, size, MAX_MARK_LINES);
    const width = Math.max(...lines.map((line) => textWidth(line, size)));
    const extent = { centre: keepInside(centres[index] ?? 0, width, box.width), width };
    let tier = 0;
    while (placed.some((other) => other.tier === tier && overlaps(extent, other))) tier += 1;
    placed.push({ ...extent, point: mark.point, index, lines, tier });
  }
  return placed;
}

/** One value as printed: the figure as the passage writes it, the unit after it and smaller. */
interface ValueLabel extends Extent {
  readonly valueWidth: number;
  readonly unitWidth: number;
  readonly unitGap: number;
}

function valueLabel(
  text: string,
  unit: string | undefined,
  size: number,
  centre: number,
  boxWidth: number,
): ValueLabel {
  // Bold digits are as wide as regular ones, so the estimate stands.
  const valueWidth = textWidth(text, size);
  const unitSize = size * 0.8;
  const unitWidth = unit === undefined ? 0 : textWidth(unit, unitSize);
  const unitGap = unit === undefined ? 0 : /^\p{L}/u.test(unit) ? size * 0.25 : size * 0.06;
  const width = valueWidth + unitGap + unitWidth;
  return { centre: keepInside(centre, width, boxWidth), width, valueWidth, unitWidth, unitGap };
}

/**
 * The numbers as printed, each with its unit after it while the slots are wide enough for that. In a crowded chart the
 * unit would run each label into the next, so it follows only the tallest point's number.
 */
function printedValues(
  picture: ChartPicture,
  centres: readonly number[],
  size: number,
  slot: number,
  tallest: number,
  boxWidth: number,
): ValueLabel[] {
  const labelled = (withUnit: boolean) =>
    picture.points.map((point, index) =>
      valueLabel(point.value, withUnit ? picture.unit : undefined, size, centres[index] ?? 0, boxWidth),
    );
  const full = labelled(true);
  if (Math.max(...full.map((label) => label.width)) <= slot * 1.5) return full;
  const plain = labelled(false);
  return plain.map((label, index) => (index === tallest ? (full[index] ?? label) : label));
}

/** Everything the shapes need, decided once from the data and the box and never from the state. */
interface Plan {
  readonly size: number;
  readonly valueSize: number;
  readonly centres: readonly number[];
  readonly slot: number;
  readonly plotTop: number;
  readonly plotBottom: number;
  readonly dataTop: number;
  readonly low: number;
  readonly high: number;
  readonly numbers: readonly number[];
  readonly xLabels: readonly (Extent | undefined)[];
  readonly valueLabels: readonly (ValueLabel | undefined)[];
  readonly marks: readonly MarkLabel[];
  readonly tierHeight: number;
  readonly markTop: number;
  readonly markBottom: number;
}

/** The value range the scale runs over: bars from 0 to the largest; a line from the least of 0 and the minimum. */
function scaleOf(picture: ChartPicture, numbers: readonly number[]): { low: number; high: number } {
  const low = picture.form === 'line' ? Math.min(0, ...numbers) : 0;
  const high = Math.max(0, ...numbers);
  // A chart of nothing but zeros still has a scale to stand on.
  return { low, high: high > low ? high : low + 1 };
}

/** The plan at one label `size`; `readable` says whether the plot kept enough height. */
function buildPlan(picture: ChartPicture, box: PictureBox, size: number): { plan: Plan; readable: boolean } {
  const room = inner(box);
  const points = picture.points;
  const slot = room.width / points.length;
  const centres = points.map((_, index) => room.x + slot * (index + 0.5));
  const numbers = points.map((point) => figureValue(point.value));
  const markedIds = new Set(picture.marks.map((mark) => mark.point));
  const shown = picture.values === 'shown';
  const valueSize = Math.max(MIN_SIZE, size * 0.9);
  const marks = placeMarks(picture, centres, size, room, box);
  const tiers = marks.reduce((most, mark) => Math.max(most, mark.tier + 1), 0);
  const tierHeight = MAX_MARK_LINES * size * LINE_HEIGHT + 2;
  const markBottom = room.y + tiers * tierHeight;
  const plotTop = markBottom + (tiers > 0 ? MARK_DROP : 0);
  const plotBottom = room.y + room.height - (5 + size * 1.05);
  const xExtents = points.map((point, index) => ({
    centre: keepInside(centres[index] ?? 0, textWidth(point.label, size) * BOLD_WIDTH, box.width),
    width: textWidth(point.label, size) * BOLD_WIDTH,
    keep: markedIds.has(point.id),
  }));
  const xShown = thinLabels(xExtents);
  const tallest = numbers.indexOf(Math.max(...numbers));
  const printed = printedValues(picture, centres, valueSize, slot, tallest, box.width);
  const valueShown = shown
    ? thinLabels(
        printed.map((label, index) => ({
          ...label,
          keep: markedIds.has(points[index]?.id ?? '') || index === tallest,
        })),
      )
    : [];
  const head = shown ? valueSize + 6 + (picture.form === 'line' ? DOT_RADIUS : 0) : 6 + DOT_RADIUS;
  const plan: Plan = {
    size,
    valueSize,
    centres,
    slot,
    plotTop,
    plotBottom,
    dataTop: plotTop + head,
    ...scaleOf(picture, numbers),
    numbers,
    xLabels: xExtents.map((extent, index) => (xShown[index] === true ? extent : undefined)),
    valueLabels: printed.map((label, index) => (valueShown[index] === true ? label : undefined)),
    marks,
    tierHeight,
    markTop: room.y,
    markBottom,
  };
  return { plan, readable: plotBottom - plotTop >= Math.max(44, room.height * 0.4) };
}

/** The biggest label size, down to 9, at which the plot keeps its height. */
function planChart(picture: ChartPicture, box: PictureBox): Plan {
  const start = labelSize(box.height, box.textScale);
  for (let size = start; size > MIN_SIZE; size -= 0.5) {
    const { plan, readable } = buildPlan(picture, box, size);
    if (readable) return plan;
  }
  return buildPlan(picture, box, MIN_SIZE).plan;
}

const yOf = (plan: Plan, value: number): number =>
  plan.plotBottom - ((value - plan.low) / (plan.high - plan.low)) * (plan.plotBottom - plan.dataTop);

/** How strongly point `index` is drawn: 0 past `upTo`, RECEDED when others are lit and it is not. */
function pointOpacity(state: PictureState, id: string, index: number): number {
  if (state.upTo !== undefined && index >= state.upTo) return 0;
  return state.lit !== undefined && !state.lit.includes(id) ? RECEDED : 1;
}

function pointColour(state: PictureState, point: ChartPicture['points'][number]): PictureRole {
  if (state.lit?.includes(point.id) === true) return 'mark';
  return point.tone === undefined ? 'ink2' : toneRole(point.tone);
}

function text(
  fields: Pick<TextShape, 'key' | 'part' | 'x' | 'y' | 'lines' | 'size' | 'anchor' | 'fill' | 'weight' | 'opacity'>,
): TextShape {
  return { type: 'text', lineHeight: fields.size * LINE_HEIGHT, family: 'sans', ...fields };
}

function barShapes(picture: ChartPicture, state: PictureState, plan: Plan): PictureShape[] {
  const width = Math.max(2, Math.min(plan.slot * 0.62, MAX_BAR_WIDTH));
  return picture.points.map((point, index): PictureShape => {
    const top = yOf(plan, plan.numbers[index] ?? 0);
    return {
      type: 'rect',
      key: `${point.id}-bar`,
      part: point.id,
      x: (plan.centres[index] ?? 0) - width / 2,
      y: top,
      width,
      height: plan.plotBottom - top,
      cornerRadius: Math.min(2, width / 2),
      fill: pointColour(state, point),
      stroke: 'none',
      strokeWidth: 0,
      opacity: pointOpacity(state, point.id, index),
    };
  });
}

function lineShapes(picture: ChartPicture, state: PictureState, plan: Plan): PictureShape[] {
  const points = picture.points;
  const lit = (id: string): boolean => state.lit?.includes(id) === true;
  const segments = points.slice(1).map((point, offset): PictureShape => {
    const before = points[offset];
    const both = before !== undefined && lit(before.id) && lit(point.id);
    return {
      type: 'line',
      key: `${before?.id ?? ''}-${point.id}-segment`,
      part: point.id,
      x1: plan.centres[offset] ?? 0,
      y1: yOf(plan, plan.numbers[offset] ?? 0),
      x2: plan.centres[offset + 1] ?? 0,
      y2: yOf(plan, plan.numbers[offset + 1] ?? 0),
      stroke: both ? 'mark' : 'ink2',
      strokeWidth: both ? 3 : 2,
      dashed: false,
      arrow: false,
      opacity: state.upTo !== undefined && offset + 1 >= state.upTo ? 0 : state.lit === undefined || both ? 1 : RECEDED,
    };
  });
  const dots = points.map((point, index): PictureShape => ({
    type: 'circle',
    key: `${point.id}-dot`,
    part: point.id,
    cx: plan.centres[index] ?? 0,
    cy: yOf(plan, plan.numbers[index] ?? 0),
    r: lit(point.id) ? DOT_RADIUS + 1.5 : DOT_RADIUS,
    fill: pointColour(state, point),
    stroke: 'none',
    strokeWidth: 0,
    opacity: pointOpacity(state, point.id, index),
  }));
  return [...segments, ...dots];
}

/** The tick label under each shown point. */
function xLabelShapes(picture: ChartPicture, state: PictureState, plan: Plan): PictureShape[] {
  return picture.points.flatMap((point, index): PictureShape[] => {
    const extent = plan.xLabels[index];
    if (extent === undefined) return [];
    const lit = state.lit?.includes(point.id) === true;
    return [
      text({
        key: `${point.id}-label`,
        part: point.id,
        x: extent.centre,
        y: plan.plotBottom + 5 + plan.size * 0.85,
        lines: [point.label],
        size: plan.size,
        anchor: 'middle',
        fill: lit ? 'mark' : 'ink2',
        weight: lit ? 'bold' : 'regular',
        opacity: pointOpacity(state, point.id, index),
      }),
    ];
  });
}

/** The number above each shown point, with its unit after it. */
function valueShapes(picture: ChartPicture, state: PictureState, plan: Plan): PictureShape[] {
  return picture.points.flatMap((point, index): PictureShape[] => {
    const label = plan.valueLabels[index];
    if (label === undefined) return [];
    const lit = state.lit?.includes(point.id) === true;
    const lift = picture.form === 'line' ? DOT_RADIUS + 3 : 4;
    const y = yOf(plan, plan.numbers[index] ?? 0) - lift;
    const left = label.centre - label.width / 2;
    const opacity = pointOpacity(state, point.id, index);
    const number = text({
      key: `${point.id}-value`,
      part: point.id,
      x: left,
      y,
      lines: [point.value],
      size: plan.valueSize,
      anchor: 'start',
      fill: lit ? 'mark' : 'ink',
      weight: 'bold',
      opacity,
    });
    if (picture.unit === undefined || label.unitWidth === 0) return [number];
    const unit = text({
      key: `${point.id}-unit`,
      part: point.id,
      x: left + label.valueWidth + label.unitGap,
      y,
      lines: [picture.unit],
      size: plan.valueSize * 0.8,
      anchor: 'start',
      fill: 'ink2',
      weight: 'regular',
      opacity,
    });
    return [number, unit];
  });
}

/** A mark's dashed line, from under its label down to the point (and its number, when printed). */
function markLines(picture: ChartPicture, state: PictureState, plan: Plan): PictureShape[] {
  return plan.marks.flatMap((mark): PictureShape[] => {
    const point = picture.points[mark.index];
    if (point === undefined) return [];
    const x = plan.centres[mark.index] ?? 0;
    // A line that would run through a lower mark's label starts below all the labels instead.
    const clear = plan.marks.every(
      (other) => other.tier <= mark.tier || Math.abs(other.centre - x) >= other.width / 2 + 2,
    );
    const start = clear ? plan.markTop + (mark.tier + 1) * plan.tierHeight - 2 : plan.markBottom;
    const reach = yOf(plan, plan.numbers[mark.index] ?? 0) - (picture.form === 'line' ? DOT_RADIUS + 2 : 2);
    const stop = reach - (plan.valueLabels[mark.index] === undefined ? 0 : plan.valueSize + 6);
    return [
      {
        type: 'line',
        key: `mark-${mark.point}-line`,
        part: mark.point,
        x1: x,
        y1: start,
        x2: x,
        y2: Math.max(stop, start + 4),
        stroke: 'ink2',
        strokeWidth: 1,
        dashed: true,
        arrow: false,
        opacity: pointOpacity(state, point.id, mark.index),
      },
    ];
  });
}

/** A mark's words, above the plot. */
function markLabels(picture: ChartPicture, state: PictureState, plan: Plan): PictureShape[] {
  return plan.marks.map((mark) =>
    text({
      key: `mark-${mark.point}`,
      part: mark.point,
      x: mark.centre,
      y: plan.markTop + mark.tier * plan.tierHeight + plan.size * 0.85,
      lines: mark.lines,
      size: plan.size,
      anchor: 'middle',
      fill: 'ink',
      weight: 'regular',
      opacity: pointOpacity(state, mark.point, mark.index),
    }),
  );
}

function baselineShape(plan: Plan, box: PictureBox): PictureShape {
  const y = yOf(plan, 0);
  return {
    type: 'line',
    key: 'baseline',
    x1: EDGE + 10,
    y1: y,
    x2: box.width - EDGE - 10,
    y2: y,
    stroke: 'rule',
    strokeWidth: 1.5,
    dashed: false,
    arrow: false,
    opacity: 1,
  };
}

/**
 * Lays out a chart: bars standing on a zero baseline, or a line of dots joined by segments, one slot to a point. The
 * scale is code's (bars from 0 to the largest value, a line from the least of 0 and the minimum), and a figure is
 * printed above a point only when `values` is `shown`. Labels under the points thin to every k-th so none overlaps;
 * the labels of marked points stay. A mark is a dashed line from its label above the plot down to its point. Points
 * past `upTo` keep their place at opacity 0, lit points take `mark` and the rest recede. The geometry is decided from
 * the data and the box alone, so a state only fades things in and out.
 */
export function layoutChart(picture: ChartPicture, state: PictureState, box: PictureBox): PictureScene {
  const plan = planChart(picture, box);
  const data = picture.form === 'bars' ? barShapes(picture, state, plan) : lineShapes(picture, state, plan);
  return {
    pictureId: picture.id,
    width: box.width,
    height: box.height,
    shapes: [
      baselineShape(plan, box),
      ...markLines(picture, state, plan),
      ...data,
      ...xLabelShapes(picture, state, plan),
      ...valueShapes(picture, state, plan),
      ...markLabels(picture, state, plan),
    ],
  };
}
