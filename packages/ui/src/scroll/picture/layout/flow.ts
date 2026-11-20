import type { PictureItem, PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureRole, PictureScene, PictureShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import {
  BOLD_SLACK,
  inner,
  isLit,
  isTall,
  itemOpacity,
  LABEL_LINE_HEIGHT,
  labelShape,
  RECEDED,
  toneRole,
} from './common';

type FlowPicture = PictureOfKind<'flow'>;

/** The widest a step in a column is drawn: a long box with a short label reads as a bar, not a step. */
const MAX_COLUMN_WIDTH = 280;
/** The least a label is shrunk to when a long word will not wrap; below this it would stop being text. */
const SMALLEST_LABEL = 6;
/** The room an arrow leaves at each end so its head and tail never touch a box. */
const ARROW_CLEARANCE = 3;
const MAX_ROWS = 3;

/** Where the steps sit: a grid of equal cells, filled in a snake so the arrow between rows is a short drop. */
interface Arrangement {
  readonly rows: number;
  readonly perRow: number;
  readonly cellWidth: number;
  /** The most height one step can have. */
  readonly cellHeight: number;
  readonly gap: number;
}

function arrange(count: number, rows: number, box: PictureBox): Arrangement {
  const room = inner(box);
  const gap = Math.min(22, Math.max(16, room.width * 0.04));
  const perRow = Math.ceil(count / rows);
  const cellWidth = isTall(box) ? Math.min(room.width, MAX_COLUMN_WIDTH) : (room.width - (perRow - 1) * gap) / perRow;
  return { rows, perRow, cellWidth, cellHeight: (room.height - (rows - 1) * gap) / rows, gap };
}

/** The wrapped labels at one size, and whether every one fits a step's text room. */
function wrapAll(steps: readonly PictureItem[], textWidthLimit: number, textHeightLimit: number, size: number) {
  const lines = steps.map((step) => wrapText(step.label, textWidthLimit, size * BOLD_SLACK, 8));
  const fits = lines.every(
    (own) =>
      own.length * size * LABEL_LINE_HEIGHT <= textHeightLimit &&
      own.every((line) => textWidth(line, size * BOLD_SLACK) <= textWidthLimit),
  );
  return { lines, fits };
}

/**
 * One label size for every step, the largest up to the reader's own that wraps every label inside its box: labels wrap
 * first and shrink only when a word will not fit, so large text grows the boxes' words before it shrinks them.
 */
function fitLabels(steps: readonly PictureItem[], arrangement: Arrangement, start: number) {
  let size = start;
  for (; size > SMALLEST_LABEL; size -= 0.5) {
    const padding = Math.max(6, size * 0.5);
    const attempt = wrapAll(steps, arrangement.cellWidth - 2 * padding, arrangement.cellHeight - 2 * size * 0.55, size);
    if (attempt.fits) return { size, lines: attempt.lines };
  }
  const padding = Math.max(6, size * 0.5);
  return {
    size,
    lines: wrapAll(steps, arrangement.cellWidth - 2 * padding, arrangement.cellHeight, size).lines,
  };
}

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The arrangement that lets the labels be largest: a column in a tall box, otherwise one, two or three rows. Ties go to
 * fewer rows, so a few short steps stay in one row and a crowded row opens into several.
 */
function chooseArrangement(steps: readonly PictureItem[], box: PictureBox) {
  const start = labelSize(box.height, box.textScale);
  const options = isTall(box)
    ? [steps.length]
    : Array.from({ length: Math.min(MAX_ROWS, steps.length) }, (_, index) => index + 1);
  return options
    .map((rows) => {
      const arrangement = arrange(steps.length, rows, box);
      return { arrangement, ...fitLabels(steps, arrangement, start) };
    })
    .reduce((best, option) => (option.size > best.size ? option : best));
}

/** The box of every step, in order: left to right along a row, back right to left along the next. */
function stepBoxes(count: number, arrangement: Arrangement, boxHeight: number, box: PictureBox): readonly Cell[] {
  const room = inner(box);
  const { rows, perRow, cellWidth, gap } = arrangement;
  const used = perRow * cellWidth + (perRow - 1) * gap;
  const left = room.x + (room.width - Math.min(used, room.width)) / 2;
  const top = room.y + (room.height - (rows * boxHeight + (rows - 1) * gap)) / 2;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / perRow);
    const across = index % perRow;
    const column = row % 2 === 0 ? across : perRow - 1 - across;
    return {
      x: left + column * (cellWidth + gap),
      y: top + row * (boxHeight + gap),
      width: cellWidth,
      height: boxHeight,
    };
  });
}

/** The height of a step's box: its text and padding at least, in a box wide enough to look like a step. */
function boxHeightFor(lines: readonly (readonly string[])[], size: number, arrangement: Arrangement): number {
  const tallest = Math.max(...lines.map((own) => own.length));
  const needed = tallest * size * LABEL_LINE_HEIGHT + 2 * size * 0.55;
  const preferred = Math.max(size * 3.6, arrangement.cellWidth * 0.7);
  return Math.min(arrangement.cellHeight, Math.max(needed, preferred));
}

/** An arrow from the edge of one box to the facing edge of the next, which is beside it or, after a row's end, below it. */
function arrowBetween(from: Cell, to: Cell): { x1: number; y1: number; x2: number; y2: number } {
  const dropped = to.y > from.y + from.height / 2;
  if (dropped) {
    const x = from.x + from.width / 2;
    return { x1: x, y1: from.y + from.height + ARROW_CLEARANCE, x2: x, y2: to.y - ARROW_CLEARANCE };
  }
  const y = from.y + from.height / 2;
  const rightwards = to.x > from.x;
  return {
    x1: rightwards ? from.x + from.width + ARROW_CLEARANCE : from.x - ARROW_CLEARANCE,
    y1: y,
    x2: rightwards ? to.x - ARROW_CLEARANCE : to.x + to.width + ARROW_CLEARANCE,
    y2: y,
  };
}

/** An arrow strengthens when it touches a lit step, recedes when other steps are lit, and waits until its step is reached. */
function arrowOpacity(state: PictureState, from: PictureItem, to: PictureItem, toIndex: number): number {
  if (state.upTo !== undefined && toIndex >= state.upTo) return 0;
  if (state.lit !== undefined && !isLit(state, from.id) && !isLit(state, to.id)) return RECEDED;
  return 1;
}

function stepShapes(
  step: PictureItem,
  index: number,
  cell: Cell,
  lines: readonly string[],
  size: number,
  state: PictureState,
): PictureShape[] {
  const lit = isLit(state, step.id);
  const opacity = itemOpacity(state, step.id, index);
  const stroke: PictureRole = lit ? 'mark' : toneRole(step.tone);
  const block = lines.length * size * LABEL_LINE_HEIGHT;
  return [
    {
      type: 'rect',
      key: `${step.id}-box`,
      part: step.id,
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      cornerRadius: Math.min(10, cell.height / 4),
      fill: 'raised',
      stroke,
      strokeWidth: lit ? 3 : 1.5,
      opacity,
    },
    labelShape({
      key: `${step.id}-label`,
      part: step.id,
      x: cell.x + cell.width / 2,
      y: cell.y + (cell.height - block) / 2 + size * 0.9,
      lines,
      size,
      bold: lit,
      anchor: 'middle',
      opacity,
    }),
  ];
}

/**
 * Steps in order, an arrow from each to the next. A wide box lays them in a row; a tall one in a column; a row too
 * crowded for readable labels becomes two or three that snake (the next row runs back), so the arrow between rows is a
 * short drop. Every step and arrow is always in the scene, so `upTo` only fades the ones not yet reached and a later
 * state glides them in.
 */
export function layoutFlow(picture: FlowPicture, state: PictureState, box: PictureBox): PictureScene {
  const steps = picture.steps;
  const { arrangement, size, lines } = chooseArrangement(steps, box);
  const cells = stepBoxes(steps.length, arrangement, boxHeightFor(lines, size, arrangement), box);
  const arrows = steps.slice(1).map((step, offset): PictureShape => {
    const from = steps[offset] as PictureItem;
    const touchesLit = isLit(state, from.id) || isLit(state, step.id);
    return {
      type: 'line',
      key: `arrow-${from.id}-${step.id}`,
      part: step.id,
      ...arrowBetween(cells[offset] as Cell, cells[offset + 1] as Cell),
      stroke: touchesLit ? 'ink' : 'ink2',
      strokeWidth: touchesLit ? 2 : 1.5,
      dashed: false,
      arrow: true,
      opacity: arrowOpacity(state, from, step, offset + 1),
    };
  });
  const drawn = steps.flatMap((step, index) =>
    stepShapes(step, index, cells[index] as Cell, lines[index] ?? [], size, state),
  );
  return { pictureId: picture.id, width: box.width, height: box.height, shapes: [...arrows, ...drawn] };
}
