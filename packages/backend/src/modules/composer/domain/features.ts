import type { EncounterSnapshot } from './types.js';
import type { ComposerSnapshot, Features, PlayLevel } from './types.js';
import { semanticFitOf } from './jev.js';
import { durationBucketOf, hierarchicalFormatFit, shrunkInterest, type FormatCounts } from './interest.js';
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
 * Format fit of one topic for a candidate (blueprint §8, "Personal interest and format fit"). The (topic, kind)
 * parent is the qualified-response rate with a uniform prior, `(1 + Q) / (2 + O)`. Policy v1 reads the candidate's
 * play-level cell instead, shrunk with prior strength `m` toward the rate of the person's other levels:
 * `(Q + m * prior) / (O + m)`, with `prior = (1 + Q_rest) / (2 + O_rest)`. The parent counts every level, this cell's
 * encounters included, so the other levels are the parent less the cell: a cell is never shrunk toward itself, and
 * its encounters are not counted twice. A cell with no encounters equals its parent, a cell with many moves to its own
 * rate, and a person with history in one level only is shrunk toward even odds. Both counts are about reading (a
 * qualified response), never about correctness. Always in [0,1].
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
  // A process from before migration 0082 counts the parent and not the cell, so the rest never goes below zero.
  const restMeasured = Math.max(0, (parentCounts?.measured ?? 0) - cell.measured);
  const restQualified = Math.min(restMeasured, Math.max(0, (parentCounts?.qualified ?? 0) - cell.qualified));
  const prior = (1 + restQualified) / (2 + restMeasured);
  return (cell.qualified + policy.formatCellPrior * prior) / (cell.measured + policy.formatCellPrior);
}

const countsOfKind = (
  formats: readonly { readonly kind: 'reel' | 'scroll'; readonly measured: number; readonly qualified: number }[],
  kind: 'reel' | 'scroll',
): FormatCounts | undefined => formats.find((f) => f.kind === kind);

/**
 * What policy v3 reads of the person for one candidate topic: the topic's own row, its system's roll-up and the person's roll-up,
 * all from the frozen snapshot. A level the input does not hold is absent (and reads as nothing known).
 */
function levelsOf(snapshot: ComposerSnapshot, topicId: string) {
  const evidence = snapshot.evidence;
  const systemId = evidence?.topicSystems?.find((t) => t.topicId === topicId)?.systemId;
  return {
    topic: evidence?.topics.find((t) => t.topicId === topicId),
    system: systemId === undefined ? undefined : evidence?.systems?.find((s) => s.systemId === systemId),
    person: evidence?.person,
  };
}

/** Policy v3's interest of a candidate's topic (D-420): shrunk toward its system and the person's overall level. */
function shrunkInterestOf(snapshot: ComposerSnapshot, topicId: string, policy: ComposerPolicy): number {
  const { topic, system, person } = levelsOf(snapshot, topicId);
  const own = topic?.activity ?? 0;
  return shrunkInterest(policy.interestModel!, {
    topicActivity: own,
    systemRestActivity: Math.max(0, (system?.activity ?? 0) - own),
    personActivity: person?.activity ?? 0,
  });
}

/** Policy v3's format fit of a candidate for one of its topics (D-420): topic, then system, then person, then a duration prior. */
function hierarchicalFormatOf(
  snapshot: ComposerSnapshot,
  topicId: string,
  encounter: EncounterSnapshot,
  policy: ComposerPolicy,
): number {
  const model = policy.formatModel!;
  const { topic, system, person } = levelsOf(snapshot, topicId);
  const kind = encounter.kind;
  const level = playLevelOf(encounter);
  const cell = topic?.cells?.find((c) => c.kind === kind && c.level === level);
  return hierarchicalFormatFit(
    model,
    {
      ...(person ? { person: countsOfKind(person.formats, kind) } : {}),
      ...(system ? { system: countsOfKind(system.formats, kind) } : {}),
      ...(topic ? { topic: countsOfKind(topic.formats, kind) } : {}),
      ...(cell ? { cell } : {}),
    },
    model.prior[durationBucketOf(encounter, model)],
  );
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
  const weighted = (get: (topicId: string) => number, neutral = 0.5): number => {
    const total = relevant.reduce((sum, t) => sum + t.weight, 0);
    return Math.max(
      0,
      Math.min(1, (1 - total) * neutral + relevant.reduce((sum, t) => sum + t.weight * get(t.topicId), 0)),
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
    interest: policy.interestModel
      ? weighted((topicId) => shrunkInterestOf(snapshot, topicId, policy), policy.interestModel.base)
      : weighted((topicId) => {
          const activity = snapshot.evidence?.topics.find((t) => t.topicId === topicId)?.activity;
          return activity === undefined ? 0.5 : activity / (1 + activity);
        }),
    format: policy.formatModel
      ? weighted(
          (topicId) => hierarchicalFormatOf(snapshot, topicId, c, policy),
          policy.formatModel.prior[durationBucketOf(c, policy.formatModel)],
        )
      : weighted((topicId) =>
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

/**
 * Which format a person leans to in one topic, from the same parent rates as {@link formatFitOf} (#709, D-404): `reel`
 * or `scroll` when one rate is higher, `undefined` when they are even or nothing is known. A lean reads reading and
 * watching only, never play; it orders which twin a region shows first and never excludes the other. Pure.
 */
export function formatLeaning(
  evidence: { readonly topics: NonNullable<ComposerSnapshot['evidence']>['topics'] } | undefined,
  topicId: string,
): 'reel' | 'scroll' | undefined {
  const topic = evidence?.topics.find((t) => t.topicId === topicId);
  const rate = (kind: 'reel' | 'scroll') => {
    const counts = topic?.formats.find((f) => f.kind === kind);
    return counts === undefined ? 0.5 : (1 + counts.qualified) / (2 + counts.measured);
  };
  const reel = rate('reel'),
    scroll = rate('scroll');
  return reel > scroll ? 'reel' : scroll > reel ? 'scroll' : undefined;
}
