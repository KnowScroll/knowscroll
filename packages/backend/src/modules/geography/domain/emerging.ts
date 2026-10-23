import type { Concept } from './policy.js';

/**
 * Catalogue systems that qualified reading has reached but that are not established yet, in a
 * stable order. A topic the catalogue does not hold supports nothing. A planet topic reaches its
 * parent system; a system topic reaches itself.
 */
export function gatheringSystems(
  catalogue: readonly Concept[],
  qualifiedTopicIds: readonly string[],
  establishedSystemIds: ReadonlySet<string>,
): readonly string[] {
  const byId = new Map(catalogue.map((concept) => [concept.id, concept]));
  const gathering = new Set<string>();
  for (const topicId of qualifiedTopicIds) {
    const concept = byId.get(topicId);
    if (!concept) continue;
    const systemId = concept.parent ?? concept.id;
    if (!establishedSystemIds.has(systemId)) gathering.add(systemId);
  }
  return [...gathering].sort();
}

/**
 * An opaque, stable cue ID for one system in one universe and epoch. It is derived from a hash so
 * the cue names nothing, and it is not the system's object ID (that ID does not exist yet).
 */
export function dustCueId(
  hash: (value: unknown) => string,
  universeId: string,
  privacyEpoch: number,
  systemId: string,
) {
  const hex = hash({ cue: 'dust', universeId, privacyEpoch, systemId });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
