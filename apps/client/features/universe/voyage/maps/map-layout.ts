import { borderWidth, type Breakpoint } from '@knowscroll/design-tokens';
import type { ChartedCell, Loop } from '@knowscroll/scene-core';
import { centreOfCell, oneCopy, type BandPoint } from '../region-centre';
import { BAND_HEIGHT, BAND_WIDTH } from '../world-texture';

/**
 * Where the two maps of a planet put things: the pure arithmetic, so the screens only draw. Every number named
 * here is a layout point (`Size`, the drawing's pixels) or a band unit (`Box`, the world's own 480 by 360), and each
 * says which.
 */

/** A size in layout points. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rectangle of the band, in band units. `x` may be negative or run past the band's width: the band wraps. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The whole band: what the map of a planet shows. */
export const WHOLE_BAND: Box = { x: 0, y: 0, width: BAND_WIDTH, height: BAND_HEIGHT };

/** A phone or a tablet is one column, at most this wide (`SimpleUniverse` keeps the same column). */
export const PHONE_COLUMN = 640;
/** The list beside the drawing from 1024 px. */
export const LIST_WIDTH = 360;
/** The space round the content, and between the two desktop columns. */
export const GUTTER = 16;
export const DESKTOP_GUTTER = 24;
/** What the header of a desktop column takes before it has been measured: the Back chip, the kicker, a title of one line. */
export const HEADER_ALLOWANCE = 150;
/** The space between the header and the drawing's card in a column. */
export const STACK_GAP = 16;
/** The card round the drawing is this much wider and taller than it, for its two borders. */
export const FRAME = 2 * borderWidth.regular;
/** The band is 4:3. */
export const BAND_ASPECT = BAND_WIDTH / BAND_HEIGHT;

/** How many columns a screen of this breakpoint has: the product's own 1024 px (`useDisplay`) decides. */
export const columnsFor = (breakpoint: Breakpoint): 1 | 2 => (breakpoint === 'desktop' ? 2 : 1);

/** The largest size of this aspect (width over height) that fits in a box of `available` points. */
export function fitBox(available: Size, aspect: number): Size {
  const width = Math.max(0, Math.min(available.width, available.height * aspect));
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}

/** What a map screen needs of the window to lay itself out. */
export interface MapLayout {
  readonly columns: 1 | 2;
  /** The drawing's size. */
  readonly drawing: Size;
  /** The width of the list column beside the drawing, or null when the list runs under it at the drawing's width. */
  readonly listWidth: number | null;
}

/**
 * The drawing's size in a window of `available` points. One column: the width of the screen less its gutters, at most
 * {@link PHONE_COLUMN}, and as tall as the aspect says. Two columns: the list takes {@link LIST_WIDTH} and the drawing
 * fits what is left, to the height as well as the width, so on a desktop the whole map is in view with its header;
 * `headerHeight` is what that header measured (a title may take two lines), or a guess until it has.
 */
export function layoutOf(
  available: Size,
  columns: 1 | 2,
  aspect: number = BAND_ASPECT,
  headerHeight: number = HEADER_ALLOWANCE,
): MapLayout {
  if (columns === 1) {
    const width = Math.max(0, Math.min(available.width - 2 * GUTTER - FRAME, PHONE_COLUMN));
    return { columns, drawing: { width: Math.floor(width), height: Math.floor(width / aspect) }, listWidth: null };
  }
  const room = {
    width: available.width - LIST_WIDTH - DESKTOP_GUTTER * 3 - FRAME,
    height: available.height - 2 * DESKTOP_GUTTER - headerHeight - STACK_GAP - FRAME,
  };
  return { columns, drawing: fitBox(room, aspect), listWidth: LIST_WIDTH };
}

const bounds = (loops: readonly Loop[]): { minX: number; minY: number; maxX: number; maxY: number } | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops)
    for (let at = 0; at < loop.length; at += 2) {
      minX = Math.min(minX, loop[at]!);
      maxX = Math.max(maxX, loop[at]!);
      minY = Math.min(minY, loop[at + 1]!);
      maxY = Math.max(maxY, loop[at + 1]!);
    }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
};

/** The room round a region in its own map, as a share of its longer side, and the least the box is wide. */
const CROP_MARGIN = 0.32;
const CROP_LEAST_WIDTH = 150;

/**
 * The part of the band a region's own map shows: the region with room round it, at the drawing's aspect. The generator
 * draws land a little past both edges of the band, so a region by the seam has two copies a whole turn apart; the box
 * is round the one nearest its label ({@link oneCopy}), so it is whole and its `x` may be below 0 or past the band's
 * width. The band is drawn once either side of the middle one ({@link copiesOf}) so what lies beyond the seam is land
 * too. A region with no land to find (an empty cell) gets the whole band.
 */
export function cropOf(cell: ChartedCell, aspect: number = BAND_ASPECT): Box {
  const own = bounds(oneCopy(cell.loops, cell.label.x, BAND_WIDTH));
  if (own === null) return WHOLE_BAND;
  const across = own.maxX - own.minX;
  const down = own.maxY - own.minY;
  const margin = Math.max(across, down) * CROP_MARGIN;
  let width = Math.max(across + 2 * margin, CROP_LEAST_WIDTH);
  let height = Math.max(down + 2 * margin, CROP_LEAST_WIDTH / aspect);
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  // Never more than one turn across or the whole band's height: the aspect follows.
  if (height > BAND_HEIGHT) {
    height = BAND_HEIGHT;
    width = height * aspect;
  }
  if (width > BAND_WIDTH) {
    width = BAND_WIDTH;
    height = width / aspect;
  }
  const middleX = (own.minX + own.maxX) / 2;
  const middleY = (own.minY + own.maxY) / 2;
  return {
    x: middleX - width / 2,
    y: Math.min(Math.max(0, middleY - height / 2), BAND_HEIGHT - height),
    width,
    height,
  };
}

/**
 * The turns of the band to draw so `box` is all land and sea: the copies a whole turn to the left and right of the
 * middle one, for as far as the box reaches past 0 or the band's width. `[0]` for the whole band.
 */
export function copiesOf(box: Box): readonly number[] {
  const first = Math.floor(box.x / BAND_WIDTH);
  const last = Math.ceil((box.x + box.width) / BAND_WIDTH) - 1;
  return Array.from({ length: last - first + 1 }, (_, at) => first + at);
}

/** Where one turn of the band is drawn: it owns the box from `left` to `right`, in band units (`left` may be negative). */
export interface CopyClip {
  readonly turn: number;
  readonly left: number;
  readonly right: number;
}

/**
 * How the turns of the band share `box` between them, for a drawing that shows it `scale` points to the band unit. Each
 * turn is clipped to its own stretch, and the stretches meet exactly on a whole point of the drawing, so no pixel is
 * half in one clip and half in the next: that is what leaves a hairline of the layer below along a seam (or a double
 * layer of the see-through ones, if the clips overlapped). A turn's land runs 60 units past its own band, so the meeting
 * point may be anywhere within 60 units of the band's edge; it is the whole point nearest the edge.
 */
export function clipsOf(box: Box, scale: number): readonly CopyClip[] {
  const turns = copiesOf(box);
  const seam = (turn: number): number => box.x + Math.round((turn * BAND_WIDTH - box.x) * scale) / scale;
  return turns.map((turn, at) => ({
    turn,
    left: at === 0 ? box.x : seam(turn),
    right: at === turns.length - 1 ? box.x + box.width : seam(turn + 1),
  }));
}

/** Where a point of the band is on a drawing of `size` points that shows `box`. */
export function pointOnScreen(point: BandPoint, box: Box, size: Size): BandPoint {
  return { x: ((point.x - box.x) * size.width) / box.width, y: ((point.y - box.y) * size.height) / box.height };
}

/** Where a region is named: the centre of its name in band units, which region it is and the name's size. */
export interface NameSpot extends BandPoint {
  readonly objectId: string;
  /** The name's width and height in band units. */
  readonly width: number;
  readonly height: number;
}

/** Where the names go on the whole band, and where the "you were here" dot goes. */
export interface NamePlan {
  readonly names: readonly NameSpot[];
  /** The centre of the dot, for the region left through Open; null when there is none (or it has not formed). */
  readonly marker: BandPoint | null;
}

/** A letter of the display type is about this wide, as a share of its size. */
const LETTER = 0.55;
/** The name's box is this much taller than its type. */
const LINE = 1.15;

/** A box on the band: its centre and its size. */
interface Block extends BandPoint {
  readonly width: number;
  readonly height: number;
}

const overlaps = (a: Block, b: Block): boolean =>
  Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2;

const wrapped = (x: number): number => ((x % BAND_WIDTH) + BAND_WIDTH) % BAND_WIDTH;

/**
 * Where each formed region's name goes on the whole band, for names `fontUnits` band units tall: at the region's
 * point ({@link centreOfCell}), or else at the generator's own label point, which it keeps apart from every other;
 * kept inside the band's edges. A name that has no free place is left out here and stays in the list under the map
 * (a name never sits on another's). The order is the cells' (site order), so the same regions are named the same way
 * every time and an earlier region never loses its name to a later one.
 *
 * The region left through Open (`here`) wears a dot of `here.markerUnits` across, just above its name. The dot and the
 * name are one block, placed first so the others make way for it: the dot never covers a neighbour's name and a
 * neighbour never lands on it. A neighbour that no longer fits loses its name to the list, never the other way round.
 */
export function nameSpots(
  cells: readonly ChartedCell[],
  names: ReadonlyMap<string, string>,
  fontUnits: number,
  here?: { readonly objectId: string; readonly markerUnits: number },
): NamePlan {
  const placed: Block[] = [];
  const spots: NameSpot[] = [];
  let marker: BandPoint | null = null;
  // The region you were here comes first, so its dot and name have the whole band to choose from and the others make way.
  const order = [...cells].sort(
    (a, b) => Number(b.objectId === here?.objectId) - Number(a.objectId === here?.objectId),
  );
  for (const cell of order) {
    const text = names.get(cell.objectId) ?? '';
    const wears = here?.objectId === cell.objectId;
    if (text === '' && !wears) continue;
    const dot = wears ? here.markerUnits : 0;
    const nameWidth = text.length * fontUnits * LETTER;
    const nameHeight = text === '' ? 0 : fontUnits * LINE;
    // The block: the dot (if any) over the name, as wide as the wider of the two.
    const width = Math.max(nameWidth, dot);
    const centre = centreOfCell(cell, BAND_WIDTH);
    const candidates: BandPoint[] = [{ x: wrapped(centre.x), y: centre.y }, cell.label];
    /** The first of the region's two points where a block this size touches no other. */
    const freeBlock = (blockWidth: number, blockHeight: number): Block | undefined =>
      candidates
        .map((point): Block => ({
          x: Math.min(BAND_WIDTH - blockWidth / 2, Math.max(blockWidth / 2, point.x)),
          y: Math.min(BAND_HEIGHT - blockHeight / 2, Math.max(blockHeight / 2, point.y)),
          width: blockWidth,
          height: blockHeight,
        }))
        .find((candidate) => !placed.some((other) => overlaps(candidate, other)));
    const block = freeBlock(width, dot + nameHeight);
    if (block !== undefined) {
      placed.push(block);
      if (nameHeight > 0)
        spots.push({ objectId: cell.objectId, x: block.x, y: block.y + dot / 2, width: nameWidth, height: nameHeight });
      if (wears) marker = { x: block.x, y: block.y - nameHeight / 2 };
    }
  }
  return { names: spots, marker };
}
