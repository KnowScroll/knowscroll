import type { RoomStation } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { indexUniverse } from '../universe-layout';
import { buildDial, filterCounts, searchPlanets, searchSystems, wheelSystems, type DialSystem } from './dial-model';
import type { UniversePlace } from '../universe-session';

const descriptor = (
  objectId: string,
  kind: SceneDescriptor['kind'],
  label: string,
  parentId: string,
  quiet = false,
): SceneDescriptor =>
  ({
    objectId,
    kind,
    label,
    parentId,
    palette: 'sage',
    activity: { availability: 'available', state: quiet ? 'quiet' : 'active' },
  }) as unknown as SceneDescriptor;

const all = [
  descriptor('s-ml', 'system', 'Machine learning', 'u'),
  descriptor('s-climate', 'system', 'Climate', 'u', true),
  descriptor('s-football', 'system', 'Football', 'u'),
  descriptor('p-att', 'planet', 'Attention', 's-ml'),
  descriptor('p-inf', 'planet', 'Inference & serving', 's-ml'),
  descriptor('p-energy', 'planet', 'Energy', 's-climate'),
  descriptor('p-tactics', 'planet', 'Tactics', 's-football'),
  descriptor('r-dep', 'region', 'Deployment', 'p-inf'),
  descriptor('r-bat', 'region', 'Batching', 'p-inf'),
];
const index = indexUniverse(all, []);
const places: UniversePlace[] = all.map((d) => ({
  id: d.objectId,
  parentId: d.parentId,
  kind: d.kind,
  label: d.label,
  truthStatus: 'factual',
}));
const looks = [
  { kind: 'system', objectId: 's-ml', haze: 'coral' },
  {
    kind: 'planet',
    objectId: 'p-inf',
    type: 'ocean',
    rings: true,
    moon: false,
    hueShift: 12,
    variant: 0,
    siteCount: 6,
  },
] as unknown as SceneLook[];
const rooms = [
  { room: { roomId: 'room-a', name: 'Serving room' }, placement: { systemId: 's-ml' } },
  { room: { roomId: 'room-b', name: 'Pitch room' }, placement: { systemId: 's-football' } },
] as unknown as RoomStation[];

const dial = (hereRegionId: string | null = null, herePlaceId?: string) =>
  buildDial({ index, looks, stations: rooms, hereRegionId, herePlaceId });

describe('the orbit dial’s systems, from reads the Universe already holds', () => {
  it('takes names and order from the index, the look from the server, and a plain look when there is none', () => {
    const systems = dial();
    expect(systems.map((system) => system.name)).toEqual(['Climate', 'Football', 'Machine learning']);
    const ml = systems.find((system) => system.id === 's-ml')!;
    expect(ml.haze).toBe('coral');
    expect(ml.planets.map((planet) => planet.name)).toEqual(['Attention', 'Inference & serving']);
    expect(ml.planets[1]).toMatchObject({ type: 'ocean', rings: true, hueShift: 12, regions: 2 });
    // No look: the plain colour set of its palette, no ring, teal haze.
    expect(ml.planets[0]).toMatchObject({ type: 'lush', rings: false, moon: false, regions: 0 });
    expect(systems.find((system) => system.id === 's-climate')!.haze).toBe('teal');
  });

  it('counts planets, rooms and formed regions, and marks where the person is and was', () => {
    const systems = dial('r-dep', 'p-inf');
    const ml = systems.find((system) => system.id === 's-ml')!;
    expect(ml).toMatchObject({ rooms: 1, regions: 2, here: true });
    expect(ml.planets.find((planet) => planet.id === 'p-inf')!.here).toBe(true);
    expect(systems.filter((system) => system.here).map((system) => system.id)).toEqual(['s-ml']);
  });
});

describe('filters and search narrow the wheel and never change what exists', () => {
  const systems = dial();
  const names = (list: readonly DialSystem[]) => list.map((system) => system.name);

  it('All keeps every system in order; A–Z orders by name', () => {
    expect(names(wheelSystems(systems, 'all', undefined))).toEqual(['Climate', 'Football', 'Machine learning']);
    expect(names(wheelSystems([...systems].reverse(), 'az', undefined))).toEqual([
      'Climate',
      'Football',
      'Machine learning',
    ]);
  });

  it('Lately drops the quiet systems and With rooms keeps those with a room', () => {
    expect(names(wheelSystems(systems, 'lately', undefined))).toEqual(['Football', 'Machine learning']);
    expect(names(wheelSystems(systems, 'rooms', undefined))).toEqual(['Football', 'Machine learning']);
    expect(filterCounts(systems)).toEqual({ all: 3, rooms: 2 });
  });

  it('a search keeps the matching names, best match first, inside the filter', () => {
    const matches = searchSystems(places, 'ma');
    // "Climate" has "ma" inside a word, so it matches too, after the name that starts with it.
    expect(names(wheelSystems(systems, 'all', matches))).toEqual(['Machine learning', 'Climate']);
    expect(names(wheelSystems(systems, 'lately', searchSystems(places, 'c')))).toEqual(['Machine learning']);
  });

  it('planet search looks in the current system first, and Everywhere widens it', () => {
    const current = systems.find((system) => system.id === 's-ml');
    const near = searchPlanets(places, systems, current, 'en', false);
    expect(near.here.map((match) => match.planet.name)).toEqual(['Attention', 'Inference & serving']);
    expect(near.elsewhere).toEqual([]);
    const wide = searchPlanets(places, systems, current, 'en', true);
    expect(wide.elsewhere.map((match) => `${match.planet.name} in ${match.system.name}`)).toEqual([
      'Energy in Climate',
    ]);
  });

  it('never lists land that has not formed: only descriptors are read, and regions are counted, never listed', () => {
    const ml = systems.find((system) => system.id === 's-ml')!;
    expect(JSON.stringify(ml)).not.toMatch(/uncharted|unreached|not reached/i);
    expect(searchPlanets(places, systems, ml, 'deployment', true).here).toEqual([]);
  });
});
