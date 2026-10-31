import type { RoomStation } from '@knowscroll/contracts';
import type { PlanetType, SceneLook } from '@knowscroll/scene-core';
import { PLAIN_TYPE, looksById } from '../space/space-model';
import type { HazeFamily } from '../space/planet-genome';
import type { UniverseIndex } from '../universe-layout';
import { listUniverse } from '../universe-lists';
import { searchUniverse, type SearchResult } from '../universe-search';
import type { UniversePlace } from '../universe-session';

/** The four ways the orbit dial narrows its wheel of systems (O2). */
export type DialFilter = 'all' | 'lately' | 'rooms' | 'az';
export const DIAL_FILTERS: readonly { readonly id: DialFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'lately', label: 'Lately' },
  { id: 'rooms', label: 'With rooms' },
  { id: 'az', label: 'A–Z' },
];

export interface DialPlanet {
  readonly id: string;
  readonly name: string;
  readonly type: PlanetType;
  readonly hueShift: number;
  readonly rings: boolean;
  readonly moon: boolean;
  /** Regions that have formed: land not reached yet is never counted (D-109). */
  readonly regions: number;
  /** The person's "You were here" region is on this planet. */
  readonly here: boolean;
  readonly quiet: boolean;
}

export interface DialSystem {
  readonly id: string;
  readonly name: string;
  readonly haze: HazeFamily;
  readonly planets: readonly DialPlanet[];
  readonly rooms: number;
  /** Formed regions in all its planets. */
  readonly regions: number;
  /** The camera, or the ship, is in this system ("You're here"). */
  readonly here: boolean;
  readonly quiet: boolean;
}

/**
 * The orbit dial's systems and planets, from the reads the Universe already holds: the index of
 * places, the looks (type, rings, moon, hue, haze), the room stations and the device's own "where
 * I was" marks. Names and order are the 3D drawing's. Nothing is fetched and nothing is scored.
 */
export function buildDial(input: {
  readonly index: UniverseIndex;
  readonly looks: readonly SceneLook[] | undefined;
  readonly stations: readonly RoomStation[];
  readonly hereRegionId: string | null;
  /** The place the camera is on, or where the ship is parked when it is on the whole map. */
  readonly herePlaceId: string | null | undefined;
}): readonly DialSystem[] {
  const { index, stations, hereRegionId, herePlaceId } = input;
  const looks = looksById(input.looks);
  const listed = listUniverse(index, stations, hereRegionId);
  const hereSystem = herePlaceId ? systemOfPlace(index, herePlaceId) : undefined;
  return listed.systems.map((system): DialSystem => {
    const systemLook = looks.get(system.id);
    const planets = system.planets.map((planet): DialPlanet => {
      const descriptor = index.byId.get(planet.id)!;
      const look = looks.get(planet.id);
      return {
        id: planet.id,
        name: planet.name,
        type: look?.kind === 'planet' ? look.type : PLAIN_TYPE[descriptor.palette],
        hueShift: look?.kind === 'planet' ? look.hueShift : 0,
        rings: look?.kind === 'planet' ? look.rings : false,
        moon: look?.kind === 'planet' ? look.moon : false,
        regions: planet.regions,
        here: planet.hereRegion !== undefined,
        quiet: planet.quiet,
      };
    });
    return {
      id: system.id,
      name: system.name,
      haze: systemLook?.kind === 'system' ? systemLook.haze : 'teal',
      planets,
      rooms: system.rooms.length,
      regions: planets.reduce((sum, planet) => sum + planet.regions, 0),
      here: system.id === hereSystem,
      quiet: system.quiet,
    };
  });
}

function systemOfPlace(index: UniverseIndex, placeId: string): string | undefined {
  for (let place = index.byId.get(placeId); place; place = index.byId.get(place.parentId))
    if (place.kind === 'system') return place.objectId;
  return undefined;
}

/** How many systems each filter would leave, for the chips' numbers. */
export function filterCounts(systems: readonly DialSystem[]): { readonly all: number; readonly rooms: number } {
  return { all: systems.length, rooms: systems.filter((system) => system.rooms > 0).length };
}

/**
 * The systems the wheel keeps. Lately drops the quiet ones, With rooms keeps those with a room beside
 * them, A–Z orders by name; a query keeps the names that match, best match first. Filtering never
 * changes what exists, only what the wheel turns through.
 */
export function wheelSystems(
  systems: readonly DialSystem[],
  filter: DialFilter,
  matches: readonly SearchResult[] | undefined,
): readonly DialSystem[] {
  const kept =
    filter === 'lately'
      ? systems.filter((system) => !system.quiet)
      : filter === 'rooms'
        ? systems.filter((system) => system.rooms > 0)
        : systems;
  const ordered = filter === 'az' ? [...kept].sort((a, b) => a.name.localeCompare(b.name)) : kept;
  if (matches === undefined) return ordered;
  const rank = new Map(matches.map((match, position) => [match.id, position]));
  return ordered.filter((system) => rank.has(system.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
}

/** Systems matching a typed name, with the letters that matched. Search runs on this device. */
export function searchSystems(places: readonly UniversePlace[], query: string): readonly SearchResult[] {
  return searchUniverse(places, [], query).filter((result) => result.kind === 'system');
}

export interface PlanetMatch {
  readonly planet: DialPlanet;
  readonly system: DialSystem;
  readonly result: SearchResult;
}

/**
 * Planets matching a typed name (O4): the current system's first, and with `everywhere` the planets
 * of every system. The rest of the planets stay on the dial, faded.
 */
export function searchPlanets(
  places: readonly UniversePlace[],
  systems: readonly DialSystem[],
  current: DialSystem | undefined,
  query: string,
  everywhere: boolean,
): { readonly here: readonly PlanetMatch[]; readonly elsewhere: readonly PlanetMatch[] } {
  const owner = new Map(
    systems.flatMap((system) => system.planets.map((planet) => [planet.id, { planet, system }] as const)),
  );
  const found = searchUniverse(places, [], query)
    .filter((result) => result.kind === 'planet')
    .flatMap((result) => {
      const entry = owner.get(result.id);
      return entry ? [{ ...entry, result }] : [];
    });
  const here = found.filter((match) => match.system.id === current?.id);
  const elsewhere = found.filter((match) => match.system.id !== current?.id);
  return { here, elsewhere: everywhere ? elsewhere : [] };
}
