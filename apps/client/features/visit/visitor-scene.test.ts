import { SceneDescriptorSchema, buildSceneGeometry } from '@knowscroll/scene-core';
import { visitorDescriptors } from './visitor-scene';

const id = (n: number) => `0199b000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const system = (n: number, planets: number) => ({
  publicSystemId: id(n),
  label: `System ${String(n)}`,
  planets: Array.from({ length: planets }, (_, index) => ({
    publicPlanetId: id(n * 100 + index),
    label: `Planet ${String(n)}.${String(index)}`,
  })),
});
const owner = id(9999);

describe('a friend’s list drawn with the Universe renderer', () => {
  it('makes descriptors the renderer accepts, with silhouettes for every place', () => {
    const descriptors = visitorDescriptors(owner, [system(1, 3), system(2, 0)]);
    expect(descriptors.map((d) => d.kind)).toEqual(['system', 'star', 'planet', 'planet', 'planet', 'system', 'star']);
    for (const descriptor of descriptors) {
      expect(SceneDescriptorSchema.safeParse(descriptor).success).toBe(true);
      expect(buildSceneGeometry(descriptor, { detail: 'full', reducedMotion: true }).silhouette.length).toBe(64);
    }
  });

  it('uses only public identities, with no activity, and never a hypothetical or a region', () => {
    const descriptors = visitorDescriptors(owner, [system(1, 2)]);
    for (const descriptor of descriptors) {
      expect(descriptor.activity).toEqual({ availability: 'unavailable' });
      expect(descriptor.truthStatus).toBe('factual');
      expect(descriptor.kind).not.toBe('region');
    }
    const publicIds = new Set([id(1), id(100), id(101)]);
    const own = descriptors.filter((d) => d.kind !== 'star' && publicIds.has(d.objectId));
    expect(own).toHaveLength(3);
  });

  it('is the same drawing every time, whatever order the list arrives in', () => {
    const systems = [system(1, 3), system(2, 2), system(3, 1)];
    const first = visitorDescriptors(owner, systems);
    const second = visitorDescriptors(owner, [...systems].reverse());
    const sorted = (items: readonly { objectId: string }[]) =>
      [...items].sort((a, b) => (a.objectId < b.objectId ? -1 : 1));
    expect(sorted(second)).toEqual(sorted(first));
  });

  it('gives no two systems the same slot and no two planets of a system the same spot', () => {
    const systems = Array.from({ length: 25 }, (_, n) => system(n + 1, 6));
    const descriptors = visitorDescriptors(owner, systems);
    const spots = descriptors
      .filter((d) => d.kind === 'system')
      .map((d) => `${String(d.anchor.x)},${String(d.anchor.y)}`);
    expect(new Set(spots).size).toBe(spots.length);
    for (const sys of descriptors.filter((d) => d.kind === 'system')) {
      const around = descriptors
        .filter((d) => d.kind === 'planet' && d.parentId === sys.objectId)
        .map((d) => `${String(d.anchor.x - sys.anchor.x)},${String(d.anchor.y - sys.anchor.y)}`);
      expect(new Set(around).size).toBe(around.length);
    }
  });

  it('keeps a place where it is when another system is shared, unless they wanted the same spot', () => {
    const before = visitorDescriptors(owner, [system(1, 2), system(2, 2), system(3, 2)]);
    const after = visitorDescriptors(owner, [system(1, 2), system(2, 2), system(3, 2), system(4, 2)]);
    const moved = before.filter((place) => {
      const same = after.find((other) => other.objectId === place.objectId)!;
      return same.anchor.x !== place.anchor.x || same.anchor.y !== place.anchor.y;
    });
    // At most the systems that collide with the newcomer's preferred spot move, with their planets.
    expect(moved.filter((place) => place.kind === 'system').length).toBeLessThanOrEqual(1);
  });

  it('keeps every coordinate inside what the renderer accepts, for the most that can be shared', () => {
    const systems = Array.from({ length: 100 }, (_, n) => system(n + 1, 4));
    for (const descriptor of visitorDescriptors(owner, systems)) {
      expect(Math.abs(descriptor.anchor.x)).toBeLessThanOrEqual(10_000);
      expect(Math.abs(descriptor.anchor.y)).toBeLessThanOrEqual(10_000);
    }
  });
});
