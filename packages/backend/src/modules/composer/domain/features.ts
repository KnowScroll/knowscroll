import type { EncounterSnapshot } from './types.js';
import type { ComposerSnapshot, Features, PlayLevel } from './types.js';
import { semanticFitOf } from './jev.js';
import { overlap, refKey, tokens, type ComposerPolicy } from './policy.js';
export function similarity(a: EncounterSnapshot, b: EncounterSnapshot): number {
  if (a.explanationUnitId === b.explanationUnitId) return 1;
  return (
    (overlap(a.facets, b.facets) +
      overlap(
        tokens(`${a.metadata.title} ${a.metadata.summary}`),
        tokens(`${b.metadata.title} ${b.metadata.summary}`),
      )) /
    2
  );
}
/** SemanticFit of a candidate nobody assessed while others were: neutral, as for any missing measurement. */
const UNASSESSED_SEMANTIC_FIT = 0.5;

/**
 * Where Jev assessed part of a shortlist, an assessed candidate scores its combined criteria and every
 * other candidate is neutral (0.5), so the lexical overlap, which sits on a much lower scale, never
 * ranks an unassessed candidate below an assessed one by itself. With no assessment in play all
 * candidates use the deterministic lexical baseline.
 */
function semanticFit(snapshot: ComposerSnapshot, candidate: EncounterSnapshot): number {
  if (!snapshot.semanticAssessments)
    return overlap(
      tokens(snapshot.intent.text),
      tokens(`${candidate.metadata.title} ${candidate.metadata.summary} ${candidate.facets.join(' ')}`),
    );
  const assessed = snapshot.semanticAssessments.entries.find((entry) => refKey(entry) === refKey(candidate));
  return assessed ? semanticFitOf(assessed) : UNASSESSED_SEMANTIC_FIT;
}
/** The play level of a candidate; a Reel, and a Scroll stored before traits existed, are plain. */
export function playLevelOf(encounter: Pick<EncounterSnapshot, 'traits'>): PlayLevel {
  return encounter.traits?.playLevel ?? 'plain';
}

/**
 * Format fit of one topic for a candidate (blueprint §8, "Personal interest and format fit"). The
 * (topic, kind) parent is the qualified-response rate with a uniform prior, `(1 + Q) / (2 + O)`. Policy
 * v1 reads the candidate's play-level cell instead, shrunk toward the parent with prior strength `m`:
 * `(Q + m * parent) / (O + m)`. A cell with no encounters equals its parent, and a cell with many moves to
 * its own rate. Both counts are about reading (a qualified response), never about correctness. Always in [0,1].
 */
export function formatFitOf(
  topic: NonNullable<ComposerSnapshot['evidence']>['topics'][number] | undefined,
  encounter: Pick<EncounterSnapshot, 'kind' | 'traits'>,
  policy: Pick<ComposerPolicy, 'formatCellPrior'>,
): number {
  const parentCounts = topic?.formats.find((f) => f.kind === encounter.kind);
  const parent = parentCounts === undefined ? 0.5 : (1 + parentCounts.qualified) / (2 + parentCounts.measured);
  if (policy.formatCellPrior === null) return parent;
  const level = playLevelOf(encounter);
  const cell = topic?.cells?.find((c) => c.kind === encounter.kind && c.level === level);
  if (cell === undefined) return parent;
  return (cell.qualified + policy.formatCellPrior * parent) / (cell.measured + policy.formatCellPrior);
}

/**
 * How much of the person's last encounters were on the candidate's topics, in [0,1]: the newest `span`
 * encounters within the recent window, weighted `span, span-1, ..., 1`, each counting when it shares a
 * non-incidental topic with the candidate. A missing history counts as no repeat (neutral). Only a
 * vertical move asks: a series or related move exists to stay on a topic.
 */
export function recentTopicRepeat(
  recent: readonly { readonly topicIds?: readonly string[] }[],
  candidateTopicIds: readonly string[],
  span: number,
): number {
  if (span === 0 || candidateTopicIds.length === 0) return 0;
  const weightTotal = (span * (span + 1)) / 2;
  const counted = recent
    .slice(0, span)
    .reduce(
      (sum, encounter, index) =>
        sum + (encounter.topicIds?.some((id) => candidateTopicIds.includes(id)) ? span - index : 0),
      0,
    );
  return counted / weightTotal;
}

export function features(
  snapshot: ComposerSnapshot,
  candidate: ComposerSnapshot['candidates'][number],
  policy: ComposerPolicy,
): Features {
  const c = candidate.encounter;
  const relevant = c.topics.filter((t) => t.role !== 'incidental');
  const weighted = (get: (topicId: string) => number): number => {
    const total = relevant.reduce((sum, t) => sum + t.weight, 0);
    return Math.max(
      0,
      Math.min(1, (1 - total) * 0.5 + relevant.reduce((sum, t) => sum + t.weight * get(t.topicId), 0)),
    );
  };
  const recent = (snapshot.evidence?.recent ?? [])
    .filter((r) => {
      const age = Date.parse(snapshot.evaluatedAt) - Date.parse(r.activatedAt);
      return age >= 0 && age <= policy.recentWindowMs;
    })
    .slice(0, policy.recentLimit);
  const repetition =
    recent.length === 0
      ? 0
      : Math.max(...recent.map((r) => (r.explanationUnitId === c.explanationUnitId ? 1 : overlap(r.facets, c.facets))));
  const established = snapshot.evidence?.established?.units.find((u) => u.explanationUnitId === c.explanationUnitId);
  // A candidate-relevant history probe can establish unseen; absent history cannot.
  const establishedRepetition =
    established === undefined
      ? 0.5
      : established.encountered
        ? 1
        : c.facets.length === 0
          ? 0
          : c.facets.reduce((sum, facet) => {
              const known = established.facets.find((f) => f.facetId === facet);
              return sum + (known === undefined ? 0.5 : known.encountered ? 1 : 0);
            }, 0) / c.facets.length;
  const knownRecentRepetition =
    recent.length === 0
      ? 0
      : Math.max(
          ...recent.map((r) =>
            r.explanationUnitId === c.explanationUnitId
              ? 1
              : r.facets.length && c.facets.length
                ? overlap(r.facets, c.facets)
                : 0,
          ),
        );
  const novelty = 1 - Math.max(establishedRepetition, knownRecentRepetition);
  const match =
    snapshot.intent.topicIds.length === 0 || relevant.length === 0
      ? 0.5
      : relevant.some((t) => snapshot.intent.topicIds.includes(t.topicId))
        ? 1
        : 0;
  return {
    intent: match,
    interest: weighted((topicId) => {
      const activity = snapshot.evidence?.topics.find((t) => t.topicId === topicId)?.activity;
      return activity === undefined ? 0.5 : activity / (1 + activity);
    }),
    format: weighted((topicId) =>
      formatFitOf(
        snapshot.evidence?.topics.find((t) => t.topicId === topicId),
        c,
        policy,
      ),
    ),
    novelty,
    semanticFit: semanticFit(snapshot, c),
    continuity: candidate.continuity?.strength ?? 0.5,
    recentRepetition: repetition,
    ...(policy.recentTopicSpan > 0 && snapshot.mode === 'vertical'
      ? {
          recentTopic: recentTopicRepeat(
            recent,
            relevant.map((t) => t.topicId),
            policy.recentTopicSpan,
          ),
        }
      : {}),
  };
}
/** The score of a candidate under a policy. Horizontal moves ask for continuity; every other move for the vertical blend. */
export function score(f: Features, horizontal: boolean, policy: ComposerPolicy): number {
  if (horizontal) {
    const w = policy.horizontal;
    return (
      w.continuity * f.continuity +
      w.intent * f.intent +
      w.format * f.format +
      w.semanticFit * f.semanticFit -
      w.recentRepetition * f.recentRepetition
    );
  }
  const w = policy.vertical;
  const blend =
    w.intent * f.intent +
    w.interest * f.interest +
    w.format * f.format +
    w.novelty * f.novelty +
    w.semanticFit * f.semanticFit -
    w.recentRepetition * f.recentRepetition;
  return w.recentTopic === 0 ? blend : blend - w.recentTopic * (f.recentTopic ?? 0);
}
