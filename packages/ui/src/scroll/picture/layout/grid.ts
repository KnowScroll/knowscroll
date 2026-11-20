import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, PictureShape, TextShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import { inner, RECEDED, toneRole } from './common';

type GridPicture = PictureOfKind<'grid'>;
type GridCell = GridPicture['cells'][number];
type Room = ReturnType<typeof inner>;

/** The space between cells, in pixels. */
const GAP = 6;
/** The room between a row label beside its row and the cells. */
const LABEL_GAP = 10;
/** Below this a cell is too narrow to read, so row labels move above their rows instead of beside them. */
const MIN_CELL_WIDTH = 60;
/** The smallest text a grid draws, as `labelSize` allows. */
const MIN_SIZE = 9;
const LINE_HEIGHT = 1.2;
const PAD_X = 6;
const PAD_Y = 4;
/** Bold text is wider than the estimate, which measures regular text. */
const BOLD_WIDTH = 1.08;
/** How much bigger a large cell's text is than a small cell's, at most and at least. */
const LARGE_MAX = 1.9;
const LARGE_MIN = 1.25;
/** The tallest a row of cells grows, so a one-row grid does not become one slab. */
const MAX_CELL_HEIGHT = 120;

/** The lines of `text` if they fit `width` and `maxLines` whole, else undefined. */
function wholeLines(text: string, width: number, size: number, maxLines: number): string[] | undefined {
  if (maxLines < 1) return undefined;
  // One line more than allowed is asked for, so a text that needs it is seen to overflow rather than cut short.
  const lines = wrapText(text, width, size, maxLines + 1);
  if (lines.length > maxLines) return undefined;
  return lines.every((line) => textWidth(line, size) <= width) ? lines : undefined;
}

/** What the headings and cells are measured against once a heading size is chosen. */
interface Frame {
  readonly size: number;
  readonly beside: boolean;
  /** Whether every heading fits whole and the cells are wide and tall enough to read. */
  readonly readable: boolean;
  readonly columnX: number;
  readonly columnWidth: number;
  readonly cellHeight: number;
  readonly headerHeight: number;
  /** The height of a row's label when it sits above the row; 0 when it sits beside. */
  readonly rowLabelHeight: number;
  readonly top: number;
  readonly columnLines: readonly (readonly string[])[];
  readonly rowLines: readonly (readonly string[])[];
}

/** The width a column of row labels needs: one line if short, else the least width that wraps to two. */
function rowLabelWidth(labels: readonly string[], size: number, room: Room): number {
  const cap = room.width * 0.36;
  const wanted = labels.map((label) => {
    const oneLine = textWidth(label, size);
    if (oneLine <= room.width * 0.22) return oneLine;
    const longestWord = Math.max(...label.split(/\s+/u).map((word) => textWidth(word, size)));
    for (let width = longestWord; width < oneLine; width += 2)
      if (wholeLines(label, width, size, 2) !== undefined) return width;
    return oneLine;
  });
  return Math.min(cap, Math.ceil(Math.max(...wanted)) + 1);
}

/** Every label wrapped to `width`, and whether each one fit whole (not cut short, no word wider than the line). */
function wrapAll(
  labels: readonly string[],
  width: number,
  size: number,
  maxLines: number,
): { lines: string[][]; whole: boolean } {
  const whole = labels.map((label) => wholeLines(label, width, size, maxLines));
  return {
    lines: labels.map((label, index) => whole[index] ?? wrapText(label, width, size, maxLines)),
    whole: whole.every((lines) => lines !== undefined),
  };
}

/**
 * The headings and the room left for cells at a heading `size`, row labels beside the rows or above them. A frame says
 * whether it is `readable`: headings whole, cells not squeezed under `MIN_CELL_WIDTH` or too short for a line of text.
 */
function buildFrame(picture: GridPicture, room: Room, textScale: number, size: number, beside: boolean): Frame {
  const { rows, columns } = picture;
  const lead = beside
    ? rowLabelWidth(
        rows.map((row) => row.label),
        size,
        room,
      ) + LABEL_GAP
    : 0;
  const columnWidth = Math.max(4, (room.width - lead - (columns.length - 1) * GAP) / columns.length);
  const columnHeadings = wrapAll(
    columns.map((column) => column.label),
    columnWidth,
    size,
    2,
  );
  const rowHeadings = wrapAll(
    rows.map((row) => row.label),
    Math.max(4, beside ? lead - LABEL_GAP : room.width),
    size,
    2,
  );
  const mostRowLines = Math.max(...rowHeadings.lines.map((lines) => lines.length));
  const headerHeight = Math.max(...columnHeadings.lines.map((lines) => lines.length)) * size * LINE_HEIGHT + 2;
  const rowLabelHeight = beside ? 0 : mostRowLines * size * LINE_HEIGHT + 2;
  const free = room.height - headerHeight - GAP - rows.length * rowLabelHeight - (rows.length - 1) * GAP;
  const cellHeight = Math.max(0, Math.min(free / rows.length, MAX_CELL_HEIGHT * Math.max(1, textScale)));
  const content = headerHeight + GAP + rows.length * (rowLabelHeight + cellHeight) + (rows.length - 1) * GAP;
  const tallEnough =
    cellHeight >= MIN_SIZE * LINE_HEIGHT + 2 * PAD_Y && (!beside || mostRowLines * size * LINE_HEIGHT <= cellHeight);
  return {
    size,
    beside,
    readable: columnHeadings.whole && rowHeadings.whole && tallEnough && columnWidth >= MIN_CELL_WIDTH,
    columnX: room.x + lead,
    columnWidth,
    cellHeight,
    headerHeight,
    rowLabelHeight,
    top: room.y + Math.max(0, (room.height - content) / 2),
    columnLines: columnHeadings.lines,
    rowLines: rowHeadings.lines,
  };
}

/** One cell's text as it will be drawn. */
interface CellText {
  readonly size: number;
  readonly lines: readonly string[];
}

/** Whether a cell's text fits whole at `size` in the cell. */
function cellLines(cell: GridCell, frame: Frame, size: number, weight: number): readonly string[] | undefined {
  const width = (frame.columnWidth - 2 * PAD_X) / weight;
  const lines = Math.floor((frame.cellHeight - 2 * PAD_Y) / (size * LINE_HEIGHT));
  return wholeLines(cell.text, width, size, lines);
}

/** The largest size in [LARGE_MIN, LARGE_MAX] times `small` at which a large cell's text fits, if any. */
function fitLarge(cell: GridCell, frame: Frame, small: number): CellText | undefined {
  for (let size = small * LARGE_MAX; size >= small * LARGE_MIN; size -= 0.5) {
    const lines = cellLines(cell, frame, size, BOLD_WIDTH);
    if (lines !== undefined) return { size, lines };
  }
  return undefined;
}

/** Every cell's text at the biggest small size that lets all of them fit, large ones outweighing the rest. */
function fitCells(picture: GridPicture, frame: Frame, textScale: number): Map<string, CellText> | undefined {
  const start = Math.min(Math.max(1.3 * frame.size, frame.cellHeight * 0.2), 20 * textScale);
  const floor = Math.max(MIN_SIZE, 0.85 * frame.size);
  for (let small = start; small >= floor; small -= 0.5) {
    const texts = new Map<string, CellText>();
    const fitted = picture.cells.every((cell) => {
      const text =
        cell.size === 'large'
          ? fitLarge(cell, frame, small)
          : { size: small, lines: cellLines(cell, frame, small, 1) ?? [] };
      if (text === undefined || text.lines.length === 0) return false;
      texts.set(cell.id, text);
      return true;
    });
    if (fitted) return texts;
  }
  return undefined;
}

/** The last resort when nothing fits whole: the smallest text, cut short with an ellipsis where it must be. */
function forcedCells(picture: GridPicture, frame: Frame): Map<string, CellText> {
  return new Map(
    picture.cells.map((cell) => {
      const size = cell.size === 'large' ? MIN_SIZE * LARGE_MIN : MIN_SIZE;
      const width = (frame.columnWidth - 2 * PAD_X) / (cell.size === 'large' ? BOLD_WIDTH : 1);
      const lines = Math.max(1, Math.floor((frame.cellHeight - 2 * PAD_Y) / (size * LINE_HEIGHT)));
      return [cell.id, { size, lines: wrapText(cell.text, width, size, lines) }];
    }),
  );
}

/** The biggest heading size, and the cell text with it, at which the whole grid fits the room. */
function planGrid(picture: GridPicture, room: Room, box: PictureBox): { frame: Frame; texts: Map<string, CellText> } {
  const start = labelSize(box.height, box.textScale);
  for (let size = start; size >= MIN_SIZE; size -= 0.5)
    for (const beside of [true, false]) {
      const frame = buildFrame(picture, room, box.textScale, size, beside);
      const texts = frame.readable ? fitCells(picture, frame, box.textScale) : undefined;
      if (texts !== undefined) return { frame, texts };
    }
  // Nothing fits whole: the smallest text, row labels above the rows where the columns would be narrowest.
  const frame = buildFrame(picture, room, box.textScale, MIN_SIZE, false);
  return { frame, texts: forcedCells(picture, frame) };
}

/** How strongly an item is drawn: 0 when its row is past `upTo`, RECEDED when others are lit and it is not. */
function opacityOf(state: PictureState, row: number, active: boolean): number {
  if (state.upTo !== undefined && row >= state.upTo) return 0;
  return state.lit !== undefined && !active ? RECEDED : 1;
}

function textShape(
  fields: Pick<TextShape, 'key' | 'part' | 'x' | 'y' | 'lines' | 'size' | 'anchor' | 'fill' | 'weight' | 'opacity'>,
): TextShape {
  return { type: 'text', lineHeight: fields.size * LINE_HEIGHT, family: 'sans', ...fields };
}

/** The first baseline of `count` lines of `size` centred on `middle`. */
const centredBaseline = (middle: number, count: number, size: number): number =>
  middle - ((count - 1) * size * LINE_HEIGHT) / 2 + size * 0.35;

interface Lit {
  readonly rows: ReadonlySet<string>;
  readonly columns: ReadonlySet<string>;
  readonly cells: ReadonlySet<string>;
  /** Rows and columns that a lit cell sits in: named, not stressed. */
  readonly rowsOfCells: ReadonlySet<string>;
  readonly columnsOfCells: ReadonlySet<string>;
}

function litParts(picture: GridPicture, state: PictureState): Lit {
  const ids = new Set(state.lit ?? []);
  const lit = picture.cells.filter((cell) => ids.has(cell.id));
  return {
    rows: new Set(picture.rows.filter((row) => ids.has(row.id)).map((row) => row.id)),
    columns: new Set(picture.columns.filter((column) => ids.has(column.id)).map((column) => column.id)),
    cells: ids,
    rowsOfCells: new Set(lit.map((cell) => cell.row)),
    columnsOfCells: new Set(lit.map((cell) => cell.column)),
  };
}

function columnHeadings(picture: GridPicture, state: PictureState, frame: Frame, lit: Lit): PictureShape[] {
  const bottom = frame.top + frame.headerHeight;
  return picture.columns.map((column, index) => {
    const lines = frame.columnLines[index] ?? [];
    const stressed = lit.columns.has(column.id);
    const active = stressed || lit.columnsOfCells.has(column.id);
    return textShape({
      key: `column-${column.id}`,
      part: column.id,
      x: frame.columnX + index * (frame.columnWidth + GAP) + frame.columnWidth / 2,
      y: bottom - 2 - (lines.length - 1) * frame.size * LINE_HEIGHT - frame.size * 0.25,
      lines,
      size: frame.size,
      anchor: 'middle',
      fill: stressed ? 'mark' : 'ink2',
      weight: stressed ? 'bold' : 'regular',
      opacity: opacityOf(state, 0, active),
    });
  });
}

/** Where row `index` starts, and where its cells do. */
function rowTops(frame: Frame, index: number): { band: number; cells: number } {
  const band = frame.top + frame.headerHeight + GAP + index * (frame.rowLabelHeight + frame.cellHeight + GAP);
  return { band, cells: band + frame.rowLabelHeight };
}

function rowHeadings(picture: GridPicture, state: PictureState, frame: Frame, room: Room, lit: Lit): PictureShape[] {
  return picture.rows.map((row, index) => {
    const lines = frame.rowLines[index] ?? [];
    const stressed = lit.rows.has(row.id);
    const top = rowTops(frame, index);
    const y = frame.beside
      ? centredBaseline(top.cells + frame.cellHeight / 2, lines.length, frame.size)
      : top.band + frame.size * 0.9;
    return textShape({
      key: `row-${row.id}`,
      part: row.id,
      x: room.x,
      y,
      lines,
      size: frame.size,
      anchor: 'start',
      fill: stressed ? 'mark' : 'ink2',
      weight: stressed ? 'bold' : 'regular',
      opacity: opacityOf(state, index, stressed || lit.rowsOfCells.has(row.id)),
    });
  });
}

/** A cell: its rectangle, then its text. A lit cell (or one in a lit row or column) gets the `mark` stroke, thicker. */
function cellShapes(
  cell: GridCell,
  geometry: { x: number; y: number; row: number },
  frame: Frame,
  text: CellText,
  state: PictureState,
  lit: Lit,
): PictureShape[] {
  const stressed = lit.cells.has(cell.id) || lit.rows.has(cell.row) || lit.columns.has(cell.column);
  const large = cell.size === 'large';
  const opacity = opacityOf(state, geometry.row, stressed);
  const toned = cell.tone !== undefined;
  const strokeWidth = (large ? 2.5 : toned ? 1.5 : 1) + (stressed ? 1.5 : 0);
  // A plain cell's border is `ink2`, not `rule`: the hairline role is under 3:1 on the dark plate, and the border is
  // what shows where a cell is.
  return [
    {
      type: 'rect',
      key: `cell-${cell.id}`,
      part: cell.id,
      x: geometry.x,
      y: geometry.y,
      width: frame.columnWidth,
      height: frame.cellHeight,
      cornerRadius: 6,
      fill: 'raised',
      stroke: stressed ? 'mark' : toned ? toneRole(cell.tone) : large ? 'ink' : 'ink2',
      strokeWidth,
      opacity,
    },
    textShape({
      key: `cell-${cell.id}-text`,
      part: cell.id,
      x: geometry.x + frame.columnWidth / 2,
      y: centredBaseline(geometry.y + frame.cellHeight / 2, text.lines.length, text.size),
      lines: text.lines,
      size: text.size,
      anchor: 'middle',
      // A large cell is the point of the grid, so it carries its tone in the words too.
      fill: large ? toneRole(cell.tone) : 'ink',
      weight: large ? 'bold' : 'regular',
      opacity,
    }),
  ];
}

/**
 * Lays out a grid: column headings across the top, row headings down the left (or above each row where the cells would
 * be squeezed under about 60 px), and the cells between, each a rectangle with its words centred. A large cell's words
 * are bigger and bold and its stroke heavier. Rows past `upTo` keep their place at opacity 0; lit cells, rows and
 * columns take the `mark` stroke and the rest recede. Geometry never depends on the state, so a glide only fades.
 */
export function layoutGrid(picture: GridPicture, state: PictureState, box: PictureBox): PictureScene {
  const room = inner(box);
  const { frame, texts } = planGrid(picture, room, box);
  const lit = litParts(picture, state);
  const rowIndex = new Map(picture.rows.map((row, index) => [row.id, index]));
  const columnIndex = new Map(picture.columns.map((column, index) => [column.id, index]));
  const cells = picture.cells.flatMap((cell): PictureShape[] => {
    const row = rowIndex.get(cell.row);
    const column = columnIndex.get(cell.column);
    const text = texts.get(cell.id);
    if (row === undefined || column === undefined || text === undefined) return [];
    const x = frame.columnX + column * (frame.columnWidth + GAP);
    return cellShapes(cell, { x, y: rowTops(frame, row).cells, row }, frame, text, state, lit);
  });
  return {
    pictureId: picture.id,
    width: box.width,
    height: box.height,
    shapes: [...columnHeadings(picture, state, frame, lit), ...rowHeadings(picture, state, frame, room, lit), ...cells],
  };
}
