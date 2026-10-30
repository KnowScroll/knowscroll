import type { RoomStation } from '@knowscroll/contracts';
import type { PlanetType, SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import { layOutUniverse, looksById, type UniverseSpace } from '../universe/space/space-model';
import { indexUniverse } from '../universe/universe-layout';

/**
 * A labelled sample universe for the developer gallery: three systems with their planets, one room
 * station and the ship parked on a planet, laid out by the same code as the Universe tab. The frame
 * numbers measured on it are the real scene's, not the one-system sample's. Authored here, never
 * product data, and only reachable from the gallery.
 */
const universeId = '0199a000-0000-7000-8000-000000000002';
const id = (n: number): string => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

type Kind = SceneDescriptor['kind'];
interface Place {
  readonly n: number;
  readonly kind: Kind;
  readonly parent: number | null;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly quiet?: boolean;
}

const PLACES: readonly Place[] = [
  { n: 10, kind: 'system', parent: null, label: 'Sample system one', x: -150, y: -150 },
  { n: 11, kind: 'star', parent: 10, label: 'Sample star one', x: 150, y: -150 },
  { n: 12, kind: 'planet', parent: 10, label: 'Sample planet one', x: -450, y: -150 },
  { n: 13, kind: 'planet', parent: 10, label: 'Sample planet two', x: -150, y: 150 },
  { n: 14, kind: 'planet', parent: 10, label: 'Sample planet three', x: 450, y: 450 },
  { n: 20, kind: 'system', parent: null, label: 'Sample system two', x: 450, y: 450, quiet: true },
  { n: 21, kind: 'planet', parent: 20, label: 'Sample planet four', x: 750, y: 450 },
  { n: 22, kind: 'planet', parent: 20, label: 'Sample planet five', x: 450, y: 750 },
  { n: 30, kind: 'system', parent: null, label: 'Sample system three', x: -750, y: 750, quiet: true },
  { n: 31, kind: 'planet', parent: 30, label: 'Sample planet six', x: -450, y: 750 },
];

const PLANET_TYPES: Readonly<Record<number, { type: PlanetType; rings: boolean; moon: boolean }>> = {
  12: { type: 'lush', rings: false, moon: true },
  13: { type: 'ocean', rings: false, moon: false },
  14: { type: 'gas', rings: true, moon: true },
  21: { type: 'scorched', rings: false, moon: false },
  22: { type: 'frozen', rings: true, moon: false },
  31: { type: 'barren', rings: false, moon: true },
};
const HAZES = { 10: 'teal', 20: 'cobalt', 30: 'coral' } as const;

function descriptorOf(place: Place): SceneDescriptor {
  return {
    schemaVersion: 'scene-descriptor.v1',
    generatorVersion: 'silhouette.v1',
    objectId: id(place.n),
    parentId: place.parent === null ? universeId : id(place.parent),
    kind: place.kind,
    originTransitionId: id(9000),
    label: place.label,
    truthStatus: 'factual',
    activity: { availability: 'available', state: place.quiet === true ? 'quiet' : 'active' },
    family: 'ridged.v1',
    seed: (place.n * 7919).toString(16).padStart(32, 'a'),
    palette: 'sage',
    material: 'solid',
    atmosphere: { density: 0.1 },
    detail: { roughness: 0.2 },
    anchor: { x: place.x, y: place.y, layer: 0 },
    target: { kind: place.kind, objectId: id(place.n) },
  };
}

function lookOf(place: Place): SceneLook[] {
  const base = { schemaVersion: 'scene-look.v1', generatorVersion: 'worldmap.v1', objectId: id(place.n) } as const;
  const planet = PLANET_TYPES[place.n];
  if (place.kind === 'system') return [{ ...base, kind: 'system', haze: HAZES[place.n as keyof typeof HAZES] }];
  if (place.kind === 'planet' && planet !== undefined)
    return [{ ...base, kind: 'planet', ...planet, hueShift: 0, variant: 0, siteCount: 7 }];
  return [];
}

const STATION = {
  room: { roomId: id(500), name: 'Sample room' },
  standing: 'member',
  placement: { systemId: id(10) },
} as unknown as RoomStation;

/** The sample universe as the Universe tab lays it out, ship parked on the second planet. */
export function sampleUniverse(): UniverseSpace {
  return layOutUniverse({
    index: indexUniverse(PLACES.map(descriptorOf), []),
    looks: looksById(PLACES.flatMap(lookOf)),
    stations: [STATION],
    dustCueIds: [],
    lately: false,
    lastPlaceId: id(13),
  });
}
