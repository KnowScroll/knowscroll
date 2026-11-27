import * as THREE from 'three';
import { createSceneContext } from './build-scene';
import { STAR_LENSED_VERTEX, STAR_VERTEX } from './shaders';
import { addSky, bendSky } from './sky';

const skyOf = () => {
  const group = new THREE.Group();
  const { context } = createSceneContext([10, 100], 1);
  const shells = addSky(group, 'sky', context, new THREE.Vector3(0, 0, 10));
  return { group, context, shells };
};
const vertexOf = (points: THREE.Points) => (points.material as THREE.ShaderMaterial).vertexShader;

describe('the background stars', () => {
  it('are drawn straight unless a view asks for them bent: the shipping map keeps its program', () => {
    const { group, shells } = skyOf();
    expect(shells.length).toBeGreaterThan(0);
    for (const points of shells) expect(vertexOf(points)).toBe(STAR_VERTEX);
    expect(group.getObjectByName('deep-field')).toBeUndefined();
  });

  it('bend round the lenses they are given, with the deep field under them, and go back straight when let go', () => {
    const { group, context, shells } = skyOf();
    const bent = bendSky(shells, group, context);
    for (const points of shells) expect(vertexOf(points)).toBe(STAR_LENSED_VERTEX);
    const deep = group.getObjectByName('deep-field') as THREE.Points;
    expect(vertexOf(deep)).toBe(STAR_LENSED_VERTEX);
    bent.set([{ x: 100, y: 200, radius: 30 }], { width: 390, height: 844 });
    const uniforms = (shells[0]!.material as THREE.ShaderMaterial).uniforms;
    expect((uniforms['lenses']!.value as THREE.Vector4[])[0]!.toArray()).toEqual([100, 200, 30, 0]);
    expect((uniforms['lenses']!.value as THREE.Vector4[])[1]!.z).toBe(0);
    expect((uniforms['view']!.value as THREE.Vector2).toArray()).toEqual([390, 844]);
    bent.dispose();
    for (const points of shells) expect(vertexOf(points)).toBe(STAR_VERTEX);
    expect(group.getObjectByName('deep-field')).toBeUndefined();
  });
});
