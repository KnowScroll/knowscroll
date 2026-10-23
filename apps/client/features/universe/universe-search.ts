import type { UniversePlace } from './universe-session';

export interface SearchResult {
  readonly place: UniversePlace;
  /** The places that contain it, nearest first ("Inference & serving", "Machine learning"). */
  readonly trail: readonly string[];
}

export const SEARCH_LIMIT = 12;
const KIND_ORDER: Record<UniversePlace['kind'], number> = { system: 0, planet: 1, region: 2, star: 3 };

const normalise = (text: string) =>
  text
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .trim();

/** 0 best: whole name starts with the query, then a word does, then it appears inside a word. */
function rank(name: string, query: string): number | undefined {
  if (name.startsWith(query)) return 0;
  if (name.split(' ').some((word) => word.startsWith(query))) return 1;
  return name.includes(query) ? 2 : undefined;
}

/**
 * Searches the person's own places by name. It runs on the places already on this device, never
 * calls the server, and never keeps or logs the query. Stars are not results: they are the
 * system's own light, and a system already stands for them.
 */
export function searchPlaces(places: readonly UniversePlace[], rawQuery: string): readonly SearchResult[] {
  const query = normalise(rawQuery);
  if (!query) return [];
  const byId = new Map(places.map((place) => [place.id, place]));
  return places
    .filter((place) => place.kind !== 'star')
    .flatMap((place) => {
      const score = rank(normalise(place.label), query);
      return score === undefined ? [] : [{ place, score }];
    })
    .sort(
      (a, b) =>
        a.score - b.score || KIND_ORDER[a.place.kind] - KIND_ORDER[b.place.kind] || a.place.label.localeCompare(b.place.label),
    )
    .slice(0, SEARCH_LIMIT)
    .map(({ place }) => {
      const trail: string[] = [];
      for (let parent = byId.get(place.parentId); parent && trail.length < 3; parent = byId.get(parent.parentId))
        trail.push(parent.label);
      return { place, trail };
    });
}
