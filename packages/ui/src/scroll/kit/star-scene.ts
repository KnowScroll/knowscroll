import {
  lifetimeInSunLifetimes,
  mainSequenceRadiusInSuns,
  starParts,
  starPhysics,
  STAR_ENUMS,
  surfaceAt,
  type StarEnd,
  type StarMotion,
  type StarPart,
  type StarState,
  type SurfaceTemperature,
} from '../model';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the star kit (D-194): what the picture needs to place its parts, worked out
 * from the derived kit state and nothing else. What gravity and pressure do, a star's colour, size and
 * lifetime and how its life ends come from `starPhysics`; this file only turns them into pixels. Sizes and
 * the lifetime bars are on stretched (logarithmic) scales so that stars of very different mass fit, which
 * the text version says.
 */

export type StarView = StarState['view'];
const MASSES = STAR_ENUMS.mass;

/** Pixels of radius for a main-sequence star, on a logarithmic scale of its radius in Suns (the Sun is 22). */
export function starRadiusPx(radiusInSuns: number): number {
  return 12 + 10 * Math.log2(1 + radiusInSuns);
}

export interface StarScene {
  readonly view: StarView;
  readonly parts: readonly StarPart[];
  readonly focus: StarState['focus'];
  readonly motion: StarMotion;
  /** Gravity's and the pressure's arrows, in units of gravity's. */
  readonly gravity: number;
  readonly pressure: number;
  /** The star's radius in pixels as drawn for the view (a main-sequence star, a giant or what is left). */
  readonly radiusPx: number;
  readonly surface: SurfaceTemperature;
  readonly end: StarEnd;
  readonly stage: StarState['stage'];
  /** The index of the stage among cloud, main sequence, giant and end. */
  readonly stageIndex: number;
  /** For the three stars of `mass`: radius in pixels, and the length of each lifetime bar (0..1, logarithmic). */
  readonly radii: readonly number[];
  readonly lifetimes: readonly number[];
  readonly markedMass: number;
}

/** A giant is this many times the main-sequence star it was; a supergiant (high mass) is larger still. */
const GIANT_PX = { low: 58, 'sun-like': 58, high: 72 } as const;

/** The lifetime bars, each as a share of the longest bar, on a log scale that gives the shortest a visible bar. */
function lifetimeBars(): readonly number[] {
  const logs = MASSES.map((mass) => Math.log10(lifetimeInSunLifetimes(mass)));
  const floor = Math.min(...logs) - 0.6;
  const ceiling = Math.max(...logs);
  return logs.map((log) => (log - floor) / (ceiling - floor));
}

/** The scene of a settled star state. */
export function starSceneOf(state: StarState): StarScene {
  const physics = starPhysics(state);
  const stagePx =
    state.stage === 'giant'
      ? GIANT_PX[state.mass]
      : state.stage === 'end'
        ? state.mass === 'high'
          ? 46
          : 9
        : starRadiusPx(physics.radius);
  return {
    view: state.view,
    parts: starParts(state),
    focus: state.focus,
    motion: physics.motion,
    gravity: physics.gravity,
    pressure: physics.pressure,
    radiusPx: state.view === 'life' ? stagePx : 58,
    surface: state.view === 'life' ? surfaceAt(state.mass, state.stage) : physics.surface,
    end: physics.end,
    stage: state.stage,
    stageIndex: STAR_ENUMS.stage.indexOf(state.stage),
    radii: MASSES.map((mass) => starRadiusPx(mainSequenceRadiusInSuns(mass))),
    lifetimes: lifetimeBars(),
    markedMass: MASSES.indexOf(state.mass),
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenStar(from: StarScene, to: StarScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpStarScene(from: StarScene, to: StarScene, progress: number): StarScene {
  return blendScenes(from, to, progress);
}
