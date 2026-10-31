import {
  mainSequenceLuminosityAt,
  starlightParts,
  starlightPhysics,
  starlightStar,
  STARLIGHT_ENUMS,
  STARS_BY_TEMPERATURE,
  ZONE_STARS,
  type StarKind,
  type StarlightPart,
  type StarlightState,
} from '../model';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the starlight kit (D-204): what the picture needs to place its parts, worked out
 * from the derived kit state and nothing else. A star's colour, where its glow is strongest, its output, how
 * its light thins with distance, its place on the chart and where each zone lies come from `starlightPhysics`
 * and `starlightStar`; this file only turns them into pixels. The colours are strengthened and the sizes and
 * bars are on stretched scales, which the text version says.
 */

export type StarlightView = StarlightState['view'];

/** The five stars, hottest first: the order of the colour view, left to right. */
export const HOTTEST_FIRST: readonly StarKind[] = [...STARS_BY_TEMPERATURE].reverse();

/** The colour of a star as drawn: its glow's colour with every channel pushed away from grey, so that a Sun-like surface is not lost on the paper. */
export function strengthenColour(hex: string, factor = 3): string {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const mean = channels.reduce((sum, channel) => sum + channel, 0) / 3;
  return `#${channels
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, mean + (channel - mean) * factor)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The strip of the spectrum: wavelengths from `fromNm` to `toNm` over `left` to `right` pixels. */
export const STRIP = { left: 20, right: 300, fromNm: 150, toNm: 850 } as const;
export const stripX = (nanometres: number): number =>
  STRIP.left + ((nanometres - STRIP.fromNm) / (STRIP.toNm - STRIP.fromNm)) * (STRIP.right - STRIP.left);

/** Pixels of radius for a star of radius `radiusInSuns`, on a logarithmic scale (the Sun is 25). */
export function starRadiusPx(radiusInSuns: number): number {
  return 5 + 10 * (Math.log10(radiusInSuns) + 2);
}

/** The bars of the output view: each step of a bar is a factor of ten, `pixelsPerDex` pixels wide, from a middle line. */
export const BARS = { middle: 190, pixelsPerDex: 22 } as const;

/** The chart of stars: temperature (hotter to the left) and output, both logarithmic. */
export const PLOT = { left: 44, right: 300, top: 18, bottom: 158 } as const;
const HOTTEST_ON_CHART = 20000;
const COOLEST_ON_CHART = 3000;
const BRIGHTEST_ON_CHART = 4.8;
const DIMMEST_ON_CHART = -3;

export function chartX(kelvins: number): number {
  const share =
    (Math.log10(HOTTEST_ON_CHART) - Math.log10(kelvins)) /
    (Math.log10(HOTTEST_ON_CHART) - Math.log10(COOLEST_ON_CHART));
  return PLOT.left + share * (PLOT.right - PLOT.left);
}

export function chartY(luminosity: number): number {
  const share = (BRIGHTEST_ON_CHART - Math.log10(luminosity)) / (BRIGHTEST_ON_CHART - DIMMEST_ON_CHART);
  return PLOT.top + share * (PLOT.bottom - PLOT.top);
}

/** The main sequence drawn as a polyline, across the temperatures of the chart. */
const BAND_KELVINS = [3000, 3600, 4500, 6000, 8000, 11000, 15000, 20000] as const;

/** The zones' scale: distance from the star in astronomical units over `left` to `right` pixels, linear. */
export const ZONE_AXIS = { left: 80, right: 300, maxAstronomicalUnits: 6 } as const;
export const zoneX = (astronomicalUnits: number): number =>
  ZONE_AXIS.left + (astronomicalUnits / ZONE_AXIS.maxAstronomicalUnits) * (ZONE_AXIS.right - ZONE_AXIS.left);

/** The frames of the dimming view: where the star sits, how far apart a step is and how wide a cell is. */
export const FRAME = { star: 36, perStep: 54, cell: 14 } as const;

export interface StarlightScene {
  readonly view: StarlightView;
  readonly parts: readonly StarlightPart[];
  readonly focus: StarlightState['focus'];
  /** The five stars, hottest first: the words, their drawn colours, where each glow is strongest on the strip, and the place of each on the chart. */
  readonly kinds: readonly StarKind[];
  readonly colours: readonly string[];
  readonly peakX: readonly number[];
  readonly pointX: readonly number[];
  readonly pointY: readonly number[];
  readonly markedIndex: number;
  /** The main sequence drawn across the chart. */
  readonly bandX: readonly number[];
  readonly bandY: readonly number[];
  /** `output`: the marked star's drawn radius, the Sun-like star's, and the three bars in tens. */
  readonly markedRadiusPx: number;
  readonly referenceRadiusPx: number;
  readonly sizeDex: number;
  readonly heatDex: number;
  readonly outputDex: number;
  /** `dimming`: steps from the star and the share one square catches (against one step away), and the marked frame (0, 1 or 2). */
  readonly steps: number;
  readonly share: number;
  readonly markedFrame: number;
  /** `zone`: each zone's edges in pixels for the three stars, the planet's place (-1 for none) and how each star's zone judges it. */
  readonly zoneInnerX: readonly number[];
  readonly zoneOuterX: readonly number[];
  readonly zoneColours: readonly string[];
  readonly zoneRow: number;
  readonly planetX: number;
  readonly verdicts: readonly string[];
}

/** The scene of a settled starlight state. */
export function starlightSceneOf(state: StarlightState): StarlightScene {
  const physics = starlightPhysics(state);
  const stars = HOTTEST_FIRST.map(starlightStar);
  const zoneIndex = ZONE_STARS.findIndex((kind) => kind === state.star);
  return {
    view: state.view,
    parts: starlightParts(state),
    focus: state.focus,
    kinds: HOTTEST_FIRST,
    colours: stars.map((star) => strengthenColour(star.colour)),
    peakX: stars.map((star) => stripX(star.peakNanometres)),
    pointX: stars.map((star) => chartX(star.kelvins)),
    pointY: stars.map((star) => chartY(star.luminosity)),
    markedIndex: HOTTEST_FIRST.indexOf(state.star),
    bandX: BAND_KELVINS.map(chartX),
    bandY: BAND_KELVINS.map((kelvins) => chartY(mainSequenceLuminosityAt(kelvins))),
    markedRadiusPx: starRadiusPx(physics.star.radius),
    referenceRadiusPx: starRadiusPx(physics.reference.radius),
    sizeDex: physics.sizeDex,
    heatDex: physics.heatDex,
    outputDex: physics.outputDex,
    steps: physics.distanceSteps,
    share: physics.share,
    markedFrame: STARLIGHT_ENUMS.distance.indexOf(state.distance),
    zoneInnerX: ZONE_STARS.map((kind) => zoneX(physics.zones[kind].innerAstronomicalUnits)),
    zoneOuterX: ZONE_STARS.map((kind) => zoneX(physics.zones[kind].outerAstronomicalUnits)),
    zoneColours: ZONE_STARS.map((kind) => strengthenColour(starlightStar(kind).colour)),
    zoneRow: Math.max(0, zoneIndex),
    planetX: physics.planet === undefined ? -1 : zoneX(physics.planet.astronomicalUnits),
    verdicts: ZONE_STARS.map((kind) => physics.planet?.verdicts[kind] ?? 'none'),
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenStarlight(from: StarlightScene, to: StarlightScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpStarlightScene(from: StarlightScene, to: StarlightScene, progress: number): StarlightScene {
  return blendScenes(from, to, progress);
}
