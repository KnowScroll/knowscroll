import type { UniverseSceneState } from '@knowscroll/client-core';
import type { RegionEncounterTarget } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneReturnLocator, SceneRoute } from '@knowscroll/scene-core';

/** A place as lists and search see it, whichever read it came from. */
export interface UniversePlace {
  readonly id: string;
  readonly parentId: string;
  readonly kind: SceneDescriptor['kind'];
  readonly label: string;
  readonly truthStatus: SceneDescriptor['truthStatus'];
}

/**
 * What the map holds, from a read. On a map read as its sky (D-417) every system is a descriptor from the sky (or from its
 * own chunk once loaded) and the planets, stars and regions are those of the loaded systems; a map without the sky holds
 * everything its chunks name. These are computed once per read, so a screen may ask as often as it draws.
 */
const descriptorsCache = new WeakMap<UniverseSceneState, readonly SceneDescriptor[]>();
export function descriptorsOf(read: UniverseSceneState): readonly SceneDescriptor[] {
  const cached = descriptorsCache.get(read);
  if (cached) return cached;
  const chunked = read.snapshot?.chunks.flatMap((chunk) => chunk.objects) ?? [];
  let all = chunked;
  if (read.sky) {
    const own = new Set(chunked.filter((o) => o.kind === 'system').map((o) => o.objectId));
    all = [
      ...read.sky.systems.filter((entry) => !own.has(entry.descriptor.objectId)).map((entry) => entry.descriptor),
      ...chunked,
    ];
  }
  descriptorsCache.set(read, all);
  return all;
}

/** The routes of the loaded systems. */
export const routesOf = (read: UniverseSceneState): readonly SceneRoute[] =>
  read.snapshot?.chunks.flatMap((chunk) => chunk.routes) ?? [];

/** The chunk that holds a place, when it is loaded. */
export const chunkOfObject = (read: UniverseSceneState, objectId: string) =>
  read.snapshot?.chunks.find((chunk) => chunk.objects.some((o) => o.objectId === objectId));

/** How many planets each system of the sky has, and which systems are loaded; absent for a map that loaded whole. */
export function skyOf(
  read: UniverseSceneState,
): { readonly planetCounts: ReadonlyMap<string, number>; readonly loaded: ReadonlySet<string> } | undefined {
  const sky = read.sky;
  if (!sky) return undefined;
  return {
    planetCounts: new Map(sky.systems.map((entry) => [entry.descriptor.objectId, entry.planetCount])),
    loaded: new Set(read.loadedSystemIds ?? []),
  };
}

/**
 * Every place of the current read. A stale Scene keeps its own labels; Geography labels are used
 * only while there is no Scene, never mixed in.
 */
export function placesOf(read: UniverseSceneState): readonly UniversePlace[] {
  if (read.snapshot || read.sky)
    return descriptorsOf(read).map((o) => ({
      id: o.objectId,
      parentId: o.parentId,
      kind: o.kind,
      label: o.label,
      truthStatus: o.truthStatus,
    }));
  return (
    read.geography?.objects.map((o) => ({
      id: o.id,
      parentId: o.parent.id,
      kind: o.kind,
      label: o.label,
      truthStatus: o.truthStatus,
    })) ?? []
  );
}

const byIdCache = new WeakMap<UniverseSceneState, ReadonlyMap<string, SceneDescriptor>>();
/** Every place of a read by its id, built once per read. */
export function placeIndexOf(read: UniverseSceneState): ReadonlyMap<string, SceneDescriptor> {
  let byId = byIdCache.get(read);
  if (!byId) {
    byId = new Map(descriptorsOf(read).map((o) => [o.objectId, o]));
    byIdCache.set(read, byId);
  }
  return byId;
}

/** The system a place belongs to, or `undefined` when its system is not on the map (or the place is not loaded). */
export function systemOf(read: UniverseSceneState, placeId: string | null): string | undefined {
  if (placeId === null) return undefined;
  const byId = placeIndexOf(read);
  for (let place = byId.get(placeId); place; place = byId.get(place.parentId))
    if (place.kind === 'system') return place.objectId;
  return undefined;
}

/**
 * The exact region a card may ask the server about: only a focused region, only while the Scene
 * and Geography agree on the revision, so a card never speaks for a map that is out of date.
 */
export function regionTargetOf(read: UniverseSceneState, focusId: string | null): RegionEncounterTarget | undefined {
  const geography = read.geography;
  const object = geography?.objects.find((o) => o.id === focusId && o.kind === 'region');
  if (
    !object ||
    !geography ||
    read.status !== 'ready' ||
    !read.snapshot ||
    read.snapshot.read.manifest.revisions.geographyRevision !== geography.geography.revision
  )
    return undefined;
  return {
    kind: 'region',
    regionId: object.id,
    expectedObjectRevision: object.objectRevision,
    expectedGeographyRevision: geography.geography.revision,
  };
}

/** A saved camera is usable only if its place still exists (and, with a locator, in that very chunk). */
export function cameraStillValid(
  read: UniverseSceneState,
  entry: { readonly focusId: string | null; readonly locator?: SceneReturnLocator },
): boolean {
  if (!entry.focusId) return true;
  const place = placesOf(read).find((candidate) => candidate.id === entry.focusId);
  if (!place) return false;
  // A system is on the map whether or not its planets are loaded, so its chunk is not what keeps it valid.
  if (place.kind === 'system') return true;
  const locator = entry.locator;
  return (
    !locator ||
    Boolean(
      read.snapshot?.chunks.some(
        (chunk) => chunk.chunkId === locator.chunkId && chunk.objects.some((o) => o.objectId === entry.focusId),
      ),
    )
  );
}
