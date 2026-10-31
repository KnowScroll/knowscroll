import { validateTopics } from '../../content/public.js';
import { explorationMass, explorationPick } from '../domain/exploration.js';
import { features, playLevelOf, score, similarity } from '../domain/features.js';
import { planLifts } from '../domain/plan.js';
import { COMPOSER_POLICY_V0, randomSource, refKey, uniformIndex, type ComposerPolicy } from '../domain/policy.js';
import { applyRelatedExclusion, applyStickyFormat, inCurrentSeries, seriesUnitIds } from '../domain/vertical-rules.js';
import { ComposerSnapshotSchema } from './snapshot-schema.js';
import type { ComposerDecision, ComposerSnapshot, EncounterRef } from '../domain/types.js';
function validRef(ref: { readonly assetId: string; readonly assetRevision: number }): boolean {
  return (
    ref.assetId.length > 0 &&
    ref.assetId.length <= 160 &&
    Number.isSafeInteger(ref.assetRevision) &&
    ref.assetRevision >= 1
  );
}
function bounded(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
export function validateSnapshot(s: ComposerSnapshot): void {
  const fail = () => {
    throw new Error('COMPOSER_SNAPSHOT_INVALID');
  };
  if (!ComposerSnapshotSchema.safeParse(s).success) fail();
  if (
    !s.universeId ||
    !Number.isSafeInteger(s.privacyEpoch) ||
    s.privacyEpoch < 1 ||
    !Number.isFinite(Date.parse(s.evaluatedAt)) ||
    s.seed.length < 1 ||
    s.seed.length > 160 ||
    !s.intent.language ||
    s.intent.language.length > 35 ||
    Object.values(s.watermarks).some((v) => !v || v.length > 240) ||
    s.candidates.length > 100 ||
    s.explorationPool.length > 100 ||
    s.intent.topicIds.length > 16 ||
    (s.intent.requiredTopicIds?.length ?? 0) > 16 ||
    s.intent.text.length > 2000 ||
    !['vertical', 'horizontal', 'return', 'variant'].includes(s.mode)
  )
    fail();
  // The two vertical rules would be silently ignored on another move, so a snapshot that asks is wrong.
  if ((s.intent.stickyFormat || s.intent.currentSeriesId || s.intent.relatedAssetIds) && s.mode !== 'vertical') fail();
  if (s.intent.stickyFormat && s.intent.format) fail();
  if (s.source && !validRef(s.source)) fail();
  if (s.explorationPool.some((r) => !validRef(r))) fail();
  if (s.intent.exactTarget && !validRef(s.intent.exactTarget)) fail();
  if (
    (s.mode === 'return' && !s.intent.exactTarget) ||
    (s.mode === 'variant' && (!s.intent.explanationUnitId || !s.intent.format)) ||
    (s.mode === 'horizontal' && !s.source)
  )
    fail();
  if (
    new Set(s.candidates.map((c) => refKey(c.encounter))).size !== s.candidates.length ||
    new Set(s.explorationPool.map(refKey)).size !== s.explorationPool.length
  )
    fail();
  if (s.semanticAssessments) {
    const candidateKeys = new Set(s.candidates.map((c) => refKey(c.encounter)));
    const assessed = s.semanticAssessments.entries.map(refKey);
    // An assessment of an unknown candidate would be an input the replay cannot explain.
    if (new Set(assessed).size !== assessed.length || assessed.some((key) => !candidateKeys.has(key))) fail();
  }
  for (const c of s.candidates) {
    if (
      !validRef(c.encounter) ||
      !['reel', 'scroll'].includes(c.encounter.kind) ||
      !c.encounter.metadata.language ||
      c.encounter.metadata.language.length > 35 ||
      !c.encounter.explanationUnitId ||
      c.encounter.explanationUnitId.length > 160 ||
      c.encounter.facets.some((f) => !f || f.length > 160) ||
      c.encounter.facets.length > 16 ||
      c.encounter.siblings.length > 2 ||
      !c.encounter.metadata.title ||
      c.encounter.metadata.title.length > 240 ||
      c.encounter.metadata.summary.length > 2000 ||
      c.encounter.metadata.kind !== c.encounter.kind
    )
      fail();
    validateTopics(c.encounter.topics);
    if (
      c.continuity &&
      (!bounded(c.continuity.strength) ||
        !s.source ||
        refKey(c.continuity.source) !== refKey(s.source) ||
        refKey(c.continuity.target) !== refKey(c.encounter))
    )
      fail();
  }
  const e = s.evidence;
  if (e) {
    if (
      e.universeId !== s.universeId ||
      e.privacyEpoch !== s.privacyEpoch ||
      e.evaluatedAt !== s.evaluatedAt ||
      e.watermark !== s.watermarks.context ||
      !e.policyVersion ||
      e.policyVersion.length > 160 ||
      e.topics.length > 100 ||
      e.recent.length > 20 ||
      e.hiddenAssetIds.length > 1000 ||
      new Set(e.topics.map((t) => t.topicId)).size !== e.topics.length ||
      new Set(e.recent.map((r) => r.exposureId)).size !== e.recent.length
    )
      fail();
    for (const t of e.topics)
      if (
        !Number.isFinite(t.activity) ||
        t.activity < 0 ||
        t.formats.length > 2 ||
        new Set(t.formats.map((f) => f.kind)).size !== t.formats.length ||
        t.formats.some(
          (f) =>
            !['reel', 'scroll'].includes(f.kind) ||
            !Number.isSafeInteger(f.measured) ||
            !Number.isSafeInteger(f.qualified) ||
            f.qualified < 0 ||
            f.measured < f.qualified,
        ) ||
        new Set((t.cells ?? []).map((cell) => `${cell.kind}:${cell.level}`)).size !== (t.cells ?? []).length ||
        (t.cells ?? []).some((cell) => cell.qualified < 0 || cell.measured < cell.qualified)
      )
        fail();
    if (e.established) {
      if (new Set(e.established.units.map((u) => u.explanationUnitId)).size !== e.established.units.length) fail();
      for (const unit of e.established.units) {
        const matches = s.candidates.filter((c) => c.encounter.explanationUnitId === unit.explanationUnitId);
        const facets = new Set(matches.flatMap((c) => c.encounter.facets));
        if (
          !matches.length ||
          new Set(unit.facets.map((f) => f.facetId)).size !== unit.facets.length ||
          unit.facets.some((f) => !facets.has(f.facetId))
        )
          fail();
      }
    }
    for (const r of e.recent)
      if (
        !Number.isFinite(Date.parse(r.activatedAt)) ||
        Date.parse(r.activatedAt) > Date.parse(s.evaluatedAt) ||
        r.facets.length > 16
      )
        fail();
    if (e.recent.some((r, i) => i > 0 && Date.parse(r.activatedAt) > Date.parse(e.recent[i - 1]!.activatedAt))) fail();
  }
  if (new TextEncoder().encode(JSON.stringify(s)).length > 192_000) fail();
}
/** Why a candidate cannot be offered at all, before any scoring. Empty means eligible. */
function exclusionsOf(
  s: ComposerSnapshot,
  c: ComposerSnapshot['candidates'][number],
  seriesUnits: ReadonlySet<string>,
): string[] {
  const exclusions: string[] = [];
  if (!c.admitted) exclusions.push('not_admitted');
  if (!c.accessible) exclusions.push('inaccessible');
  if (!c.renderable) exclusions.push('unrenderable');
  if (c.encounter.metadata.language !== s.intent.language) exclusions.push('language');
  if (s.intent.format && c.encounter.kind !== s.intent.format) exclusions.push('format');
  if (s.intent.exactTarget && refKey(c.encounter) !== refKey(s.intent.exactTarget)) exclusions.push('exact_target');
  if (s.mode === 'variant' && c.encounter.explanationUnitId !== s.intent.explanationUnitId)
    exclusions.push('explanation');
  // A subject move never offers the explanation the person is already on, in either format.
  if (s.mode === 'vertical' && c.encounter.explanationUnitId === s.intent.explanationUnitId)
    exclusions.push('current_explanation');
  // Another part of the series the person is in is reached by the Part move, never by a new subject.
  if (inCurrentSeries(s, c, seriesUnits)) exclusions.push('same_series');
  if (
    s.intent.requiredTopicIds?.some(
      (id) => !c.encounter.topics.some((t) => t.topicId === id && t.role !== 'incidental'),
    )
  )
    exclusions.push('required_topic');
  if (s.intent.continuityLinkId && c.continuity?.linkId !== s.intent.continuityLinkId) exclusions.push('exact_link');
  if (s.mode === 'horizontal' && !c.continuity) exclusions.push('no_admitted_link');
  if (s.evidence?.hiddenAssetIds.includes(c.encounter.assetId)) exclusions.push('hidden');
  return exclusions;
}
type Evaluation = ComposerDecision['evaluations'][number];

/** Every candidate with its exclusions, features and score under the policy. */
function evaluate(s: ComposerSnapshot, policy: ComposerPolicy) {
  const seriesUnits = seriesUnitIds(s);
  const { screened: unrelated, related } = applyRelatedExclusion(
    s,
    s.candidates.map((candidate) => ({
      candidate,
      exclusions: exclusionsOf(s, candidate, seriesUnits),
      base: features(s, candidate, policy),
    })),
  );
  const { screened: assessed, sticky } = applyStickyFormat(s, unrelated);
  // The plan lifts only among eligible candidates, after the intent has ranked them.
  const lifts = planLifts(
    s,
    assessed.filter(({ exclusions }) => exclusions.length === 0),
  );
  const evaluations: Evaluation[] = assessed.map(({ candidate: c, exclusions, base }) => {
    const lift = lifts.get(refKey(c.encounter));
    const f = lift?.features ?? base;
    return {
      assetId: c.encounter.assetId,
      assetRevision: c.encounter.assetRevision,
      explanationUnitId: c.encounter.explanationUnitId,
      eligible: exclusions.length === 0,
      exclusions,
      features: f,
      ...(lift ? { plan: lift.influence } : {}),
      score: score(f, s.mode === 'horizontal', policy),
    };
  });
  return { evaluations, sticky, related };
}

const byKey = (a: EncounterRef, b: EncounterRef) => (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0);

/**
 * The first offer (the ranked winner, or on the exploration branch a draw from the pool) and then up to
 * `maxOffers - 1` more by maximal marginal relevance. Deterministic for a snapshot and a policy.
 */
function choose(s: ComposerSnapshot, evaluations: readonly Evaluation[], policy: ComposerPolicy) {
  const eligible = evaluations.filter((e) => e.eligible).sort((a, b) => b.score - a.score || byKey(a, b));
  const rankedWinner = eligible[0];
  const pool = eligible.filter((e) => s.explorationPool.some((p) => refKey(p) === refKey(e))).sort(byKey);
  const encounter = (id: EncounterRef) => s.candidates.find((c) => refKey(c.encounter) === refKey(id))!.encounter;
  const members = pool.map((evaluation) => ({
    evaluation,
    kind: encounter(evaluation).kind,
    level: playLevelOf(encounter(evaluation)),
  }));
  const fraction = s.mode === 'vertical' && pool.length ? policy.explorationFraction : 0;
  const random = randomSource(s.seed);
  const explore = fraction > 0 && uniformIndex(random, 10) === 0;
  const first = explore ? explorationPick(members, random, policy.explorationByPlayLevel).evaluation : rankedWinner;
  const selection: ComposerDecision['selection'][number][] = [];
  if (first)
    selection.push({
      assetId: first.assetId,
      assetRevision: first.assetRevision,
      score: first.score,
      similarity: 0,
      mmr: first.score,
    });
  const seen = new Set(first ? [first.explanationUnitId] : []);
  while (selection.length < policy.maxOffers) {
    const next = eligible
      .filter((e) => !seen.has(e.explanationUnitId))
      .map((e) => {
        const redundancy = selection.length
          ? Math.max(...selection.map((chosen) => similarity(encounter(e), encounter(chosen))))
          : 0;
        return { e, redundancy, mmr: e.score - policy.mmrLambda * redundancy };
      })
      .sort((a, b) => b.mmr - a.mmr || byKey(a.e, b.e))[0];
    if (!next) break;
    selection.push({
      assetId: next.e.assetId,
      assetRevision: next.e.assetRevision,
      score: next.e.score,
      similarity: next.redundancy,
      mmr: next.mmr,
    });
    seen.add(next.e.explanationUnitId);
  }
  const member = first && members.find((m) => refKey(m.evaluation) === refKey(first));
  const probability = !first
    ? 0
    : (rankedWinner && refKey(first) === refKey(rankedWinner) ? 1 - fraction : 0) +
      (member ? explorationMass(fraction, members, member, policy.explorationByPlayLevel) : 0);
  return {
    selection,
    exploration: {
      fraction,
      branch: explore ? ('explore' as const) : ('ranked' as const),
      pool: pool.map((p) => ({ assetId: p.assetId, assetRevision: p.assetRevision })),
      selectedProbability: probability,
      ...(rankedWinner
        ? { rankedWinner: { assetId: rankedWinner.assetId, assetRevision: rankedWinner.assetRevision } }
        : {}),
    },
  };
}

/**
 * Pure policy: caller prepares an authorized bounded snapshot; activation later rechecks eligibility.
 * The caller names the policy (the composition roots choose it from `KS_COMPOSER_POLICY`); without one it is v0. A
 * stored decision replays under the policy it names (`policyOf(decision.policyVersion)`), so an old decision never
 * changes with a newer policy.
 */
export function composeEncounter(
  snapshot: ComposerSnapshot,
  policy: ComposerPolicy = COMPOSER_POLICY_V0,
): ComposerDecision {
  // Clone first: a caller cannot mutate an asynchronous persistence input through shared references.
  const s: ComposerSnapshot = structuredClone(snapshot);
  validateSnapshot(s);
  return decideValidated(s, policy);
}

/**
 * The decision for a snapshot that has already been validated and will not be changed, as the replay of
 * many stored decisions under several policies needs it (one validation, one decision per policy).
 */
export function decideValidated(s: ComposerSnapshot, policy: ComposerPolicy): ComposerDecision {
  const { evaluations, sticky, related } = evaluate(s, policy);
  const { selection, exploration } = choose(s, evaluations, policy);
  return {
    version: 'composer-decision.v0',
    policyVersion: policy.version,
    fallbackVersion: policy.fallback,
    universeId: s.universeId,
    privacyEpoch: s.privacyEpoch,
    evaluatedAt: s.evaluatedAt,
    seed: s.seed,
    input: s,
    evaluations,
    selection,
    exploration,
    ...(sticky ? { stickyFormat: sticky } : {}),
    ...(related ? { relatedTarget: related } : {}),
    outcome: selection.length ? 'ready' : 'exhausted',
  };
}
