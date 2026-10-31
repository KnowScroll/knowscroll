import { ROOM_SWATCHES, type RoomKit } from '@knowscroll/contracts';
import { FRAME_OUTLINES, GLYPH_SHAPES, innerOutline, type Point } from './shapes';

/** An emblem as pixels, for the station on the map: RGBA bytes, row by row, transparent outside the frame. */
export interface EmblemPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const GRID = 24;
const SAMPLES = 2;

/** The winding number of the outlines about a point: zero outside, non-zero inside, and a hole where outlines wind apart. */
function winding(x: number, y: number, contours: readonly (readonly Point[])[]): number {
  let total = 0;
  for (const points of contours)
    for (let index = 0; index < points.length; index += 1) {
      const [x1, y1] = points[index]!;
      const [x2, y2] = points[(index + 1) % points.length]!;
      const side = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
      if (y1 <= y) {
        if (y2 > y && side > 0) total += 1;
      } else if (y2 <= y && side < 0) total -= 1;
    }
  return total;
}

const channels = (hex: string): readonly [number, number, number] => {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
};

const cache = new Map<string, EmblemPixels>();

/**
 * Draws a kit's emblem: the frame in the kit's ink with its face in the ground, and the glyph over it in the accent
 * (a `cut` of the glyph in the ground). Each pixel averages a few samples, so the edges are soft. The same description
 * draws the SVG emblem on screens, so the map and the room show one thing. Memoised by the emblem and palette.
 */
export function rasterEmblem(kit: Pick<RoomKit, 'emblem' | 'palette'>, size = 64): EmblemPixels {
  const key = `${kit.emblem.frame}|${kit.emblem.glyph}|${kit.palette.ground}|${kit.palette.accent}|${kit.palette.ink}|${String(size)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const ground = channels(ROOM_SWATCHES[kit.palette.ground]);
  const accent = channels(ROOM_SWATCHES[kit.palette.accent]);
  const ink = channels(ROOM_SWATCHES[kit.palette.ink]);
  const outline = FRAME_OUTLINES[kit.emblem.frame];
  const face = [innerOutline(outline)];
  const glyph = GLYPH_SHAPES[kit.emblem.glyph];
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1)
    for (let column = 0; column < size; column += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1)
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = ((column + (sx + 0.5) / SAMPLES) / size) * GRID;
          const y = ((row + (sy + 0.5) / SAMPLES) / size) * GRID;
          if (winding(x, y, [outline]) === 0) continue;
          let colour = winding(x, y, face) === 0 ? ink : ground;
          for (const shape of glyph)
            if (winding(x, y, shape.contours) !== 0) colour = shape.role === 'mark' ? accent : ground;
          red += colour[0];
          green += colour[1];
          blue += colour[2];
          covered += 1;
        }
      const at = (row * size + column) * 4;
      if (covered > 0) {
        data[at] = Math.round(red / covered);
        data[at + 1] = Math.round(green / covered);
        data[at + 2] = Math.round(blue / covered);
        data[at + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
      }
    }
  const pixels = { width: size, height: size, data };
  cache.set(key, pixels);
  return pixels;
}
