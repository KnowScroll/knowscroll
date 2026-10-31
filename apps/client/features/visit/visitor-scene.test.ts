import { SceneDescriptorSchema, buildSceneGeometry } from '@knowscroll/scene-core';
import { HAZE_FAMILIES, PLANET_TYPES, SceneLookSchema } from '@knowscroll/scene-core';
import { visitorDescriptors, visitorLooks } from './visitor-scene';

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

describe('the look of a friend’s places, derived on this device', () => {
  const systems = [system(1, 4), system(2, 3), system(3, 2)];

  it('gives every shared place a look the renderer accepts, and none to anything else', () => {
    const looks = visitorLooks(systems);
    expect(looks).toHaveLength(3 + 9);
    for (const look of looks) expect(SceneLookSchema.safeParse(look).success).toBe(true);
    expect(looks.filter((look) => look.kind === 'region')).toEqual([]);
  });

  it('uses each of the six types once before any type is used again, and never twice in one system while another is free', () => {
    const planets = visitorLooks(systems).flatMap((look) => (look.kind === 'planet' ? [look] : []));
    expect(new Set(planets.slice(0, 6).map((look) => look.type)).size).toBe(6);
    const counts = PLANET_TYPES.map((type) => planets.filter((look) => look.type === type).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    for (const sys of systems) {
      const own = planets.filter((look) => sys.planets.some((planet) => planet.publicPlanetId === look.objectId));
      expect(new Set(own.map((look) => look.type)).size).toBe(own.length);
    }
  });

  it('turns the hue of a repeat so it is not mistaken for the first of its type', () => {
    const planets = visitorLooks([system(1, 6), system(2, 6)]).flatMap((look) =>
      look.kind === 'planet' ? [look] : [],
    );
    const repeat = planets.find((look) => look.variant === 1)!;
    const first = planets.find((look) => look.type === repeat.type && look.variant === 0)!;
    expect(Math.abs(repeat.hueShift - first.hueShift)).toBeGreaterThan(45);
  });

  it('draws gas worlds with rings and gives different systems different haze while there are six or fewer', () => {
    const looks = visitorLooks([system(1, 6), system(2, 6), system(3, 1), system(4, 1)]);
    for (const look of looks) if (look.kind === 'planet' && look.type === 'gas') expect(look.rings).toBe(true);
    const hazes = looks.flatMap((look) => (look.kind === 'system' ? [look.haze] : []));
    expect(new Set(hazes).size).toBe(4);
    for (const haze of hazes) expect(HAZE_FAMILIES).toContain(haze);
  });

  it('is the same every time, whatever order the list arrives in, and uses only public identities', () => {
    const forward = visitorLooks(systems);
    const backward = visitorLooks(
      [...systems].reverse().map((entry) => ({ ...entry, planets: [...entry.planets].reverse() })),
    );
    const byId = (items: typeof forward) => [...items].sort((a, b) => (a.objectId < b.objectId ? -1 : 1));
    expect(byId(backward)).toEqual(byId(forward));
    const publicIds = new Set(
      systems.flatMap((entry) => [entry.publicSystemId, ...entry.planets.map((p) => p.publicPlanetId)]),
    );
    expect(forward.every((look) => publicIds.has(look.objectId))).toBe(true);
  });

  it('keeps a place’s look when another is shared, unless the newcomer takes its turn at a type', () => {
    const before = visitorLooks([system(1, 3)]);
    const after = visitorLooks([system(1, 3), system(2, 3)]);
    const planetsOf = (items: typeof before) => items.flatMap((look) => (look.kind === 'planet' ? [look] : []));
    const unchanged = planetsOf(before).filter((look) =>
      planetsOf(after).some((other) => JSON.stringify(other) === JSON.stringify(look)),
    );
    expect(unchanged.length).toBeGreaterThanOrEqual(1);
  });
});
