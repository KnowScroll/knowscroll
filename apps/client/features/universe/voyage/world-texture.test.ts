import { createHash } from 'node:crypto';
import { buildGlobe, chartWorld, type Chart, type GlobeWorld, type Loop, type WorldSpec } from '@knowscroll/scene-core';
import { paletteOf } from '../planet/planet-palette';
import { fillLoops, maskShapes, strokeLoops, type PixelTarget } from './fill-loops';
import {
  BAND_HEIGHT,
  BAND_UNITS_PER_RADIAN,
  BAND_WIDTH,
  createWorldPainter,
  groundGreyOf,
  labelPoints,
  latitudeOfBandY,
  worldLookOf,
  type WorldTexture,
  type WorldTextureInput,
} from './world-texture';
import { centreOfCell } from './region-centre';

const WIDTH = 512;
const HEIGHT = 256;
/** A synthetic CI seed: 32 hex characters, as a descriptor's seed is. */
const SPEC: WorldSpec = { seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 12 };
const FORMED = [0, 2, 3, 5, 8];

const world: GlobeWorld = buildGlobe(SPEC);
const chart: Chart = chartWorld(
  world,
  FORMED.map((site) => ({ objectId: `region-${site}`, site })),
);
const palette = paletteOf('lush', 0);

/** The whole texture at once: `createWorldPainter` stepped until it is done. */
function paintWorldTexture(input: WorldTextureInput): WorldTexture {
  const painter = createWorldPainter(input);
  while (!painter.step(Infinity));
  return painter.result();
}

const paint = (overrides: Partial<WorldTextureInput> = {}) =>
  paintWorldTexture({ world, chart, palette, width: WIDTH, height: HEIGHT, ...overrides });

/** The band row of a latitude in radians, kept within the band: the inverse of `latitudeOfBandY`. */
function bandYOfLatitude(latitude: number): number {
  const y = BAND_HEIGHT / 2 - BAND_UNITS_PER_RADIAN * Math.log(Math.tan(Math.PI / 4 + latitude / 2));
  return Math.min(BAND_HEIGHT, Math.max(0, y));
}

let standardTexture: WorldTexture | undefined;
let cloudlessTexture: WorldTexture | undefined;
/** The texture of the usual input, painted once for the tests that only read it. */
const standard = (): WorldTexture => (standardTexture ??= paint());
/** The same with no weather, to see what the clouds changed. */
const cloudless = (): WorldTexture =>
  (cloudlessTexture ??= paint({ world: { ...world, clouds: { body: [], middle: [], core: [] } } }));

/** The texture with its weather laid over it, as the globe's shader does from orbit (both premultiplied). */
const withWeather = (texture: WorldTexture): WorldTexture => {
  const { weather } = texture;
  const data = new Uint8Array(texture.data.length);
  for (let at = 0; at < data.length; at += 4) {
    const cover = 1 - weather!.data[at + 3]! / 255;
    for (let channel = 0; channel < 4; channel++)
      data[at + channel] = Math.round(weather!.data[at + channel]! + texture.data[at + channel]! * cover);
  }
  return { ...texture, data };
};

const grid: PixelTarget = { width: WIDTH, height: HEIGHT, data: new Uint8Array(0) };
const draw = { scale: { x: WIDTH / BAND_WIDTH, y: HEIGHT / BAND_HEIGHT } };
const maskOf = (loops: readonly Loop[]) => maskShapes(grid, [loops], draw);
const UNREACHED = maskShapes(
  grid,
  chart.unreached.map((land) => land.loops),
  draw,
);
const CHARTED = maskShapes(
  grid,
  chart.charted.map((cell) => cell.loops),
  draw,
);
const rgbAt = (texture: PixelTarget, at: number) =>
  `${texture.data[at * 4]},${texture.data[at * 4 + 1]},${texture.data[at * 4 + 2]}`;
const hex = (colour: string) => [1, 3, 5].map((start) => Number.parseInt(colour.slice(start, start + 2), 16)).join(',');

/** How often each colour appears in the pixels of a mask, as `r,g,b`. */
function histogram(texture: PixelTarget, mask: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>();
  mask.forEach((inside, at) => {
    if (inside) counts.set(rgbAt(texture, at), (counts.get(rgbAt(texture, at)) ?? 0) + 1);
  });
  return counts;
}

/** True when a pixel of `mask` lies within `reach` pixels of the given one, across the seam. */
function touches(mask: Uint8Array, column: number, row: number, reach: number): boolean {
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      const y = row + dy;
      if (y >= 0 && y < HEIGHT && mask[y * WIDTH + ((column + dx + WIDTH) % WIDTH)]) return true;
    }
  return false;
}

const modal = (counts: Map<string, number>): string => [...counts].sort((a, b) => b[1] - a[1])[0]![0];
const total = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0);

/** The grey of land not reached yet, worked out here from the palette: `mix(land[0], grey, 0.86)`. */
const greyOfUnreached = (): string => {
  const land = hex(palette.land[0]).split(',').map(Number);
  const grey = hex(palette.grey[0]).split(',').map(Number);
  return land.map((channel, at) => Math.round(channel + (grey[at]! - channel) * 0.86)).join(',');
};

describe('painting a world into a texture', () => {
  it('gives the size asked for', () => {
    const texture = standard();
    expect(texture.width).toBe(WIDTH);
    expect(texture.height).toBe(HEIGHT);
    expect(texture.data).toBeInstanceOf(Uint8Array);
    expect(texture.data.length).toBe(WIDTH * HEIGHT * 4);
  });

  it('leaves open sea transparent and all land opaque, premultiplied', () => {
    const texture = standard();
    let clear = 0;
    for (let at = 0; at < WIDTH * HEIGHT; at++) {
      const [red, green, blue, alpha] = texture.data.slice(at * 4, at * 4 + 4) as unknown as number[];
      // Premultiplied: no channel is more than the alpha, and a clear pixel is nothing at all (no sea colour to fringe a coast).
      expect(Math.max(red!, green!, blue!)).toBeLessThanOrEqual(alpha!);
      if (alpha === 0) {
        clear += 1;
        expect(red! + green! + blue!).toBe(0);
      }
      if (UNREACHED[at] || CHARTED[at]) expect(alpha).toBe(255);
    }
    expect(clear / (WIDTH * HEIGHT)).toBeGreaterThan(0.3);
  });

  it('carries the palette look the globe composes its sea and light from, with caps only where the palette has them', () => {
    const lush = standard().look!;
    expect(lush).toEqual(worldLookOf(palette));
    expect(lush.ball).toEqual(palette.sea);
    expect(lush.flatSea).toEqual(palette.flatSea);
    expect(lush.atmosphere).toBe(palette.atmosphere);
    expect(lush.rim).toBe(palette.rim);
    expect(lush.cap).toBeNull();
    const frozen = paletteOf('frozen', 0);
    expect(worldLookOf(frozen).cap).toBe(frozen.cloud[0]);
    expect(worldLookOf(paletteOf('ocean', 40)).flatSea).toEqual(paletteOf('ocean', 40).flatSea);
  });

  it('carries the two greys of land not reached in its look: the globe from orbit and the ground', () => {
    const { closedGrey } = standard().look!;
    expect(closedGrey.globe.map((channel) => Math.round(channel)).join(',')).toBe(greyOfUnreached());
    expect(closedGrey.ground).toEqual(groundGreyOf(palette));
    expect(closedGrey.ground).not.toEqual(closedGrey.globe);
  });

  it('marks where land not reached lies, as 255 and 0, for the globe to read on the ground', () => {
    const { closed } = standard();
    expect(closed).toBeInstanceOf(Uint8Array);
    expect(closed!.length).toBe(WIDTH * HEIGHT);
    for (let at = 0; at < WIDTH * HEIGHT; at++) expect(closed![at]).toBe(UNREACHED[at] === 1 ? 255 : 0);
    // It cannot tell unformed land from decorative land: one value for both.
    const unformed = world.cells.find((cell) => !FORMED.includes(cell.site) && total(maskOf(cell.loops)) > 200)!;
    const decorative = world.decor.find((decor) => total(maskOf(decor.loops)) > 200)!;
    for (const loops of [unformed.loops, decorative.loops]) {
      const values = new Set<number>();
      maskOf(loops).forEach((here, at) => {
        if (here && UNREACHED[at]) values.add(closed![at]!);
      });
      expect([...values]).toEqual([255]);
    }
  });

  it('is the same bytes every time', () => {
    expect(Buffer.from(paint().data).equals(Buffer.from(standard().data))).toBe(true);
  });

  it('paints a formed region in the colour of its site', () => {
    const texture = standard();
    expect(chart.charted).toHaveLength(FORMED.length);
    for (const cell of chart.charted) {
      const mask = maskOf(cell.loops);
      if (total(mask) < 200) continue;
      const own = histogram(texture, mask).get(hex(palette.land[cell.site % 4]!)) ?? 0;
      expect(own / total(mask)).toBeGreaterThan(0.15);
    }
  });

  it('paints every piece of land not reached in the one grey, unformed and decorative alike', () => {
    const texture = standard();
    const unformed = world.cells.find((cell) => !FORMED.includes(cell.site) && total(maskOf(cell.loops)) > 200)!;
    const decorative = world.decor.find((decor) => total(maskOf(decor.loops)) > 200)!;
    for (const loops of [unformed.loops, decorative.loops])
      expect(modal(histogram(texture, maskOf(loops)))).toBe(greyOfUnreached());
    expect(greyOfUnreached()).not.toBe(hex(palette.land[0]));
  });

  it('keeps the weather in a layer of its own, premultiplied and the size of the texture, which has no cloud in it', () => {
    const { weather } = standard();
    expect(weather).toMatchObject({ width: WIDTH, height: HEIGHT });
    expect(weather!.data.length).toBe(WIDTH * HEIGHT * 4);
    for (let at = 0; at < WIDTH * HEIGHT; at++)
      expect(Math.max(...weather!.data.slice(at * 4, at * 4 + 3))).toBeLessThanOrEqual(weather!.data[at * 4 + 3]!);
    // The texture is the same with no clouds in the world: nothing of them is in its own pixels.
    expect(Buffer.from(cloudless().data).equals(Buffer.from(standard().data))).toBe(true);
    expect(cloudless().weather!.data.every((value) => value === 0)).toBe(true);
  });

  it('lays weather over the sea and land not reached, and never over formed land', () => {
    const { weather } = standard();
    let overSea = 0;
    let overUnreached = 0;
    for (let at = 0; at < WIDTH * HEIGHT; at++) {
      if (weather!.data[at * 4 + 3] === 0) continue;
      expect(CHARTED[at]).toBe(0);
      if (UNREACHED[at]) overUnreached += 1;
      else overSea += 1;
    }
    expect(overSea).toBeGreaterThan(200);
    expect(overUnreached).toBeGreaterThan(200);
  });

  it('puts no cloud over the point a formed region is named at', () => {
    const { weather } = standard();
    for (const { label } of chart.charted) {
      const at = Math.floor((label.y * HEIGHT) / BAND_HEIGHT) * WIDTH + Math.floor((label.x * WIDTH) / BAND_WIDTH);
      expect(weather!.data[at * 4 + 3]).toBe(0);
    }
  });

  /** The share of rows whose two edge pixels differ by more than 90 over three channels, as they look laid over mid grey. */
  const rowsApartAtSeam = (texture: WorldTexture): number => {
    const seen = (at: number, channel: number) =>
      texture.data[at * 4 + channel]! + 120 * (1 - texture.data[at * 4 + 3]! / 255);
    let apart = 0;
    for (let row = 0; row < HEIGHT; row++) {
      const left = row * WIDTH;
      const right = left + WIDTH - 1;
      const gap = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(seen(left, channel) - seen(right, channel)), 0);
      if (gap > 90) apart += 1;
    }
    return apart / HEIGHT;
  };

  it('carries land across the seam: the two edges of the texture meet', () => {
    expect(rowsApartAtSeam(cloudless())).toBeLessThan(0.05);
  });

  it('keeps the weather over the sea nearly seamless too: the world draws a cloud a step off at the seam in a few rows', () => {
    // The world's own cloud loops are not exact copies either side of the seam (a body edge a unit off over about
    // six rows of 256), which showed only on the rare cloud over grey land before it lay over the sea.
    expect(rowsApartAtSeam(withWeather(standard()))).toBeLessThan(0.08);
  });

  it('draws no border between two pieces of land not reached, and leaves their grey alone', () => {
    const clear = cloudless();
    const unreached = UNREACHED;
    const unformed = world.cells.filter((cell) => !FORMED.includes(cell.site)).map((cell) => maskOf(cell.loops));
    const insideUnreached = (column: number, row: number, reach: number): boolean => {
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          const at = (row + dy) * WIDTH + ((column + dx + WIDTH) % WIDTH);
          if (row + dy < 0 || row + dy >= HEIGHT || !unreached[at]) return false;
        }
      return true;
    };
    let alongBorders = 0;
    unformed.forEach((one, first) =>
      unformed.slice(first + 1).forEach((other) => {
        for (let at = 0; at < one.length; at++) {
          const column = at % WIDTH;
          const row = Math.floor(at / WIDTH);
          if (!one[at] || !touches(other, column, row, 2) || !insideUnreached(column, row, 2)) continue;
          expect(rgbAt(clear, at)).toBe(greyOfUnreached());
          alongBorders += 1;
        }
      }),
    );
    expect(alongBorders).toBeGreaterThan(30);
  });

  it('keeps the borders between formed regions and the coast where they meet land not reached', () => {
    const texture = standard();
    for (const cell of chart.charted) {
      const mask = maskOf(cell.loops);
      if (total(mask) < 200) continue;
      const own = hex(palette.land[cell.site % 4]!);
      let lines = 0;
      mask.forEach((inside, at) => {
        if (inside && rgbAt(texture, at) !== own && touches(UNREACHED, at % WIDTH, Math.floor(at / WIDTH), 1))
          lines += 1;
      });
      expect(lines).toBeGreaterThan(0);
    }
  });

  it('can be painted a little at a time, to the same bytes as all at once', () => {
    let time = 0;
    const painter = createWorldPainter({ world, chart, palette, width: WIDTH, height: HEIGHT }, () => (time += 1));
    expect(() => painter.result()).toThrow();
    let steps = 1;
    while (!painter.step(0.5)) steps += 1;
    expect(steps).toBeGreaterThan(10);
    expect(painter.step(0.5)).toBe(true);
    expect(Buffer.from(painter.result().data).equals(Buffer.from(standard().data))).toBe(true);
    expect(Buffer.from(painter.result().weather!.data).equals(Buffer.from(standard().weather!.data))).toBe(true);
  });

  it('paints the same bytes at 2048 by 1024 a little at a time as all at once', () => {
    const input = { world, chart, palette, width: 2048, height: 1024 };
    let time = 0;
    const stepped = createWorldPainter(input, () => (time += 1));
    let steps = 1;
    while (!stepped.step(0.5)) steps += 1;
    expect(steps).toBeGreaterThan(300);
    expect(Buffer.from(stepped.result().data).equals(Buffer.from(paintWorldTexture(input).data))).toBe(true);
  });

  it('draws a fill, a stroke and a mask in bands of rows to the bytes of drawing them whole', () => {
    const size = { width: WIDTH, height: HEIGHT };
    const blank = (): PixelTarget => ({ ...size, data: new Uint8Array(WIDTH * HEIGHT * 4).fill(40) });
    const drawing = (target: PixelTarget, rows?: { from: number; to: number }) => {
      const options = { ...draw, ...(rows ? { rows } : {}), clip: CHARTED };
      fillLoops(target, world.shallow, [200, 30, 30, 0.5], options);
      strokeLoops(target, world.land, [10, 90, 200, 0.6], { ...options, width: 2.5 });
      strokeLoops(target, chart.charted[0]!.loops, [255, 255, 0, 1], { ...draw, ...(rows ? { rows } : {}), width: 1 });
    };
    const whole = blank();
    drawing(whole);
    const banded = blank();
    for (let from = 0; from < HEIGHT; from += 37) drawing(banded, { from, to: from + 37 });
    expect(Buffer.from(banded.data).equals(Buffer.from(whole.data))).toBe(true);
    const mask = new Uint8Array(WIDTH * HEIGHT);
    for (let from = 0; from < HEIGHT; from += 37)
      maskShapes(grid, [world.land], { ...draw, rows: { from, to: from + 37 }, into: mask });
    expect(Buffer.from(mask).equals(Buffer.from(maskShapes(grid, [world.land], draw)))).toBe(true);
  });

  it('finishes in one step when the budget allows', () => {
    const painter = createWorldPainter({ world, chart, palette, width: WIDTH, height: HEIGHT });
    expect(painter.step(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('draws only the bands of a gas giant, and only on a gas giant', () => {
    const gasPalette = paletteOf('gas', 0);
    const gas = paint({ palette: gasPalette });
    for (let at = 3; at < gas.data.length; at += 4)
      if (gas.data[at] !== 255) throw new Error('a gas giant has no sea to show');
    const seen = new Set(histogram(gas, new Uint8Array(WIDTH * HEIGHT).fill(1)).keys());
    for (const band of gasPalette.bands!) expect(seen.has(hex(band))).toBe(true);
    const plain = new Set(histogram(standard(), new Uint8Array(WIDTH * HEIGHT).fill(1)).keys());
    for (const band of gasPalette.bands!) expect(plain.has(hex(band))).toBe(false);
  });
});

describe('the grey of land not reached on the ground', () => {
  const hexOf = (colour: readonly number[]) => colour.map((channel) => Math.round(channel));
  const distance = (one: readonly number[], other: readonly number[]) =>
    Math.hypot(...one.map((channel, at) => channel - other[at]!));
  const channelsOf = (colour: string) => hexOf(hex(colour).split(',').map(Number));

  it('is the prototype ground grey for a palette that leaves it clear, a darker and neutral grey than the globe', () => {
    const lush = paletteOf('lush', 0);
    const grey = groundGreyOf(lush);
    const [face, edge] = lush.grey.map(channelsOf);
    expect(hexOf(grey)).toEqual(face!.map((channel, at) => Math.round((channel + edge![at]!) / 2)));
    const luma = (colour: readonly number[]) => 0.2126 * colour[0]! + 0.7152 * colour[1]! + 0.0722 * colour[2]!;
    expect(luma(grey)).toBeLessThan(luma(worldLookOf(lush).closedGrey.globe));
  });

  it('keeps clear of the whole sea and of every colour a formed region wears, on every planet type at every hue', () => {
    const types = ['lush', 'ocean', 'frozen', 'scorched', 'barren', 'gas'] as const;
    for (const type of types)
      for (let hue = 0; hue < 360; hue += 10) {
        const turned = paletteOf(type, hue);
        const grey = groundGreyOf(turned);
        const [top, bottom] = turned.flatSea.map(channelsOf) as [number[], number[]];
        const seas = [0, 0.25, 0.5, 0.75, 1].map((along) =>
          top.map((channel, at) => channel + (bottom[at]! - channel) * along),
        );
        const lands = [...turned.land, turned.lowland, turned.highland].map(channelsOf);
        for (const other of [...seas, ...lands]) expect(distance(grey, other)).toBeGreaterThan(55);
      }
  });
});

describe('where a name goes', () => {
  it('maps band rows to latitude as Mercator does: the band edges are about 79.2 degrees', () => {
    const edge = (79.2 * Math.PI) / 180;
    expect(latitudeOfBandY(0)).toBeCloseTo(edge, 2);
    expect(latitudeOfBandY(360)).toBeCloseTo(-edge, 2);
    expect(latitudeOfBandY(0)).toBeCloseTo(-latitudeOfBandY(360), 12);
    expect(latitudeOfBandY(180)).toBeCloseTo(0, 12);
    expect(latitudeOfBandY(90)).toBeGreaterThan(latitudeOfBandY(91));
  });

  it('keeps a unit as long north as it is east, wherever it is: a row is cos(latitude) of a radian', () => {
    for (const y of [20, 100, 180, 250, 340]) {
      const step = latitudeOfBandY(y - 0.5) - latitudeOfBandY(y + 0.5);
      expect(step).toBeCloseTo(Math.cos(latitudeOfBandY(y)) / BAND_UNITS_PER_RADIAN, 5);
    }
  });

  it('goes from a row to a latitude and back', () => {
    for (let y = 0; y <= 360; y += 15) expect(bandYOfLatitude(latitudeOfBandY(y))).toBeCloseTo(y, 9);
    expect(bandYOfLatitude(0.3)).toBeCloseTo(180 - BAND_UNITS_PER_RADIAN * Math.log(Math.tan(Math.PI / 4 + 0.15)), 9);
  });

  it('keeps a latitude within the band, the poles included', () => {
    expect(bandYOfLatitude(Math.PI / 2)).toBe(0);
    expect(bandYOfLatitude(-Math.PI / 2)).toBe(360);
    expect(bandYOfLatitude(1.5)).toBe(0);
    expect(bandYOfLatitude(-1.5)).toBe(360);
  });

  it('has one point for each formed region, well inside its land, and none for land not reached', () => {
    const points = labelPoints(chart);
    expect(points.map((point) => point.objectId)).toEqual(chart.charted.map((cell) => cell.objectId));
    expect(points).toHaveLength(FORMED.length);
    for (const [index, point] of points.entries()) {
      const cell = chart.charted[index]!;
      const centre = centreOfCell(cell, BAND_WIDTH);
      expect(point.x).toBeCloseTo(((centre.x % BAND_WIDTH) + BAND_WIDTH) % BAND_WIDTH, 9);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThan(BAND_WIDTH);
      expect(point.lat).toBe(latitudeOfBandY(centre.y));
    }
  });
});

/**
 * Pins the painter's output: a tidy-up of the painter or of `fill-loops.ts` must not change a pixel.
 * One world with each of three palettes (lush, gas, scorched: the gas bands and the scorched coast
 * glow are layers the lush one lacks), SHA-1 of the whole RGBA array at 1024 by 512. A deliberate
 * change of look updates the hashes. 2048 by 1024 is not pinned: it costs about 13 s for the three.
 *
 * Re-pinned for the globe's new look (the pale-globe fix, #811). The pictures are now: open sea is not
 * painted but left transparent (0,0,0,0) for the globe's shader to fill with the prototype's ball and flat
 * sea (about 56% of a lush texture, 72% of an ocean one; a gas giant has none: its first band now runs up to
 * the top edge); everything is premultiplied (colour times alpha, so a coast filters without a dark
 * fringe); the world's own cloud lies over the sea as well as over land not reached, though never over formed
 * land, a coast line's width of it, or the places the names go. Land, lines and the shelf are as before.
 *
 * Re-pinned again (ground terrain, #811): the weather left the band's own pixels and has a layer of its own
 * (`WorldTexture.weather`), so that the globe can take it off on the ground and leave the coast and the sea's shelf
 * under it whole. The texture's pixels are the same as before with no cloud in them; the weather laid back over them,
 * as the globe does from orbit, is the old picture to within a unit of rounding in a channel (checked when it was
 * pinned: the largest difference was 2 and 2 channels in 524,288 were off by more than 1).
 */
describe('the painter output, pinned', () => {
  const PINNED = {
    lush: 'dee7722df3e93ca6a9e1244bf5dbbc21e3fd4ca6',
    gas: '59cb7c4c6eb2a6914e469b7cb7c7caac4ccb774e',
    scorched: '74e8e35447c5053f127153fe498a5b09f68cbb87',
  } as const;
  it.each(Object.keys(PINNED) as (keyof typeof PINNED)[])('paints %s at 1024 by 512 to the pinned bytes', (type) => {
    const texture = paint({ palette: paletteOf(type, 0), width: 1024, height: 512 });
    expect(createHash('sha1').update(texture.data).digest('hex')).toBe(PINNED[type]);
  });
});
