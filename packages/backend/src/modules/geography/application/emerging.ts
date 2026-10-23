import { EmergingUniverseSchema, ReadEmergingUniverseSchema } from '@knowscroll/contracts';
import { CONCEPTS } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { dustCueId, gatheringSystems } from '../domain/emerging.js';
import type { EmergingPorts, ReadOwnEmerging } from './ports.js';

/** The context query takes at most this many topic IDs. */
const TOPICS_PER_QUERY = 100;

/**
 * Own dust cues: the catalogue systems that qualified reading or watching has reached and that are
 * not established yet.
 *
 * Authority: the caller's current personal scope and an active owner. Side effects: none; this
 * read never enqueues cartography or writes. The cue exists because Personal Context holds a
 * qualified explanation unit under one of the system's topics, so only an actual personal
 * encounter creates one, and a selective Clear that removes the evidence removes the cue.
 */
export function makeReadOwnEmerging(p: EmergingPorts): ReadOwnEmerging {
  const catalogue = CONCEPTS.map((topic) => ({
    id: topic.id,
    parent: topic.parent,
    facets: topic.facets.map((facet) => facet.id),
  }));
  return async (authority, input) => {
    ReadEmergingUniverseSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      const view = await p.store.view(scope);
      const qualifiedTopicIds = await readQualifiedTopics(
        p,
        scope,
        catalogue.map((concept) => concept.id),
      );
      const established = new Set(
        view.objects.filter((place) => place.kind === 'system').map((place) => place.conceptId),
      );
      const systems = gatheringSystems(catalogue, qualifiedTopicIds, established);
      return EmergingUniverseSchema.parse({
        version: 'universe-emerging.v1',
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalWatermark: scope.revisionAtEntry,
        recordedAt: p.now().toISOString(),
        geography: {
          revision: view.state.revision,
          structureRevision: view.state.structureRevision,
          activityRevision: view.state.activityRevision,
        },
        dust: systems.map((systemId) => ({
          id: dustCueId(p.hash, scope.authority.universeId, scope.authority.privacyEpoch, systemId),
        })),
      });
    });
    return result.kind === 'entered' && result.value
      ? ({ kind: 'read', emerging: result.value } as const)
      : ({ kind: 'refused', reason: 'scope_refused' } as const);
  };
}

async function readQualifiedTopics(
  p: EmergingPorts,
  scope: PersonalScopeTx,
  topicIds: readonly string[],
): Promise<readonly string[]> {
  const qualified: string[] = [];
  for (let start = 0; start < topicIds.length; start += TOPICS_PER_QUERY) {
    const snapshot = await p.readSnapshot(scope, {
      evaluatedAt: p.now().toISOString(),
      topicIds: topicIds.slice(start, start + TOPICS_PER_QUERY),
      candidates: [],
      provisionalLimit: 0,
    });
    for (const topic of snapshot.topics) if (topic.qualifiedExplanationUnits > 0) qualified.push(topic.topicId);
  }
  return qualified;
}
