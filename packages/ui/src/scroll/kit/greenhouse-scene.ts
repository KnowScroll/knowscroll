import { greenhouseParts, greenhousePhysics, type GreenhousePart, type GreenhouseState } from '../model';
import { blendScenes } from './blend';

/**
 * The drawing parameters of the greenhouse kit (D-194): what the picture needs to place its parts, worked
 * out from the derived kit state and nothing else. Every flow of energy, the balance and the warmth of the
 * ground come from `greenhousePhysics`; this file only turns them into the width of an arrow and the height
 * of a bar, so a picture cannot disagree with the text version of the same state or show energy made.
 */

export type GreenhouseView = GreenhouseState['view'];

/** Pixels of arrow width for a flow equal to all the sunlight that arrives. */
export const ARROW_PX_PER_SUNLIGHT = 12;

/** How thick the layer is drawn, by how much it absorbs: not there, thin, thick (pixels). */
const LAYER_PX = { none: 0, thin: 9, thick: 20 } as const;

export interface GreenhouseScene {
  readonly view: GreenhouseView;
  readonly parts: readonly GreenhousePart[];
  readonly focus: GreenhouseState['focus'];
  /** The thickness the layer is drawn with (0 for none) and how opaque it is (0..1). */
  readonly layerPx: number;
  readonly layerOpacity: number;
  /** Flows, in units of the sunlight that arrives. */
  readonly reflected: number;
  readonly absorbed: number;
  readonly surfaceEmission: number;
  readonly passesThrough: number;
  readonly layerUp: number;
  readonly backDown: number;
  readonly toSpace: number;
  /** How warm the ground is, 0 to 1. */
  readonly warmth: number;
  /** Whether energy in and energy out differ: the ground is still warming. */
  readonly imbalanced: boolean;
}

/** The scene of a settled greenhouse state. */
export function greenhouseSceneOf(state: GreenhouseState): GreenhouseScene {
  const physics = greenhousePhysics(state);
  return {
    view: state.view,
    parts: greenhouseParts(state),
    focus: state.focus,
    layerPx: LAYER_PX[state.layer],
    layerOpacity: { none: 0, thin: 0.35, thick: 0.7 }[state.layer],
    reflected: physics.reflected,
    absorbed: physics.absorbed,
    surfaceEmission: physics.surfaceEmission,
    passesThrough: physics.passesThrough,
    layerUp: physics.layerUp,
    backDown: physics.backDown,
    toSpace: physics.toSpace,
    warmth: physics.warmth,
    imbalanced: Math.abs(physics.imbalance) > 1e-9,
  };
}

/** Whether a move between two scenes is one picture changing (a tween) or one replacing another. */
export function canTweenGreenhouse(from: GreenhouseScene, to: GreenhouseScene): boolean {
  return from.view === to.view;
}

/** The scene `progress` of the way (0..1) from one scene to another. */
export function lerpGreenhouseScene(from: GreenhouseScene, to: GreenhouseScene, progress: number): GreenhouseScene {
  return blendScenes(from, to, progress);
}
