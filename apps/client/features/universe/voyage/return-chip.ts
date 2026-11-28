import type { UniverseIndex, UniverseView } from '../universe-layout';
import type { UniverseViewState } from '../universe-session';

/** Where the ship is parked: the planet (or star) to fly back to, named, and the star it belongs to. */
export interface ReturnTarget {
  readonly id: string;
  readonly label: string;
  /** What the place hangs under: a planet's star, a star's whole universe. */
  readonly parentId: string;
}

/** Where the ship is parked: the last place, or the planet of a region. A system is its own place. */
export function returnTarget(
  index: UniverseIndex,
  lastPlace: UniverseViewState['lastPlace'],
): ReturnTarget | undefined {
  const place = lastPlace ? index.byId.get(lastPlace.id) : undefined;
  if (!place) return undefined;
  const target = place.kind === 'region' ? (index.byId.get(place.parentId) ?? place) : place;
  return { id: target.objectId, label: target.label, parentId: target.parentId };
}

/**
 * Whether the new look's "Return to" chip shows at `shown` for the ship parked at `target` (the prototype's rule): never
 * at the place itself, and never at the star that holds the parked planet either. Pressing Back from a planet lands
 * on its star, and the star must not at once offer the planet you just left. Climbing on to the whole universe offers it.
 */
export function returnOffered(shown: UniverseView, target: ReturnTarget): boolean {
  if (shown.kind === 'planet') return target.id !== shown.planet.objectId;
  if (shown.kind === 'system') return target.id !== shown.system.objectId && target.parentId !== shown.system.objectId;
  return true;
}
