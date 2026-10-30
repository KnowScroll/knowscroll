import * as THREE from 'three';
import { hexToUnit } from '../paint';
import type { HazeFamily } from '../planet-genome';
import { additive, type SceneContext } from './context';
import { HALO_FRAGMENT, WORLD_VERTEX } from './shaders';

/** The two colours of each haze family, inner and outer (design: Foundations, "Haze"). */
const HALO_COLOURS: Readonly<Record<HazeFamily, readonly [string, string]>> = {
  teal: ['#3BFFD0', '#2B5BFF'],
  cobalt: ['#7AD8FF', '#6B3BFF'],
  coral: ['#FFB03B', '#E02B7F'],
  amber: ['#FFD84D', '#E0502B'],
  pink: ['#FF8AE2', '#6B2BFF'],
  violet: ['#C8A8FF', '#3B2BD0'],
};

const toVector = (hex: string): THREE.Vector3 => new THREE.Vector3(...hexToUnit(hex));

/** The flat, softly spiralling haze under a sun or nebula. `strength` scales its brightness. */
export function makeHalo(radius: number, family: HazeFamily, context: SceneContext, strength = 0.35): THREE.Mesh {
  const [inner, outer] = HALO_COLOURS[family];
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.ShaderMaterial({
      vertexShader: WORLD_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      ...additive,
      side: THREE.DoubleSide,
      uniforms: {
        c1: { value: toVector(inner) },
        c2: { value: toVector(outer) },
        time: context.time,
        strength: { value: strength },
        calm: { value: context.calm ? 1 : 0 },
      },
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  return mesh;
}
