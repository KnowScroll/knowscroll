import type { PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ReadGeographySceneInput } from '../../geography/public.js';
import type { GeographyPlace } from '../domain/visibility.js';
import type { SocialPorts } from './ports.js';
import type { VisibilityStore } from './visibility-store.js';

/**
 * What redrawing a universe's published copy needs, and no friendship: the worker composes only
 * this. A read of the universe's own Geography inside the open scope, and a source of public
 * identities.
 */
export interface RefreshPorts {
  withScope: WithPersonalScope;
  visibility: VisibilityStore;
  readGeography: ReadGeographySceneInput;
  /** A random identifier unrelated to any private one. Never time-ordered, never derived. */
  newPublicId(): string;
  /** A random positive integer below 2^48, for fences that must not count anything (D-047). */
  newOpaqueToken(): number;
  now(): Date;
}

/** Everything the settings and visit commands use: Social's own ports and the refresh ports. */
export interface VisibilityPorts extends SocialPorts, RefreshPorts {}

/** The caller's own established places and the Geography revision they were read at. */
export interface OwnPlaces {
  readonly places: readonly GeographyPlace[];
  readonly geographyRevision: number;
}

/**
 * Reads the places of the scope's own universe through Geography's public read (never its tables).
 * Not readable (a limit, a failed consistency check, an owner that is not active) is `undefined`:
 * callers refuse rather than treat it as an empty universe, so a hiccup never unshares anything.
 */
export async function readOwnPlaces(
  p: Pick<RefreshPorts, 'readGeography'>,
  scope: PersonalScopeTx,
): Promise<OwnPlaces | undefined> {
  const read = await p.readGeography(scope);
  if (read.kind !== 'read') return undefined;
  return {
    geographyRevision: read.input.geography.revision,
    places: read.input.objects.map((object) => ({
      id: object.id,
      kind: object.kind,
      parentId: object.parent.id,
      label: object.label,
      truthStatus: object.truthStatus,
    })),
  };
}
