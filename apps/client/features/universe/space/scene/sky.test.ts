import * as THREE from 'three';
import { createSceneContext } from './build-scene';
import { STAR_VERTEX } from './shaders';
import { addSky, BACKGROUND_LAYER, splitSky } from './sky';

const skyOf = () => {
  const group = new THREE.Group();
  const { context } = createSceneContext([10, 100], 1);
  addSky(group, 'sky', context, new THREE.Vector3(0, 0, 10));
  return { group, context };
};
const stars = (group: THREE.Object3D) =>
  group.children.filter((child): child is THREE.Points => child instanceof THREE.Points);

describe('the background stars', () => {
  it('are drawn with everything else, on the default layer, unless a view splits them off: the shipping map keeps its sky', () => {
    const { group } = skyOf();
    expect(stars(group).length).toBeGreaterThan(0);
    for (const points of stars(group)) {
      expect(points.layers.mask).toBe(1);
      expect((points.material as THREE.ShaderMaterial).vertexShader).toBe(STAR_VERTEX);
    }
    expect(group.getObjectByName('deep-field')).toBeUndefined();
  });

  it('move to their own layer with the deep field when split, drawn as they were, and split only once', () => {
    const { group, context } = skyOf();
    const before = stars(group).length;
    splitSky(group, context);
    splitSky(group, context);
    const after = stars(group);
    // The deep field of faint stars, and its far smudges.
    expect(after.length).toBe(before + 2);
    // The near motes float among the bodies and stay with them.
    for (const points of after) {
      const motes = points.name === 'near-motes';
      expect(points.layers.mask).toBe(motes ? 1 : 1 << BACKGROUND_LAYER);
    }
    for (const points of after.filter((points) => points.name !== 'deep-field' && points.name !== 'deep-smudges'))
      expect((points.material as THREE.ShaderMaterial).vertexShader).toBe(STAR_VERTEX);
    expect(group.getObjectByName('deep-field')).toBeDefined();
    expect(group.getObjectByName('deep-smudges')).toBeDefined();
  });
});
