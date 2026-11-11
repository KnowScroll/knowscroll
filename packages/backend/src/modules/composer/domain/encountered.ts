import type { ComposerSnapshot, SourcePlace, UnseenLadderOutcome } from './types.js';

type Candidate = ComposerSnapshot['candidates'][number];

/** The non-incidental topic ids of a candidate: the topics it is about. */
const aboutTopics = (candidate: Candidate): readonly string[] =>
  candidate.encounter.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId);

/**
 * Whether the person has already met the explanation of a candidate: an activated exposure of its unit in either format,
 * the same notion `evidence.established.units[].encountered` carries (a Reel and its Scroll twin are one explanation),
 * or an encounter in the recent window (which is activated too). History that was not read says nothing, so a candidate
 * without it is not met: absence is never an assertion either way.
 */
export function isMet(snapshot: ComposerSnapshot, explanationUnitId: string): boolean {
  const evidence = snapshot.evidence;
  if (evidence === undefined) return false;
  return (
    evidence.established?.units.some((u) => u.explanationUnitId === explanationUnitId && u.encountered) === true ||
    evidence.recent.some((r) => r.explanationUnitId === explanationUnitId)
  );
}

/**
 * When the person last met an explanation, in milliseconds, or `0` (the oldest) when the input does not say. The
 * newest of the established unit's time and of the recent encounters of it.
 */
export function lastMetAt(snapshot: ComposerSnapshot, explanationUnitId: string): number {
  const evidence = snapshot.evidence;
  if (evidence === undefined) return 0;
  const times = [
    evidence.established?.units.find((u) => u.explanationUnitId === explanationUnitId)?.lastEncounteredAt,
    ...evidence.recent.filter((r) => r.explanationUnitId === explanationUnitId).map((r) => r.activatedAt),
  ].flatMap((at) => (at === undefined ? [] : [Date.parse(at)]));
  return times.length === 0 ? 0 : Math.max(...times);
}

/**
 * Where a candidate sits relative to the move's source (analytics only, never read by selection). `source_topic`: it is about
 * a topic the move starts from. `same_system`: about a topic of the same system (`intent.systemTopicIds`). Otherwise
 * `elsewhere`. A move without a source has no topics, so every candidate is `elsewhere`.
 */
export function placeOf(snapshot: ComposerSnapshot, candidate: Candidate): SourcePlace {
  const topics = aboutTopics(candidate);
  if (topics.some((id) => snapshot.intent.topicIds.includes(id))) return 'source_topic';
  const system = snapshot.intent.systemTopicIds ?? [];
  if (topics.some((id) => system.includes(id))) return 'same_system';
  return 'elsewhere';
}

/**
 * Whether policy v2's two tiers apply to a snapshot: a system-chosen move. A vertical move without an exact target is the
 * system's choice (the next subject, or the next one inside a region). Series, related, variant and return moves name
 * what the person asked for, and any snapshot with an exact target does, so none of them is ever asked to leave out what
 * was met: resuming, a part, a saved item, a shared link and the other format of what the person is on all stay open.
 */
export function unseenFirstApplies(snapshot: ComposerSnapshot): boolean {
  return snapshot.mode === 'vertical' && snapshot.intent.exactTarget === undefined;
}

/** The counts of places for a set of candidates. */
export function placeCounts(places: readonly SourcePlace[]): UnseenLadderOutcome['eligible'] {
  return {
    source_topic: places.filter((p) => p === 'source_topic').length,
    same_system: places.filter((p) => p === 'same_system').length,
    elsewhere: places.filter((p) => p === 'elsewhere').length,
  };
}

/**
 * The topics, among `candidateTopicIds`, of a system one of the `sourceTopicIds` belongs to and that are not the source's
 * own (the source's topics are `source_topic`). It only labels where an offer sits (analytics). `systemOf` names the system of a topic (`undefined` for an unknown one):
 * the catalogue is Content's, so the caller passes it in, and the result is frozen into the snapshot. Sorted and
 * bounded, so the snapshot is the same for the same inputs.
 */
export function systemTopicIdsOf(
  sourceTopicIds: readonly string[],
  candidateTopicIds: readonly string[],
  systemOf: (topicId: string) => string | undefined,
  limit = 200,
): readonly string[] {
  const systems = new Set(sourceTopicIds.flatMap((id) => systemOf(id) ?? []));
  if (systems.size === 0) return [];
  return [...new Set(candidateTopicIds)]
    .filter((id) => !sourceTopicIds.includes(id) && systems.has(systemOf(id) ?? ''))
    .sort()
    .slice(0, limit);
}
