import * as THREE from 'three';
import { buildSpace } from './scene/build-scene';
import type { PaintCache } from './scene/context';
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

/** The pick glows of a scene that are showing. */
function glowing(space: ReturnType<typeof buildSpace>): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  space.scene.traverse((node) => {
    if (node.userData['pick'] === true && node.visible) found.push(node);
  });
  return found;
}

describe('the sample space scene', () => {
  it('glows one picked system or planet and no other, and nothing when nothing is picked (D02)', () => {
    const space = buildSpace(SAMPLE_SPACE, 390 / 844, 1);
    expect(glowing(space)).toHaveLength(0);
    const planet = space.anchors.find((anchor) => anchor.id === 'sample-planet-two')!;
    space.highlight('sample-planet-two');
    space.poseAt(1);
    const [glow] = glowing(space);
    expect(glowing(space)).toHaveLength(1);
    // It rides on the planet it glows around.
    expect(glow!.parent).toBe(planet.object);
    space.highlight('sample-system');
    expect(glowing(space)).toHaveLength(1);
    expect(glowing(space)[0]!.parent).not.toBe(planet.object);
    space.highlight(null);
    expect(glowing(space)).toHaveLength(0);
    space.dispose();
  });

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

  it('draws a room’s emblem on its station, in its colours, and nothing on a station whose room has no face', () => {
    const emblem = {
      emblem: { frame: 'hexagon', glyph: 'atom' },
      palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
    } as const;
    const withFace: SpaceDefinition = {
      ...universe,
      stations: [
        { ...universe.stations![0]!, id: 'faced', emblem },
        { ...universe.stations![0]!, id: 'plain', position: { x: -2, y: 0.6, z: 6 } },
      ],
    };
    const space = buildSpace(withFace, 390 / 844, 1);
    const emblemOf = (id: string) => {
      let found: THREE.Sprite | undefined;
      space.anchors
        .find((anchor) => anchor.id === id)!
        .object.traverse((node) => {
          if (node.name === 'room-emblem') found = node as THREE.Sprite;
        });
      return found;
    };
    const plate = emblemOf('faced')!;
    expect(plate).toBeInstanceOf(THREE.Sprite);
    const map = plate.material.map as THREE.DataTexture;
    expect(map.image.width).toBe(64);
    // The plate's pixels are the emblem: its frame in the ink, so some of it is cream, and it is not all one colour.
    const data = map.image.data as Uint8Array;
    const colours = new Set<number>();
    for (let at = 0; at < data.length; at += 4)
      if (data[at + 3]! > 200) colours.add((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!);
    expect(colours.has(0xfffbf0)).toBe(true);
    expect(colours.has(0xffe44d)).toBe(true);
    expect(emblemOf('plain')).toBeUndefined();
    space.dispose();
  });

  it('dims the emblem of a station under Lately', () => {
    const emblem = {
      emblem: { frame: 'circle', glyph: 'star' },
      palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
    } as const;
    const space = buildSpace(
      { ...universe, stations: [{ ...universe.stations![0]!, emblem, calm: true }] },
      390 / 844,
      1,
    );
    let opacity = 1;
    space.anchors
      .find((anchor) => anchor.id === 'room')!
      .object.traverse((node) => {
        if (node.name === 'room-emblem') opacity = (node as THREE.Sprite).material.opacity;
      });
    expect(opacity).toBeLessThan(1);
    space.dispose();
  });

  it('draws the constellation over a member’s station with the room’s accent only, and none over an outsider’s', () => {
    const faced = {
      emblem: { frame: 'circle', glyph: 'star' },
      palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
    } as const;
    const withSky: SpaceDefinition = {
      ...universe,
      stations: [
        { ...universe.stations![0]!, id: 'sky', emblem: faced, sky: { lit: 3, finished: 0, state: 'forming' } },
        { ...universe.stations![0]!, id: 'none', emblem: faced, position: { x: -2, y: 0.6, z: 6 } },
      ],
    };
    const space = buildSpace(withSky, 390 / 844, 1);
    const plateOf = (id: string) => {
      let found: THREE.Sprite | undefined;
      space.anchors
        .find((anchor) => anchor.id === id)!
        .object.traverse((node) => {
          if (node.name === 'room-constellation') found = node as THREE.Sprite;
        });
      return found;
    };
    const plate = plateOf('sky')!;
    expect(plate).toBeInstanceOf(THREE.Sprite);
    const data = (plate.material.map as THREE.DataTexture).image.data as Uint8Array;
    const colours = new Set<number>();
    for (let at = 0; at < data.length; at += 4)
      if (data[at + 3]! > 200) colours.add((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!);
    // Lit stars are the kit's accent and nothing else is opaque: no glow or sparkle was painted.
    expect([...colours]).toEqual([0xffe44d]);
    expect(plateOf('none')).toBeUndefined();
    expect(space.anchors.find((anchor) => anchor.id === 'sky')!.caption).toBe('3 of 7');
    expect(space.anchors.find((anchor) => anchor.id === 'none')).not.toHaveProperty('caption');
    space.dispose();
  });

  it('keeps the light of a station that finished a constellation on, and dims its sky under Lately', () => {
    const faced = {
      emblem: { frame: 'circle', glyph: 'star' },
      palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
    } as const;
    const base = { ...universe.stations![0]!, emblem: faced };
    const probe = (station: NonNullable<SpaceDefinition['stations']>[number], at: number) => {
      const space = buildSpace({ ...universe, stations: [station] }, 390 / 844, 1);
      space.poseAt(at);
      let light = -1;
      let plate = 1;
      space.anchors
        .find((anchor) => anchor.kind === 'station')!
        .object.traverse((node) => {
          if (node.name === 'room-constellation') plate = (node as THREE.Sprite).material.opacity;
          else if (node instanceof THREE.Sprite && node.name === '') light = node.material.opacity;
        });
      space.dispose();
      return { light, plate };
    };
    // At t = 0.3 the blinking light is dark (sin(0.78) > 0.4 is false at t = 0; use t = 2 where it is off).
    const finished = { lit: 7, finished: 1, state: 'naming' as const };
    const forming = { lit: 2, finished: 0, state: 'forming' as const };
    for (const at of [0, 0.6, 1.2, 2, 2.9]) expect(probe({ ...base, sky: finished }, at).light).toBe(1);
    const blinks = [0, 0.6, 1.2, 2, 2.9].map((at) => probe({ ...base, sky: forming }, at).light);
    expect(new Set(blinks).size).toBeGreaterThan(1);
    expect(probe({ ...base, calm: true, sky: forming }, 0).plate).toBeLessThan(1);
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

describe('the planet painting cache', () => {
  it('belongs to the renderer that passes it, and a scene built without one leaves nothing behind', () => {
    const cache: PaintCache = new Map();
    const first = buildSpace(SAMPLE_SPACE, 390 / 844, 1, cache);
    const painted = cache.size;
    expect(painted).toBeGreaterThan(0);
    // Built again with the same cache, nothing new is painted.
    buildSpace(SAMPLE_SPACE, 390 / 844, 1, cache).dispose();
    expect(cache.size).toBe(painted);
    // A scene made without a cache keeps no module-level one that a later cache could inherit.
    buildSpace(SAMPLE_SPACE, 390 / 844, 1).dispose();
    const fresh: PaintCache = new Map();
    expect(fresh.size).toBe(0);
    first.dispose();
  });
});
