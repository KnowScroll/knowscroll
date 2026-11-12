import * as THREE from 'three';
import { hexToUnit } from '../paint';
import { HAZE_COLOURS, type HazeFamily } from '../planet-genome';
import { additive, type SceneContext } from './context';
import { FAR_FRAGMENT, FAR_VERTEX } from './shaders';

/** A system as the far field draws it: a place, a haze and whether it is quiet. */
export interface FarSystem {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly family: HazeFamily;
  readonly calm: boolean;
}

/** The width of one glow point in scene units: about the glow around a sun, not its bloom. */
const WORLD_SIZE = 8;

export interface FarField {
  readonly object: THREE.Points;
  /** Draws the point of every system except those in `detail`, which are drawn in full. */
  readonly hide: (detail: ReadonlySet<string>) => void;
  /** Pixels one scene unit spans at distance one, from the height of the view and its field of view. */
  readonly setView: (heightPx: number, fovDegrees: number) => void;
  readonly dispose: () => void;
}

const unit = (hex: string): readonly [number, number, number] => hexToUnit(hex);

/**
 * One `THREE.Points` for every system of a map at scale (D-417): the cheap form of a system that is too far to see
 * its planets. Built from the definition in one pass and replaced whenever the systems change.
 */
export function makeFarField(systems: readonly FarSystem[], context: SceneContext): FarField {
  const count = systems.length;
  const position = new Float32Array(count * 3);
  const inner = new Float32Array(count * 3);
  const outer = new Float32Array(count * 3);
  const calm = new Float32Array(count);
  const on = new Float32Array(count).fill(1);
  const indexOf = new Map<string, number>();
  systems.forEach((system, at) => {
    position.set([system.x, 0, system.z], at * 3);
    const [near, far] = HAZE_COLOURS[system.family];
    inner.set(unit(near), at * 3);
    outer.set(unit(far), at * 3);
    calm[at] = system.calm ? 1 : 0;
    indexOf.set(system.id, at);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aInner', new THREE.BufferAttribute(inner, 3));
  geometry.setAttribute('aOuter', new THREE.BufferAttribute(outer, 3));
  geometry.setAttribute('aCalm', new THREE.BufferAttribute(calm, 1));
  const shown = new THREE.BufferAttribute(on, 1);
  geometry.setAttribute('aOn', shown);
  const uniforms = {
    pr: context.pixelRatio,
    k: { value: 640 / (2 * Math.tan((38 / 2) * (Math.PI / 180))) },
    worldSize: { value: WORLD_SIZE },
    fogR: { value: context.fog },
  };
  const object = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({ vertexShader: FAR_VERTEX, fragmentShader: FAR_FRAGMENT, ...additive, uniforms }),
  );
  // Every point is in the one buffer, whose bounds the camera's breathing would only keep recomputing.
  object.frustumCulled = false;
  object.name = 'far-field';
  let hidden: ReadonlySet<string> = new Set();
  return {
    object,
    hide(detail) {
      // Only the points whose state changed are written, so a camera move costs a handful of writes.
      for (const id of hidden) {
        const at = indexOf.get(id);
        if (at !== undefined && !detail.has(id)) on[at] = 1;
      }
      for (const id of detail) {
        const at = indexOf.get(id);
        if (at !== undefined) on[at] = 0;
      }
      hidden = new Set(detail);
      shown.needsUpdate = true;
    },
    setView(heightPx, fovDegrees) {
      uniforms.k.value = Math.max(heightPx, 1) / (2 * Math.tan((fovDegrees / 2) * (Math.PI / 180)));
    },
    dispose() {
      geometry.dispose();
      object.material.dispose();
    },
  };
}
