import {
  brightnessAt,
  PLANET_WIDTH_SHARE,
  transitParts,
  transitPhysics,
  type TransitPart,
  type TransitState,
} from '../model';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the transit kit (D-194): what the picture needs to place its parts, worked out
 * from the derived kit state and nothing else. How much of the star the planet covers and the whole light
 * curve come from `transitPhysics` and `brightnessAt`; this file only samples them and turns them into
 * pixels, so a picture cannot disagree with the text version of the same state. The dip is enlarged for the
 * picture (`DIP_ENLARGEMENT`), which the text version says.
 */

export type TransitView = TransitState['view'];

/** How much taller the graph draws the dip than its true share of the star's light. */
export const DIP_ENLARGEMENT = 10;

/** The graph spans this many star radii either side of the star's centre. */
export const CURVE_HALF_SPAN = 2.6;
export const CURVE_SAMPLES = 61;

export interface TransitScene {
  readonly view: TransitView;
  readonly parts: readonly TransitPart[];
  readonly focus: TransitState['focus'];
  /** The planet's width as a share of the star's, and its place along the crossing in star radii. */
  readonly widthShare: number;
  readonly separation: number;
  /** Where the planet is round its orbit (degrees from the line to us) and whether it is in front of the star. */
  readonly orbitDegrees: number;
  readonly blocking: boolean;
  /** The star's brightness now (1 is unblocked). */
  readonly brightness: number;
  /** The light curve of the shown planet, sampled across the crossing: brightness at each sample. */
  readonly curve: readonly number[];
  /** The light curves of the small and the large planet, for `compare`, and the two planets' widths for the legend. */
  readonly smallCurve: readonly number[];
  readonly largeCurve: readonly number[];
  readonly smallWidth: number;
  readonly largeWidth: number;
}

function curveOf(widthShare: number): readonly number[] {
  return Array.from({ length: CURVE_SAMPLES }, (_, index) => {
    const separation = -CURVE_HALF_SPAN + (index * 2 * CURVE_HALF_SPAN) / (CURVE_SAMPLES - 1);
    return brightnessAt(widthShare, separation);
  });
}

/** The scene of a settled transit state. */
export function transitSceneOf(state: TransitState): TransitScene {
  const physics = transitPhysics(state);
  return {
    view: state.view,
    parts: transitParts(state.view),
    focus: state.focus,
    widthShare: physics.widthShare,
    separation: physics.separation,
    orbitDegrees: physics.orbitDegrees,
    blocking: physics.blocking,
    brightness: physics.brightness,
    curve: curveOf(physics.widthShare),
    smallCurve: curveOf(PLANET_WIDTH_SHARE.small),
    largeCurve: curveOf(PLANET_WIDTH_SHARE.large),
    smallWidth: PLANET_WIDTH_SHARE.small,
    largeWidth: PLANET_WIDTH_SHARE.large,
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenTransit(from: TransitScene, to: TransitScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpTransitScene(from: TransitScene, to: TransitScene, progress: number): TransitScene {
  return blendScenes(from, to, progress, ['orbitDegrees']);
}
