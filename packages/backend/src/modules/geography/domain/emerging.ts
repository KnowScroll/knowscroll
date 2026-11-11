import type { Concept } from './policy.js';

/**
 * Catalogue systems that qualified reading has reached but that are not established yet, in a
 * stable order, at most `limit` of them. A topic the catalogue does not hold supports nothing. A
 * planet topic reaches its parent system; a system topic reaches itself.
 *
 * The cut is by system ID, so the same systems are offered on every read however the reading
 * arrived, and a system that becomes established lets the next one in. The contract holds only
 * `limit` cues (`EMERGING_LIMITS.dust`); a cue names nothing, so which ones are shown is not a
 * product choice.
 */
export function gatheringSystems(
  catalogue: readonly Concept[],
  qualifiedTopicIds: readonly string[],
  establishedSystemIds: ReadonlySet<string>,
  limit: number,
): readonly string[] {
  const byId = new Map(catalogue.map((concept) => [concept.id, concept]));
  const gathering = new Set<string>();
  for (const topicId of qualifiedTopicIds) {
    const concept = byId.get(topicId);
    if (!concept) continue;
    const systemId = concept.parent ?? concept.id;
    if (!establishedSystemIds.has(systemId)) gathering.add(systemId);
  }
  return [...gathering].sort().slice(0, limit);
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
