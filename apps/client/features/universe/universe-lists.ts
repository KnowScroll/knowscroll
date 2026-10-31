import type { RoomStation } from '@knowscroll/contracts';
import { isQuiet, type UniverseIndex } from './universe-layout';

/** One planet as a list reads it: how many regions have formed on it, and where the person was last. */
export interface ListedPlanet {
  readonly id: string;
  readonly name: string;
  /** Regions that have formed. Land not reached yet is never counted (D-109). */
  readonly regions: number;
  /** The name of the region the person left from, when it is on this planet ("You were here"). */
  readonly hereRegion: string | undefined;
  readonly quiet: boolean;
}

/** A room's station, as a list reads it. */
export interface ListedRoom {
  readonly id: string;
  readonly name: string;
  readonly systemId: string;
}

export interface ListedSystem {
  readonly id: string;
  readonly name: string;
  readonly planets: readonly ListedPlanet[];
  readonly rooms: readonly ListedRoom[];
  readonly quiet: boolean;
}

export interface ListedUniverse {
  readonly systems: readonly ListedSystem[];
  /** Every room that stands beside a system of this map, in the order the stations came. */
  readonly rooms: readonly (ListedRoom & { readonly systemName: string })[];
}

/**
 * The systems and planets of a map as plain lists read them: the Simple views, the desktop panel and
 * the orbit dial all show these. Names and order are the 3D drawing's (`index` order); a room whose
 * system is not on the map is left out, as it is not drawn either (D-106). Pure: no reads, no clock.
 */
export function listUniverse(
  index: UniverseIndex,
  stations: readonly RoomStation[],
  hereRegionId: string | null,
  lately = false,
): ListedUniverse {
  const hereRegion = hereRegionId ? index.byId.get(hereRegionId) : undefined;
  const rooms = stations.flatMap((station) =>
    index.byId.get(station.placement.systemId)?.kind === 'system'
      ? [{ id: station.room.roomId, name: station.room.name, systemId: station.placement.systemId }]
      : [],
  );
  /** Stable: with Lately on, quiet places go after the others and keep their order among themselves. */
  const recentFirst = <T extends { readonly quiet: boolean }>(items: readonly T[]): readonly T[] =>
    lately ? [...items].sort((a, b) => Number(a.quiet) - Number(b.quiet)) : items;
  const systems = index.systems.map((system): ListedSystem => {
    const planets = (index.planets.get(system.objectId) ?? []).map((planet): ListedPlanet => ({
      id: planet.objectId,
      name: planet.label,
      regions: index.regions.get(planet.objectId)?.length ?? 0,
      hereRegion: hereRegion?.parentId === planet.objectId ? hereRegion.label : undefined,
      quiet: isQuiet(planet),
    }));
    return {
      id: system.objectId,
      name: system.label,
      planets: recentFirst(planets),
      rooms: rooms.filter((room) => room.systemId === system.objectId),
      quiet: isQuiet(system),
    };
  });
  const nameOf = new Map(systems.map((system) => [system.id, system.name]));
  return {
    systems: recentFirst(systems),
    rooms: rooms.map((room) => ({ ...room, systemName: nameOf.get(room.systemId) ?? '' })),
  };
}

/** "1 planet", "3 planets", "1 country", "4 countries" for lists that speak of countries as the design does. */
export function countOf(count: number, noun: string): string {
  const plural = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${count} ${count === 1 ? noun : plural}`;
}
