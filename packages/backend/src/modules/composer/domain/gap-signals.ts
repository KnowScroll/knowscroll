import { refKey } from './policy.js';
import type { ComposerDecision, TopicAttribution } from './types.js';

/**
 * Where a decision shows that content is running out (#674, D-414): the Composer already knows it, so it says it; whoever commits
 * the decision records it. `last_resort`: nothing unseen was eligible in either format and the least recently met was offered.
 * `low_headroom`: an unseen explanation was offered, and it is the last unseen one about its topic (or the topic has none left that
 * is eligible), so production can start before the reader runs out.
 */
export interface DecisionGapSignal {
  readonly source: 'last_resort' | 'low_headroom';
  /** A topic id: the one the first offer is about. Whether it is a catalogue planet is the recorder's check, not ours. */
  readonly planet: string;
}

/** At most this many unseen explanations about the offered topic, the offered one included, is low headroom. */
export const LOW_HEADROOM_UNITS = 1;

/** The most topics one decision speaks for: the offer's primary topics. */
const MAX_PLANETS = 2;

const aboutPrimary = (topics: readonly TopicAttribution[]): readonly string[] =>
  topics
    .filter((topic) => topic.role === 'primary')
    .map((topic) => topic.topicId)
    .slice(0, MAX_PLANETS);

/**
 * The gap signals one decision carries, from the decision alone: pure, nothing read, nothing written, and nothing about the
 * decision changes (the decision's inputs and replay are untouched). Only policy v2's system-chosen moves have a ladder, so
 * the rest carry none.
 *
 * Headroom is judged only when the snapshot held fewer candidates than the policy's maximum: a full snapshot is a sample of the
 * library, and a sample that hides unseen explanations must not read as the end of a topic. The last resort needs no such care,
 * because retrieval reads the unseen explanations first (D-408), so a snapshot with any unseen explanation holds it.
 */
export function gapSignalsOf(decision: ComposerDecision, maxCandidates: number): readonly DecisionGapSignal[] {
  const ladder = decision.unseenLadder;
  const first = decision.selection[0];
  if (ladder === undefined || first === undefined) return [];
  const candidates = new Map(
    decision.input.candidates.map((candidate) => [refKey(candidate.encounter), candidate.encounter]),
  );
  const offered = candidates.get(refKey(first));
  if (offered === undefined) return [];
  const planets = aboutPrimary(offered.topics);
  if (ladder.outcome === 'fell_back') return planets.map((planet) => ({ source: 'last_resort', planet }));
  if (ladder.outcome !== 'unseen' || decision.input.candidates.length >= maxCandidates) return [];
  const eligible = decision.evaluations.filter((evaluation) => evaluation.eligible);
  return planets
    .filter((planet) => {
      const units = new Set(
        eligible.flatMap((evaluation) => {
          const encounter = candidates.get(refKey(evaluation));
          return encounter?.topics.some((topic) => topic.topicId === planet && topic.role !== 'incidental') === true
            ? [encounter.explanationUnitId]
            : [];
        }),
      );
      return units.size <= LOW_HEADROOM_UNITS;
    })
    .map((planet) => ({ source: 'low_headroom', planet }));
}
