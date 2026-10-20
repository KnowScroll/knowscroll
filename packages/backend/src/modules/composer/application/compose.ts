import { validateTopics } from '../../content/public.js';
import { features, score, similarity } from '../domain/features.js';
import { COMPOSER_POLICY, randomSource, refKey, uniformIndex } from '../domain/policy.js';
import { ComposerSnapshotSchema } from './snapshot-schema.js';
import type { ComposerDecision, ComposerSnapshot } from '../domain/types.js';
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
        )
      )
        fail();
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
/** Pure policy: caller prepares an authorized bounded snapshot; activation later rechecks eligibility. */
export function composeEncounter(snapshot: ComposerSnapshot): ComposerDecision {
  // Clone first: a caller cannot mutate an asynchronous persistence input through shared references.
  const s: ComposerSnapshot = structuredClone(snapshot);
  validateSnapshot(s);
  const evaluations = s.candidates.map((c) => {
    const exclusions: string[] = [];
    if (!c.admitted) exclusions.push('not_admitted');
    if (!c.accessible) exclusions.push('inaccessible');
    if (!c.renderable) exclusions.push('unrenderable');
    if (c.encounter.metadata.language !== s.intent.language) exclusions.push('language');
    if (s.intent.format && c.encounter.kind !== s.intent.format) exclusions.push('format');
    if (s.intent.exactTarget && refKey(c.encounter) !== refKey(s.intent.exactTarget)) exclusions.push('exact_target');
    if (s.mode === 'variant' && c.encounter.explanationUnitId !== s.intent.explanationUnitId)
      exclusions.push('explanation');
    if (
      s.intent.requiredTopicIds?.some(
        (id) => !c.encounter.topics.some((t) => t.topicId === id && t.role !== 'incidental'),
      )
    )
      exclusions.push('required_topic');
    if (s.intent.continuityLinkId && c.continuity?.linkId !== s.intent.continuityLinkId) exclusions.push('exact_link');
    if (s.mode === 'horizontal' && !c.continuity) exclusions.push('no_admitted_link');
    if (s.evidence?.hiddenAssetIds.includes(c.encounter.assetId)) exclusions.push('hidden');
    const f = features(s, c);
    return {
      assetId: c.encounter.assetId,
      assetRevision: c.encounter.assetRevision,
      explanationUnitId: c.encounter.explanationUnitId,
      eligible: exclusions.length === 0,
      exclusions,
      features: f,
      score: score(f, s.mode === 'horizontal'),
    };
  });
  const eligible = evaluations
    .filter((e) => e.eligible)
    .sort((a, b) => b.score - a.score || (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0));
  const rankedWinner = eligible[0];
  const pool = eligible
    .filter((e) => s.explorationPool.some((p) => refKey(p) === refKey(e)))
    .sort((a, b) => (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0));
  const fraction = s.mode === 'vertical' && pool.length ? COMPOSER_POLICY.explorationFraction : 0;
  const random = randomSource(s.seed);
  const explore = fraction > 0 && uniformIndex(random, 10) === 0;
  const first = explore ? pool[uniformIndex(random, pool.length)] : rankedWinner;
  const selection: ComposerDecision['selection'][number][] = [];
  const encounter = (id: { readonly assetId: string; readonly assetRevision: number }) =>
    s.candidates.find((c) => refKey(c.encounter) === refKey(id))!.encounter;
  if (first)
    selection.push({
      assetId: first.assetId,
      assetRevision: first.assetRevision,
      score: first.score,
      similarity: 0,
      mmr: first.score,
    });
  const seen = new Set(first ? [first.explanationUnitId] : []);
  while (selection.length < COMPOSER_POLICY.maxOffers) {
    const next = eligible
      .filter((e) => !seen.has(e.explanationUnitId))
      .map((e) => {
        const redundancy = selection.length
          ? Math.max(...selection.map((chosen) => similarity(encounter(e), encounter(chosen))))
          : 0;
        return { e, redundancy, mmr: e.score - COMPOSER_POLICY.mmrLambda * redundancy };
      })
      .sort((a, b) => b.mmr - a.mmr || (refKey(a.e) < refKey(b.e) ? -1 : refKey(a.e) > refKey(b.e) ? 1 : 0))[0];
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
  const probability = !first
    ? 0
    : (rankedWinner && refKey(first) === refKey(rankedWinner) ? 1 - fraction : 0) +
      (pool.some((p) => refKey(p) === refKey(first)) ? fraction / pool.length : 0);
  return {
    version: 'composer-decision.v0',
    policyVersion: 'composer-policy.v0',
    fallbackVersion: 'lexical-admitted.v0',
    universeId: s.universeId,
    privacyEpoch: s.privacyEpoch,
    evaluatedAt: s.evaluatedAt,
    seed: s.seed,
    input: s,
    evaluations,
    selection,
    exploration: {
      fraction,
      branch: explore ? 'explore' : 'ranked',
      pool: pool.map((p) => ({ assetId: p.assetId, assetRevision: p.assetRevision })),
      selectedProbability: probability,
      ...(rankedWinner
        ? { rankedWinner: { assetId: rankedWinner.assetId, assetRevision: rankedWinner.assetRevision } }
        : {}),
    },
    outcome: selection.length ? 'ready' : 'exhausted',
  };
}
