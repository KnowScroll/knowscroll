import type { Chart, GlobeWorld, Loop } from '@knowscroll/scene-core';
import type { PlanetPalette } from '../planet/planet-palette';
import { mixRgb, type Rgb } from '../space/paint';
import {
  fillLoops,
  fillShapes,
  maskShapes,
  strokeCover,
  strokeLoops,
  type DrawOptions,
  type PixelTarget,
  type RowRange,
  type Rgba,
} from './fill-loops';

/**
 * The planet's surface as pixels. The planet you fly to is one sphere that wears this texture, so
 * from orbit and on the ground it is the same drawing and going down is the camera falling toward
 * it. The texture is the SVG globe's land recipe (`planet/planet-globe.tsx`: `Land`, `GasBands` and
 * `Clouds`, with the same colours and alphas) painted into an RGBA array, because a sphere can wear
 * pixels but not SVG. It differs from the SVG in two ways: land that is not reached is one grey (the
 * SVG colours its decor), and the region borders are inked after the coast, solid where the SVG's are
 * dashed. Where a number below copies the SVG globe or the design prototype it says which. The painter
 * works a few rows at a time so the caller can spread it over frames.
 *
 * This file is reached from the main bundle (the stage reads `labelPoints`), so it must not import
 * `three`; `globe.ts` is what puts the pixels on a sphere.
 */

/** The globe's band, as the SVG globe's `BAND` and `BAND_HEIGHT` (`planet/planet-globe.tsx`): 480 units round, a whole turn of longitude. */
export const BAND_WIDTH = 480;
/** 360 units from the north edge of the band to the south edge. */
export const BAND_HEIGHT = 360;
/** Band units for one radian of longitude: the band is `BAND_WIDTH` units for a whole turn. The Mercator scale of the band. */
export const BAND_UNITS_PER_RADIAN = BAND_WIDTH / (2 * Math.PI);
/** The ink of the shadow under a cloud: the SVG globe's cloud shadow fill. */
const CLOUD_SHADOW = '#06182a';
/**
 * How far land that is not reached yet is mixed toward the palette's grey (so it keeps 0.14 of its own
 * colour): the prototype's `mix(land, lock[0], 0.86)` for a region not reached (`drawGlobe`,
 * `Universe.dc.html` line 1328), with `lock[0]` being `palette.grey[0]`. Here the first land colour is
 * mixed for all of it, so no piece shows which site it is.
 */
const UNREACHED_GREY_MIX = 0.86;
/**
 * A line of the SVG globe is one to six units wide on a disc of 360 units. The texture is stretched
 * over a sphere, so a line is thinner here than its unit width in pixels would be.
 */
const LINE_WEIGHT = 0.6;
/** The gas giant's bands: nine, the SVG globe's `GasBands` count, each as high as the band is tall over nine (40 units). */
const GAS_BAND_COUNT = 9;
const GAS_BAND_HEIGHT = BAND_HEIGHT / GAS_BAND_COUNT;
/** The wave along the top of a gas band, as the SVG globe's `GasBands`: a quadratic arc every 60 units, swinging 9 up or down. */
const GAS_WAVE_LENGTH = 60;
const GAS_WAVE_SWING = 9;
/** Columns of gas band painted in one task. */
const GAS_COLUMNS_PER_TASK = 64;
/** Pixel rows a layer is painted in at a time, so that no task is long. */
const ROWS_PER_TASK = 32;

/** The pixels of a finished texture: RGBA, row 0 at the north edge of the band. */
export type WorldTexture = PixelTarget;

/** What the texture is painted from: the planet's world, its chart (which regions have formed), its palette and the size to paint at. */
export interface WorldTextureInput {
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  readonly width: number;
  readonly height: number;
}

/** What the painting tasks draw into: the image, how world units map onto it and how thick a line is. */
interface Sheet {
  readonly target: PixelTarget;
  readonly draw: DrawOptions & { readonly scale: { readonly x: number; readonly y: number } };
  /** Pixels for one unit of line width. */
  readonly line: number;
}

/**
 * The latitude, in radians north of the equator, of band row `y` (0 at the top, `BAND_HEIGHT` at the
 * bottom). The band is a Mercator strip: a unit is the same length north as east at every latitude, so
 * a continent keeps its shape on the sphere. The band's edges lie at about +-79.2 degrees.
 */
export function latitudeOfBandY(y: number): number {
  return 2 * Math.atan(Math.exp((BAND_HEIGHT / 2 - y) / BAND_UNITS_PER_RADIAN)) - Math.PI / 2;
}

/**
 * Where a formed region's name belongs and where it is tapped: its column on the band, and its latitude
 * in radians (the sphere has to be told how high up, and a band row is not a latitude).
 */
export interface LabelPoint {
  readonly objectId: string;
  readonly x: number;
  readonly lat: number;
}

/**
 * The place for the name of each formed region (and its tap target), in the order of the chart. Only
 * formed regions have one: land that is not reached yet has no name and so no point.
 */
export function labelPoints(chart: Chart): readonly LabelPoint[] {
  return chart.charted.map(({ objectId, label }) => ({
    objectId,
    x: label.x,
    lat: latitudeOfBandY(label.y),
  }));
}

/** A `#rrggbb` colour as 0..255 channels (not `space/paint`'s `hexToUnit`: 0..1 floats would round the bytes differently). */
const rgbOf = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const withAlpha = (colour: Rgb, alpha: number): Rgba => [colour[0], colour[1], colour[2], alpha];
const hexAlpha = (hex: string, alpha: number): Rgba => withAlpha(rgbOf(hex), alpha);

/** The same loops moved by a few world units: how a shadow sits under a shape. */
const shifted = (loops: readonly Loop[], dx: number, dy: number): Loop[] =>
  loops.map((loop) => loop.map((value, at) => value + (at % 2 === 0 ? dx : dy)));

/**
 * Open water in rows `from` up to `to`: from the palette's `sea[1]` at the equator, a little deeper
 * towards the poles (mixed toward `sea[2]`, 0.7 of the way at the edge of the band). The sphere's own
 * light does the rest of the shading, so none is painted in.
 */
function paintSea(target: PixelTarget, palette: PlanetPalette, from: number, to: number): void {
  const equator = rgbOf(palette.sea[1]);
  const pole = rgbOf(palette.sea[2]);
  for (let row = from; row < Math.min(to, target.height); row++) {
    const fromEquator = Math.abs(((row + 0.5) / target.height) * 2 - 1);
    const [red, green, blue] = mixRgb(equator, pole, 0.7 * fromEquator * fromEquator);
    for (let column = 0; column < target.width; column++) {
      const at = (row * target.width + column) * 4;
      target.data[at] = Math.round(red);
      target.data[at + 1] = Math.round(green);
      target.data[at + 2] = Math.round(blue);
      target.data[at + 3] = 255;
    }
  }
}

/**
 * How far the top edge of a gas band swings at world `x`: the SVG globe's wave, a quadratic arc every
 * `GAS_WAVE_LENGTH` units. A quadratic curve whose control point sits `GAS_WAVE_SWING` off the line
 * is `2t(1 - t)` of that swing off it at `t` of the way along.
 */
function gasWave(x: number): number {
  const along = (x + GAS_WAVE_LENGTH) / GAS_WAVE_LENGTH;
  const step = Math.floor(along);
  const t = along - step;
  return 2 * t * (1 - t) * (step % 2 === 1 ? GAS_WAVE_SWING : -GAS_WAVE_SWING);
}

/**
 * A gas giant's flat wavy bands in columns `from` up to `to`: one every `GAS_BAND_HEIGHT` units from the
 * top, each running down to the top edge of the next, in the palette's colours in turn. The SVG globe's
 * `GasBands` instead draws each band 44 units tall, so the next paints over its foot.
 */
function paintGasBands(sheet: Sheet, bands: readonly string[], from: number, to: number): void {
  const { target, draw } = sheet;
  const colours = bands.map(rgbOf);
  const tops = new Array<number>(GAS_BAND_COUNT + 1);
  for (let column = from; column < Math.min(to, target.width); column++) {
    const wave = gasWave((column + 0.5) / draw.scale.x);
    for (let band = 0; band < GAS_BAND_COUNT; band++)
      tops[band] = Math.ceil((band * GAS_BAND_HEIGHT + wave) * draw.scale.y - 0.5);
    tops[GAS_BAND_COUNT] = target.height;
    for (let band = 0; band < GAS_BAND_COUNT; band++) {
      const [red, green, blue] = colours[band % colours.length]!;
      for (let row = Math.max(0, tops[band]!); row < Math.min(target.height, tops[band + 1]!); row++) {
        const at = (row * target.width + column) * 4;
        target.data[at] = red;
        target.data[at + 1] = green;
        target.data[at + 2] = blue;
        target.data[at + 3] = 255;
      }
    }
  }
}

/** Every loop of the land not reached, as one list: the edge of it, for the coast's reach. */
const unreachedLoops = (chart: Chart): Loop[] => chart.unreached.flatMap((land) => land.loops);
/** One shape for each piece of land, so neighbours that overlap by a sliver do not cancel each other under even-odd. */
const chartedShapes = (chart: Chart): (readonly Loop[])[] => chart.charted.map((cell) => cell.loops);
const unreachedShapes = (chart: Chart): (readonly Loop[])[] => chart.unreached.map((land) => land.loops);

/** A piece of work that paints one range of rows of a layer. */
type Task = () => void;

/** What the later layers need to know about earlier ones; each is set by the mask tasks. */
interface Masks {
  /** Pixels inside a formed region. */
  charted: Uint8Array;
  /** Pixels inside land not reached, and within a line's width of its edge. */
  nearUnreached: Uint8Array;
  /** The pixels `nearUnreached` leaves out: where the coast is inked. */
  awayFromUnreached: Uint8Array;
  /** Pixels where cloud may lie: land not reached, and no formed region. */
  cloudRoom: Uint8Array;
  /** Pixels inside land not reached, kept only to make the other masks. */
  unreachedLand: Uint8Array;
}

/** The ranges a texture of `count` rows (or columns) is painted in, `size` at a time. */
const rangesOf = (count: number, size: number): RowRange[] =>
  Array.from({ length: Math.ceil(count / size) }, (_, at) => ({
    from: at * size,
    to: Math.min(count, (at + 1) * size),
  }));

/** One task for each range of rows of the target: the work of a layer, spread so no task is long. */
const rowTasks = (target: PixelTarget, paint: (rows: RowRange) => void): Task[] =>
  rangesOf(target.height, ROWS_PER_TASK).map((rows) => () => paint(rows));

/**
 * The sea, the bands of a gas giant, the water off the coast, the coast's glow where a planet has one,
 * and the foam line: the SVG globe's `Land` up to the coast, in its order, with its alphas and widths
 * (shallows 0.35 each, glow `#ffb03a` 6 wide at 0.8, foam 3.6 wide at 0.85). The prototype draws the
 * same three strokes in `drawGlobe`: a shelf, a hot line where the palette glows, then foam.
 */
function waterTasks(sheet: Sheet, input: WorldTextureInput): Task[] {
  const { target, draw, line } = sheet;
  const { world, palette } = input;
  const glow = hexAlpha('#ffb03a', 0.8);
  return [
    ...rangesOf(target.height, ROWS_PER_TASK).map(
      ({ from, to }) =>
        () =>
          paintSea(target, palette, from, to),
    ),
    ...(palette.bands
      ? rangesOf(target.width, GAS_COLUMNS_PER_TASK).map(
          ({ from, to }) =>
            () =>
              paintGasBands(sheet, palette.bands!, from, to),
        )
      : []),
    ...rowTasks(target, (rows) =>
      fillLoops(target, world.shallowWide, hexAlpha(palette.shallow, 0.35), { ...draw, rows }),
    ),
    ...rowTasks(target, (rows) => fillLoops(target, world.shallow, hexAlpha(palette.foam, 0.35), { ...draw, rows })),
    ...(palette.glowCoast
      ? rowTasks(target, (rows) => strokeLoops(target, world.land, glow, { ...draw, rows, width: 6 * line }))
      : []),
    ...rowTasks(target, (rows) =>
      strokeLoops(target, world.land, hexAlpha(palette.foam, 0.85), { ...draw, rows, width: 3.6 * line }),
    ),
  ];
}

/**
 * Every continent in its colour. A formed region wears the colour of its site (`site % 4` picks one of
 * the palette's four, as the SVG globe's `byColour`). Land that is not reached is one flat grey, the
 * same for every piece, unformed or decorative: nothing here tells them apart, so the pixels give away
 * no site and no count (D-078, D-109).
 */
function landTasks(sheet: Sheet, input: WorldTextureInput): Task[] {
  const { target, draw } = sheet;
  const { chart, palette } = input;
  const grey = withAlpha(mixRgb(rgbOf(palette.land[0]), rgbOf(palette.grey[0]), UNREACHED_GREY_MIX), 1);
  const unreached = unreachedShapes(chart);
  return [
    ...palette.land.flatMap((hex, colour) => {
      const shapes = chart.charted.filter((cell) => cell.site % 4 === colour).map((cell) => cell.loops);
      return shapes.length === 0
        ? []
        : rowTasks(target, (rows) => fillShapes(target, shapes, hexAlpha(hex, 1), { ...draw, rows }));
    }),
    ...rowTasks(target, (rows) => fillShapes(target, unreached, grey, { ...draw, rows })),
  ];
}

/**
 * The masks the detail and the cloud are kept to, made a range of rows at a time. Land not reached
 * is grown by a coast line's width, so its coast is inside the mask and the coast of reached land is not.
 */
function maskTasks(sheet: Sheet, input: WorldTextureInput, masks: Masks): Task[] {
  const { target, draw, line } = sheet;
  const { chart } = input;
  const charted = chartedShapes(chart);
  const unreached = unreachedShapes(chart);
  const unreachedEdges = unreachedLoops(chart);
  return rowTasks(target, (rows) => {
    maskShapes(target, charted, { ...draw, rows, into: masks.charted });
    maskShapes(target, unreached, { ...draw, rows, into: masks.unreachedLand });
    const edge = strokeCover(target, unreachedEdges, { ...draw, rows, width: 1.4 * line });
    const first = rows.from * target.width;
    for (let at = 0; at < edge.length; at++) {
      const pixel = first + at;
      const land = masks.unreachedLand[pixel] !== 0;
      const near = land || edge[at] !== 0;
      masks.nearUnreached[pixel] = near ? 1 : 0;
      masks.awayFromUnreached[pixel] = near ? 0 : 1;
      masks.cloudRoom[pixel] = land && masks.charted[pixel] === 0 ? 1 : 0;
    }
  });
}

/**
 * Lowland and highland patches on reached land, and the lines: the coast in ink, the borders
 * between formed regions, and the coast of land not reached in grey. Alphas and widths are the SVG
 * globe's `Land` (lowland 0.6, highland 0.62, coast ink 0.7 at 1.4 wide, region border ink 0.45 at 1
 * wide, solid where the SVG's is dashed); the grey coast is the prototype's `lock[2]` outline. Land
 * not reached is outlined as one (the coast of the world where it meets the sea), never along the
 * borders between its cells, which would show how it is split (D-109).
 */
function detailTasks(sheet: Sheet, input: WorldTextureInput, masks: Masks): Task[] {
  const { target, draw, line } = sheet;
  const { world, chart, palette } = input;
  const ink = hexAlpha(palette.ink, 0.7);
  const grey = hexAlpha(palette.grey[2], 0.6);
  return [
    ...rowTasks(target, (rows) =>
      fillLoops(target, world.lowland, hexAlpha(palette.lowland, 0.6), { ...draw, rows, clip: masks.charted }),
    ),
    ...rowTasks(target, (rows) =>
      fillLoops(target, world.highland, hexAlpha(palette.highland, 0.62), { ...draw, rows, clip: masks.charted }),
    ),
    ...rowTasks(target, (rows) =>
      strokeLoops(target, world.land, ink, { ...draw, rows, clip: masks.awayFromUnreached, width: 1.4 * line }),
    ),
    ...rowTasks(target, (rows) =>
      strokeLoops(target, world.land, grey, { ...draw, rows, clip: masks.nearUnreached, width: 1.4 * line }),
    ),
    ...chart.charted.flatMap((cell) =>
      rowTasks(target, (rows) =>
        strokeLoops(target, cell.loops, hexAlpha(palette.ink, 0.45), { ...draw, rows, width: line }),
      ),
    ),
  ];
}

/**
 * Cumulus laid as the SVG globe's `Clouds` stacks it (shadow, cool underside, body, brighter middle,
 * sunlit core: the same offsets, alphas and colours), only where the cloud has room.
 */
function cloudTasks(sheet: Sheet, input: WorldTextureInput, masks: Masks): Task[] {
  const { target, draw } = sheet;
  const { body, middle, core } = input.world.clouds;
  const { palette } = input;
  const layers: [readonly Loop[], Rgba][] = [
    [shifted(body, 4, 7), hexAlpha(CLOUD_SHADOW, 0.22)],
    [shifted(body, 0, 2), hexAlpha(palette.cloud[1], 0.9)],
    [body, hexAlpha(palette.cloud[0], 1)],
    [shifted(middle, -0.6, -1), hexAlpha('#f6f9fd', 1)],
    [shifted(core, -1.2, -2), hexAlpha('#ffffff', 1)],
  ];
  return layers.flatMap(([loops, colour]) =>
    rowTasks(target, (rows) => fillLoops(target, loops, colour, { ...draw, rows, clip: masks.cloudRoom })),
  );
}

/** A texture being painted a little at a time, so that painting never holds the frame for long. */
export interface WorldPainter {
  /**
   * Paints ranges of layers (`ROWS_PER_TASK` rows of one layer at a time) until `budgetMs` milliseconds on the
   * painter's clock have passed, at least one strip each call. Returns true when the texture is finished.
   */
  step(budgetMs: number): boolean;
  /** The finished texture. @throws Error before `step` has returned true. */
  result(): WorldTexture;
}

/**
 * Starts painting one planet's continents into an RGBA image a sphere can wear: x is longitude all
 * round (the band's `BAND_WIDTH` units), y is the band's row from north (row 0) to south, nothing
 * flipped and painted linearly in band units; the sphere's UVs do the Mercator mapping of
 * `latitudeOfBandY`. Pure: the same world, chart and palette give the same bytes however it is
 * stepped, and the seam is seamless. Nothing runs until `step` is called, so a caller can spread the
 * cost over frames.
 *
 * Formed regions are in colour. Land that is not reached yet is one flat grey, with cloud over it
 * and nowhere else; it is drawn from `chart.unreached` alone, which has no site or id for it, so
 * no site, region id or count goes into the pixels. Land is painted like the SVG globe, a gas giant
 * included: its bands lie under the soft land its world has. A globe world carries no veils, so the
 * cloud is the world's own weather (`world.clouds`) kept to unreached land.
 *
 * @param now the clock `step` measures its budget by, in milliseconds. Default `performance.now`.
 */
export function createWorldPainter(
  input: WorldTextureInput,
  now: () => number = () => performance.now(),
): WorldPainter {
  const { world, width, height } = input;
  const target: PixelTarget = { width, height, data: new Uint8Array(width * height * 4) };
  const scale = { x: width / world.width, y: height / world.height };
  // Nothing wraps round the seam: the world's loops already run 60 units past each edge, as copies of what lies at
  // the other edge, so the texture's own bounds cut them. Wrapping them again would draw the edge where they were
  // cut across the land.
  const sheet: Sheet = {
    target,
    draw: { scale },
    line: ((scale.x + scale.y) / 2) * LINE_WEIGHT,
  };
  const pixels = width * height;
  const masks: Masks = {
    charted: new Uint8Array(pixels),
    nearUnreached: new Uint8Array(pixels),
    awayFromUnreached: new Uint8Array(pixels),
    cloudRoom: new Uint8Array(pixels),
    unreachedLand: new Uint8Array(pixels),
  };
  const tasks = [
    ...waterTasks(sheet, input),
    ...landTasks(sheet, input),
    ...maskTasks(sheet, input, masks),
    ...detailTasks(sheet, input, masks),
    ...cloudTasks(sheet, input, masks),
    // The masks are only for painting: let go of them (five bytes a pixel) once it is done.
    () => {
      for (const name of Object.keys(masks) as (keyof Masks)[]) masks[name] = new Uint8Array(0);
    },
  ];
  let next = 0;
  return {
    step(budgetMs) {
      const deadline = now() + budgetMs;
      while (next < tasks.length) {
        tasks[next++]!();
        if (now() >= deadline) break;
      }
      return next >= tasks.length;
    },
    result() {
      if (next < tasks.length) throw new Error('The texture is not finished: keep calling step.');
      return target;
    },
  };
}
