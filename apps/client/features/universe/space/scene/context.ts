import * as THREE from 'three';
import { cloudPuff, radialGlow, type PixelImage } from '../texture-data';

/** A three.js texture over plain pixels (no canvas: Hermes has none). */
export function pixelTexture(image: PixelImage): THREE.DataTexture {
  const texture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The soft sprites every scene shares; created once per scene and released with it. */
export interface SpriteTextures {
  readonly glow: THREE.DataTexture;
  readonly bloom: THREE.DataTexture;
  readonly puff: THREE.DataTexture;
}

/** What a builder needs to know about the scene it is added to. */
export interface SceneContext {
  /** The scene time `t` in seconds. Shaders read it; builders' `tick(t)` set everything else. */
  readonly time: { value: number };
  /** Drawing-buffer pixels per layout pixel (point sizes scale with it). */
  readonly pixelRatio: { value: number };
  /** Distance range over which things melt into the sky colour; the camera rig retunes it as it moves. */
  readonly fog: THREE.Vector2;
  /** A quiet system draws grey and dim. */
  readonly calm: boolean;
  readonly sprites: SpriteTextures;
  /** Makes a texture over plain pixels and releases it when the scene is disposed. */
  readonly trackTexture: (image: PixelImage) => THREE.DataTexture;
}

/** A built scene object and the function that poses it at scene time `t` (a pure function of `t`). */
export interface Built<T extends THREE.Object3D = THREE.Group> {
  readonly object: T;
  readonly tick: (t: number) => void;
}

/** The sky colour that distant things fade into. */
export const SKY_COLOUR = new THREE.Vector3(0.012, 0.016, 0.045);

/** Haze uniforms shared by every lit material. */
export function hazeUniforms(context: SceneContext): Record<string, THREE.IUniform> {
  return {
    fogCol: { value: SKY_COLOUR },
    fogR: { value: context.fog },
    calm: { value: context.calm ? 1 : 0 },
  };
}

/** Additive blending for glows, as the design draws them. */
export const additive = {
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
} as const;

export function unitColour(rgb: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
}

export function createSpriteTextures(trackTexture: SceneContext['trackTexture']): SpriteTextures {
  return {
    glow: trackTexture(
      radialGlow([
        [0, 1],
        [0.2, 0.55],
        [0.5, 0.14],
        [1, 0],
      ]),
    ),
    bloom: trackTexture(
      radialGlow([
        [0, 0.9],
        [0.08, 0.5],
        [0.25, 0.14],
        [0.6, 0.03],
        [1, 0],
      ]),
    ),
    puff: trackTexture(cloudPuff()),
  };
}
