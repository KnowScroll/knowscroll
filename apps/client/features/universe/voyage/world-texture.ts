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
  type Rgba,
} from './fill-loops';

/** The globe's band: 480 units round (a whole turn of longitude) and 360 high (pole to pole). */
const BAND_WIDTH = 480;
const BAND_HEIGHT = 360;
/** Dark ink for the shadow under a cloud. */
const CLOUD_SHADOW = '#06182a';
/** How much of the land's own colour a land that is not reached yet keeps (`mix(land, grey, 0.86)`). */
const UNREACHED_GREY_MIX = 0.86;
/**
 * A line of the SVG globe is one to six units wide on a disc of 360 units. The texture is stretched
 * over a sphere, so a line is thinner here than its unit width in pixels would be.
 */
const LINE_WEIGHT = 0.6;
const BAND_ROWS = 9;
/** Rows of sea and columns of gas band painted in one step. */
const STRIP = 64;
/** Band units for one radian of longitude: the band is 480 units for a whole turn. */
const UNITS_PER_RADIAN = BAND_WIDTH / (2 * Math.PI);

export type WorldTexture = PixelTarget;

export interface WorldTextureInput {
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  readonly width: number;
  readonly height: number;
}

/** What `paintWorldTexture` paints into: the image, how world units map onto it and how thick a line is. */
interface Sheet {
  readonly target: PixelTarget;
  readonly draw: DrawOptions & { readonly scale: { readonly x: number; readonly y: number } };
  /** Pixels for one unit of line width. */
  readonly line: number;
}

/**
 * The latitude, in radians north of the equator, of band row `y` (0 at the top, 360 at the bottom).
 * The band is a Mercator strip: a unit is the same length north as east at every latitude, so a
 * continent keeps its shape on the sphere. The band's edges lie at about +-79.2 degrees.
 */
export function latitudeOfBandY(y: number): number {
  return 2 * Math.atan(Math.exp((BAND_HEIGHT / 2 - y) / UNITS_PER_RADIAN)) - Math.PI / 2;
}

/** The band row of a latitude in radians, kept within the band: the poles, beyond its edges, give 0 or 360. */
export function bandYOfLatitude(latitude: number): number {
  const y = BAND_HEIGHT / 2 - UNITS_PER_RADIAN * Math.log(Math.tan(Math.PI / 4 + latitude / 2));
  return Math.min(BAND_HEIGHT, Math.max(0, y));
}

/** A point of the band as the angle round the planet (east) and up from its equator (north), in radians. */
export function bandToLonLat(x: number, y: number): { readonly lon: number; readonly lat: number } {
  return { lon: (x / BAND_WIDTH) * 2 * Math.PI, lat: latitudeOfBandY(y) };
}

/** Where a formed region's name belongs, on the band and on the sphere. */
export interface LabelPoint {
  readonly objectId: string;
  readonly x: number;
  readonly y: number;
  readonly lon: number;
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
    y: label.y,
    ...bandToLonLat(label.x, label.y),
  }));
}

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

/** Open water in rows `from` up to `to`, a little deeper towards the poles. The 3D light does the rest of the shading. */
function paintSea(target: PixelTarget, palette: PlanetPalette, from: number, to: number): void {
  const equator = rgbOf(palette.sea[1]);
  const pole = rgbOf(palette.sea[2]);
  for (let row = from; row < Math.min(to, target.height); row++) {
    const fromEquator = Math.abs(((row + 0.5) / target.height) * 2 - 1);
    const [red, green, blue] = mixRgb(equator, pole, 0.7 * fromEquator * fromEquator);
    for (let column = 0; column < target.width; column++)
      target.data.set([Math.round(red), Math.round(green), Math.round(blue), 255], (row * target.width + column) * 4);
  }
}

/** How far the top edge of a gas band swings at world `x`: the SVG globe's wave, a quadratic arc every 60 units. */
function bandWave(x: number): number {
  const along = (x + 60) / 60;
  const step = Math.floor(along);
  const t = along - step;
  return 2 * t * (1 - t) * (step % 2 === 1 ? 9 : -9);
}

/** A gas giant's flat wavy bands in columns `from` up to `to`: every 40 units from the top, each running down to the bottom edge. */
function paintGasBands(sheet: Sheet, bands: readonly string[], from: number, to: number): void {
  const { target, draw } = sheet;
  const colours = bands.map(rgbOf);
  const tops = new Array<number>(BAND_ROWS + 1);
  for (let column = from; column < Math.min(to, target.width); column++) {
    const wave = bandWave((column + 0.5) / draw.scale.x);
    for (let band = 0; band < BAND_ROWS; band++) tops[band] = Math.ceil((band * 40 + wave) * draw.scale.y - 0.5);
    tops[BAND_ROWS] = target.height;
    for (let band = 0; band < BAND_ROWS; band++) {
      const [red, green, blue] = colours[band % colours.length]!;
      for (let row = Math.max(0, tops[band]!); row < Math.min(target.height, tops[band + 1]!); row++)
        target.data.set([red, green, blue, 255], (row * target.width + column) * 4);
    }
  }
}

const unreachedLoops = (chart: Chart): Loop[] => chart.unreached.flatMap((land) => land.loops);
/** One shape for each piece of land, so neighbours that overlap by a sliver do not cancel each other under even-odd. */
const chartedShapes = (chart: Chart): (readonly Loop[])[] => chart.charted.map((cell) => cell.loops);
const unreachedShapes = (chart: Chart): (readonly Loop[])[] => chart.unreached.map((land) => land.loops);

/** A piece of work that paints one layer, or one strip of a layer. */
type Task = () => void;

/** What the later layers need to know about earlier ones; each is set by its own task. */
interface Masks {
  /** Pixels inside a formed region. */
  charted: Uint8Array;
  /** Pixels inside land not reached, and within a line's width of its edge. */
  nearUnreached: Uint8Array;
  /** Pixels where cloud may lie: land not reached, and no formed region. */
  cloudRoom: Uint8Array;
}

const strips = (count: number): number[] => Array.from({ length: Math.ceil(count / STRIP) }, (_, at) => at * STRIP);

/** The sea, the bands of a gas giant, the water off the coast, the coast's glow where a planet has one, and the foam line. */
function waterTasks(sheet: Sheet, input: WorldTextureInput): Task[] {
  const { target, draw, line } = sheet;
  const { world, palette } = input;
  return [
    ...strips(target.height).map((from) => () => paintSea(target, palette, from, from + STRIP)),
    ...(palette.bands
      ? strips(target.width).map((from) => () => paintGasBands(sheet, palette.bands!, from, from + STRIP))
      : []),
    () => fillLoops(target, world.shallowWide, hexAlpha(palette.shallow, 0.35), draw),
    () => fillLoops(target, world.shallow, hexAlpha(palette.foam, 0.35), draw),
    ...(palette.glowCoast
      ? [() => strokeLoops(target, world.land, hexAlpha('#ffb03a', 0.8), { ...draw, width: 6 * line })]
      : []),
    () => strokeLoops(target, world.land, hexAlpha(palette.foam, 0.85), { ...draw, width: 3.6 * line }),
  ];
}

/**
 * Every continent in its colour. A formed region wears the colour of its site. Land that is not
 * reached is one flat grey, the same for every piece, unformed or decorative: nothing here tells
 * them apart. Then the masks the detail and the cloud are kept to.
 */
function landTasks(sheet: Sheet, input: WorldTextureInput, masks: Masks): Task[] {
  const { target, draw, line } = sheet;
  const { chart, palette } = input;
  const grey = mixRgb(rgbOf(palette.land[0]), rgbOf(palette.grey[0]), UNREACHED_GREY_MIX);
  return [
    ...palette.land.map((hex, colour) => () => {
      const shapes = chart.charted.filter((cell) => cell.site % 4 === colour).map((cell) => cell.loops);
      if (shapes.length > 0) fillShapes(target, shapes, hexAlpha(hex, 1), draw);
    }),
    () => fillShapes(target, unreachedShapes(chart), withAlpha(grey, 1), draw),
    () => {
      masks.charted = maskShapes(target, chartedShapes(chart), draw);
      const land = maskShapes(target, unreachedShapes(chart), draw);
      const edge = strokeCover(target, unreachedLoops(chart), { ...draw, width: 1.4 * line });
      masks.nearUnreached = land.map((inside, at) => (inside !== 0 || edge[at] !== 0 ? 1 : 0));
      masks.cloudRoom = land.map((inside, at) => (inside !== 0 && masks.charted[at] === 0 ? 1 : 0));
    },
  ];
}

/**
 * Lowland and highland patches on reached land, and the lines: the coast in ink, the borders
 * between formed regions, and the coast of land not reached in grey. Land not reached is outlined
 * as one (the coast of the world where it meets the sea), never along the borders between its
 * cells, which would show how it is split (D-109).
 */
function detailTasks(sheet: Sheet, input: WorldTextureInput, masks: Masks): Task[] {
  const { target, draw, line } = sheet;
  const { world, chart, palette } = input;
  const unreachedCoast = () => ({ ...draw, clip: masks.nearUnreached, width: 1.4 * line });
  return [
    () => fillLoops(target, world.lowland, hexAlpha(palette.lowland, 0.6), { ...draw, clip: masks.charted }),
    () => fillLoops(target, world.highland, hexAlpha(palette.highland, 0.62), { ...draw, clip: masks.charted }),
    () => {
      const away = masks.nearUnreached.map((near) => 1 - near);
      strokeLoops(target, world.land, hexAlpha(palette.ink, 0.7), { ...draw, clip: away, width: 1.4 * line });
    },
    () => strokeLoops(target, world.land, hexAlpha(palette.grey[2], 0.6), unreachedCoast()),
    ...chart.charted.map(
      (cell) => () => strokeLoops(target, cell.loops, hexAlpha(palette.ink, 0.45), { ...draw, width: line }),
    ),
  ];
}

/** Cumulus laid as the SVG globe stacks it (shadow, cool underside, body, brighter middle, sunlit core), only where the cloud has room. */
function cloudTasks(sheet: Sheet, input: WorldTextureInput, masks: Masks): Task[] {
  const { target, draw } = sheet;
  const { body, middle, core } = input.world.clouds;
  const { palette } = input;
  const onLand = () => ({ ...draw, clip: masks.cloudRoom });
  return [
    () => fillLoops(target, shifted(body, 4, 7), hexAlpha(CLOUD_SHADOW, 0.22), onLand()),
    () => fillLoops(target, shifted(body, 0, 2), hexAlpha(palette.cloud[1], 0.9), onLand()),
    () => fillLoops(target, body, hexAlpha(palette.cloud[0], 1), onLand()),
    () => fillLoops(target, shifted(middle, -0.6, -1), hexAlpha('#f6f9fd', 1), onLand()),
    () => fillLoops(target, shifted(core, -1.2, -2), hexAlpha('#ffffff', 1), onLand()),
  ];
}

/** A texture being painted a little at a time. */
export interface WorldPainter {
  /**
   * Paints whole layers (the sea and the gas bands a strip at a time) until `budgetMs` milliseconds
   * on the painter's clock have passed, at least one piece each call. Returns true when the texture is finished.
   */
  step(budgetMs: number): boolean;
  /** The finished texture. @throws Error before `step` has returned true. */
  result(): WorldTexture;
}

/**
 * Starts painting one planet's continents into an RGBA image a sphere can wear: x is longitude all
 * round (the band's 480 units), y is the band's row from north (row 0) to south, nothing flipped
 * and painted linearly in band units; the sphere's UVs do the Mercator mapping of
 * `latitudeOfBandY`. Pure: the same world, chart and palette give the same bytes however it is
 * stepped, and the seam is seamless. Nothing runs until `step` is called,
 * so a caller can spread the cost over frames.
 *
 * Formed regions are in colour. Land that is not reached yet is one flat grey, with cloud over it
 * and nowhere else; it is drawn from `chart.unreached` alone, which has no site or id for it, so
 * no site, region id or count goes into the pixels (D-078, D-109). Land is painted like the SVG
 * globe, a gas giant included: its bands lie under the soft land its world has. A globe world
 * carries no veils, so the cloud is the world's own weather (`world.clouds`) kept to unreached land.
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
  // No wrapping: the loops already run 60 units past each edge, as copies of what lies at the other edge, so the
  // texture's own bounds cut them. Wrapping them again would draw the edge where they were cut across the land.
  const sheet: Sheet = {
    target,
    draw: { scale },
    line: ((scale.x + scale.y) / 2) * LINE_WEIGHT,
  };
  const masks: Masks = { charted: new Uint8Array(0), nearUnreached: new Uint8Array(0), cloudRoom: new Uint8Array(0) };
  const tasks = [
    ...waterTasks(sheet, input),
    ...landTasks(sheet, input, masks),
    ...detailTasks(sheet, input, masks),
    ...cloudTasks(sheet, input, masks),
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

/** The whole texture at once: `createWorldPainter` stepped until it is done. */
export function paintWorldTexture(input: WorldTextureInput): WorldTexture {
  const painter = createWorldPainter(input);
  while (!painter.step(Infinity));
  return painter.result();
}
