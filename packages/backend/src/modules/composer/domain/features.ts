import type { EncounterSnapshot } from './types.js';
import type { ComposerSnapshot, Features } from './types.js';
import { COMPOSER_POLICY, overlap, tokens } from './policy.js';
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
export function features(snapshot: ComposerSnapshot, candidate: ComposerSnapshot['candidates'][number]): Features {
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
      return age >= 0 && age <= COMPOSER_POLICY.recentWindowMs;
    })
    .slice(0, COMPOSER_POLICY.recentLimit);
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
    format: weighted((topicId) => {
      const f = snapshot.evidence?.topics.find((t) => t.topicId === topicId)?.formats.find((f) => f.kind === c.kind);
      return f === undefined ? 0.5 : (1 + f.qualified) / (2 + f.measured);
    }),
    novelty,
    semanticFit: overlap(
      tokens(snapshot.intent.text),
      tokens(`${c.metadata.title} ${c.metadata.summary} ${c.facets.join(' ')}`),
    ),
    continuity: candidate.continuity?.strength ?? 0.5,
    recentRepetition: repetition,
  };
}
export function score(f: Features, horizontal: boolean): number {
  return horizontal
    ? 0.45 * f.continuity + 0.25 * f.intent + 0.15 * f.format + 0.15 * f.semanticFit - 0.25 * f.recentRepetition
    : 0.35 * f.intent +
        0.2 * f.interest +
        0.15 * f.format +
        0.15 * f.novelty +
        0.15 * f.semanticFit -
        0.25 * f.recentRepetition;
}
