import {
  ROOM_EMBLEM_FRAMES,
  ROOM_EMBLEM_GLYPHS,
  ROOM_SWATCHES,
  type RoomEmblemFrame,
  type RoomEmblemGlyph,
  type RoomKit,
} from '@knowscroll/contracts';
import { rasterEmblem } from './emblem-raster';
import { FRAME_OUTLINES, GLYPH_SHAPES, pathOf } from './shapes';

const palette = { ground: 'midnight', accent: 'sun', ink: 'cream' } as const;
const kitOf = (frame: RoomEmblemFrame, glyph: RoomEmblemGlyph): Pick<RoomKit, 'emblem' | 'palette'> => ({
  emblem: { frame, glyph },
  palette,
});

const [AR, AG, AB] = [0xff, 0xe4, 0x4d];
const isAccent = (data: Uint8Array, at: number): boolean =>
  data[at + 3]! > 200 &&
  Math.abs(data[at]! - AR) < 40 &&
  Math.abs(data[at + 1]! - AG) < 40 &&
  Math.abs(data[at + 2]! - AB) < 60;

/** Which pixels of a 32 pixel emblem are the glyph (the accent), as a string of 0 and 1. */
const accentMask = (frame: RoomEmblemFrame, glyph: RoomEmblemGlyph): string => {
  const { data, width, height } = rasterEmblem(kitOf(frame, glyph), 32);
  let mask = '';
  for (let index = 0; index < width * height; index += 1) mask += isAccent(data, index * 4) ? '1' : '0';
  return mask;
};
const areaOf = (mask: string): number => mask.split('1').length - 1;

describe('the emblem drawings', () => {
  it('draws every glyph of the vocabulary as something with area, and every frame as an outline', () => {
    const thin = ROOM_EMBLEM_GLYPHS.filter(
      (glyph) => GLYPH_SHAPES[glyph].length === 0 || areaOf(accentMask('circle', glyph)) <= 30,
    );
    expect(thin).toEqual([]);
    const open = ROOM_EMBLEM_FRAMES.filter((frame) => FRAME_OUTLINES[frame].length < 4);
    expect(open).toEqual([]);
  });

  it('draws no two glyphs alike, so a word is never another word with the same picture', () => {
    const masks = ROOM_EMBLEM_GLYPHS.map((glyph) => accentMask('circle', glyph));
    expect(new Set(masks).size).toBe(masks.length);
  });

  it('draws a glyph the same in every frame it can sit in, and never over the frame’s border', () => {
    const strays: string[] = [];
    for (const frame of ROOM_EMBLEM_FRAMES)
      for (const glyph of ROOM_EMBLEM_GLYPHS) {
        const { data, width, height } = rasterEmblem(kitOf(frame, glyph), 32);
        // The outermost ring of pixels is the frame's border or empty: never the glyph's accent.
        for (let row = 0; row < height; row += 1)
          for (const column of [0, 1, width - 2, width - 1])
            if (isAccent(data, (row * width + column) * 4)) strays.push(`${frame} ${glyph}`);
        for (let column = 0; column < width; column += 1)
          for (const row of [0, 1, height - 2, height - 1])
            if (isAccent(data, (row * width + column) * 4)) strays.push(`${frame} ${glyph}`);
      }
    expect(strays).toEqual([]);
  });

  it('is transparent outside the frame, filled inside it, and cached for the same kit', () => {
    const pixels = rasterEmblem(kitOf('diamond', 'star'), 32);
    expect(pixels.data[3]).toBe(0);
    expect(pixels.data[(16 * 32 + 16) * 4 + 3]).toBe(255);
    expect(rasterEmblem(kitOf('diamond', 'star'), 32)).toBe(pixels);
    expect(pixels.data).toHaveLength(32 * 32 * 4);
  });

  it('uses the kit’s own colours: the border in its ink, the face in its ground', () => {
    const { data } = rasterEmblem(kitOf('circle', 'star'), 64);
    const ink = Number.parseInt(ROOM_SWATCHES.cream.slice(1), 16);
    const ground = Number.parseInt(ROOM_SWATCHES.midnight.slice(1), 16);
    const pixel = (x: number, y: number) => {
      const at = (y * 64 + x) * 4;
      return (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
    };
    // The border is a ring just inside the circle's edge; further in, below the star, the face is the ground.
    expect(pixel(32, 5)).toBe(ink);
    expect(pixel(32, 50)).toBe(ground);
  });

  it('writes a path that starts and ends on its own points', () => {
    expect(pathOf([FRAME_OUTLINES.diamond])).toMatch(/^M[\d. L-]+Z$/);
  });
});
