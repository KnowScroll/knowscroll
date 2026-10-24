import type { UniverseSceneState } from '@knowscroll/client-core';
import type { RegionEncounterTarget } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneReturnLocator } from '@knowscroll/scene-core';

/** A place as lists and search see it, whichever read it came from. */
export interface UniversePlace {
  readonly id: string;
  readonly parentId: string;
  readonly kind: SceneDescriptor['kind'];
  readonly label: string;
  readonly truthStatus: SceneDescriptor['truthStatus'];
}

export const descriptorsOf = (read: UniverseSceneState): readonly SceneDescriptor[] =>
  read.snapshot?.chunks.flatMap((chunk) => chunk.objects) ?? [];

/**
 * Every place of the current read. A stale Scene keeps its own labels; Geography labels are used
 * only while there is no Scene, never mixed in.
 */
export function placesOf(read: UniverseSceneState): readonly UniversePlace[] {
  if (read.snapshot)
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
  if (!placesOf(read).some((place) => place.id === entry.focusId)) return false;
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
