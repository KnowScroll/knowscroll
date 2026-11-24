import type { ReactElement } from 'react';
import {
  AXIAL_TILT_DEGREES,
  describeStageAtTilt,
  type BlackHoleState,
  type NerveState,
  type StageState,
  type StarlightState,
} from '../model';
import { BlackHolePicture } from './black-hole';
import { blackHoleSceneOf, canTweenBlackHole, lerpBlackHoleScene, type BlackHoleScene } from './black-hole-scene';
import { EarthSkyPicture } from './earth-sky';
import { canTween, describeRecap, lerpScene, recapSceneOf, sceneOf, type EarthSkyScene } from './earth-sky-scene';
import { NervePicture } from './nerve';
import { canTweenNerve, lerpNerveScene, nerveSceneOf, type NerveScene } from './nerve-scene';
import { StarlightPicture } from './starlight';
import { canTweenStarlight, lerpStarlightScene, starlightSceneOf, type StarlightScene } from './starlight-scene';

/**
 * What the stage engine needs of a kit's drawing (D-133, D-194): the scene of a stored state, whether a
 * move between two scenes is drawn as one picture changing, the scene part-way between two, and the
 * picture itself. Each kit supplies its own; the engine handles every kit alike through this record, with
 * scenes it never looks inside.
 */
export interface KitPicture {
  readonly sceneOf: (state: unknown) => unknown;
  readonly canTween: (from: unknown, to: unknown) => boolean;
  readonly lerpScene: (from: unknown, to: unknown, progress: number) => unknown;
  readonly Picture: (props: { readonly scene: unknown }) => ReactElement;
  /** What a Final call that hands the reader a control does to the picture: only Earth & sky has one, the tilt of its axis (D-187). */
  readonly atTilt?: {
    readonly isTurned: (tilt: number) => boolean;
    readonly sceneOf: (state: unknown, tilt: number) => unknown;
    readonly describe: (state: unknown, tilt: number) => string;
  };
  /**
   * The picture of the whole journey (V3 F10): what the stage turns into at the end of a Scroll, made of the document's own
   * states, with its words. Only a kit that can draw one honestly has it; the others keep their last state.
   */
  readonly recap?: {
    readonly sceneOf: (states: readonly unknown[]) => unknown;
    readonly describe: (states: readonly unknown[]) => string | undefined;
  };
}

/**
 * Types a kit's own functions as the engine's record. A stored state reaches the kit's functions only
 * after the document's schema has proved it holds the kit's words, which is why the one cast is sound.
 */
function kitPicture<State, Scene>(kit: {
  readonly sceneOf: (state: State) => Scene;
  readonly canTween: (from: Scene, to: Scene) => boolean;
  readonly lerpScene: (from: Scene, to: Scene, progress: number) => Scene;
  readonly Picture: (props: { readonly scene: Scene }) => ReactElement;
  readonly atTilt?: {
    readonly isTurned: (tilt: number) => boolean;
    readonly sceneOf: (state: State, tilt: number) => Scene;
    readonly describe: (state: State, tilt: number) => string;
  };
  readonly recap?: {
    readonly sceneOf: (states: readonly State[]) => Scene | undefined;
    readonly describe: (states: readonly State[]) => string | undefined;
  };
}): KitPicture {
  return kit as unknown as KitPicture;
}

/** The pictures of the kits, by the kit id a document's stage names. */
export const KIT_PICTURES = {
  'earth-sky.v1': kitPicture<StageState, EarthSkyScene>({
    sceneOf: (state) => sceneOf(state),
    canTween,
    lerpScene,
    Picture: EarthSkyPicture,
    atTilt: {
      isTurned: (tilt) => tilt !== AXIAL_TILT_DEGREES,
      sceneOf,
      describe: describeStageAtTilt,
    },
    recap: { sceneOf: recapSceneOf, describe: describeRecap },
  }),
  'nerve.v1': kitPicture<NerveState, NerveScene>({
    sceneOf: nerveSceneOf,
    canTween: canTweenNerve,
    lerpScene: lerpNerveScene,
    Picture: NervePicture,
  }),
  'starlight.v1': kitPicture<StarlightState, StarlightScene>({
    sceneOf: starlightSceneOf,
    canTween: canTweenStarlight,
    lerpScene: lerpStarlightScene,
    Picture: StarlightPicture,
  }),
  'black-hole.v1': kitPicture<BlackHoleState, BlackHoleScene>({
    sceneOf: blackHoleSceneOf,
    canTween: canTweenBlackHole,
    lerpScene: lerpBlackHoleScene,
    Picture: BlackHolePicture,
  }),
} as const satisfies Record<string, KitPicture>;

/** The id of a kit this build draws. */
export type KitPictureId = keyof typeof KIT_PICTURES;

/**
 * Whether this build draws the kit a stage names. A stored stage may name a kit that has since been removed (its
 * revision stays readable and is served to older apps), so every reader that looks a kit up by a stored or wire `kit`
 * asks first and draws nothing for one it lacks. Own keys only: a name such as `constructor` is no kit.
 */
export function isKitPictureId(kit: string): kit is KitPictureId {
  return Object.hasOwn(KIT_PICTURES, kit);
}
