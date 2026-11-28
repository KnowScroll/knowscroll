import { buildGlobe, chartWorld, type Chart, type GlobeWorld, type Loop } from '@knowscroll/scene-core';
import { paletteOf } from '../planet/planet-palette';
import { maskShapes, type PixelTarget } from './fill-loops';
import {
  BAND_HEIGHT,
  BAND_UNITS_PER_RADIAN,
  BAND_WIDTH,
  createWorldPainter,
  GROUND_LINE_POINTS,
  groundGreyOf,
  groundPatchOf,
  labelPoints,
  PATCH_TEXELS_PER_POINT,
  type PatchSpec,
  type WorldTexture,
  type WorldTextureInput,
} from './world-texture';
import { focalOf, GROUND_FIELD_OF_VIEW, planetDistances } from './voyage-chains';

const SPEC = { seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 12 } as const;
const FORMED = [0, 2, 3, 5, 8];
const world: GlobeWorld = buildGlobe(SPEC);
const chart: Chart = chartWorld(
  world,
  FORMED.map((site) => ({ objectId: `region-${site}`, site })),
);
const palette = paletteOf('lush', 0);
const PHONE = { width: 390, height: 844 };

/** A painter run to the end in one go. */
function paintAll(input: WorldTextureInput): WorldTexture {
  const painter = createWorldPainter(input);
  while (!painter.step(Infinity));
  return painter.result();
}

/** The patch input for a window and a scale: `pixelsPerUnit` texels to a band unit, the texture sized to the window. */
function patchInput(patch: PatchSpec, pixelsPerUnit: number, over: Partial<WorldTextureInput> = {}): WorldTextureInput {
  return {
    world,
    chart,
    palette,
    width: Math.round(patch.window.width * pixelsPerUnit),
    height: Math.round(patch.window.height * pixelsPerUnit),
    patch,
    ...over,
  };
}

const pointsPerUnitAt = (pointsPerRadian: number, latitude: number) =>
  (pointsPerRadian * Math.cos(latitude)) / BAND_UNITS_PER_RADIAN;

/**
 * Where the sphere is under a screen point, by a ray from the camera (an independent way to the closed form
 * `groundPatchOf` uses): the camera is `distance` radii from the sphere's centre straight above the landing, `across`
 * points right and `up` points above the landing's own place on screen. Returns band x (unwrapped, near the landing's)
 * and band row, or null where the ray misses the sphere.
 */
function groundUnder(
  landing: { x: number; lat: number },
  size: { width: number; height: number },
  across: number,
  up: number,
): { x: number; y: number } | null {
  const focal = focalOf(size, GROUND_FIELD_OF_VIEW);
  const distance = planetDistances(1, size).ground;
  const ray = [across / focal, up / focal, -1] as const;
  const length = Math.hypot(...ray);
  const direction = ray.map((value) => value / length) as [number, number, number];
  // |camera + t * direction| = 1 for the camera at (0, 0, distance).
  const b = direction[2] * distance;
  const disc = b * b - (distance * distance - 1);
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  const point = [direction[0] * t, direction[1] * t, direction[2] * t + distance] as const;
  const pole = [0, Math.cos(landing.lat), Math.sin(landing.lat)] as const;
  const noon = [0, -Math.sin(landing.lat), Math.cos(landing.lat)] as const;
  const dot = (one: readonly number[], other: readonly number[]) => one.reduce((sum, v, at) => sum + v * other[at]!, 0);
  const latitude = Math.asin(Math.max(-1, Math.min(1, dot(point, pole))));
  const turn = Math.atan2(point[0], dot(point, noon));
  return {
    x: landing.x + turn * BAND_UNITS_PER_RADIAN,
    y: BAND_HEIGHT / 2 - BAND_UNITS_PER_RADIAN * Math.log(Math.tan(Math.PI / 4 + latitude / 2)),
  };
}

describe('the window and density of the ground patch', () => {
  const landings = [0, 0.3, 0.57, 1.0, -0.4, -1.1].flatMap((lat) => [240, 5, 475].map((x) => ({ x, lat })));
  const sizes = [PHONE, { width: 430, height: 932 }, { width: 820, height: 1180 }, { width: 1280, height: 800 }];

  it('is pure: the same landing and screen give the same patch', () => {
    expect(groundPatchOf({ x: 100, lat: 0.4 }, PHONE)).toEqual(groundPatchOf({ x: 100, lat: 0.4 }, PHONE));
  });

  it('holds the landing, in a window of whole texels that are square', () => {
    for (const size of sizes)
      for (const landing of landings) {
        const patch = groundPatchOf(landing, size);
        const { window } = patch;
        expect(window.x).toBeLessThanOrEqual(landing.x);
        expect(window.x + window.width).toBeGreaterThanOrEqual(landing.x);
        const y = BAND_HEIGHT / 2 - BAND_UNITS_PER_RADIAN * Math.log(Math.tan(Math.PI / 4 + landing.lat / 2));
        expect(window.y).toBeLessThanOrEqual(y);
        expect(window.y + window.height).toBeGreaterThanOrEqual(y);
        expect(Number.isInteger(patch.width)).toBe(true);
        expect(Number.isInteger(patch.height)).toBe(true);
        expect(patch.width / window.width).toBeCloseTo(patch.height / window.height, 9);
      }
  });

  it('keeps inside the band, and inside the 60 units either side of the landing the loops reach', () => {
    for (const size of sizes)
      for (const landing of landings) {
        const { window } = groundPatchOf(landing, size);
        expect(window.y).toBeGreaterThanOrEqual(-1e-6);
        expect(window.y + window.height).toBeLessThanOrEqual(BAND_HEIGHT + 1);
        expect(window.x).toBeGreaterThanOrEqual(landing.x - 61);
        expect(window.x + window.width).toBeLessThanOrEqual(landing.x + 61);
      }
  });

  it('wraps across the seam: a landing by it gives a window that runs past either edge of the band', () => {
    const west = groundPatchOf({ x: 5, lat: 0.4 }, PHONE).window;
    expect(west.x).toBeLessThan(0);
    expect(west.x + west.width).toBeGreaterThan(5);
    const east = groundPatchOf({ x: 475, lat: 0.4 }, PHONE).window;
    expect(east.x + east.width).toBeGreaterThan(BAND_WIDTH);
    // The same ground, a turn round: the same window, moved by the band's width.
    const middle = groundPatchOf({ x: 245, lat: 0.4 }, PHONE).window;
    const moved = groundPatchOf({ x: 245 - 240, lat: 0.4 }, PHONE).window;
    expect(middle.x - moved.x).toBeCloseTo(240, 9);
    expect(middle.width).toBeCloseTo(moved.width, 9);
  });

  it('draws at least 1.5 texels for each point at the landing, on a phone, at every latitude', () => {
    for (const size of [PHONE, { width: 430, height: 932 }])
      for (const landing of landings) {
        const patch = groundPatchOf(landing, size);
        const texelsPerUnit = patch.width / patch.window.width;
        const texelsPerPoint = texelsPerUnit / pointsPerUnitAt(patch.pointsPerRadian, landing.lat);
        expect(texelsPerPoint).toBeGreaterThanOrEqual(PATCH_TEXELS_PER_POINT - 0.01);
      }
  });

  it('knows the ground scale: 1 / (d - 1) of the focal length a radian, which is 672 points on a 390 by 844 phone', () => {
    const patch = groundPatchOf({ x: 100, lat: 0.2 }, PHONE);
    expect(patch.pointsPerRadian).toBeCloseTo(
      focalOf(PHONE, GROUND_FIELD_OF_VIEW) / (planetDistances(1, PHONE).ground - 1),
      9,
    );
    expect(patch.pointsPerRadian).toBeGreaterThan(660);
    expect(patch.pointsPerRadian).toBeLessThan(685);
  });

  it('caps the pixels and the sides, whatever the screen', () => {
    for (const size of sizes)
      for (const landing of landings) {
        const patch = groundPatchOf(landing, size);
        expect(patch.width * patch.height).toBeLessThanOrEqual(1536 * 1536);
        expect(Math.max(patch.width, patch.height)).toBeLessThanOrEqual(2048);
      }
  });

  it('covers the screen where the ground is under it: the middle of it, and most of the way to every edge', () => {
    // A ray to the sphere is the check: a patch is cut down (`share`) when the whole screen would need too many texels,
    // so it covers the share of the screen's reach it reports, margin included; the middle is always inside.
    for (const size of sizes)
      for (const landing of landings) {
        const patch = groundPatchOf(landing, size);
        const { window } = patch;
        const held = 0.45;
        const reach = {
          left: size.width / 2 + 0.12 * size.height,
          up: held * size.height + 0.12 * size.height,
          down: (1 - held) * size.height + 0.12 * size.height,
        };
        for (const [across, up] of [
          [0, 0],
          [0, reach.up * patch.share * 0.95],
          [0, -reach.down * patch.share * 0.95],
          [reach.left * patch.share * 0.95, 0],
          [-reach.left * patch.share * 0.95, 0],
          [reach.left * patch.share * 0.7, reach.up * patch.share * 0.7],
          [-reach.left * patch.share * 0.7, -reach.down * patch.share * 0.7],
        ] as const) {
          const under = groundUnder(landing, size, across, up);
          // Past the band's edge (over a pole) there is no land to paint.
          if (under === null || under.y < 0 || under.y > BAND_HEIGHT) continue;
          // Or more than 60 units of longitude from the landing (a near-polar screen, or the far side of a pole): the
          // world's loops reach no farther, so the patch does not either, and the globe's texture has those corners.
          if (Math.abs(under.x - landing.x) > 60) continue;
          expect(under.x).toBeGreaterThanOrEqual(window.x - 0.01);
          expect(under.x).toBeLessThanOrEqual(window.x + window.width + 0.01);
          // The band's own edge cuts the window's top and bottom: past it there is no land to paint.
          expect(Math.max(0, Math.min(BAND_HEIGHT, under.y))).toBeGreaterThanOrEqual(window.y - 0.01);
          expect(Math.max(0, Math.min(BAND_HEIGHT, under.y))).toBeLessThanOrEqual(window.y + window.height + 0.01);
        }
      }
  });

  it('covers the whole phone screen, or all but a thin strip of its edges, with its margin spent', () => {
    // The phone is cut down to under 0.8 of its reach, which includes the 12% margin: the screen itself is almost all in.
    const patch = groundPatchOf({ x: 240, lat: 0.4 }, PHONE);
    expect(patch.share).toBeGreaterThan(0.7);
    expect(patch.share).toBeLessThanOrEqual(1);
  });
});

describe('painting the ground patch', () => {
  const label = labelPoints(chart).find((point) => point.objectId === 'region-3')!;
  const patch = groundPatchOf(label, PHONE);
  let painted: WorldTexture | undefined;
  const ground = (): WorldTexture =>
    (painted ??= paintAll({ world, chart, palette, width: patch.width, height: patch.height, patch }));
  const GLOBE_W = 1024;
  const GLOBE_H = 512;
  let globeTexture: WorldTexture | undefined;
  const globe = (): WorldTexture =>
    (globeTexture ??= paintAll({ world, chart, palette, width: GLOBE_W, height: GLOBE_H }));
  const grid: PixelTarget = { width: GLOBE_W, height: GLOBE_H, data: new Uint8Array(0) };
  const draw = { scale: { x: GLOBE_W / BAND_WIDTH, y: GLOBE_H / BAND_HEIGHT } };
  const landOf = (loops: readonly (readonly Loop[])[]) => maskShapes(grid, loops, draw);

  it('gives the pixels asked for, and leaves open sea transparent and land opaque, premultiplied, as the globe does', () => {
    const texture = ground();
    expect(texture.width).toBe(patch.width);
    expect(texture.height).toBe(patch.height);
    expect(texture.data.length).toBe(patch.width * patch.height * 4);
    let clear = 0;
    let opaque = 0;
    for (let at = 0; at < patch.width * patch.height; at++) {
      const [red, green, blue, alpha] = texture.data.slice(at * 4, at * 4 + 4) as unknown as number[];
      expect(Math.max(red!, green!, blue!)).toBeLessThanOrEqual(alpha!);
      if (alpha === 0) {
        clear += 1;
        expect(red! + green! + blue!).toBe(0);
      }
      if (alpha === 255) opaque += 1;
    }
    expect(clear).toBeGreaterThan(0);
    expect(opaque).toBeGreaterThan(0);
    expect(texture.look).toBeDefined();
  });

  it('is the palette look the globe composes the sea from, the same as the whole-band texture carries', () => {
    expect(ground().look).toEqual(globe().look);
  });

  it('matches the whole-band texture colour for colour where both paint the same formed land', () => {
    const texture = ground();
    const reference = globe();
    const charted = landOf(chart.charted.map((cell) => cell.loops));
    // Land not reached is the one place they differ on purpose: the ground's grey is not the globe's (below).
    const land = (column: number, row: number) => charted[row * GLOBE_W + column];
    /** The colour of a texel, as a string. */
    const colourOf = (target: PixelTarget, column: number, row: number) =>
      Array.from(target.data.slice((row * target.width + column) * 4, (row * target.width + column) * 4 + 4));
    const unit = patch.window.width / patch.width;
    let compared = 0;
    let differing = 0;
    for (let row = 0; row < patch.height; row += 3)
      for (let column = 0; column < patch.width; column += 3) {
        const bandX = (((patch.window.x + (column + 0.5) * unit) % BAND_WIDTH) + BAND_WIDTH) % BAND_WIDTH;
        const bandY = patch.window.y + (row + 0.5) * unit;
        const globeColumn = Math.floor((bandX * GLOBE_W) / BAND_WIDTH);
        const globeRow = Math.floor((bandY * GLOBE_H) / BAND_HEIGHT);
        if (globeColumn < 2 || globeColumn >= GLOBE_W - 2 || globeRow < 2 || globeRow >= GLOBE_H - 2) continue;
        // Only where the globe's own texels round this one are all one colour (no line, edge or patch edge) and on land.
        const here = colourOf(reference, globeColumn, globeRow);
        let flat = land(globeColumn, globeRow) !== 0 && here[3] === 255;
        for (let dy = -2; dy <= 2 && flat; dy++)
          for (let dx = -2; dx <= 2 && flat; dx++)
            flat = colourOf(reference, globeColumn + dx, globeRow + dy).join() === here.join();
        if (!flat) continue;
        compared += 1;
        const mine = colourOf(texture, column, row);
        if (mine.some((channel, at) => Math.abs(channel - here[at]!) > 2)) differing += 1;
      }
    // Plenty of land is compared, and the colours agree (a rare pixel at a patch's lowland edge or a cloud's may not).
    expect(compared).toBeGreaterThan(2000);
    expect(differing / compared).toBeLessThan(0.01);
  });

  it('lets no cloud over formed land, as the globe does: nothing there changes when the clouds are taken away', () => {
    const cloudless = paintAll({
      world: { ...world, clouds: { body: [], middle: [], core: [] } },
      chart,
      palette,
      width: patch.width,
      height: patch.height,
      patch,
    });
    const texture = ground();
    // The patch's own mask of formed land: a pixel whose centre is inside a cell.
    const cells = chart.charted.map((cell) => cell.loops);
    const mask = maskShapes({ width: patch.width, height: patch.height, data: new Uint8Array(0) }, cells, {
      scale: { x: patch.width / patch.window.width, y: patch.height / patch.window.height },
      origin: { x: patch.window.x, y: patch.window.y },
    });
    let formed = 0;
    let changed = 0;
    for (let at = 0; at < mask.length; at++)
      if (mask[at]) {
        formed += 1;
        for (let channel = 0; channel < 4; channel++)
          if (texture.data[at * 4 + channel] !== cloudless.data[at * 4 + channel]) {
            changed += 1;
            break;
          }
      }
    expect(formed).toBeGreaterThan(10000);
    expect(changed).toBe(0);
  });

  it('has no weather at all: it is the same bytes with the clouds taken away, over land and sea', () => {
    const cloudless = paintAll({
      world: { ...world, clouds: { body: [], middle: [], core: [] } },
      chart,
      palette,
      width: patch.width,
      height: patch.height,
      patch,
    });
    expect(Buffer.from(ground().data).equals(Buffer.from(cloudless.data))).toBe(true);
    // The whole-band texture is what carries weather, in a layer of its own that the globe takes off.
    expect(ground().weather).toBeUndefined();
    expect(ground().closed).toBeUndefined();
  });

  it('paints land not reached in the ground grey, the one colour for unformed and decorative land alike', () => {
    const texture = ground();
    const unit = patch.window.width / patch.width;
    const target: PixelTarget = { width: patch.width, height: patch.height, data: new Uint8Array(0) };
    const scale = { x: patch.width / patch.window.width, y: patch.height / patch.window.height };
    const origin = { x: patch.window.x, y: patch.window.y };
    const wanted = groundGreyOf(palette)
      .map((channel) => Math.round(channel))
      .join(',');
    const colours: string[] = [];
    for (const loops of [...world.cells.filter((cell) => !FORMED.includes(cell.site)), ...world.decor].map(
      (piece) => piece.loops,
    )) {
      const mask = maskShapes(target, [loops], { scale, origin });
      const counts = new Map<string, number>();
      mask.forEach((inside, at) => {
        if (!inside) return;
        const colour = Array.from(texture.data.slice(at * 4, at * 4 + 3)).join(',');
        counts.set(colour, (counts.get(colour) ?? 0) + 1);
      });
      const [modal, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      // Only pieces with a good deal of land in the window say anything.
      if (count > 400 / (unit * unit)) colours.push(modal);
    }
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(colour).toBe(wanted);
  });

  it('is the same bytes painted a little at a time as all at once', () => {
    const small: PatchSpec = {
      window: { x: patch.window.x + 20, y: patch.window.y + 30, width: 30, height: 50 },
      pointsPerRadian: patch.pointsPerRadian,
    };
    const input = patchInput(small, 6);
    const whole = paintAll(input);
    const painter = createWorldPainter(input, () => 0);
    let steps = 0;
    // A budget of nothing paints one strip a call: the most slices there are.
    while (!painter.step(0)) steps += 1;
    expect(steps).toBeGreaterThan(50);
    expect(Buffer.from(painter.result().data).equals(Buffer.from(whole.data))).toBe(true);
  });

  it('paints a window across the seam from the same loops as the band: the two sides of the seam meet', () => {
    const across: PatchSpec = { window: { x: -25, y: 130, width: 50, height: 70 }, pointsPerRadian: 672 };
    const turned: PatchSpec = { window: { x: BAND_WIDTH - 25, y: 130, width: 50, height: 70 }, pointsPerRadian: 672 };
    const one = paintAll(patchInput(across, 8));
    const other = paintAll(patchInput(turned, 8));
    // Same ground a turn apart: the same pixels, but where the world's own copy at the seam is a step off (clouds, in a few rows).
    let same = 0;
    for (let at = 0; at < one.width * one.height; at++)
      if (
        Array.from(one.data.slice(at * 4, at * 4 + 4)).join() ===
        Array.from(other.data.slice(at * 4, at * 4 + 4)).join()
      )
        same += 1;
    expect(same / (one.width * one.height)).toBeGreaterThan(0.97);
    // And there is land across it, so this compares something.
    let opaque = 0;
    for (let at = 0; at < one.width * one.height; at++) if (one.data[at * 4 + 3] === 255) opaque += 1;
    expect(opaque).toBeGreaterThan(0.02 * one.width * one.height);
  });
});

/** A world of one square of land and nothing else, its top edge at band row `top`, for measuring a line. */
function squareWorld(top: number) {
  const square: Loop = [100, top, 200, top, 200, top + 120, 100, top + 120];
  const bare = {
    ...world,
    cells: [],
    decor: [],
    shallow: [],
    shallowWide: [],
    lowland: [],
    highland: [],
    land: [square],
  };
  return { square, bare: { ...bare, clouds: { body: [], middle: [], core: [] } } as GlobeWorld };
}

describe('the lines of the ground patch, in points', () => {
  const POINTS_PER_RADIAN = 672;
  const PIXELS_PER_UNIT = 12;
  /** A 20 by 20 unit window across the top edge of the square at row `top`, and the numbers to read the picture in points. */
  function frame(top: number) {
    const { square, bare } = squareWorld(top);
    const window = { x: 140, y: top - 10, width: 20, height: 20 };
    const spec: PatchSpec = { window, pointsPerRadian: POINTS_PER_RADIAN };
    const latitude = 2 * Math.atan(Math.exp((BAND_HEIGHT / 2 - top) / BAND_UNITS_PER_RADIAN)) - Math.PI / 2;
    return {
      square,
      bare,
      spec,
      size: window.width * PIXELS_PER_UNIT,
      edgeRow: 10 * PIXELS_PER_UNIT,
      column: (window.width * PIXELS_PER_UNIT) / 2,
      pixelsPerPoint: PIXELS_PER_UNIT / pointsPerUnitAt(POINTS_PER_RADIAN, latitude),
    };
  }
  const rgbOf = (texture: WorldTexture, row: number, column: number) => {
    const at = (row * texture.width + column) * 4;
    return [texture.data[at]!, texture.data[at + 1]!, texture.data[at + 2]!, texture.data[at + 3]!] as const;
  };
  const sumOf = (hex: string) => [1, 3, 5].reduce((sum, at) => sum + Number.parseInt(hex.slice(at, at + 2), 16), 0);

  /** How far off the coast, in points, the shelf and the foam reach (alpha above 0 and at least 0.8). */
  function reaches(top: number) {
    const f = frame(top);
    const texture = paintAll({
      world: f.bare,
      chart: { charted: [], unreached: [] },
      palette,
      width: f.size,
      height: f.size,
      patch: f.spec,
    });
    let shelf = f.edgeRow;
    let foam = f.edgeRow;
    for (let row = f.edgeRow; row >= 0; row--) {
      const alpha = rgbOf(texture, row, f.column)[3];
      if (alpha > 0) shelf = row;
      if (alpha >= 0.8 * 255) foam = row;
    }
    return { shelf: (f.edgeRow - shelf) / f.pixelsPerPoint, foam: (f.edgeRow - foam) / f.pixelsPerPoint };
  }

  it('reaches the pale shelf half of its 22 points off the coast, and the foam half of its 7', () => {
    const { shelf, foam } = reaches(180);
    // Half of each stroke is off the coast (the other half is under the land): to within the soft edge of a pixel.
    expect(shelf).toBeGreaterThan(GROUND_LINE_POINTS.shelf / 2 - 1);
    expect(shelf).toBeLessThanOrEqual(GROUND_LINE_POINTS.shelf / 2 + 0.6);
    expect(foam).toBeGreaterThan(GROUND_LINE_POINTS.foam / 2 - 1);
    expect(foam).toBeLessThanOrEqual(GROUND_LINE_POINTS.foam / 2 + 0.6);
  });

  it('keeps those widths in points at a high latitude, where a band unit is shorter on the ground', () => {
    const equator = reaches(180);
    const north = reaches(100);
    expect(north.shelf).toBeCloseTo(equator.shelf, 0);
    expect(north.foam).toBeCloseTo(equator.foam, 0);
    expect(north.shelf).toBeLessThanOrEqual(GROUND_LINE_POINTS.shelf / 2 + 0.6);
  });

  /** The ink laid over a flat colour by one stroke, as the width in points of its inner half (the side with the land). */
  function innerInk(texture: WorldTexture, f: ReturnType<typeof frame>, fill: string, ink: string, alpha: number) {
    let weight = 0;
    for (let row = f.edgeRow; row < f.edgeRow + 40; row++) {
      const [red, green, blue] = rgbOf(texture, row, f.column);
      const moved = (sumOf(fill) - (red + green + blue)) / (sumOf(fill) - sumOf(ink)) / alpha;
      if (moved > 0.01) weight += moved;
    }
    return weight / f.pixelsPerPoint;
  }

  it('inks the border between regions 1.8 points wide', () => {
    const f = frame(180);
    const cell = { objectId: 'a', site: 0, loops: [f.square], label: { x: 150, y: 240 } };
    const texture = paintAll({
      world: { ...f.bare, land: [] },
      chart: { charted: [cell], unreached: [] },
      palette,
      width: f.size,
      height: f.size,
      patch: f.spec,
    });
    // The inner half of a stroke 1.8 points wide at 0.7 over the cell's land colour.
    expect(innerInk(texture, f, palette.land[0], palette.ink, 0.7)).toBeCloseTo(GROUND_LINE_POINTS.border / 2, 0);
  });

  it('inks the coast of land not reached 2 points wide, in the grey outline', () => {
    const f = frame(180);
    const texture = paintAll({
      world: f.bare,
      chart: { charted: [], unreached: [{ loops: [f.square] }] },
      palette,
      width: f.size,
      height: f.size,
      patch: f.spec,
    });
    // The fill is the ground's grey, and the line is the prototype's 0.75 of the palette's darkest grey.
    const fill = `#${groundGreyOf(palette)
      .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
      .join('')}`;
    expect(innerInk(texture, f, fill, palette.grey[2], 0.75)).toBeCloseTo(GROUND_LINE_POINTS.ink / 2, 0);
  });

  it('lights the coast of land the person has opened and shades the coast of land not reached', () => {
    const f = frame(180);
    const paintSquare = (kind: 'open' | 'closed') =>
      paintAll({
        world: f.bare,
        chart:
          kind === 'open'
            ? { charted: [{ objectId: 'a', site: 0, loops: [f.square], label: { x: 150, y: 240 } }], unreached: [] }
            : { charted: [], unreached: [{ loops: [f.square] }] },
        palette,
        width: f.size,
        height: f.size,
        patch: f.spec,
      });
    const open = paintSquare('open');
    const closed = paintSquare('closed');
    // Off the coast by 4.5 points (inside the shelf, outside the foam) and by 2.2 (inside the foam, outside the ink).
    const shelfRow = Math.round(f.edgeRow - 4.5 * f.pixelsPerPoint);
    const foamRow = Math.round(f.edgeRow - 2.2 * f.pixelsPerPoint);
    const [openRed, , , openAlpha] = rgbOf(open, shelfRow, f.column);
    const [closedRed, closedGreen, , closedAlpha] = rgbOf(closed, shelfRow, f.column);
    // Open: the pale shelf, white at 0.2. Closed: the palette's shadow at 0.3, which has no red to speak of.
    expect(openAlpha / 255).toBeCloseTo(0.2, 1);
    expect(openRed).toBeGreaterThan(40);
    expect(closedAlpha / 255).toBeCloseTo(0.3, 1);
    expect(closedRed + closedGreen).toBeLessThan(openRed);
    // And the foam, white at 0.85, is only along the open coast.
    expect(rgbOf(open, foamRow, f.column)[3]).toBeGreaterThanOrEqual(0.8 * 255);
    expect(rgbOf(closed, foamRow, f.column)[3]).toBeLessThan(0.5 * 255);
  });

  it('draws these lines far thinner than the globe does on the ground: the globe is about 9 points there', () => {
    // The globe's coast ink is 1.4 * 0.6 = 0.84 band units: at 672 points a radian on the equator that is 7.4 points.
    const globeInkPoints = 0.84 * pointsPerUnitAt(POINTS_PER_RADIAN, 0);
    expect(globeInkPoints).toBeGreaterThan(3.5 * GROUND_LINE_POINTS.ink);
  });
});
