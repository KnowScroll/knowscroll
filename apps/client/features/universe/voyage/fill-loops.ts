import type { Loop } from '@knowscroll/scene-core';

/**
 * A small scanline painter for the outlines a world is made of. Plain typed arrays: there is no canvas
 * under Hermes. Every function draws into a straight-alpha RGBA `PixelTarget`, row 0 at the top, and
 * maps world units to pixels by the `scale` it is given.
 */

/** An RGBA image, four bytes a pixel, row by row. Straight (not premultiplied) alpha. */
export interface PixelTarget {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Red, green and blue as 0..255, alpha as 0..1. */
export type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

export interface DrawOptions {
  /** Pixels for one world unit, across and down. Default 1 and 1. */
  readonly scale?: { readonly x: number; readonly y: number };
  /**
   * A world that repeats every `wrapWidth` units across. Everything is also drawn shifted a whole
   * turn either way, so a shape over the seam shows at both edges. Overlaps are drawn once.
   */
  readonly wrapWidth?: number;
  /** Paint only where this mask (one byte a pixel, row by row) is not zero. */
  readonly clip?: Uint8Array;
}

export interface FillOptions extends DrawOptions {
  /**
   * `false` (default): all loops make one shape under the even-odd rule, so a loop inside another is a hole.
   * `true`: every loop is a solid shape of its own and the shapes add up, like the lobes of a cloud.
   */
  readonly union?: boolean;
}

export interface StrokeOptions extends DrawOptions {
  /** Line width in pixels. */
  readonly width: number;
}

/** Per pixel row, the covered stretches as `from, to` pairs: `from` is the first pixel, `to` is one past the last. */
type Rows = number[][];

const UNIT_SCALE = { x: 1, y: 1 } as const;

/** The whole turns to draw a group of loops at: none unless it comes near the edges of the target. */
function shiftsOf(loops: readonly Loop[], target: PixelTarget, options: DrawOptions): readonly number[] {
  const { wrapWidth } = options;
  if (wrapWidth === undefined) return [0];
  const scaleX = (options.scale ?? UNIT_SCALE).x;
  let low = Infinity;
  let high = -Infinity;
  for (const loop of loops)
    for (let at = 0; at < loop.length; at += 2) {
      low = Math.min(low, loop[at]!);
      high = Math.max(high, loop[at]!);
    }
  return [0, -wrapWidth, wrapWidth].filter(
    (shift) => shift === 0 || ((low + shift) * scaleX < target.width && (high + shift) * scaleX > 0),
  );
}

/** Where the edges of some loops cross each pixel row's middle: a flat list of x for every row they touch. */
function crossingsOf(loops: readonly Loop[], shift: number, target: PixelTarget, scale: { x: number; y: number }) {
  const crossings: (number[] | undefined)[] = new Array<number[] | undefined>(target.height);
  for (const loop of loops) {
    const count = loop.length / 2;
    for (let point = 0; point < count; point++) {
      const next = (point + 1) % count;
      let fromX = (loop[point * 2]! + shift) * scale.x;
      let fromY = loop[point * 2 + 1]! * scale.y;
      let toX = (loop[next * 2]! + shift) * scale.x;
      let toY = loop[next * 2 + 1]! * scale.y;
      if (fromY === toY) continue;
      if (fromY > toY) [fromX, fromY, toX, toY] = [toX, toY, fromX, fromY];
      const slope = (toX - fromX) / (toY - fromY);
      const last = Math.min(target.height, Math.ceil(toY - 0.5));
      for (let row = Math.max(0, Math.ceil(fromY - 0.5)); row < last; row++)
        (crossings[row] ??= []).push(fromX + (row + 0.5 - fromY) * slope);
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

/** The pixels that an even-odd shape of these loops covers, added to `rows`. */
function addShape(rows: Rows, loops: readonly Loop[], target: PixelTarget, options: DrawOptions): void {
  const scale = options.scale ?? UNIT_SCALE;
  for (const shift of shiftsOf(loops, target, options)) {
    const crossings = crossingsOf(loops, shift, target, scale);
    for (let row = 0; row < target.height; row++) {
      const xs = crossings[row];
      if (xs === undefined) continue;
      xs.sort((one, other) => one - other);
      for (let at = 0; at + 1 < xs.length; at += 2) {
        const from = Math.max(0, Math.ceil(xs[at]! - 0.5));
        const to = Math.min(target.width, Math.ceil(xs[at + 1]! - 0.5));
        if (to > from) (rows[row] ??= []).push(from, to);
      }
    }
  }
}

function coverShapes(shapes: readonly (readonly Loop[])[], target: PixelTarget, options: DrawOptions): Rows {
  const rows: Rows = new Array<number[]>(target.height);
  for (const shape of shapes) addShape(rows, shape, target, options);
  return rows.map((pairs) => (pairs.length > 2 ? mergeStretches(pairs) : pairs));
}

const shapesOf = (loops: readonly Loop[], options: FillOptions): readonly (readonly Loop[])[] =>
  options.union ? loops.map((loop) => [loop]) : [loops];

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
 * leave no crack. A pixel is inside when its centre is.
 */
export function fillShapes(
  target: PixelTarget,
  shapes: readonly (readonly Loop[])[],
  colour: Rgba,
  options: DrawOptions = {},
): void {
  const rows = coverShapes(shapes, target, options);
  const { clip } = options;
  for (let row = 0; row < target.height; row++) {
    const pairs = rows[row];
    if (pairs === undefined) continue;
    for (let at = 0; at < pairs.length; at += 2)
      for (let column = pairs[at]!; column < pairs[at + 1]!; column++)
        if (clip === undefined || clip[row * target.width + column] !== 0)
          blendPixel(target.data, (row * target.width + column) * 4, colour, 1);
  }
}

/**
 * Paints the area inside `loops` (a loop is `x, y, x, y, …` in world units) with the even-odd rule,
 * or as a union of solid shapes with `union`. A pixel is inside when its centre is.
 */
export function fillLoops(target: PixelTarget, loops: readonly Loop[], colour: Rgba, options: FillOptions = {}): void {
  fillShapes(target, shapesOf(loops, options), colour, options);
}

/** A mask, one byte a pixel, that is 1 inside the shapes (as `fillShapes` fills them) and 0 elsewhere. */
export function maskShapes(
  target: PixelTarget,
  shapes: readonly (readonly Loop[])[],
  options: DrawOptions = {},
): Uint8Array {
  const mask = new Uint8Array(target.width * target.height);
  coverShapes(shapes, target, options).forEach((pairs, row) => {
    for (let at = 0; at < pairs.length; at += 2)
      mask.fill(1, row * target.width + pairs[at]!, row * target.width + pairs[at + 1]!);
  });
  return mask;
}

/** A mask, one byte a pixel, that is 1 inside `loops` (as `fillLoops` fills them) and 0 elsewhere. */
export function maskLoops(target: PixelTarget, loops: readonly Loop[], options: FillOptions = {}): Uint8Array {
  return maskShapes(target, shapesOf(loops, options), options);
}

/** Stamps a soft-edged disc into a coverage layer, keeping the strongest cover where discs meet. */
function stampDisc(cover: Uint8Array, target: PixelTarget, centreX: number, centreY: number, radius: number): void {
  const reach = radius + 1;
  const lastRow = Math.min(target.height - 1, Math.floor(centreY + reach));
  const lastColumn = Math.min(target.width - 1, Math.floor(centreX + reach));
  for (let row = Math.max(0, Math.ceil(centreY - reach)); row <= lastRow; row++)
    for (let column = Math.max(0, Math.ceil(centreX - reach)); column <= lastColumn; column++) {
      const distance = Math.hypot(column + 0.5 - centreX, row + 0.5 - centreY);
      const level = Math.round(Math.max(0, Math.min(1, radius + 0.5 - distance)) * 255);
      const at = row * target.width + column;
      if (level > cover[at]!) cover[at] = level;
    }
}

/** Walks one edge in half-pixel steps, stamping a disc at each. */
function stampEdge(cover: Uint8Array, target: PixelTarget, edge: readonly number[], radius: number): void {
  const [fromX, fromY, toX, toY] = edge as [number, number, number, number];
  if (Math.max(fromX, toX) < -radius || Math.min(fromX, toX) > target.width + radius) return;
  const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toY - fromY) * 2));
  for (let step = 0; step <= steps; step++)
    stampDisc(cover, target, fromX + ((toX - fromX) * step) / steps, fromY + ((toY - fromY) * step) / steps, radius);
}

/**
 * How much of each pixel a line `options.width` pixels wide along the edges of every loop covers, 0 to
 * 255, with soft edges and round joins. Where the line crosses itself it is counted once.
 */
export function strokeCover(target: PixelTarget, loops: readonly Loop[], options: StrokeOptions): Uint8Array {
  const scale = options.scale ?? UNIT_SCALE;
  const cover = new Uint8Array(target.width * target.height);
  for (const shift of shiftsOf(loops, target, options))
    for (const loop of loops) {
      const count = loop.length / 2;
      for (let point = 0; point < count; point++) {
        const next = (point + 1) % count;
        const edge = [
          (loop[point * 2]! + shift) * scale.x,
          loop[point * 2 + 1]! * scale.y,
          (loop[next * 2]! + shift) * scale.x,
          loop[next * 2 + 1]! * scale.y,
        ];
        stampEdge(cover, target, edge, options.width / 2);
      }
    }
  return cover;
}

/**
 * Draws the outline of every loop as a line `options.width` pixels wide with soft edges and round
 * joins. Where the line crosses itself it is laid once, so a see-through colour does not darken there.
 */
export function strokeLoops(target: PixelTarget, loops: readonly Loop[], colour: Rgba, options: StrokeOptions): void {
  const cover = strokeCover(target, loops, options);
  for (let at = 0; at < cover.length; at++)
    if (cover[at] !== 0 && (options.clip === undefined || options.clip[at] !== 0))
      blendPixel(target.data, at * 4, colour, cover[at]! / 255);
}
