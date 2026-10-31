import type { SceneDescriptor } from '@knowscroll/scene-core';
import { indexUniverse, placeLabels, viewFor } from './universe-layout';
import { fixtureId, sceneFixture } from './universe.fixture';

/** Authored CI descriptors only. */
function descriptor(
  n: number,
  kind: SceneDescriptor['kind'],
  parentId: string,
  x: number,
  y: number,
  label = `CI ${n}`,
) {
  const base = sceneFixture(5).descriptors[0]!;
  return {
    ...base,
    objectId: fixtureId(n),
    parentId,
    kind,
    label,
    anchor: { x, y, layer: 0 },
    seed: n.toString(16).padStart(32, '0'),
  } satisfies SceneDescriptor;
}
const system = descriptor(100, 'system', fixtureId(1), 0, 0, 'Alpha');
const star = descriptor(101, 'star', system.objectId, 300, 0);
const planets = [
  descriptor(102, 'planet', system.objectId, 300, 300, 'Near'),
  descriptor(103, 'planet', system.objectId, -600, 0, 'Far'),
];
const regions = [200, 201, 202].map((n) => descriptor(n, 'region', planets[0]!.objectId, 300 + n, 300));
const index = indexUniverse([system, star, ...planets, ...regions], []);

describe('Universe layout', () => {
  it('groups places by parent and picks the view a focused place opens', () => {
    expect(index.systems).toHaveLength(1);
    expect(index.stars.get(system.objectId)).toBe(star);
    expect(viewFor(index, null).kind).toBe('universe');
    expect(viewFor(index, system.objectId).kind).toBe('system');
    expect(viewFor(index, star.objectId)).toEqual({ kind: 'system', system });
    expect(viewFor(index, planets[0]!.objectId)).toEqual({ kind: 'planet', planet: planets[0], landed: false });
    expect(viewFor(index, planets[0]!.objectId, true)).toEqual({ kind: 'planet', planet: planets[0], landed: true });
    // A chosen region is always on the map, whatever the planet's own flag says.
    expect(viewFor(index, regions[1]!.objectId)).toMatchObject({
      kind: 'planet',
      landed: true,
      selectedRegion: regions[1],
    });
    expect(viewFor(index, fixtureId(999)).kind).toBe('universe');
  });

  it('places labels without overlap and leaves out one that finds no room', () => {
    const request = (id: string, x: number, priority: number) => ({
      id,
      anchor: { x, y: 100 },
      clearance: 10,
      width: 80,
      height: 20,
      priority,
    });
    const labels = placeLabels([request('a', 100, 1), request('b', 110, 2)], { width: 300, height: 300 });
    expect(labels.map((label) => label.id)).toContain('b');
    for (const first of labels)
      for (const second of labels)
        if (first !== second)
          expect(
            first.x < second.x + second.width &&
              second.x < first.x + first.width &&
              first.y < second.y + second.height &&
              second.y < first.y + first.height,
          ).toBe(false);
    expect(placeLabels([request('c', 100, 1)], { width: 20, height: 20 })).toEqual([]);
  });
});
