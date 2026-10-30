import * as THREE from 'three';
import { buildSpace } from './scene/build-scene';
import { SAMPLE_SPACE, type SpaceDefinition } from './space-definition';

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
      ['sample-dust', 'dust'],
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

describe('a universe with stations, a ship and quiet places', () => {
  const universe: SpaceDefinition = {
    ...SAMPLE_SPACE,
    systems: [
      { ...SAMPLE_SPACE.systems[0]!, id: 'one', position: { x: 0, z: 0 } },
      { ...SAMPLE_SPACE.systems[0]!, id: 'two', position: { x: 12, z: 3 }, calm: true },
    ].map((system) => ({
      ...system,
      planets: system.planets.map((planet) => ({ ...planet, id: `${system.id}-${planet.id}` })),
    })),
    stations: [{ id: 'room', name: 'A room', systemId: 'one', position: { x: 2, y: 0.6, z: 6 } }],
    shipPlanetId: 'one-sample-planet-one',
    dust: [],
  };

  it('anchors the stations, and parks the ship on its planet without making it a place', () => {
    const space = buildSpace(universe, 390 / 844, 1);
    expect(space.anchors.filter((anchor) => anchor.kind === 'station').map((anchor) => anchor.id)).toEqual(['room']);
    const hasShip = (id: string): boolean => {
      let found = false;
      space.anchors
        .find((anchor) => anchor.id === id)!
        .object.traverse((node) => {
          if ((node as THREE.Mesh).geometry?.type === 'ConeGeometry') found = true;
        });
      return found;
    };
    expect(hasShip('one-sample-planet-one')).toBe(true);
    expect(hasShip('one-sample-planet-two')).toBe(false);
    expect(hasShip('two-sample-planet-one')).toBe(false);
    space.dispose();
  });

  it('shows one system alone when asked, with its stations, and everything again afterwards', () => {
    const space = buildSpace(universe, 390 / 844, 1);
    space.showOnly('two');
    const visible = () => space.scene.children.filter((child) => child.visible).length;
    const alone = visible();
    space.showOnly(null);
    expect(visible()).toBeGreaterThan(alone);
    space.dispose();
  });
});
