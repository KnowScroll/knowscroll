import * as THREE from 'three';
import { chooseDetail, DETAIL_MAX } from '../detail-set';
import type { PaintCache } from './context';
import { buildSpace } from './build-scene';
import { scaleDefinition } from './scale-fixture';

const phone = 390 / 844;
const nobody = new Set<string>();
/** Painting a planet is the slow part of a build; the tests share what they have painted, as one renderer does. */
const painted: PaintCache = new Map();

/** The geometries and materials under an object. */
function resourcesUnder(root: THREE.Object3D): {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
} {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((node) => {
    const drawable = node as Partial<THREE.Mesh>;
    // Every sprite shares one geometry, which belongs to the scene and not to a system.
    if (drawable.geometry && !(node as THREE.Sprite).isSprite) geometries.add(drawable.geometry);
    for (const material of Array.isArray(drawable.material)
      ? drawable.material
      : drawable.material
        ? [drawable.material]
        : [])
      materials.add(material);
  });
  return { geometries, materials };
}
const meshesIn = (root: THREE.Object3D): number => {
  let count = 0;
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) count += 1;
  });
  return count;
};
const groupOf = (space: ReturnType<typeof buildSpace>, systemId: string): THREE.Object3D =>
  space.anchors.find((anchor) => anchor.id === systemId)!.object.parent!;
const farPoints = (space: ReturnType<typeof buildSpace>): THREE.Points | undefined =>
  space.scene.children.find((child) => child.name === 'far-field') as THREE.Points | undefined;

describe('a map small enough to draw whole', () => {
  it('builds every system in full, with no far field, and anchors them in the order it always did', () => {
    const definition = scaleDefinition(DETAIL_MAX, 1);
    const space = buildSpace(definition, phone, 1, painted);
    expect(space.scaled).toBe(false);
    expect(space.detail.size).toBe(DETAIL_MAX);
    expect(farPoints(space)).toBeUndefined();
    expect(space.anchors.map((anchor) => anchor.id)).toEqual(
      definition.systems.flatMap((system) => [system.id, ...system.planets.map((planet) => planet.id)]),
    );
    expect(space.setDetail(nobody)).toBe(false);
    expect(space.detail.size).toBe(DETAIL_MAX);
    space.dispose();
  });

  it('is not built differently by a detail set it is given: all of a small map is always in', () => {
    const definition = scaleDefinition(6, 2);
    const space = buildSpace(definition, phone, 1, painted, new Set(['sys-00001']));
    expect(space.detail.size).toBe(6);
    space.dispose();
  });
});

describe('a map at scale', () => {
  it('builds only a bounded set in full and draws every other system as one field of points', () => {
    const definition = scaleDefinition(400, 1);
    const space = buildSpace(definition, phone, 1, painted);
    expect(space.scaled).toBe(true);
    expect(space.detail.size).toBeLessThanOrEqual(DETAIL_MAX);
    expect(space.detail.size).toBeGreaterThan(0);
    const points = farPoints(space)!;
    expect(points).toBeInstanceOf(THREE.Points);
    expect(points.geometry.getAttribute('position').count).toBe(400);
    // The points of the systems in full are switched off, every other one is on.
    const on = points.geometry.getAttribute('aOn');
    let lit = 0;
    for (let at = 0; at < on.count; at++) lit += on.getX(at);
    expect(lit).toBe(400 - space.detail.size);
    // Anchors name only what was built in full; the other systems are places.
    expect(space.anchors.filter((anchor) => anchor.kind === 'system')).toHaveLength(space.detail.size);
    expect(space.places.ids).toHaveLength(400);
    // Meshes: a sun, a planet and their shells per system in full, and none for the others.
    expect(meshesIn(space.scene)).toBeLessThan(space.detail.size * 20 + 40);
    space.dispose();
  });

  it('starts from the systems nearest the camera target, or the ones it is told', () => {
    const definition = scaleDefinition(400, 2);
    const wanted = new Set(['sys-00399', 'sys-00000']);
    const space = buildSpace(definition, phone, 1, painted, wanted);
    expect([...space.detail].sort()).toEqual(['sys-00000', 'sys-00399']);
    space.dispose();
  });

  it('brings systems in a few at a time and takes the others out, releasing what they built', () => {
    const definition = scaleDefinition(400, 1);
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedTextures = new Set<THREE.Texture>();
    const spies = [
      jest.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry) {
        disposedGeometries.add(this);
      }),
      jest.spyOn(THREE.Material.prototype, 'dispose').mockImplementation(function (this: THREE.Material) {
        disposedMaterials.add(this);
      }),
      jest.spyOn(THREE.Texture.prototype, 'dispose').mockImplementation(function (this: THREE.Texture) {
        disposedTextures.add(this);
      }),
    ];
    try {
      const space = buildSpace(definition, phone, 1, painted);
      const before = [...space.detail];
      const leaving = before.slice(0, 5);
      const owned = leaving.map((id) => resourcesUnder(groupOf(space, id)));
      const texturesOf = (id: string): THREE.Texture[] => {
        const found: THREE.Texture<unknown>[] = [];
        groupOf(space, id).traverse((node) => {
          const material = (node as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
          const map = (material as unknown as { uniforms?: Record<string, { value: unknown }> } | undefined)
            ?.uniforms?.['map']?.value;
          if (map instanceof THREE.Texture) found.push(map as THREE.Texture<unknown>);
        });
        return found;
      };
      const leavingTextures = leaving.flatMap(texturesOf);
      expect(leavingTextures.length).toBeGreaterThan(0);

      // Five leave, five others (the far end of the map) are wanted.
      const arriving = definition.systems.slice(-5).map((system) => system.id);
      const wanted = new Set([...before.slice(5), ...arriving]);
      const geometriesBefore = disposedGeometries.size;
      // Two at a time: the first call builds two newcomers, never five.
      expect(space.setDetail(wanted, 2)).toBe(true);
      expect(space.detail.size).toBe(before.length - 5 + 2);
      expect(space.setDetail(wanted, 2)).toBe(true);
      expect(space.setDetail(wanted, 2)).toBe(true);
      expect(space.setDetail(wanted, 2)).toBe(false);
      expect([...space.detail].sort()).toEqual([...wanted].sort());

      for (const { geometries, materials } of owned) {
        for (const geometry of geometries) expect(disposedGeometries.has(geometry)).toBe(true);
        for (const material of materials) expect(disposedMaterials.has(material)).toBe(true);
      }
      for (const texture of leavingTextures) expect(disposedTextures.has(texture)).toBe(true);
      expect(disposedGeometries.size).toBeGreaterThan(geometriesBefore);
      // What stays is not released: the shared sprites of the scene and the systems still in detail.
      const kept = resourcesUnder(groupOf(space, before[10]!));
      for (const geometry of kept.geometries) expect(disposedGeometries.has(geometry)).toBe(false);
      // The scene holds the same number of systems in full as before, and the far field was told.
      expect(space.detail.size).toBe(before.length);
      const on = farPoints(space)!.geometry.getAttribute('aOn');
      for (const id of leaving) expect(on.getX(definition.systems.findIndex((system) => system.id === id))).toBe(1);
      for (const id of arriving) expect(on.getX(definition.systems.findIndex((system) => system.id === id))).toBe(0);
      expect(space.anchors.filter((anchor) => anchor.kind === 'system')).toHaveLength(before.length);
      space.dispose();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not grow: bringing systems in and out for a long walk leaves as many meshes as it began with', () => {
    // Suns only: painting planets is the slow part, and the walk is about what is built and released.
    const definition = scaleDefinition(300, 0);
    const space = buildSpace(definition, phone, 1, painted);
    const meshes = meshesIn(space.scene);
    const places = space.places;
    for (let step = 0; step < 30; step++) {
      const wanted = chooseDetail({
        places,
        target: { x: step * 6 - 80, z: step * 3 - 40 },
        pinned: nobody,
        previous: space.detail,
      });
      space.setDetail(wanted);
      expect(space.detail.size).toBeLessThanOrEqual(DETAIL_MAX);
    }
    expect(meshesIn(space.scene)).toBeLessThanOrEqual(meshes + 40);
    expect(space.scene.children.filter((child) => child.name === 'far-field')).toHaveLength(1);
    space.dispose();
  });

  it('builds again only the system whose definition changed, and keeps the rest as they are', () => {
    const definition = scaleDefinition(300, 1);
    const space = buildSpace(definition, phone, 1, painted, new Set(['sys-00010', 'sys-00011', 'sys-00012']));
    const kept = groupOf(space, 'sys-00010');
    const changed = groupOf(space, 'sys-00011');
    const next = {
      ...definition,
      systems: definition.systems.map((system) =>
        system.id === 'sys-00011'
          ? {
              ...system,
              planets: [
                ...system.planets,
                { id: 'sys-00011-new', name: 'New', type: 'gas' as const, orbitRadius: 3, startAngle: 1 },
              ],
            }
          : system,
      ),
    };
    const field = farPoints(space);
    space.update(next);
    expect(groupOf(space, 'sys-00010')).toBe(kept);
    expect(groupOf(space, 'sys-00011')).not.toBe(changed);
    expect(space.anchors.some((anchor) => anchor.id === 'sys-00011-new')).toBe(true);
    expect([...space.detail].sort()).toEqual(['sys-00010', 'sys-00011', 'sys-00012']);
    // The far field was renewed, and the old one released.
    expect(farPoints(space)).not.toBe(field);
    expect(space.scene.children.filter((child) => child.name === 'far-field')).toHaveLength(1);
    space.dispose();
  });

  it('answers a camera script for a system in full and gives way safely for one that is not', () => {
    const definition = scaleDefinition(300, 1);
    const space = buildSpace(definition, phone, 1, painted, new Set(['sys-00001']));
    space.poseAt(0);
    expect(space.script.planet('sys-00001-p0')).toBeDefined();
    expect(space.script.dock('sys-00001')).toBeDefined();
    expect(space.script.planet('sys-00200-p0')).toBeUndefined();
    expect(space.script.dock('sys-00200')).toBeUndefined();
    // A sun's place is known for every system, built or not, and unknown for one that is not on the map.
    expect(space.script.sun('sys-00200')).toBeInstanceOf(THREE.Vector3);
    expect(space.script.sun('nowhere')).toBeUndefined();
    expect(() => space.script.closeUp('sys-00200-p0', { atmosphere: 0.5, sunBloom: 0.5, sunGlow: 0.5 })).not.toThrow();
    expect(() => space.script.handOver('sys-00200-p0', null)).not.toThrow();
    space.dispose();
  });

  it('keeps a glow and a "show one system alone" for systems that come into detail later', () => {
    const definition = scaleDefinition(300, 1);
    const space = buildSpace(definition, phone, 1, painted, new Set(['sys-00001']));
    space.highlight('sys-00250');
    space.showOnly('sys-00250');
    space.setDetail(new Set(['sys-00001', 'sys-00250']));
    const glowing: THREE.Object3D[] = [];
    space.scene.traverse((node) => {
      if (node.userData['pick'] === true && node.visible) glowing.push(node);
    });
    expect(glowing).toHaveLength(1);
    // One system alone: the other system in full and the far field are hidden.
    expect(groupOf(space, 'sys-00001').visible).toBe(false);
    expect(groupOf(space, 'sys-00250').visible).toBe(true);
    expect(farPoints(space)!.visible).toBe(false);
    space.showOnly(null);
    expect(farPoints(space)!.visible).toBe(true);
    expect(groupOf(space, 'sys-00001').visible).toBe(true);
    space.dispose();
  });

  it('keeps the stars around a camera that is far from the middle of the map', () => {
    const definition = scaleDefinition(300, 0);
    const space = buildSpace(definition, phone, 1, painted);
    const sky = space.scene.children[0]!;
    space.setCamera({ position: [0, 22, 46], target: [0, 0, 2], fov: 38 });
    expect(sky.position.length()).toBe(0);
    space.setCamera({ position: [0, 1500, 2000], target: [0, 0, 0], fov: 38 });
    expect(sky.position.length()).toBeGreaterThan(1500);
    expect(space.camera.far).toBeGreaterThan(3000);
    space.dispose();
  });

  it('is built from a shared paint cache once: a system that returns is not painted again', () => {
    const definition = scaleDefinition(300, 1);
    const paintCache: PaintCache = new Map();
    const space = buildSpace(definition, phone, 1, paintCache, new Set(['sys-00001']));
    const afterFirst = paintCache.size;
    expect(afterFirst).toBeGreaterThan(0);
    space.setDetail(new Set(['sys-00002']));
    space.setDetail(new Set(['sys-00001']));
    // The first one comes back from the cache; only the second system's genomes were new.
    expect(paintCache.size).toBeLessThanOrEqual(afterFirst * 2);
    space.dispose();
  });
});
