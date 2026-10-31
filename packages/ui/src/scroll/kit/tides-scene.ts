import {
  moonPull,
  SOLAR_SHARE_OF_LUNAR,
  tideRangeByPhase,
  TIDES_ENUMS,
  tidesParts,
  tidesPhysics,
  type TidesPart,
  type TidesState,
  type TideKind,
} from '../model';
import { onCircle, type Point } from './earth-sky-scene';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the tides kit (D-194): what the picture needs to place its parts, worked
 * out from the derived kit state and nothing else. Which way the bulges point, how tall the combined ones
 * are, spring or neap and the size of each phase's tide come from `tidesPhysics`, `moonPull` and
 * `tideRangeByPhase`; this file only turns those answers into lengths and angles, so a picture cannot
 * disagree with the text version of the same state.
 */

export type TidesView = TidesState['view'];

/** How much the differences in the Moon's pull are enlarged for the picture: they are a few parts in a hundred. */
export const PULL_ENLARGEMENT = 10;

export interface TidesScene {
  readonly view: TidesView;
  readonly parts: readonly TidesPart[];
  readonly focus: TidesState['focus'];
  /** Directions of the Moon and the Sun, degrees anticlockwise from the right (the Sun is at the left). */
  readonly moonDegrees: number;
  readonly sunDegrees: number;
  /** Bulge heights in units of the Moon's own: the Moon's, the Sun's and the combined tide's. */
  readonly moonHeight: number;
  readonly sunHeight: number;
  readonly combinedHeight: number;
  /** The line of the combined bulges, degrees. */
  readonly combinedAxis: number;
  readonly kind: TideKind;
  /** Length of the Moon's pull on the near side and the far side, in units of its pull at Earth's centre (differences enlarged). */
  readonly pullNear: number;
  readonly pullFar: number;
  /** The pull that is left over once the centre's is taken away: toward the Moon on the near side, away from it on the far side, the larger one being 1. */
  readonly differenceNear: number;
  readonly differenceFar: number;
  /** The size of the tide at each phase in the order of the phases, the greatest being 1, and the index of the phase shown. */
  readonly bars: readonly number[];
  readonly current: number;
}

const ANGLES = ['moonDegrees', 'sunDegrees', 'combinedAxis'] as const;

/** The scene of a settled tides state. */
export function tidesSceneOf(state: TidesState): TidesScene {
  const parts = tidesParts(state.view);
  const physics = tidesPhysics(state);
  const pull = moonPull();
  const nearDifference = pull.near - pull.centre;
  const farDifference = pull.centre - pull.far;
  const largest = Math.max(nearDifference, farDifference);
  const ranges = tideRangeByPhase();
  const phaseMatters = parts.includes('phase');
  return {
    view: state.view,
    parts,
    focus: state.focus,
    moonDegrees: phaseMatters ? physics.moonDegrees : 0,
    sunDegrees: physics.sunDegrees,
    moonHeight: 1,
    sunHeight: SOLAR_SHARE_OF_LUNAR,
    combinedHeight: phaseMatters ? physics.combined.amplitude : 1,
    combinedAxis: phaseMatters ? physics.combined.axisDegrees : 0,
    kind: physics.kind,
    pullNear: 1 + PULL_ENLARGEMENT * (pull.near - pull.centre),
    pullFar: 1 + PULL_ENLARGEMENT * (pull.far - pull.centre),
    differenceNear: nearDifference / largest,
    differenceFar: farDifference / largest,
    bars: TIDES_ENUMS.moonAt.map((phase) => ranges[phase]),
    current: TIDES_ENUMS.moonAt.indexOf(state.moonAt),
  };
}

/**
 * The two ends of the bulges at `distance` from `centre`: the one on the side that faces the Moon and the
 * one opposite. They lie along the Moon's own direction, never along the combined tide's axis, which is
 * a line and has no side (it is the same line a half turn on).
 */
export function bulgeTips(
  scene: Pick<TidesScene, 'moonDegrees'>,
  centre: Point,
  distance: number,
): { near: Point; far: Point } {
  return {
    near: onCircle(centre, distance, scene.moonDegrees),
    far: onCircle(centre, distance, scene.moonDegrees + 180),
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenTides(from: TidesScene, to: TidesScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpTidesScene(from: TidesScene, to: TidesScene, progress: number): TidesScene {
  return blendScenes(from, to, progress, ANGLES);
}
