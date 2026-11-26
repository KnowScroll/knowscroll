import type { Chart, GlobeWorld, Loop } from '@knowscroll/scene-core';
import type { PlanetPalette } from '../planet/planet-palette';
import { mixRgb, type Rgb } from '../space/paint';
import { STOPS } from './ladder';
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
import { focalOf, GROUND_FIELD_OF_VIEW, planetDistances, type ViewSize } from './voyage-chains';
import { centreOfCell } from './region-centre';

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
 * Open sea is not painted: those pixels are transparent, and the globe's shader (`globe.ts`) lays the
 * sea under the texture (the prototype's ball gradient from orbit, its flat deep sea on the ground), so
 * the sea can change with the camera. Everything else is painted over nothing, and the finished
 * texture is premultiplied (colour times alpha), so a coast sampled between a sea texel and a land
 * texel mixes to the right colour and never to a dark fringe.
 *
 * The ground has a second, smaller texture, the patch (`groundPatchOf`): the same painter over the same loops, but only
 * for a window of the band round the place the camera comes down over, at a density that suits the ground's lens and
 * with the coast and border lines drawn in screen points (the prototype's caps) instead of band units. So the ground
 * is sharp where you look and is still one drawing with the globe's.
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
/** On the patch a stroke's discs are stamped at least this far apart (pixels), and at most a twelfth of the stroke's width apart. */
const PATCH_MIN_PITCH = 0.5;
const PATCH_PITCH_SHARE = 12;
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

/**
 * What the globe needs of the planet's palette to compose the sea under the texture and to light it. It
 * rides on the finished texture so that the globe, which is only ever handed the texture and three
 * colours, has the palette's own numbers (the four ball stops and the two flat sea stops, hue turned).
 */
export interface WorldLook {
  /** The ball's radial gradient from orbit, light to dark: the palette's `sea`. */
  readonly ball: readonly [string, string, string, string];
  /** The flat sea of the ground, top to bottom of the screen: the palette's `flatSea`. */
  readonly flatSea: readonly [string, string];
  /** The halo of air round the disc. */
  readonly atmosphere: string;
  /** The rim of air at the limb. */
  readonly rim: string;
  /** The polar caps above the band's edges, or null for a planet type whose palette has none (its sea shows there). */
  readonly cap: string | null;
}

/** The look the globe needs of a palette (see {@link WorldLook}); the cap only for a palette that has polar caps. */
export function worldLookOf(palette: PlanetPalette): WorldLook {
  return {
    ball: palette.sea,
    flatSea: palette.flatSea,
    atmosphere: palette.atmosphere,
    rim: palette.rim,
    cap: palette.poleCaps ? palette.cloud[0] : null,
  };
}

/**
 * The pixels of a finished texture: RGBA with premultiplied alpha (open sea is 0,0,0,0), row 0 at the
 * north edge of the band, and the palette's look.
 */
export type WorldTexture = PixelTarget & { readonly look?: WorldLook };

/**
 * A rectangle of the band, in band units: `x` is the left edge and may be negative, or the window may run past
 * `BAND_WIDTH`, where it wraps round the seam (the world's loops run 60 units past each edge, so a window up to 60 units
 * either side of the seam is painted straight from them); `y` is the top edge.
 */
export interface BandWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a window needs of the camera to be painted as the ground draws it: how many layout points one radian of arc
 * measures on screen where the camera looks straight down. The line widths in points of {@link GROUND_LINE_POINTS} are
 * turned into pixels from it (a band unit is `cos(latitude) / BAND_UNITS_PER_RADIAN` radians, so lines keep their
 * width in points from the equator to the poles).
 */
export interface PatchSpec {
  readonly window: BandWindow;
  readonly pointsPerRadian: number;
}

/** What the texture is painted from: the planet's world, its chart (which regions have formed), its palette and the size to paint at. */
export interface WorldTextureInput {
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** The pixels of the texture. With a `patch` they are the pixels of its window. */
  readonly width: number;
  readonly height: number;
  /**
   * Paint only this window of the band, with its lines at the ground's widths in points ({@link GROUND_LINE_POINTS}),
   * instead of the whole band with the globe's. Same loops, palette, colours and rules, so it is one drawing with the
   * whole-band texture; `width` and `height` should have the window's proportions so a texel is square.
   */
  readonly patch?: PatchSpec;
}

/**
 * The widths of the ground's lines, in layout points, as the prototype caps them (`drawGlobe`, `Universe.dc.html` lines
 * 1323 to 1334, `clamp(R * k, lo, hi)` at the ground's radius): the pale shelf 22 across (half of it under the land), its
 * hot glow 13, the foam 7, the coast's ink 2 and the border between regions 1.8.
 */
export const GROUND_LINE_POINTS = { shelf: 22, glow: 13, foam: 7, ink: 2, border: 1.8 } as const;

/** The widths of the lines the painter strokes, in pixels, for the rows of one task. */
interface StrokeWidths {
  /** The pale shelf off the coast, drawn only on the ground patch (the globe fills the world's shallows instead). */
  readonly shelf: number;
  /** The orange glow of a coast that has one. */
  readonly glow: number;
  /** The foam along the coast. */
  readonly foam: number;
  /** The ink of the coast and of the grey coast of land not reached, and how far the masks reach round it. */
  readonly ink: number;
  /** The ink between formed regions. */
  readonly border: number;
}

/** What the painting tasks draw into: the image, how world units map onto it and how thick a line is. */
interface Sheet {
  readonly target: PixelTarget;
  readonly draw: DrawOptions & {
    readonly scale: { readonly x: number; readonly y: number };
    readonly origin: { readonly x: number; readonly y: number };
  };
  /** How thick each line is, in pixels, for the rows of one task (on the patch a line's width follows the latitude of its rows). */
  readonly widths: (rows: RowRange) => StrokeWidths;
  /**
   * The options of a stroke `width` pixels wide: the width, and on the patch a coarser pitch for a wide line, since a
   * disc stamped every half pixel along a 30-pixel shelf would take most of the patch's time.
   */
  readonly stroke: (width: number) => { readonly width: number; readonly pitch?: number };
  /** True on the ground patch, which strokes its shelf in points and inks the borders as the prototype's ground does. */
  readonly ground: boolean;
}

/**
 * The latitude, in radians north of the equator, of band row `y` (0 at the top, `BAND_HEIGHT` at the
 * bottom). The band is a Mercator strip: a unit is the same length north as east at every latitude, so
 * a continent keeps its shape on the sphere. The band's edges lie at about +-79.2 degrees.
 */
export function latitudeOfBandY(y: number): number {
  return 2 * Math.atan(Math.exp((BAND_HEIGHT / 2 - y) / BAND_UNITS_PER_RADIAN)) - Math.PI / 2;
}

/** The band row of a latitude in radians, kept within the band: the inverse of {@link latitudeOfBandY}. */
export function bandYOfLatitude(latitude: number): number {
  const y = BAND_HEIGHT / 2 - BAND_UNITS_PER_RADIAN * Math.log(Math.tan(Math.PI / 4 + latitude / 2));
  return Math.min(BAND_HEIGHT, Math.max(0, y));
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
 * The place for the name of each formed region (and its tap target, where the camera comes down over it and where the
 * ship stands on it), in the order of the chart: a point well inside its land ({@link regionCentre}), not the
 * generator's label, which is often on the shore. Only formed regions have one: land that is not reached yet has no
 * name and so no point.
 */
export function labelPoints(chart: Chart): readonly LabelPoint[] {
  return chart.charted.map((cell) => {
    const { objectId } = cell;
    const centre = centreOfCell(cell, BAND_WIDTH);
    return {
      objectId,
      // A region that crosses the band's seam has loops past its edges; its column wraps like the band.
      x: ((centre.x % BAND_WIDTH) + BAND_WIDTH) % BAND_WIDTH,
      lat: latitudeOfBandY(centre.y),
    };
  });
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
    const wave = gasWave((column + 0.5) / draw.scale.x + draw.origin.x);
    for (let band = 0; band < GAS_BAND_COUNT; band++)
      tops[band] = Math.ceil((band * GAS_BAND_HEIGHT + wave - draw.origin.y) * draw.scale.y - 0.5);
    // The first band runs up to the top edge: a gas giant has no sea to show above it.
    tops[0] = Number.NEGATIVE_INFINITY;
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
  /**
   * Pixels where cloud may lie: sea and land not reached, but never a formed region, a coast line's width round
   * one (so its ink and foam stay readable) or the place its name goes.
   */
  cloudRoom: Uint8Array;
  /** Pixels inside land not reached, kept only to make the other masks. */
  unreachedLand: Uint8Array;
}

/** How far round the point a formed region is named at (and tapped) the cloud keeps off, in band units. */
const LABEL_CLEAR = 10;
/** The pale shelf off the coast on the ground: the prototype's `rgba(255,255,255,0.2)`. */
const GROUND_SHELF: Rgba = [255, 255, 255, 0.2];

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
 * The bands of a gas giant, the water off the coast, the coast's glow where a planet has one, and the
 * foam line (open sea is left transparent, for the globe's shader to fill): the SVG globe's `Land` up to
 * the coast, in its order, with its alphas and widths
 * (shallows 0.35 each, glow `#ffb03a` 6 wide at 0.8, foam 3.6 wide at 0.85). The prototype draws the
 * same three strokes in `drawGlobe`: a shelf, a hot line where the palette glows, then foam.
 */
function waterTasks(sheet: Sheet, input: WorldTextureInput): Task[] {
  const { target, draw, widths, stroke, ground } = sheet;
  const { world, palette } = input;
  const glow = hexAlpha('#ffb03a', 0.8);
  return [
    ...(palette.bands
      ? rangesOf(target.width, GAS_COLUMNS_PER_TASK).map(
          ({ from, to }) =>
            () =>
              paintGasBands(sheet, palette.bands!, from, to),
        )
      : []),
    // The globe's shelf is the world's shallows filled; the ground's is the coast stroked at a width in points, as the
    // prototype's `drawGlobe` strokes it: white at 0.2, half of it under the land, so the deep sea shows a pale band
    // along the coast and then the foam. A fill would be dozens of points wide there.
    ...(ground
      ? rowTasks(target, (rows) =>
          strokeLoops(target, world.land, GROUND_SHELF, { ...draw, rows, ...stroke(widths(rows).shelf) }),
        )
      : [
          ...rowTasks(target, (rows) =>
            fillLoops(target, world.shallowWide, hexAlpha(palette.shallow, 0.35), { ...draw, rows }),
          ),
          ...rowTasks(target, (rows) =>
            fillLoops(target, world.shallow, hexAlpha(palette.foam, 0.35), { ...draw, rows }),
          ),
        ]),
    ...(palette.glowCoast
      ? rowTasks(target, (rows) =>
          strokeLoops(target, world.land, glow, { ...draw, rows, ...stroke(widths(rows).glow) }),
        )
      : []),
    ...rowTasks(target, (rows) =>
      strokeLoops(target, world.land, hexAlpha(palette.foam, 0.85), { ...draw, rows, ...stroke(widths(rows).foam) }),
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
  const { target, draw, widths, stroke } = sheet;
  const { chart } = input;
  const charted = chartedShapes(chart);
  const unreached = unreachedShapes(chart);
  const unreachedEdges = unreachedLoops(chart);
  const chartedEdges = chart.charted.flatMap((cell) => cell.loops);
  // Each name's place on the band ({@link labelPoints}), with its copies a whole turn either side so a name by the
  // seam is kept clear too.
  const places = chart.charted.flatMap((cell) => {
    const centre = centreOfCell(cell, BAND_WIDTH);
    return [-BAND_WIDTH, 0, BAND_WIDTH].map((turn) => ({ x: centre.x + turn, y: centre.y }));
  });
  return rowTasks(target, (rows) => {
    maskShapes(target, charted, { ...draw, rows, into: masks.charted });
    maskShapes(target, unreached, { ...draw, rows, into: masks.unreachedLand });
    const { ink } = widths(rows);
    const edge = strokeCover(target, unreachedEdges, { ...draw, rows, ...stroke(ink) });
    const coast = strokeCover(target, chartedEdges, { ...draw, rows, ...stroke(ink) });
    const first = rows.from * target.width;
    for (let at = 0; at < edge.length; at++) {
      const pixel = first + at;
      const land = masks.unreachedLand[pixel] !== 0;
      const near = land || edge[at] !== 0;
      masks.nearUnreached[pixel] = near ? 1 : 0;
      masks.awayFromUnreached[pixel] = near ? 0 : 1;
      masks.cloudRoom[pixel] = masks.charted[pixel] === 0 && coast[at] === 0 ? 1 : 0;
    }
    // Keep the cloud off the places the names go: the pixels of each label's disc that lie in these rows.
    for (const place of places) {
      const rowsOf = Math.max(rows.from, Math.floor((place.y - LABEL_CLEAR - draw.origin.y) * draw.scale.y));
      const rowsTo = Math.min(rows.to, Math.ceil((place.y + LABEL_CLEAR - draw.origin.y) * draw.scale.y));
      for (let row = rowsOf; row < rowsTo; row++) {
        const down = (row + 0.5) / draw.scale.y + draw.origin.y - place.y;
        const half = Math.sqrt(Math.max(0, LABEL_CLEAR * LABEL_CLEAR - down * down));
        const from = Math.max(0, Math.ceil((place.x - half - draw.origin.x) * draw.scale.x - 0.5));
        const to = Math.min(target.width, Math.ceil((place.x + half - draw.origin.x) * draw.scale.x - 0.5));
        for (let column = from; column < to; column++) masks.cloudRoom[row * target.width + column] = 0;
      }
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
  const { target, draw, widths, stroke, ground } = sheet;
  const { world, chart, palette } = input;
  const ink = hexAlpha(palette.ink, 0.7);
  const grey = hexAlpha(palette.grey[2], 0.6);
  // The prototype's region border is 0.45 from orbit and 0.7 on the ground (`lerp(0.45, 0.7, flat)`).
  const border = hexAlpha(palette.ink, ground ? 0.7 : 0.45);
  return [
    ...rowTasks(target, (rows) =>
      fillLoops(target, world.lowland, hexAlpha(palette.lowland, 0.6), { ...draw, rows, clip: masks.charted }),
    ),
    ...rowTasks(target, (rows) =>
      fillLoops(target, world.highland, hexAlpha(palette.highland, 0.62), { ...draw, rows, clip: masks.charted }),
    ),
    ...rowTasks(target, (rows) =>
      strokeLoops(target, world.land, ink, {
        ...draw,
        rows,
        clip: masks.awayFromUnreached,
        ...stroke(widths(rows).ink),
      }),
    ),
    ...rowTasks(target, (rows) =>
      strokeLoops(target, world.land, grey, { ...draw, rows, clip: masks.nearUnreached, ...stroke(widths(rows).ink) }),
    ),
    ...chart.charted.flatMap((cell) =>
      rowTasks(target, (rows) =>
        strokeLoops(target, cell.loops, border, { ...draw, rows, ...stroke(widths(rows).border) }),
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

/** Colour times alpha, in place, for the rows given: the last thing painted, so every layer above blended in straight alpha. */
function premultiply(target: PixelTarget, rows: RowRange): void {
  const { data } = target;
  for (let at = rows.from * target.width * 4; at < Math.min(rows.to, target.height) * target.width * 4; at += 4) {
    const alpha = data[at + 3]!;
    if (alpha === 255) continue;
    data[at] = Math.round((data[at]! * alpha) / 255);
    data[at + 1] = Math.round((data[at + 1]! * alpha) / 255);
    data[at + 2] = Math.round((data[at + 2]! * alpha) / 255);
  }
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
 * Formed regions are in colour. Land that is not reached yet is one flat grey; it is drawn from
 * `chart.unreached` alone, which has no site or id for it, so no site, region id or count goes into the
 * pixels. Open sea is left transparent. Land is painted like the SVG globe, a gas giant included: its
 * bands (opaque, to the top) lie under the soft land its world has. A globe world carries no veils, so
 * the cloud is the world's own weather (`world.clouds`), over the sea and the grey land and never over
 * formed land. The finished texture is premultiplied and carries the palette's `look`.
 *
 * With `input.patch` it paints only that window of the band (see {@link WorldTextureInput.patch}) into its own pixel array,
 * the same layers in the same order, so the result matches the whole-band texture where both cover the same land.
 *
 * @param now the clock `step` measures its budget by, in milliseconds. Default `performance.now`.
 */
export function createWorldPainter(
  input: WorldTextureInput,
  now: () => number = () => performance.now(),
): WorldPainter {
  const { world, width, height, palette, patch } = input;
  const target: PixelTarget = { width, height, data: new Uint8Array(width * height * 4) };
  const finished: WorldTexture = { ...target, look: worldLookOf(palette) };
  const origin = patch === undefined ? { x: 0, y: 0 } : { x: patch.window.x, y: patch.window.y };
  const scale =
    patch === undefined
      ? { x: width / world.width, y: height / world.height }
      : { x: width / patch.window.width, y: height / patch.window.height };
  // Nothing wraps round the seam: the world's loops already run 60 units past each edge, as copies of what lies at
  // the other edge, so the texture's own bounds cut them. Wrapping them again would draw the edge where they were
  // cut across the land. A patch window that crosses the seam is just a window that reaches past 0 or the band's width.
  const line = ((scale.x + scale.y) / 2) * LINE_WEIGHT;
  const sheet: Sheet = {
    target,
    draw: { scale, origin },
    ground: patch !== undefined,
    stroke:
      patch === undefined
        ? (width) => ({ width })
        : (width) => ({ width, pitch: Math.max(PATCH_MIN_PITCH, width / PATCH_PITCH_SHARE) }),
    widths:
      patch === undefined
        ? () => ({ shelf: 0, glow: 6 * line, foam: 3.6 * line, ink: 1.4 * line, border: line })
        : (rows) => {
            // Points to pixels at the latitude of these rows: a band unit is cos(latitude) / K radians long.
            const row = patch.window.y + (rows.from + rows.to) / 2 / scale.y;
            const pointsPerUnit = (patch.pointsPerRadian * Math.cos(latitudeOfBandY(row))) / BAND_UNITS_PER_RADIAN;
            const pixelsPerPoint = (scale.x + scale.y) / 2 / pointsPerUnit;
            return {
              shelf: GROUND_LINE_POINTS.shelf * pixelsPerPoint,
              glow: GROUND_LINE_POINTS.glow * pixelsPerPoint,
              foam: GROUND_LINE_POINTS.foam * pixelsPerPoint,
              ink: GROUND_LINE_POINTS.ink * pixelsPerPoint,
              border: GROUND_LINE_POINTS.border * pixelsPerPoint,
            };
          },
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
    ...rowTasks(target, (rows) => premultiply(target, rows)),
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
      return finished;
    },
  };
}

/** The density the ground patch aims at, in texels for each layout point on screen where the camera looks straight down. */
export const PATCH_TEXELS_PER_POINT = 1.5;
/** The most pixels a patch has (1536 by 1536), so it is painted in a fraction of a second of 4 ms slices and weighs a few MB. */
const PATCH_MAX_TEXELS = 1536 * 1536;
/** The longest side of a patch, in texels: inside what every phone's GPU takes as a texture. */
const PATCH_MAX_SIDE = 2048;
/** How far either side of the landing a patch reaches, at most: the loops run this far past the band's seam. */
const PATCH_MAX_HALF_WIDTH = 60;
/** The margin round the screen the patch covers, as a share of the screen's height, so turning the ground a little stays inside it. */
const PATCH_MARGIN = 0.12;
/** How many points are sampled along each side of the screen to find the ground it shows. */
const PATCH_EDGE_SAMPLES = 16;
/** The least share of the screen (round the landing) a patch is cut down to before its density gives instead. */
const PATCH_LEAST_SHARE = 0.25;

/** The window of the band the ground patch covers, the pixels to paint it at, and the scale of the ground it was made for. */
export interface GroundPatch extends PatchSpec {
  readonly width: number;
  readonly height: number;
  /** How much of the screen's reach (margin included) the window covers: 1 when the whole of it fits within the limits, less when it is cut to them. */
  readonly share: number;
}

/**
 * The patch to paint for a camera that comes down over `landing` (a band column and a latitude in radians, as a
 * region's {@link LabelPoint}) on a screen of `size`: the window of the band the ground's lens shows round it, with a
 * margin, and how many texels to paint it at.
 *
 * The camera looks straight down at the landing from `planetDistances(1, size).ground` radii through the ground's field
 * of view, so a screen point at `r` points from the landing's own is the point of the sphere `asin(d sin a) - a` of arc
 * from it (`a = atan(r / focal)`), at the screen point's bearing; the window is the box, in band units, round such
 * points all along the screen's edge (held up by the ground stop's `heldAt`, plus the margin), and ground past the limb
 * counts as the limb. A band unit is `cos(latitude) / BAND_UNITS_PER_RADIAN` radians, so the density is
 * {@link PATCH_TEXELS_PER_POINT} texels a point at the landing's latitude, one texel the same in both directions.
 * Ground seen at a slant is squeezed on screen, so the box a whole screen shows is larger than a texture of that
 * density may be (`PATCH_MAX_TEXELS`, `PATCH_MAX_SIDE`): then the screen's reach is cut down round the landing until the
 * box fits, so the middle of the screen, where the ground is flattest and the globe's own texture is softest, keeps
 * its density and the edge of the screen is left to the globe (the shader blends them). Pure.
 */
export function groundPatchOf(
  landing: { readonly x: number; readonly lat: number },
  size: ViewSize,
  heldAt: number = STOPS.ground.heldAt,
): GroundPatch {
  const focal = focalOf(size, GROUND_FIELD_OF_VIEW);
  const distance = planetDistances(1, size).ground;
  const pointsPerRadian = focal / (distance - 1);
  const limb = Math.acos(1 / distance);
  const pad = PATCH_MARGIN * size.height;
  const reach = {
    left: size.width / 2 + pad,
    right: size.width / 2 + pad,
    up: heldAt * size.height + pad,
    down: (1 - heldAt) * size.height + pad,
  };
  const sinLat = Math.sin(landing.lat);
  const cosLat = Math.cos(landing.lat);
  // The texels for a band unit: the density at the landing's latitude.
  const texelsPerUnit = (PATCH_TEXELS_PER_POINT * pointsPerRadian * cosLat) / BAND_UNITS_PER_RADIAN;
  /** The arc of the sphere (radians) from the landing to the ground `points` from its place on screen; ground past the limb counts as the limb. */
  const arcAt = (points: number) => {
    const angle = Math.atan(points / focal);
    const seen = distance * Math.sin(angle);
    return seen >= 1 ? limb : Math.min(limb, Math.asin(seen) - angle);
  };
  /** The box of the band that the screen's edge shows, when the screen reaches `share` of the way to its margin's edge. */
  const boxAt = (share: number) => {
    let eastMost = 0;
    let westMost = 0;
    let northMost = landing.lat;
    let southMost = landing.lat;
    const look = (across: number, up: number) => {
      const arc = arcAt(Math.hypot(across, up));
      const bearing = Math.atan2(across, up);
      const lat = Math.asin(
        Math.max(-1, Math.min(1, sinLat * Math.cos(arc) + cosLat * Math.sin(arc) * Math.cos(bearing))),
      );
      const turn = Math.atan2(Math.sin(bearing) * Math.sin(arc) * cosLat, Math.cos(arc) - sinLat * Math.sin(lat));
      eastMost = Math.max(eastMost, turn);
      westMost = Math.min(westMost, turn);
      northMost = Math.max(northMost, lat);
      southMost = Math.min(southMost, lat);
    };
    const [left, right, up, down] = [reach.left, reach.right, reach.up, reach.down].map((value) => value * share) as [
      number,
      number,
      number,
      number,
    ];
    for (let step = 0; step <= PATCH_EDGE_SAMPLES; step++) {
      const along = step / PATCH_EDGE_SAMPLES;
      look(-left + along * (left + right), up);
      look(-left + along * (left + right), -down);
      look(-left, -down + along * (down + up));
      look(right, -down + along * (down + up));
    }
    // A pole in view is the extreme of its side, though no sample of the screen's edge is there.
    if (landing.lat + arcAt(up) >= Math.PI / 2) northMost = Math.PI / 2;
    if (landing.lat - arcAt(down) <= -Math.PI / 2) southMost = -Math.PI / 2;
    const west = Math.max(landing.x + westMost * BAND_UNITS_PER_RADIAN, landing.x - PATCH_MAX_HALF_WIDTH);
    const east = Math.min(landing.x + eastMost * BAND_UNITS_PER_RADIAN, landing.x + PATCH_MAX_HALF_WIDTH);
    const north = bandYOfLatitude(northMost);
    const south = bandYOfLatitude(southMost);
    return { west, east, north, south, across: Math.max(1, east - west), down: Math.max(1, south - north) };
  };
  const fits = (box: { across: number; down: number }, density: number) =>
    // A texel of slack on each side, for the whole texels the window is rounded up to.
    (box.across * density + 1) * (box.down * density + 1) <= PATCH_MAX_TEXELS &&
    Math.max(box.across, box.down) * density + 1 <= PATCH_MAX_SIDE;
  let share = 1;
  let box = boxAt(share);
  let density = texelsPerUnit;
  if (!fits(box, density)) {
    // The largest share of the screen's reach whose box fits, by bisection (a box only grows with the share).
    let low = PATCH_LEAST_SHARE;
    let high = 1;
    if (fits(boxAt(low), density)) {
      for (let round = 0; round < 12; round++) {
        const middle = (low + high) / 2;
        if (fits(boxAt(middle), density)) low = middle;
        else high = middle;
      }
    }
    share = low;
    box = boxAt(share);
    // Even the least share does not fit (a big, near-equatorial screen): give up density, not the middle.
    if (!fits(box, density))
      density *= Math.min(
        Math.sqrt((PATCH_MAX_TEXELS - 8192) / (box.across * box.down * density * density)),
        (PATCH_MAX_SIDE - 2) / (Math.max(box.across, box.down) * density),
      );
  }
  const width = Math.max(1, Math.ceil(box.across * density));
  const height = Math.max(1, Math.ceil(box.down * density));
  // A whole number of texels about the same middle, so a texel is square.
  const unitsAcross = width / density;
  const unitsDown = height / density;
  return {
    window: {
      x: (box.west + box.east) / 2 - unitsAcross / 2,
      // Rounded up to whole texels about the middle, but never off the band's edge.
      y: Math.min(Math.max(0, (box.north + box.south) / 2 - unitsDown / 2), Math.max(0, BAND_HEIGHT - unitsDown)),
      width: unitsAcross,
      height: unitsDown,
    },
    width,
    height,
    pointsPerRadian,
    share,
  };
}
