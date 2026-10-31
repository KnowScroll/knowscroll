import type { RoomStation } from '@knowscroll/contracts';
import type { UniversePlace } from './universe-session';

export type SearchKind = 'system' | 'planet' | 'region' | 'room';

/** A room's station as search reads it: its name, and the system it stands beside. */
export interface SearchRoom {
  readonly id: string;
  readonly name: string;
  readonly systemId: string;
}

/** What a result names: a place of the map, or a room's station. Either way it is something the person already has. */
export interface SearchResult {
  readonly id: string;
  readonly kind: SearchKind;
  readonly name: string;
  /** The places that contain it, nearest first ("Inference & serving", "Machine learning"). */
  readonly trail: readonly string[];
  /** The part of `name` that matched, as a range of its own characters (start, end exclusive). */
  readonly match: readonly [number, number];
}

export const SEARCH_LIMIT = 12;
const KIND_ORDER: Record<SearchKind, number> = { system: 0, planet: 1, region: 2, room: 3 };
/** The one word each kind shows in a result's path. */
export const KIND_WORD: Record<SearchKind, string> = {
  system: 'System',
  planet: 'Planet',
  region: 'Region',
  room: 'Room',
};

/** The stations of a map as search reads them. */
export const searchRoomsOf = (stations: readonly RoomStation[]): readonly SearchRoom[] =>
  stations.map((station) => ({
    id: station.room.roomId,
    name: station.room.name,
    systemId: station.placement.systemId,
  }));

/** A name with its accents and case taken off, and where each of its letters came from in the original. */
interface Folded {
  readonly text: string;
  readonly from: readonly number[];
  readonly to: readonly number[];
}

function fold(name: string): Folded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let position = 0;
  for (const character of name) {
    const letters = character.normalize('NFKD').replaceAll(/\p{M}/gu, '').toLowerCase();
    for (const letter of letters) {
      text += letter;
      from.push(position);
      to.push(position + character.length);
    }
    position += character.length;
  }
  return { text, from, to };
}

const normaliseQuery = (query: string) =>
  query.normalize('NFKD').replaceAll(/\p{M}/gu, '').toLowerCase().replaceAll(/\s+/g, ' ').trim();

/** 0 best: the whole name, then its start, then a word's start, then anywhere inside it. */
function locate(name: Folded, query: string): { tier: number; at: number } | undefined {
  if (name.text.trim() === query) return { tier: 0, at: name.text.indexOf(query) };
  if (name.text.startsWith(query)) return { tier: 1, at: 0 };
  const word = name.text.indexOf(` ${query}`);
  if (word >= 0) return { tier: 2, at: word + 1 };
  const inside = name.text.indexOf(query);
  return inside >= 0 ? { tier: 3, at: inside } : undefined;
}

interface Candidate {
  readonly id: string;
  readonly kind: SearchKind;
  readonly name: string;
  readonly parentId: string;
}

/**
 * Searches what the person already has by name: the places of their map and, when it is their own,
 * the rooms beside it (D-111). Best match first, then systems before planets before regions before
 * rooms. It runs on the places and stations already on this device, never calls the server and never
 * keeps or logs the query. Stars are not results: they are the system's own light. A place that has
 * not formed is not in `places`, so it cannot be found.
 */
export function searchUniverse(
  places: readonly UniversePlace[],
  rooms: readonly SearchRoom[],
  rawQuery: string,
): readonly SearchResult[] {
  const query = normaliseQuery(rawQuery);
  if (!query) return [];
  const byId = new Map(places.map((place) => [place.id, place]));
  const candidates: Candidate[] = [
    ...places.flatMap((place) =>
      place.kind === 'star'
        ? []
        : [{ id: place.id, kind: place.kind, name: place.label, parentId: place.parentId } satisfies Candidate],
    ),
    // A room stands beside a system of this map; one whose system is not here is not drawn, so it is not found either.
    ...rooms.flatMap((room) =>
      byId.get(room.systemId)?.kind === 'system'
        ? [{ id: room.id, kind: 'room', name: room.name, parentId: room.systemId } satisfies Candidate]
        : [],
    ),
  ];
  return candidates
    .flatMap((candidate) => {
      const folded = fold(candidate.name);
      const found = locate(folded, query);
      if (!found) return [];
      const last = found.at + query.length - 1;
      const match = [folded.from[found.at]!, folded.to[last] ?? folded.to.at(-1)!] as const;
      return [{ candidate, tier: found.tier, match }];
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind] ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .slice(0, SEARCH_LIMIT)
    .map(({ candidate, match }) => {
      const trail: string[] = [];
      for (let parent = byId.get(candidate.parentId); parent && trail.length < 3; parent = byId.get(parent.parentId))
        trail.push(parent.label);
      return { id: candidate.id, kind: candidate.kind, name: candidate.name, trail, match };
    });
}
