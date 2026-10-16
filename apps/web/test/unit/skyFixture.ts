import { webAtlasResponseSchema, type WebAtlasResponse } from '@knowscroll/contracts/atlas';

/** Hand-written Atlas responses for the star sky (ADR-0049). Test data only, never runtime evidence;
 * `atlasOf` validates every fixture against the real web contract, so no test reasons about a
 * response the server could not send. */
type Place = WebAtlasResponse['places'][number];
type Relation = WebAtlasResponse['relations'][number];
type ChronicleEntry = WebAtlasResponse['chronicle'][number];
type Room = Place['rooms'][number];
type RelationKind = Relation['kind'];

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const ids = {
  gravity: id(0xa1),
  orbits: id(0xa2),
  kepler: id(0xa3),
  starFormation: id(0xa4),
  tides: id(0xa5),
  light: id(0xb1),
  optics: id(0xb2),
  music: id(0xc1),
  released: id(0xd1),
  orphan: id(0xd2),
  missingParent: id(0xd3),
  roomGravity: id(0xe1),
  roomOrbits: id(0xe2),
  delta: (n: number) => id(0xf00 + n),
};

const FORMED = '2026-09-20T12:00:00.000Z';

function anchorOf(name: string) {
  return { code: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, description: `What ${name} is about.` };
}

export function planet(placeId: string, name: string, overrides: Partial<Place> = {}): Place {
  return {
    placeId,
    kind: 'planet',
    parentPlaceId: null,
    anchor: anchorOf(name),
    basis: null,
    attention: { state: 'anchored', episodes: 4, daysActive: 2 },
    scrolls: { total: 3, seen: 1 },
    formedAt: FORMED,
    formedBy: 'cartographer-v1',
    foundation: null,
    rooms: [],
    demand: null,
    ...overrides,
  };
}

export function region(placeId: string, parentPlaceId: string, name: string, overrides: Partial<Place> = {}): Place {
  return planet(placeId, name, { kind: 'region', parentPlaceId, attention: { state: 'anchored', episodes: 3, daysActive: 2 }, ...overrides });
}

export function sighting(placeId: string, parentPlaceId: string, name: string, kind: RelationKind | null, claim: string | null = null): Place {
  return planet(placeId, name, {
    kind: 'sighting',
    parentPlaceId,
    attention: null,
    scrolls: { total: 0, seen: 0 },
    basis: kind ? { kind, from: 'Somewhere', to: name, claim: claim ? { text: claim } : null, bridge: null } : null,
  });
}

/** A live room. The contract's ladder holds: it argues exactly when its doubter is seated. */
export function room(roomId: string, question: string, state: 'opened' | 'arguing' = 'opened', openedAt = '2026-09-22T12:00:00.000Z'): Room {
  return {
    roomId,
    question,
    state,
    openedAt,
    inhabitants: [
      { role: 'reader_of_record', claims: [{ key: `${roomId}-a`, statement: 'Mass changes how objects move.', truthState: 'documented', supportKind: 'supports' }] },
      ...(state === 'arguing'
        ? [{ role: 'doubter' as const, claims: [{ key: `${roomId}-b`, statement: 'The effect depends on the scale.', truthState: 'interpretation' as const, supportKind: 'qualifies' as const }] }]
        : []),
    ],
  };
}

export function relation(fromPlaceId: string, toPlaceId: string, kind: RelationKind, support: { claim?: string; bridge?: string } = {}): Relation {
  return {
    fromPlaceId,
    toPlaceId,
    kind,
    claim: support.claim ? { text: support.claim } : null,
    bridge: support.bridge ? { mechanism: support.bridge } : null,
  };
}

export function chronicle(n: number, placeId: string, parentPlaceId: string | null, kind: ChronicleEntry['kind'], at: string, line: string): ChronicleEntry {
  return { deltaId: ids.delta(n), placeId, parentPlaceId, kind, causalClass: 'personal_exploration', at, line };
}

export function atlasOf(places: Place[], relations: Relation[] = [], entries: ChronicleEntry[] = []): WebAtlasResponse {
  return webAtlasResponseSchema.parse({ policyVersion: 'cartographer-v1', places, relations, chronicle: entries });
}

/**
 * A two-star sky: Gravity holds a facet world (Orbits), a world inside it (Kepler's laws), a
 * question world on itself and one on Orbits, and two possibilities (one at its own edge, one at
 * Orbits'). Light has no world of its own; one sourced connection runs to it from Orbits.
 */
export function twoStarSky(): WebAtlasResponse {
  return atlasOf(
    [
      planet(ids.gravity, 'Gravity', { rooms: [room(ids.roomGravity, 'Does gravity shape the paths we see?', 'arguing', '2026-09-23T12:00:00.000Z')] }),
      region(ids.orbits, ids.gravity, 'Orbits', { rooms: [room(ids.roomOrbits, 'Why are orbits ellipses?', 'opened', '2026-09-24T12:00:00.000Z')], formedAt: '2026-09-21T12:00:00.000Z' }),
      region(ids.kepler, ids.orbits, "Kepler's laws", { formedAt: '2026-09-22T12:00:00.000Z' }),
      sighting(ids.starFormation, ids.gravity, 'Star formation', 'explains', 'Gravity gathers gas into stars.'),
      sighting(ids.tides, ids.orbits, 'Tides', 'analogous_in'),
      planet(ids.light, 'Light', { formedAt: '2026-09-25T12:00:00.000Z' }),
    ],
    [
      relation(ids.gravity, ids.orbits, 'explains', { claim: 'Gravity keeps bodies on their orbits.' }),
      relation(ids.orbits, ids.light, 'applies_to', { bridge: 'Orbits are measured with light.' }),
    ],
    [
      chronicle(1, ids.orbits, ids.gravity, 'place_formed', '2026-09-21T12:00:00.000Z', 'Orbits formed inside Gravity through your reading.'),
      chronicle(2, ids.gravity, null, 'place_formed', '2026-09-20T12:00:00.000Z', 'Gravity became a place through your reading.'),
    ],
  );
}
