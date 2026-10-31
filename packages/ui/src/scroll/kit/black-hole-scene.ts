import {
  BLACK_HOLE_ENUMS,
  blackbodyColour,
  blackHoleParts,
  blackHolePhysics,
  DISC_INNER_EDGE_IN_HORIZON_RADII,
  DISC_RINGS,
  discKelvins,
  HOLE_MASS_IN_SUNS,
  ORBIT_RADII,
  orbitSpeed,
  pullAt,
  separationAt,
  SHADOW_RADIUS_IN_HORIZON_RADII,
  TIME_TO_MERGER,
  waveFrequencyAt,
  waveStrengthAt,
  type BlackHolePart,
  type BlackHoleState,
} from '../model';
import { blendScenes } from './blend';
import { strengthenColour } from './starlight-scene';

/**
 * The drawing parameters of the black-hole kit (D-204): what the picture needs to place its parts, worked out
 * from the derived kit state and nothing else. The horizon's size comes from the mass, the orbits from
 * Kepler's law, the disc's heat from its radius, the shadow's size from the horizon's and the chirp from the
 * time to merger (`black-hole.ts`); this file only turns them into pixels. It draws nothing at a black hole's
 * centre, and it draws the shadow and the horizon as two different things.
 */

export type BlackHoleView = BlackHoleState['view'];

/** The stages of a star's end, in order. */
const STAGES = BLACK_HOLE_ENUMS.stage;

/** The horizon radius, in pixels, of the smaller of the two black holes of the horizon view; the larger is drawn to scale. */
export const SMALL_HORIZON_PX = 13;
/** The pull view: the star and the black hole have the same mass (that of the smaller hole), the object is far from both, and an arrow of this length stands for the pull of that mass there. */
export const PULL = {
  starMassInSuns: HOLE_MASS_IN_SUNS.small,
  holeMassInSuns: HOLE_MASS_IN_SUNS.small,
  distanceMetres: 1e12,
} as const;
export const PULL_ARROW_PX = 30;
/** Pixels of orbit radius for each unit of `ORBIT_RADII`, and of arrow for the speed of the nearest star. */
export const ORBIT_PX = 20;
export const ORBIT_ARROW_PX = 22;
/** The disc: pixels for each inner edge of radius, and how flat the tilted disc is drawn. */
export const DISC_PX = 14;
export const DISC_FLATNESS = 0.38;
/** The disc's temperatures are scaled down by this much to make the false colour of its glow, so the hottest is blue-white and the coolest orange. */
export const FALSE_COLOUR_DIVISOR = 700;
/** The shadow's horizon radius in pixels. */
export const SHADOW_HORIZON_PX = 22;
/** The graph of the waves: x pixels over the time shown (merger at time one, then a short ringdown) and the baseline. */
export const WAVES = {
  left: 20,
  right: 300,
  baseline: 142,
  height: 34,
  samples: 480,
  ringdownEnd: 1.15,
  lastBefore: 0.002,
} as const;
/** The first frequency of the chirp, in cycles over the time shown. Illustrative. */
const FIRST_CYCLES = 6;

export interface BlackHoleScene {
  readonly view: BlackHoleView;
  readonly parts: readonly BlackHolePart[];
  readonly focus: BlackHoleState['focus'];
  /** `formation`: 1 for the massive star, 0 for one like the Sun; the stage (0 to 2); the star's drawn radius, its core's and the strength of gravity and the pressure. */
  readonly massive: number;
  readonly stageIndex: number;
  readonly starRadiusPx: number;
  readonly coreRadiusPx: number;
  readonly gravity: number;
  readonly pressure: number;
  /** `horizon`: 1 for the larger hole marked, and the radii of the two holes in pixels, to scale. */
  readonly largeMarked: number;
  readonly smallHolePx: number;
  readonly largeHolePx: number;
  /** `pull`: the pull of a star and of a black hole of the same mass, each against the other's (both one). */
  readonly starPull: number;
  readonly holePull: number;
  /** `orbits`: the radii in pixels, the arrow of each star's speed in pixels and the star's place round its orbit in degrees. */
  readonly orbitPx: readonly number[];
  readonly speedPx: readonly number[];
  readonly orbitDegrees: readonly number[];
  /** `disc`: the outer radius of each ring in pixels, their false colours and the hole's radius. */
  readonly ringPx: readonly number[];
  readonly ringInnerPx: readonly number[];
  readonly ringColours: readonly string[];
  readonly diskHolePx: number;
  /** `waves`: how far apart the two holes are in pixels, the angle of the pair, whether they have merged, the wave across the whole graph, and how far along it the picture is (0 to 1). */
  readonly separationPx: number;
  readonly pairDegrees: number;
  readonly merged: number;
  readonly wave: readonly number[];
  readonly nowShare: number;
  readonly mergerShare: number;
  /** `shadow`: the shadow's radius and the horizon's in pixels, to scale. */
  readonly shadowPx: number;
  readonly shadowHorizonPx: number;
}

/** The whole chirp across the graph: height at each sample, from the first part to the merger and the ringdown. */
export function chirpWave(): readonly number[] {
  const lastBefore = WAVES.lastBefore;
  const strongest = waveStrengthAt(lastBefore);
  const startFrequency = FIRST_CYCLES;
  const phaseAt = (timeToMerger: number): number =>
    2 * Math.PI * startFrequency * (8 / 5) * (1 - timeToMerger ** (5 / 8));
  const finalFrequency = startFrequency * waveFrequencyAt(lastBefore);
  const finalPhase = phaseAt(lastBefore);
  return Array.from({ length: WAVES.samples }, (_, index) => {
    const time = (index / (WAVES.samples - 1)) * WAVES.ringdownEnd;
    if (time < 1 - lastBefore) return (waveStrengthAt(1 - time) / strongest) * Math.sin(phaseAt(1 - time));
    const since = time - (1 - lastBefore);
    return Math.exp(-since * 25) * Math.sin(finalPhase + 2 * Math.PI * finalFrequency * since);
  });
}

const CHIRP = chirpWave();

/** Where the graph has reached for a stage of the merger, as a share of its width. */
function nowShareOf(merger: BlackHoleState['merger']): number {
  return merger === 'merged' ? 1 : (1 - TIME_TO_MERGER[merger]) / WAVES.ringdownEnd;
}

/** The scene of a settled black-hole state. */
export function blackHoleSceneOf(state: BlackHoleState): BlackHoleScene {
  const physics = blackHolePhysics(state);
  const stageIndex = STAGES.indexOf(state.stage);
  const collapsing = physics.formation.coreCollapses && state.stage === 'fuel-out';
  const swollen = state.stage !== 'fusing' && state.stage !== 'end';
  const largeMarked = state.hole === 'large';
  const horizonRatio = HOLE_MASS_IN_SUNS.large / HOLE_MASS_IN_SUNS.small;
  const innerEdge = DISC_PX;
  const merged = state.merger === 'merged';
  return {
    view: state.view,
    parts: blackHoleParts(state),
    focus: state.focus,
    massive: state.star === 'massive' ? 1 : 0,
    stageIndex,
    starRadiusPx: swollen ? 54 : 40,
    coreRadiusPx: collapsing ? 6 : state.stage === 'fusing' ? 13 : 9,
    gravity: 1,
    pressure: collapsing ? 0.3 : 1,
    largeMarked: largeMarked ? 1 : 0,
    smallHolePx: SMALL_HORIZON_PX,
    largeHolePx: SMALL_HORIZON_PX * horizonRatio,
    starPull: pullAt(PULL.starMassInSuns, PULL.distanceMetres) / pullAt(HOLE_MASS_IN_SUNS.small, PULL.distanceMetres),
    holePull: pullAt(PULL.holeMassInSuns, PULL.distanceMetres) / pullAt(HOLE_MASS_IN_SUNS.small, PULL.distanceMetres),
    orbitPx: ORBIT_RADII.map((radius) => radius * ORBIT_PX),
    speedPx: ORBIT_RADII.map((radius) => (ORBIT_ARROW_PX * orbitSpeed(radius)) / orbitSpeed(ORBIT_RADII[0])),
    orbitDegrees: [35, 150, 265],
    ringPx: DISC_RINGS.slice(1).map((rings) => rings * innerEdge),
    ringInnerPx: DISC_RINGS.slice(0, -1).map((rings) => rings * innerEdge),
    ringColours: DISC_RINGS.slice(0, -1).map((rings) =>
      strengthenColour(blackbodyColour(discKelvins(rings) / FALSE_COLOUR_DIVISOR), 1.6),
    ),
    diskHolePx: innerEdge / DISC_INNER_EDGE_IN_HORIZON_RADII,
    separationPx: merged ? 0 : 90 * separationAt(physics.mergerTime),
    pairDegrees: state.merger === 'apart' ? 20 : 55,
    merged: merged ? 1 : 0,
    wave: CHIRP,
    nowShare: nowShareOf(state.merger),
    mergerShare: 1 / WAVES.ringdownEnd,
    shadowPx: SHADOW_HORIZON_PX * SHADOW_RADIUS_IN_HORIZON_RADII,
    shadowHorizonPx: SHADOW_HORIZON_PX,
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenBlackHole(from: BlackHoleScene, to: BlackHoleScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpBlackHoleScene(from: BlackHoleScene, to: BlackHoleScene, progress: number): BlackHoleScene {
  return blendScenes(from, to, progress, ['pairDegrees']);
}
