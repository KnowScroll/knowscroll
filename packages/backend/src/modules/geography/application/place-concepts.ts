import { PlaceConceptsSchema, ReadPlaceConceptsSchema } from '@knowscroll/contracts';
import type { GeographyPorts, ReadOwnPlaceConcepts } from './ports.js';

/**
 * Own place concepts: the catalogue topic of each established factual planet, so a client can set
 * something it holds about a topic on that topic's planet (the play landmarks of D-084 and D-089).
 *
 * Authority: the caller's current personal scope and an active owner. Side effects: none. It reads
 * the same stored places as the geography snapshot and adds only their public catalogue ids; it never
 * enqueues cartography, forms or moves a place, and holds nothing from play or from reading.
 */
export function makeReadOwnPlaceConcepts(
  p: Pick<GeographyPorts, 'withScope' | 'ownerActive' | 'store' | 'now'>,
): ReadOwnPlaceConcepts {
  return async (authority, input) => {
    ReadPlaceConceptsSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      const view = await p.store.view(scope);
      return PlaceConceptsSchema.parse({
        version: 'universe-place-concepts.v1',
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalWatermark: scope.revisionAtEntry,
        geography: {
          revision: view.state.revision,
          structureRevision: view.state.structureRevision,
          activityRevision: view.state.activityRevision,
        },
        planets: view.objects
          .filter((place) => place.kind === 'planet' && place.truthStatus === 'factual')
          .map((place) => ({ id: place.id, topicId: place.conceptId })),
      });
    });
    return result.kind === 'entered' && result.value
      ? ({ kind: 'read', concepts: result.value } as const)
      : ({ kind: 'refused', reason: 'scope_refused' } as const);
  };
}
