import type { Loop } from '@knowscroll/scene-core';

/**
 * A small scanline painter for the outlines a world is made of: fills, strokes and masks of loops
 * (`x, y, x, y, …` in world units) into plain RGBA arrays. It exists because the planet's texture is
 * painted on the phone and there is no canvas under Hermes; everything here is typed arrays, so the
 * same bytes come out in Jest, in the browser and on the device. `world-texture.ts` is its only
 * caller. Every function draws into a straight-alpha RGBA `PixelTarget`, row 0 at the top, and maps
 * world units to pixels by the `scale` it is given. A pixel is inside a shape when its centre is.
 *
 * It must not import `three`: it is reached from the main bundle.
 */

/** An RGBA image, four bytes a pixel, row by row. Straight (not premultiplied) alpha. */
export interface PixelTarget {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Red, green and blue as 0..255, alpha as 0..1. */
export type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

/** Pixel rows from `from` up to (not including) `to`: the part of a picture one call draws. */
export interface RowRange {
  readonly from: number;
  readonly to: number;
}

/** What every drawing function takes: how world units map to pixels, and which part of the target to touch. */
export interface DrawOptions {
  /** Pixels for one world unit, across and down. Default 1 and 1. */
  readonly scale?: { readonly x: number; readonly y: number };
  /** Paint only where this mask (one byte a pixel, row by row) is not zero. */
  readonly clip?: Uint8Array;
  /**
   * Draw only these pixel rows. A picture drawn in row ranges, one call each, has the same bytes as
   * one drawn whole, so the work can be spread over frames.
   */
  readonly rows?: RowRange;
}

/** `DrawOptions` for a mask. */
export interface MaskOptions extends DrawOptions {
  /** The mask to write into (one byte a pixel for the whole target), so ranges of rows can fill one mask. */
  readonly into?: Uint8Array;
}

/** `DrawOptions` for a line. */
export interface StrokeOptions extends DrawOptions {
  /** Line width in pixels. */
  readonly width: number;
}

/** Per pixel row, the covered stretches as `from, to` pairs: `from` is the first pixel, `to` is one past the last. */
type Spans = number[][];

/** One edge of a loop, in pixels: where it starts and where it ends. */
type Edge = readonly [fromX: number, fromY: number, toX: number, toY: number];

const UNIT_SCALE = { x: 1, y: 1 } as const;

/** The pixel rows a call draws: all of the target unless `options.rows` narrows them. */
function rowRangeOf(target: PixelTarget, options: DrawOptions): RowRange {
  return {
    from: Math.max(0, options.rows?.from ?? 0),
    to: Math.min(target.height, options.rows?.to ?? target.height),
  };
}

/** Where the edges of some loops cross the middle of each pixel row of the range: a flat list of x for every row they touch. */
function crossingsOf(loops: readonly Loop[], range: RowRange, scale: { x: number; y: number }) {
  const crossings: (number[] | undefined)[] = new Array<number[] | undefined>(Math.max(0, range.to - range.from));
  for (const loop of loops) {
    const count = loop.length / 2;
    for (let point = 0; point < count; point++) {
      const next = (point + 1) % count;
      let fromX = loop[point * 2]! * scale.x;
      let fromY = loop[point * 2 + 1]! * scale.y;
      let toX = loop[next * 2]! * scale.x;
      let toY = loop[next * 2 + 1]! * scale.y;
      if (fromY === toY) continue;
      if (fromY > toY) [fromX, fromY, toX, toY] = [toX, toY, fromX, fromY];
      const slope = (toX - fromX) / (toY - fromY);
      const last = Math.min(range.to, Math.ceil(toY - 0.5));
      for (let row = Math.max(range.from, Math.ceil(fromY - 0.5)); row < last; row++)
        (crossings[row - range.from] ??= []).push(fromX + (row + 0.5 - fromY) * slope);
    }
  }
  return crossings;
}

/** Joins stretches that touch or overlap, so a pixel is never painted twice by one call. */
function mergeStretches(pairs: readonly number[]): number[] {
  const stretches: [number, number][] = [];
  for (let at = 0; at < pairs.length; at += 2) stretches.push([pairs[at]!, pairs[at + 1]!]);
  stretches.sort((one, other) => one[0] - other[0]);
  const merged: number[] = [];
  for (const [from, to] of stretches) {
    if (merged.length > 0 && from <= merged[merged.length - 1]!) {
      merged[merged.length - 1] = Math.max(merged[merged.length - 1]!, to);
    } else merged.push(from, to);
  }
  return merged;
}

/** The pixels that an even-odd shape of these loops covers, added to `spans`. */
function addShape(spans: Spans, loops: readonly Loop[], target: PixelTarget, options: DrawOptions): void {
  const scale = options.scale ?? UNIT_SCALE;
  const range = rowRangeOf(target, options);
  const crossings = crossingsOf(loops, range, scale);
  for (let row = range.from; row < range.to; row++) {
    const xs = crossings[row - range.from];
    if (xs === undefined) continue;
    xs.sort((one, other) => one - other);
    for (let at = 0; at + 1 < xs.length; at += 2) {
      const from = Math.max(0, Math.ceil(xs[at]! - 0.5));
      const to = Math.min(target.width, Math.ceil(xs[at + 1]! - 0.5));
      if (to > from) (spans[row] ??= []).push(from, to);
    }
  }
}

/** The stretches the shapes cover, each shape even-odd by itself and the shapes added up (overlaps merged). */
function coverShapes(shapes: readonly (readonly Loop[])[], target: PixelTarget, options: DrawOptions): Spans {
  const spans: Spans = new Array<number[]>(target.height);
  for (const shape of shapes) addShape(spans, shape, target, options);
  return spans.map((pairs) => (pairs.length > 2 ? mergeStretches(pairs) : pairs));
}

/** One pixel of `colour` laid "over" what is there. */
function blendPixel(data: Uint8Array, at: number, colour: Rgba, strength: number): void {
  const alpha = colour[3] * strength;
  const below = data[at + 3]! / 255;
  const out = alpha + below * (1 - alpha);
  if (out <= 0) return;
  for (let channel = 0; channel < 3; channel++)
    data[at + channel] = Math.round((colour[channel]! * alpha + data[at + channel]! * below * (1 - alpha)) / out);
  data[at + 3] = Math.round(out * 255);
}

/**
 * Paints the area inside each shape, a shape being the loops of one piece of land: even-odd within a
 * shape, so a loop inside another is a hole, and the shapes added up, so two that overlap by a sliver
 * leave no crack that even-odd over all the loops would cut. Used for land, whose cells overlap.
 */
export function fillShapes(
  target: PixelTarget,
  shapes: readonly (readonly Loop[])[],
  colour: Rgba,
  options: DrawOptions = {},
): void {
  const spans = coverShapes(shapes, target, options);
  const { clip } = options;
  const range = rowRangeOf(target, options);
  for (let row = range.from; row < range.to; row++) {
    const pairs = spans[row];
    if (pairs === undefined) continue;
    for (let at = 0; at < pairs.length; at += 2)
      for (let column = pairs[at]!; column < pairs[at + 1]!; column++)
        if (clip === undefined || clip[row * target.width + column] !== 0)
          blendPixel(target.data, (row * target.width + column) * 4, colour, 1);
  }
}

/**
 * Paints the area inside `loops` as one shape, with the even-odd rule: it is how the SVG globe fills
 * a path (`fillRule="evenodd"`), so the texture matches it where land has lakes and highlands have holes.
 */
export function fillLoops(target: PixelTarget, loops: readonly Loop[], colour: Rgba, options: DrawOptions = {}): void {
  fillShapes(target, [loops], colour, options);
}

/**
 * A mask, one byte a pixel, that is 1 inside the shapes (as `fillShapes` fills them) and 0 elsewhere.
 * Later layers are kept to it with `clip`.
 */
export function maskShapes(
  target: PixelTarget,
  shapes: readonly (readonly Loop[])[],
  options: MaskOptions = {},
): Uint8Array {
  const mask = options.into ?? new Uint8Array(target.width * target.height);
  coverShapes(shapes, target, options).forEach((pairs, row) => {
    for (let at = 0; at < pairs.length; at += 2)
      mask.fill(1, row * target.width + pairs[at]!, row * target.width + pairs[at + 1]!);
  });
  return mask;
}

/** Stamps a soft-edged disc into a coverage layer of the range's rows, keeping the strongest cover where discs meet. */
function stampDisc(
  cover: Uint8Array,
  target: PixelTarget,
  range: RowRange,
  centre: { readonly x: number; readonly y: number },
  radius: number,
): void {
  const reach = radius + 1;
  const lastRow = Math.min(range.to - 1, Math.floor(centre.y + reach));
  const lastColumn = Math.min(target.width - 1, Math.floor(centre.x + reach));
  for (let row = Math.max(range.from, Math.ceil(centre.y - reach)); row <= lastRow; row++)
    for (let column = Math.max(0, Math.ceil(centre.x - reach)); column <= lastColumn; column++) {
      const distance = Math.hypot(column + 0.5 - centre.x, row + 0.5 - centre.y);
      const level = Math.round(Math.max(0, Math.min(1, radius + 0.5 - distance)) * 255);
      const at = (row - range.from) * target.width + column;
      if (level > cover[at]!) cover[at] = level;
    }
}

/** Walks one edge in half-pixel steps, stamping a disc at each; an edge nowhere near the range is skipped. */
function stampEdge(cover: Uint8Array, target: PixelTarget, range: RowRange, edge: Edge, radius: number): void {
  const [fromX, fromY, toX, toY] = edge;
  if (Math.max(fromX, toX) < -radius || Math.min(fromX, toX) > target.width + radius) return;
  if (Math.max(fromY, toY) < range.from - radius - 1 || Math.min(fromY, toY) > range.to + radius + 1) return;
  const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toY - fromY) * 2));
  for (let step = 0; step <= steps; step++)
    stampDisc(
      cover,
      target,
      range,
      { x: fromX + ((toX - fromX) * step) / steps, y: fromY + ((toY - fromY) * step) / steps },
      radius,
    );
}

/**
 * How much of each pixel a line `options.width` pixels wide along the edges of every loop covers, 0 to
 * 255, with soft edges and round joins. Where the line crosses itself it is counted once. Only the rows
 * of `options.rows` (all, by default) are covered, and the result holds just those rows: the pixel at
 * row `r`, column `c` is at `(r - from) * width + c`, `from` being the first row of the range. Kept
 * apart from `strokeLoops` so a caller can also use the coverage as a mask (the coast's reach).
 */
export function strokeCover(target: PixelTarget, loops: readonly Loop[], options: StrokeOptions): Uint8Array {
  const scale = options.scale ?? UNIT_SCALE;
  const range = rowRangeOf(target, options);
  const cover = new Uint8Array(Math.max(0, range.to - range.from) * target.width);
  for (const loop of loops) {
    const count = loop.length / 2;
    for (let point = 0; point < count; point++) {
      const next = (point + 1) % count;
      const edge: Edge = [
        loop[point * 2]! * scale.x,
        loop[point * 2 + 1]! * scale.y,
        loop[next * 2]! * scale.x,
        loop[next * 2 + 1]! * scale.y,
      ];
      stampEdge(cover, target, range, edge, options.width / 2);
    }
  }
  return cover;
}

/**
 * Draws the outline of every loop as a line `options.width` pixels wide with soft edges and round
 * joins, as the SVG globe's `strokeLinejoin="round"` strokes. Where the line crosses itself it is laid
 * once, so a see-through colour does not darken there.
 */
export function strokeLoops(target: PixelTarget, loops: readonly Loop[], colour: Rgba, options: StrokeOptions): void {
  const cover = strokeCover(target, loops, options);
  const first = rowRangeOf(target, options).from * target.width;
  for (let at = 0; at < cover.length; at++)
    if (cover[at] !== 0 && (options.clip === undefined || options.clip[first + at] !== 0))
      blendPixel(target.data, (first + at) * 4, colour, cover[at]! / 255);
}
