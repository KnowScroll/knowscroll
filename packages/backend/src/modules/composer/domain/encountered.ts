import type { ComposerSnapshot, LadderStep, UnseenLadderOutcome } from './types.js';

/** The ladder's steps in the order they are tried. */
export const LADDER_STEPS: readonly LadderStep[] = ['source_topic', 'same_system', 'any_unseen', 'last_resort'];

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
 * The step of the ladder an explanation the person has not met belongs to. `source_topic`: it is about a topic the move
 * starts from. `same_system`: about a topic of the same system (`intent.systemTopicIds`). Otherwise `any_unseen`.
 * A move without a source has no topics, so every unseen candidate is `any_unseen`.
 */
export function unseenStepOf(snapshot: ComposerSnapshot, candidate: Candidate): Exclude<LadderStep, 'last_resort'> {
  const topics = aboutTopics(candidate);
  if (topics.some((id) => snapshot.intent.topicIds.includes(id))) return 'source_topic';
  const system = snapshot.intent.systemTopicIds ?? [];
  if (topics.some((id) => system.includes(id))) return 'same_system';
  return 'any_unseen';
}

/** The step of a candidate in the ladder: its unseen step, or `last_resort` when the person has met it. */
export function ladderStepOf(snapshot: ComposerSnapshot, candidate: Candidate): LadderStep {
  return isMet(snapshot, candidate.encounter.explanationUnitId) ? 'last_resort' : unseenStepOf(snapshot, candidate);
}

/**
 * Whether the ladder applies to a snapshot: a system-chosen move. A vertical move without an exact target is the
 * system's choice (the next subject, or the next one inside a region). Series, related, variant and return moves name
 * what the person asked for, and any snapshot with an exact target does, so none of them is ever asked to leave out what
 * was met: resuming, a part, a saved item, a shared link and the other format of what the person is on all stay open.
 */
export function ladderApplies(snapshot: ComposerSnapshot): boolean {
  return snapshot.mode === 'vertical' && snapshot.intent.exactTarget === undefined;
}

/** The counts of the ladder's steps for a set of candidates. */
export function stepCounts(steps: readonly LadderStep[]): UnseenLadderOutcome['eligible'] {
  return {
    source_topic: steps.filter((s) => s === 'source_topic').length,
    same_system: steps.filter((s) => s === 'same_system').length,
    any_unseen: steps.filter((s) => s === 'any_unseen').length,
    last_resort: steps.filter((s) => s === 'last_resort').length,
  };
}

/**
 * The topics, among `candidateTopicIds`, of a system one of the `sourceTopicIds` belongs to and that are not the source's
 * own (the source's topics are the first step). `systemOf` names the system of a topic (`undefined` for an unknown one):
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
