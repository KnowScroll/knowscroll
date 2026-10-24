import type { SceneDescriptor } from '@knowscroll/scene-core';
import {
  composeRegions,
  composeSystem,
  indexUniverse,
  outlineRows,
  overviewScale,
  placeDust,
  placeLabels,
  placeTrail,
  unitsFromId,
  viewFor,
  ORBIT_BANDS,
} from './universe-layout';
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
    expect(viewFor(index, planets[0]!.objectId)).toEqual({ kind: 'planet', planet: planets[0] });
    expect(viewFor(index, regions[1]!.objectId)).toMatchObject({ kind: 'planet', selectedRegion: regions[1] });
    expect(viewFor(index, fixtureId(999)).kind).toBe('universe');
  });

  it('places planets on the orbit and in the direction their anchors have from the star', () => {
    const composition = composeSystem(index, system);
    const near = composition.planets.find((p) => p.descriptor.label === 'Near')!;
    const far = composition.planets.find((p) => p.descriptor.label === 'Far')!;
    expect(near.band).toBe(0);
    expect(far.band).toBe(2);
    // Near is below-left of the star (anchor diff (0, 300)): straight down the ellipse.
    expect(near.position.x).toBeCloseTo(0, 5);
    expect(near.position.y).toBeCloseTo(ORBIT_BANDS[0].ry, 5);
    // Far is left of the star (anchor diff (-900, 0)).
    expect(far.position.x).toBeCloseTo(-ORBIT_BANDS[2].rx, 5);
    expect(composition.bands).toEqual([0, 2]);
  });

  it('names the places that contain a place, nearest first', () => {
    expect(placeTrail(index, regions[0]!)).toEqual(['Near', 'Alpha']);
    expect(placeTrail(index, planets[0]!)).toEqual(['Alpha']);
    expect(placeTrail(index, system)).toEqual([]);
  });

  it('keeps a planet where it was when another arrives, whatever the input order', () => {
    const before = composeSystem(index, system).planets.find((p) => p.descriptor.objectId === planets[0]!.objectId)!;
    const later = descriptor(104, 'planet', system.objectId, 0, -300, 'Later');
    const grown = indexUniverse([later, ...regions, ...planets, star, system].reverse(), []);
    const after = composeSystem(grown, system).planets.find((p) => p.descriptor.objectId === planets[0]!.objectId)!;
    expect(after.position).toEqual(before.position);
  });

  it('spreads regions apart on their own spots and never moves one when another is added', () => {
    const three = composeRegions(index, planets[0]!);
    expect(new Set(three.map((r) => `${r.offset.x},${r.offset.y}`)).size).toBe(3);
    const newest = descriptor(250, 'region', planets[0]!.objectId, 0, 0);
    const four = composeRegions(indexUniverse([system, star, ...planets, ...regions, newest], []), planets[0]!);
    for (const region of three)
      expect(four.find((r) => r.descriptor.objectId === region.descriptor.objectId)!.offset).toEqual(region.offset);
    expect(four).toHaveLength(4);
  });

  it('draws one lone dust cue at the centre and others outside the systems', () => {
    const lone = placeDust([fixtureId(1)], []);
    expect([...lone.values()]).toEqual([{ x: 0, y: 0 }]);
    const several = placeDust([fixtureId(2), fixtureId(3)], [system]);
    for (const at of several.values()) expect(Math.hypot(at.x, at.y)).toBeGreaterThan(130);
    expect(placeDust([fixtureId(3), fixtureId(2)], [system])).toEqual(several);
    expect(unitsFromId(fixtureId(2)).every((unit) => unit >= 0 && unit <= 1)).toBe(true);
  });

  it('fits the overview to the stage and never magnifies a lone system past a readable size', () => {
    expect(overviewScale([system], { width: 390, height: 700 })).toBeGreaterThan(0.5);
    expect(overviewScale([system], { width: 4000, height: 4000 })).toBeLessThanOrEqual(1.7);
    const spread = [system, { ...system, objectId: fixtureId(300), anchor: { x: 6000, y: 0, layer: 0 } }];
    expect(overviewScale(spread, { width: 390, height: 700 })).toBeLessThan(0.1);
  });

  it('lists every place in order, with recent activity first only when Lately is on', () => {
    const quiet = { ...planets[1]!, activity: { availability: 'available', state: 'quiet' } } satisfies SceneDescriptor;
    const active = {
      ...planets[0]!,
      activity: { availability: 'available', state: 'active' },
    } satisfies SceneDescriptor;
    const withActivity = indexUniverse([system, star, quiet, active, ...regions], []);
    const plain = outlineRows(withActivity, false).map((row) => row.place.label);
    const lately = outlineRows(withActivity, true).map((row) => row.place.label);
    expect([...plain].sort()).toEqual([...lately].sort());
    // By label Far comes first; with Lately on, the quiet Far goes after the active Near.
    expect(plain.indexOf('Far')).toBeLessThan(plain.indexOf('Near'));
    expect(lately.indexOf('Near')).toBeLessThan(lately.indexOf('Far'));
    expect(outlineRows(withActivity, false).map((row) => row.depth)).toEqual([0, 1, 1, 2, 2, 2]);
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
