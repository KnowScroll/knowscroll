import type { RoomStation } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { indexUniverse } from '../universe-layout';
import { layOutUniverse, looksById, shipPlanetOf, type UniverseSpaceInput } from './space-model';

/** Authored CI descriptors and looks only. */
function descriptor(
  n: number,
  kind: SceneDescriptor['kind'],
  parentId: string,
  x: number,
  y: number,
  extra: Partial<SceneDescriptor> = {},
): SceneDescriptor {
  const base = sceneFixture(5).descriptors[0]!;
  return {
    ...base,
    objectId: fixtureId(n),
    parentId,
    kind,
    label: `CI ${kind} ${n}`,
    anchor: { x, y, layer: 0 },
    seed: n.toString(16).padStart(32, '0'),
    ...extra,
  };
}
const look = (objectId: string, rest: Record<string, unknown>): SceneLook =>
  ({ schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1', objectId, ...rest }) as SceneLook;

const system = descriptor(100, 'system', fixtureId(1), -150, -150);
const star = descriptor(101, 'star', system.objectId, 150, -150);
const near = descriptor(102, 'planet', system.objectId, 150, 150, { palette: 'sage' });
const far = descriptor(103, 'planet', system.objectId, -750, -150, { palette: 'cobalt' });
const region = descriptor(200, 'region', near.objectId, 0, 0);
const looks = looksById([
  look(system.objectId, { kind: 'system', haze: 'coral' }),
  look(near.objectId, {
    kind: 'planet',
    type: 'frozen',
    rings: true,
    moon: false,
    hueShift: 40,
    variant: 1,
    siteCount: 7,
  }),
  look(far.objectId, { kind: 'planet', type: 'gas', rings: true, moon: true, hueShift: -20, variant: 0, siteCount: 7 }),
]);
const input = (overrides: Partial<UniverseSpaceInput> = {}): UniverseSpaceInput => ({
  index: indexUniverse([system, star, near, far, region], []),
  looks,
  stations: [],
  dustCueIds: [],
  lately: false,
  lastPlaceId: undefined,
  ...overrides,
});
const station = (n: number, systemId: string, planetId?: string): RoomStation =>
  ({
    room: { roomId: fixtureId(n), name: `Room ${n}` },
    standing: 'member',
    placement: { systemId, ...(planetId ? { planetId } : {}) },
  }) as unknown as RoomStation;

describe('laying out the universe for the space views', () => {
  it('draws type, rings, moon, hue and haze from the server looks, never from the seed', () => {
    const [placed] = layOutUniverse(input()).definition.systems;
    expect(placed!.family).toBe('coral');
    const byId = new Map(placed!.planets.map((planet) => [planet.id, planet]));
    expect(byId.get(near.objectId)).toMatchObject({
      type: 'frozen',
      rings: true,
      moon: false,
      hueShift: 40,
      variant: 1,
    });
    expect(byId.get(far.objectId)).toMatchObject({ type: 'gas', rings: true, moon: true, hueShift: -20 });
    // Two planets with one seed but different looks differ: the look decides.
    const same = { ...far, seed: near.seed };
    const [other] = layOutUniverse(input({ index: indexUniverse([system, star, near, same], []) })).definition.systems;
    expect(other!.planets.map((planet) => planet.type).sort()).toEqual(['frozen', 'gas']);
  });

  it('draws a place with no look plainly: a colour set from its palette, teal haze, no rings or moon', () => {
    const [placed] = layOutUniverse(input({ looks: new Map() })).definition.systems;
    expect(placed!.family).toBe('teal');
    const plain = placed!.planets.map((planet) => [planet.id, planet.type, planet.rings, planet.moon]);
    expect(plain).toContainEqual([near.objectId, 'lush', undefined, undefined]);
    expect(plain).toContainEqual([far.objectId, 'ocean', undefined, undefined]);
  });

  it('keeps every place where it was when others arrive, in any input order', () => {
    const before = layOutUniverse(input()).definition.systems[0]!;
    const later = descriptor(104, 'planet', system.objectId, 150, -450);
    const other = descriptor(105, 'system', fixtureId(1), 450, 150);
    const grown = layOutUniverse(
      input({ index: indexUniverse([other, later, region, far, near, star, system], []) }),
    ).definition;
    const after = grown.systems.find((candidate) => candidate.id === system.objectId)!;
    expect(after.position).toEqual(before.position);
    expect(after.sunRadius).toBe(before.sunRadius);
    for (const planet of before.planets)
      expect(after.planets.find((candidate) => candidate.id === planet.id)).toEqual(planet);
  });

  it('puts planets on orbits by their distance from the star and sizes the sun by seed alone', () => {
    const [placed] = layOutUniverse(input()).definition.systems;
    const [inner, outer] = [near, far].map((planet) => placed!.planets.find((p) => p.id === planet.objectId)!);
    expect(outer!.orbitRadius).toBeGreaterThan(inner!.orbitRadius);
    const quiet = { ...system, activity: { availability: 'available', state: 'quiet' } } satisfies SceneDescriptor;
    const quietLayout = layOutUniverse(input({ index: indexUniverse([quiet, star, near, far], []) })).definition;
    expect(quietLayout.systems[0]!.sunRadius).toBe(placed!.sunRadius);
  });

  it('turns places calm only under Lately, and only the quiet ones', () => {
    const quiet = { ...system, activity: { availability: 'available', state: 'quiet' } } satisfies SceneDescriptor;
    const index = indexUniverse([quiet, star, near, far], []);
    expect(layOutUniverse(input({ index })).definition.systems[0]!.calm).toBeUndefined();
    const lately = layOutUniverse(input({ index, lately: true })).definition.systems[0]!;
    expect(lately.calm).toBe(true);
    expect(lately.planets.every((planet) => planet.calm === undefined)).toBe(true);
  });

  it('parks the ship at the planet of the last place, and not under Lately', () => {
    const index = indexUniverse([system, star, near, far, region], []);
    expect(shipPlanetOf(index, near.objectId)).toBe(near.objectId);
    expect(shipPlanetOf(index, region.objectId)).toBe(near.objectId);
    expect(shipPlanetOf(index, system.objectId)).toBeUndefined();
    expect(shipPlanetOf(index, undefined)).toBeUndefined();
    expect(layOutUniverse(input({ lastPlaceId: region.objectId })).definition.shipPlanetId).toBe(near.objectId);
    expect(
      layOutUniverse(input({ lastPlaceId: region.objectId, lately: true })).definition.shipPlanetId,
    ).toBeUndefined();
  });

  it('places a station beyond its system orbits, drops one whose system is not on the map, and dims it under Lately', () => {
    const stations = [
      station(300, system.objectId),
      station(301, system.objectId, near.objectId),
      station(302, fixtureId(999)),
    ];
    const space = layOutUniverse(input({ stations }));
    expect(space.definition.stations!.map((entry) => entry.id)).toEqual([fixtureId(300), fixtureId(301)]);
    const [home] = space.definition.systems;
    const [round, beside] = space.definition.stations!;
    const reach = (entry: NonNullable<typeof round>) =>
      Math.hypot(entry.position.x - home!.position.x, entry.position.z - home!.position.z);
    expect(reach(round!)).toBeGreaterThan(Math.max(...home!.planets.map((planet) => planet.orbitRadius)));
    expect(reach(beside!)).toBeGreaterThan(home!.planets.find((planet) => planet.id === near.objectId)!.orbitRadius);
    expect(layOutUniverse(input({ stations, lately: true })).definition.stations!.every((entry) => entry.calm)).toBe(
      true,
    );
    expect(space.systemFocus(system.objectId)!.radius).toBeGreaterThan(reach(round!));
  });

  it('carries a room’s emblem and palette to its station, and nothing else of its face', () => {
    const kit = {
      version: 'station-kit.v1',
      palette: { ground: 'forest', accent: 'amber', ink: 'cream' },
      emblem: { frame: 'shield', glyph: 'centre-circle' },
      motif: 'chalk-lines',
      motion: 'draw',
      cast: { explainer: 'star', skeptic: 'gear' },
    };
    const faced = {
      ...station(310, system.objectId),
      room: { roomId: fixtureId(310), name: 'Room 310', identity: { kit } },
    } as unknown as RoomStation;
    const [withFace, plain] = layOutUniverse(input({ stations: [faced, station(311, system.objectId)] })).definition
      .stations!;
    expect(withFace!.emblem).toEqual({ emblem: kit.emblem, palette: kit.palette });
    expect(plain!.emblem).toBeUndefined();
  });

  it('draws one large dust cloud at the centre before any place exists, else small ones past the systems', () => {
    const empty = indexUniverse([], []);
    const lone = layOutUniverse(input({ index: empty, dustCueIds: [fixtureId(1)] })).definition.dust!;
    expect(lone).toHaveLength(1);
    expect(lone[0]!.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(lone[0]!.radius).toBeGreaterThan(4);
    const space = layOutUniverse(input({ dustCueIds: [fixtureId(3), fixtureId(2)] }));
    const { universeFocus } = space;
    for (const cloud of space.definition.dust!)
      expect(
        Math.hypot(cloud.position.x - universeFocus.center.x, cloud.position.z - universeFocus.center.z),
      ).toBeGreaterThan(Math.max(universeFocus.halfWidth, universeFocus.halfDepth));
    expect(space.definition.dust!.map((cloud) => cloud.id)).toEqual([fixtureId(2), fixtureId(3)]);
  });
});
