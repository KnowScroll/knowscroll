import { CONSTELLATION_POINTS } from '@knowscroll/client-core';
import { ROOM_SWATCHES, type RoomSwatch } from '@knowscroll/contracts';
import type { PixelImage } from '../texture-data';

const SIZE = 128;
const CREAM = [255, 251, 240] as const;
const DEFAULT_ACCENT = [255, 228, 77] as const;

const channels = (hex: string): readonly [number, number, number] => {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
};

const luminance = ([red, green, blue]: readonly [number, number, number]): number =>
  (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

/** The kit's accent when it can be seen on the dark map, cream when it cannot; yellow for a room with no face. */
export function starColour(accent: RoomSwatch | undefined): readonly [number, number, number] {
  if (accent === undefined) return DEFAULT_ACCENT;
  const colour = channels(ROOM_SWATCHES[accent]);
  return luminance(colour) < 0.3 ? CREAM : colour;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** The distance from a point to a segment. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const along = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + along * dx), py - (ay + along * dy));
}

const cache = new Map<string, PixelImage>();

/**
 * A station's constellation as pixels (RGBA, the first row at the top): the lit stars as flat discs in the room's accent,
 * straight thin lines between neighbouring lit stars, and the stars not yet earned as small hollow rings in cream. Flat
 * shapes only: no glow, no halo, no sparkle (D-090). Pure and memoised, so the same sky is the same picture everywhere.
 */
export function rasterConstellation(lit: number, accent: RoomSwatch | undefined): PixelImage {
  const key = `${String(lit)}|${accent ?? ''}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const star = starColour(accent);
  const points = CONSTELLATION_POINTS.map(([x, y]) => [x * SIZE, y * SIZE] as const);
  const data = new Uint8Array(SIZE * SIZE * 4);
  const discRadius = SIZE * 0.045;
  const ringRadius = SIZE * 0.03;
  const lineHalf = SIZE * 0.008;
  for (let row = 0; row < SIZE; row += 1)
    for (let column = 0; column < SIZE; column += 1) {
      const x = column + 0.5;
      const y = row + 0.5;
      let colour: readonly [number, number, number] = star;
      let alpha = 0;
      for (let index = 0; index < points.length; index += 1) {
        const [cx, cy] = points[index]!;
        const distance = Math.hypot(x - cx, y - cy);
        if (index < lit) {
          const cover = clamp(discRadius + 0.5 - distance);
          if (cover > alpha) {
            alpha = cover;
            colour = star;
          }
          if (index > 0) {
            const [ax, ay] = points[index - 1]!;
            const line = clamp(lineHalf + 0.5 - distanceToSegment(x, y, ax, ay, cx, cy)) * 0.8;
            if (line > alpha) {
              alpha = line;
              colour = star;
            }
          }
        } else {
          const ring = clamp(1 - Math.abs(distance - ringRadius)) * 0.55;
          if (ring > alpha) {
            alpha = ring;
            colour = CREAM;
          }
        }
      }
      if (alpha > 0) {
        const at = (row * SIZE + column) * 4;
        data[at] = colour[0];
        data[at + 1] = colour[1];
        data[at + 2] = colour[2];
        data[at + 3] = Math.round(alpha * 255);
      }
    }
  const image = { data, width: SIZE, height: SIZE };
  cache.set(key, image);
  return image;
}

/** The same picture turned over for a texture, whose first row is its bottom. */
export function constellationImage(lit: number, accent: RoomSwatch | undefined): PixelImage {
  const { data, width, height } = rasterConstellation(lit, accent);
  const upright = new Uint8Array(data.length);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1)
    upright.set(data.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride);
  return { data: upright, width, height };
}
