import * as THREE from 'three';
import { buildSpace } from './scene/build-scene';
import { SAMPLE_SPACE } from './space-definition';

function positions(t: number) {
  const space = buildSpace(SAMPLE_SPACE, 390 / 844, 1);
  space.poseAt(t);
  space.camera.updateMatrixWorld();
  const point = new THREE.Vector3();
  return {
    space,
    byId: Object.fromEntries(
      space.anchors.map((anchor) => [anchor.id, anchor.object.getWorldPosition(point).toArray()]),
    ),
  };
}

describe('the sample space scene', () => {
  it('names a system and two planets as anchors', () => {
    const { space } = positions(0);
    expect(space.anchors.map(({ id, kind }) => [id, kind])).toEqual([
      ['sample-system', 'system'],
      ['sample-planet-one', 'planet'],
      ['sample-planet-two', 'planet'],
    ]);
    space.dispose();
  });

  it('is a pure function of the time: the same t poses the same picture', () => {
    const first = positions(7.25);
    const second = positions(7.25);
    expect(second.byId).toEqual(first.byId);
    first.space.dispose();
    second.space.dispose();
  });

  it('revolves the planets around a fixed sun', () => {
    const early = positions(0);
    const later = positions(6);
    expect(later.byId['sample-system']).toEqual(early.byId['sample-system']);
    expect(later.byId['sample-planet-one']).not.toEqual(early.byId['sample-planet-one']);
    expect(later.byId['sample-planet-two']).not.toEqual(early.byId['sample-planet-two']);
    early.space.dispose();
    later.space.dispose();
  });

  it('keeps each planet on its own orbit around the sun', () => {
    const { space, byId } = positions(11);
    const sun = new THREE.Vector3(...byId['sample-system']!);
    const distance = (id: string) => new THREE.Vector3(...byId[id]!).distanceTo(sun);
    expect(distance('sample-planet-one')).toBeCloseTo(3.8, 5);
    expect(distance('sample-planet-two')).toBeCloseTo(6.3, 5);
    space.dispose();
  });

  it('draws no orbit lines and no route lines', () => {
    const { space } = positions(0);
    const lines: string[] = [];
    space.scene.traverse((node) => {
      if (node instanceof THREE.Line) lines.push(node.type);
    });
    expect(lines).toEqual([]);
    space.dispose();
  });
});
