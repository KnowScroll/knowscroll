import { buildGlobe, chartWorld, type Chart, type GlobeWorld, type Loop, type WorldSpec } from '@knowscroll/scene-core';
import { paletteOf } from '../planet/planet-palette';
import { maskLoops, maskShapes, type PixelTarget } from './fill-loops';
import {
  bandToLonLat,
  bandYOfLatitude,
  createWorldPainter,
  labelPoints,
  latitudeOfBandY,
  paintWorldTexture,
  type WorldTexture,
} from './world-texture';

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
const paint = (overrides: Partial<Parameters<typeof paintWorldTexture>[0]> = {}) =>
  paintWorldTexture({ world, chart, palette, width: WIDTH, height: HEIGHT, ...overrides });

let standardTexture: WorldTexture | undefined;
let cloudlessTexture: WorldTexture | undefined;
/** The texture of the usual input, painted once for the tests that only read it. */
const standard = (): WorldTexture => (standardTexture ??= paint());
/** The same with no weather, to see what the clouds changed. */
const cloudless = (): WorldTexture =>
  (cloudlessTexture ??= paint({ world: { ...world, clouds: { body: [], middle: [], core: [] } } }));

const grid: PixelTarget = { width: WIDTH, height: HEIGHT, data: new Uint8Array(0) };
const draw = { scale: { x: WIDTH / 480, y: HEIGHT / 360 } };
const maskOf = (loops: readonly Loop[]) => maskLoops(grid, loops, draw);
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
  it('gives the size asked for, opaque all over', () => {
    const texture = standard();
    expect(texture.width).toBe(WIDTH);
    expect(texture.height).toBe(HEIGHT);
    expect(texture.data).toBeInstanceOf(Uint8Array);
    expect(texture.data.length).toBe(WIDTH * HEIGHT * 4);
    for (let at = 3; at < texture.data.length; at += 4) if (texture.data[at] !== 255) throw new Error('not opaque');
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

  it('keeps cloud to land not reached: nothing else changes when the clouds are taken away', () => {
    const clear = cloudless();
    const cloudy = standard();
    const unreached = UNREACHED;
    const charted = CHARTED;
    let cloudPixels = 0;
    for (let at = 0; at < WIDTH * HEIGHT; at++) {
      const same = rgbAt(clear, at) === rgbAt(cloudy, at);
      if (!same) cloudPixels += 1;
      if (!unreached[at] || charted[at]) expect(same).toBe(true);
    }
    expect(cloudPixels).toBeGreaterThan(200);
  });

  it('puts no cloud over the point a formed region is named at', () => {
    const clear = cloudless();
    const cloudy = standard();
    for (const { x, y } of labelPoints(chart)) {
      const at = Math.floor((y * HEIGHT) / 360) * WIDTH + Math.floor((x * WIDTH) / 480);
      expect(rgbAt(cloudy, at)).toBe(rgbAt(clear, at));
    }
  });

  it('carries land across the seam: the two edges of the texture meet', () => {
    const texture = standard();
    let apart = 0;
    for (let row = 0; row < HEIGHT; row++) {
      const left = row * WIDTH;
      const right = left + WIDTH - 1;
      const gap = [0, 1, 2].reduce(
        (sum, channel) => sum + Math.abs(texture.data[left * 4 + channel]! - texture.data[right * 4 + channel]!),
        0,
      );
      if (gap > 90) apart += 1;
    }
    expect(apart / HEIGHT).toBeLessThan(0.05);
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
  });

  it('finishes in one step when the budget allows', () => {
    const painter = createWorldPainter({ world, chart, palette, width: WIDTH, height: HEIGHT });
    expect(painter.step(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('draws only the bands of a gas giant, and only on a gas giant', () => {
    const gasPalette = paletteOf('gas', 0);
    const gas = paint({ palette: gasPalette });
    const seen = new Set(histogram(gas, new Uint8Array(WIDTH * HEIGHT).fill(1)).keys());
    for (const band of gasPalette.bands!) expect(seen.has(hex(band))).toBe(true);
    const plain = new Set(histogram(standard(), new Uint8Array(WIDTH * HEIGHT).fill(1)).keys());
    for (const band of gasPalette.bands!) expect(plain.has(hex(band))).toBe(false);
  });
});

describe('where a name goes', () => {
  it('turns a place on the band into an angle round the planet and up from the equator', () => {
    expect(bandToLonLat(0, 180)).toEqual({ lon: 0, lat: 0 });
    expect(bandToLonLat(240, 180).lon).toBeCloseTo(Math.PI, 12);
    expect(bandToLonLat(120, 0).lon).toBeCloseTo(Math.PI / 2, 12);
    expect(bandToLonLat(120, 0).lat).toBeCloseTo(latitudeOfBandY(0), 12);
  });

  it('maps band rows to latitude as Mercator does: the band edges are about 79.2 degrees', () => {
    const edge = (79.2 * Math.PI) / 180;
    expect(latitudeOfBandY(0)).toBeCloseTo(edge, 2);
    expect(latitudeOfBandY(360)).toBeCloseTo(-edge, 2);
    expect(latitudeOfBandY(0)).toBeCloseTo(-latitudeOfBandY(360), 12);
    expect(latitudeOfBandY(180)).toBeCloseTo(0, 12);
    expect(latitudeOfBandY(90)).toBeGreaterThan(latitudeOfBandY(91));
  });

  it('keeps a unit as long north as it is east, wherever it is: a row is cos(latitude) of a radian', () => {
    const perRadian = 480 / (2 * Math.PI);
    for (const y of [20, 100, 180, 250, 340]) {
      const step = latitudeOfBandY(y - 0.5) - latitudeOfBandY(y + 0.5);
      expect(step).toBeCloseTo(Math.cos(latitudeOfBandY(y)) / perRadian, 5);
    }
  });

  it('goes from a row to a latitude and back', () => {
    for (let y = 0; y <= 360; y += 15) expect(bandYOfLatitude(latitudeOfBandY(y))).toBeCloseTo(y, 9);
    expect(bandYOfLatitude(0.3)).toBeCloseTo(180 - (480 / (2 * Math.PI)) * Math.log(Math.tan(Math.PI / 4 + 0.15)), 9);
  });

  it('keeps a latitude within the band, the poles included', () => {
    expect(bandYOfLatitude(Math.PI / 2)).toBe(0);
    expect(bandYOfLatitude(-Math.PI / 2)).toBe(360);
    expect(bandYOfLatitude(1.5)).toBe(0);
    expect(bandYOfLatitude(-1.5)).toBe(360);
  });

  it('has one point for each formed region, from its cell, and none for land not reached', () => {
    const points = labelPoints(chart);
    expect(points.map((point) => point.objectId)).toEqual(chart.charted.map((cell) => cell.objectId));
    expect(points).toHaveLength(FORMED.length);
    for (const [index, point] of points.entries()) {
      const label = chart.charted[index]!.label;
      expect([point.x, point.y]).toEqual([label.x, label.y]);
      expect(point.lon).toBeCloseTo(bandToLonLat(label.x, label.y).lon, 12);
      expect(point.lat).toBeCloseTo(bandToLonLat(label.x, label.y).lat, 12);
    }
  });
});
