import type { ReactElement } from 'react';
import {
  AXIAL_TILT_DEGREES,
  describeStageAtTilt,
  type BlackHoleState,
  type GreenhouseState,
  type StageState,
  type StarlightState,
  type StarState,
  type TidesState,
  type TransitState,
} from '../model';
import { BlackHolePicture } from './black-hole';
import { blackHoleSceneOf, canTweenBlackHole, lerpBlackHoleScene, type BlackHoleScene } from './black-hole-scene';
import { EarthSkyPicture } from './earth-sky';
import { canTween, lerpScene, sceneOf, type EarthSkyScene } from './earth-sky-scene';
import { GreenhousePicture } from './greenhouse';
import { canTweenGreenhouse, greenhouseSceneOf, lerpGreenhouseScene, type GreenhouseScene } from './greenhouse-scene';
import { StarlightPicture } from './starlight';
import { canTweenStarlight, lerpStarlightScene, starlightSceneOf, type StarlightScene } from './starlight-scene';
import { StarPicture } from './star';
import { canTweenStar, lerpStarScene, starSceneOf, type StarScene } from './star-scene';
import { TidesPicture } from './tides';
import { canTweenTides, lerpTidesScene, tidesSceneOf, type TidesScene } from './tides-scene';
import { TransitPicture } from './transit';
import { canTweenTransit, lerpTransitScene, transitSceneOf, type TransitScene } from './transit-scene';

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
  }),
  'tides.v1': kitPicture<TidesState, TidesScene>({
    sceneOf: tidesSceneOf,
    canTween: canTweenTides,
    lerpScene: lerpTidesScene,
    Picture: TidesPicture,
  }),
  'greenhouse.v1': kitPicture<GreenhouseState, GreenhouseScene>({
    sceneOf: greenhouseSceneOf,
    canTween: canTweenGreenhouse,
    lerpScene: lerpGreenhouseScene,
    Picture: GreenhousePicture,
  }),
  'star.v1': kitPicture<StarState, StarScene>({
    sceneOf: starSceneOf,
    canTween: canTweenStar,
    lerpScene: lerpStarScene,
    Picture: StarPicture,
  }),
  'transit.v1': kitPicture<TransitState, TransitScene>({
    sceneOf: transitSceneOf,
    canTween: canTweenTransit,
    lerpScene: lerpTransitScene,
    Picture: TransitPicture,
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
