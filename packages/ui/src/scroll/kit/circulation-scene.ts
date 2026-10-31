import {
  ARTERIOLE_RADIUS,
  circulationParts,
  haemoglobinSaturation,
  heartPhysics,
  loopPhysics,
  LOOP_STRETCHES,
  OXYGEN_PRESSURE,
  oxygenPhysics,
  RELATIVE_FLOW,
  type CirculationPart,
  type CirculationState,
} from '../model';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the circulation kit (D-201): what the picture needs to place its parts, worked
 * out from the derived kit state and nothing else. Which valve is open comes from `heartPhysics`, the
 * pressure along the loop from `loopPhysics` and the oxygen carried from `oxygenPhysics`; this file only
 * turns them into numbers the picture can draw and tween, so a picture cannot disagree with the text
 * version of the same state. Pressures are relative, and no figure is drawn.
 */

export type CirculationView = CirculationState['view'];

/** The oxygen pressure at the right end of the curve's axis, in the model's units: a little beyond the lungs. */
export const OXYGEN_AXIS_MAX = 120;
export const CURVE_SAMPLES = 61;

const FLOWS = ['usual', 'more', 'less'] as const;
const WIDTHS = ['usual', 'narrowed', 'widened'] as const;

/** The highest pressure any state of the loop reaches, so every state is drawn against the same scale. */
export const PRESSURE_SCALE_MAX = Math.max(
  ...FLOWS.flatMap((flow) => WIDTHS.map((vessels) => loopPhysics({ flow, vessels }).pressureAtStart.arteries)),
);

export interface CirculationScene {
  readonly view: CirculationView;
  readonly parts: readonly CirculationPart[];
  readonly focus: CirculationState['focus'];
  /** `heart`: 1 while the chamber squeezes, 0 while it is relaxed; 1 for a valve that is open, 0 for one that is shut. */
  readonly atriaSqueeze: number;
  readonly ventriclesSqueeze: number;
  readonly atrioventricularOpen: number;
  readonly semilunarOpen: number;
  /** How full the ventricles are, against their fullest (0 to 1). */
  readonly ventricleFill: number;
  /** The pressure in an atrium, a ventricle and an artery, against the highest. */
  readonly atriumPressure: number;
  readonly ventriclePressure: number;
  readonly arteryPressure: number;
  /** `pressure`: the pressure where each stretch starts and at the end of the veins, and the same for the usual vessels and flow, against the highest of any state. */
  readonly levels: readonly number[];
  readonly usualLevels: readonly number[];
  /** The flow against the usual, and the width of the arterioles against the usual. */
  readonly flow: number;
  readonly arterioleWidth: number;
  /** `oxygen`: the curve, the place the blood left the lungs and the place it is now, along the axis, with the share of haemoglobin loaded at each. */
  readonly curve: readonly number[];
  readonly lungsAt: number;
  readonly lungsLoaded: number;
  readonly hereAt: number;
  readonly hereLoaded: number;
  /** 1 when the blood is in tissue, so there is something handed over; 0 in the lungs. */
  readonly handedOver: number;
}

function levelsOf(state: Pick<CirculationState, 'flow' | 'vessels'>): number[] {
  const physics = loopPhysics(state);
  return [...LOOP_STRETCHES.map((stretch) => physics.pressureAtStart[stretch]), physics.pressureAtEnd].map(
    (level) => level / PRESSURE_SCALE_MAX,
  );
}

const curve = (): number[] =>
  Array.from({ length: CURVE_SAMPLES }, (_, index) =>
    haemoglobinSaturation((index * OXYGEN_AXIS_MAX) / (CURVE_SAMPLES - 1)),
  );

/** The scene of a settled circulation state. */
export function circulationSceneOf(state: CirculationState): CirculationScene {
  const heart = heartPhysics(state.phase);
  const oxygen = oxygenPhysics(state.where);
  return {
    view: state.view,
    parts: circulationParts(state),
    focus: state.focus,
    atriaSqueeze: heart.atriaSqueezing ? 1 : 0,
    ventriclesSqueeze: heart.ventriclesSqueezing ? 1 : 0,
    atrioventricularOpen: heart.atrioventricularOpen ? 1 : 0,
    semilunarOpen: heart.semilunarOpen ? 1 : 0,
    ventricleFill: heart.ventricleFill,
    atriumPressure: heart.atriumPressure,
    ventriclePressure: heart.ventriclePressure,
    arteryPressure: heart.arteryPressure,
    levels: levelsOf(state),
    usualLevels: levelsOf({ flow: 'usual', vessels: 'usual' }),
    flow: RELATIVE_FLOW[state.flow],
    arterioleWidth: ARTERIOLE_RADIUS[state.vessels],
    curve: curve(),
    lungsAt: OXYGEN_PRESSURE.lungs / OXYGEN_AXIS_MAX,
    lungsLoaded: oxygen.loadedInLungs,
    hereAt: oxygen.oxygenPressure / OXYGEN_AXIS_MAX,
    hereLoaded: oxygen.saturation,
    handedOver: state.where === 'lungs' ? 0 : 1,
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenCirculation(from: CirculationScene, to: CirculationScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpCirculationScene(from: CirculationScene, to: CirculationScene, progress: number): CirculationScene {
  return blendScenes(from, to, progress);
}
