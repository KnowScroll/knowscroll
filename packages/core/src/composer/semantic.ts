/**
 * #133 — `composer-semantic-v3` (ADR-0032 §3–§4). A pure function from a recorded state snapshot to
 * an ordered slate plus the full record of every candidate considered. No database, HTTP, provider
 * or UI import; the caller loads the state with bounded SQL and persists exactly this output.
 *
 * Objective: useful next encounters grounded in what the reader actually did — continue a thread,
 * go deeper, cross an admitted sourced bridge, meet a credible challenge, revisit something newly
 * relevant, or step outside on purpose — with honest fallback and exhaustion. Watch time is not an
 * input. Engagement is not the objective. Every term is recorded; every reason is a registered
 * template filled only with recorded facts.
 */
import { isWithin } from '../semantic/bridge-validator.ts';

export const COMPOSER_SEMANTIC_V3 = 'composer-semantic-v3';

export type Family = 'continue' | 'deepen' | 'bridge' | 'challenge' | 'revisit' | 'frontier' | 'seed' | 'fallback';
export const EXPLORATION_FAMILIES: readonly Family[] = ['bridge', 'frontier', 'challenge', 'revisit', 'fallback'];
export type MarkKind = 'keep' | 'branch' | 'ask';
export type GateReason = 'kept' | 'suppressed_by_person' | 'current_encounter';

export interface V3Policy {
  version: string;
  slateSize: number;
  maxPerSource: number;
  maxPerConcept: number;
  weights: { continuity: number; useful: number; depth: number; novelty: number; returnRelevance: number; prior: number; redundancy: number; fatigue: number; seen: number };
  familyDepth: Record<Family, number>;
  continuityWindowHours: number;
  explorationEvery: number;
  fatigueWindow: number;
  redundancyWindowDays: number;
  revisitMinGapDays: number;
  usefulSaturation: { exposureShare: number; cap: number };
  /** Every term size, versioned with the policy (packages/core/AGENTS.md: no ranking by code constants). */
  terms: {
    continuity: number; questionContinuity: number; novelty: number; returnRelevance: number; prior: number;
    redundancy: number; redundancyShare: number; fatigueStep: number; usefulScale: number; parentMassShare: number;
    /** Per showing; larger than the largest relevance swing, so the least-seen tier always comes first. */
    seenPerShowing: number;
    /** Only the most recent acts shape families: composition stays bounded as history grows. */
    maxMarks: number;
  };
}

export interface V3Concept { code: string; name: string; parentCode: string | null }
export interface V3Asset {
  assetId: string; title: string; kind: 'Scroll' | 'Reel'; sourceKey: string; editorialOrder: number;
  primary: string | null; concepts: readonly { code: string; role: 'primary' | 'secondary' | 'mentioned' }[];
  claimKeys: readonly string[];
}
export interface V3Bridge { id: string; from: string; to: string; symmetric: boolean; phraseForward: string; phraseReverse: string; fromName: string; toName: string }
export interface V3Mark { eventId: string; assetId: string; kind: MarkKind; atMs: number }
export interface V3Served { assetId: string; family: Family | null; atMs: number }

export interface V3State {
  nowMs: number;
  /** Deterministic tie-break salt: universe id + the number of v3 windows already served. */
  seed: string;
  concepts: ReadonlyMap<string, V3Concept>;
  assets: readonly V3Asset[];
  kept: ReadonlySet<string>;
  exposures: ReadonlyMap<string, { count: number; lastAtMs: number }>;
  sourceExposures: ReadonlyMap<string, number>;
  /** Voluntary marks, newest first. */
  marks: readonly V3Mark[];
  /** Encounters actually exposed, newest first, with the family they were served under. */
  served: readonly V3Served[];
  accounts: ReadonlyMap<string, { mass: number; exposureShare: number }>;
  bridges: readonly V3Bridge[];
  contradictions: readonly { from: string; to: string; claimKey: string }[];
  openQuestionConcepts: readonly string[];
  directionPriors: readonly string[];
  suppressedRoutes: readonly { family: Family; concept: string }[];
  /** The encounter currently on screen, never offered as its own next step. */
  currentAssetId: string | null;
}

export type Facts = Record<string, string | number | null>;
export type EvidenceStep =
  | { kind: 'mark'; markKind: MarkKind; assetId: string; title: string; at: string; eventId: string }
  | { kind: 'bridge'; bridgeId: string; sentence: string }
  | { kind: 'question'; concept: string }
  | { kind: 'outside'; domain: string };

export interface V3Candidate {
  assetId: string;
  sourceKey: string;
  family: Family;
  concept: string | null;
  bridgeId: string | null;
  gate: GateReason | null;
  terms: Record<string, number>;
  score: number;
  rank: number | null;
  explanationKey: string;
  facts: Facts;
  evidence: EvidenceStep[];
}

export interface V3Result {
  selected: V3Candidate[];
  candidates: V3Candidate[];
  quotas: string[];
  window: { served: V3Served[]; explorationDue: boolean };
}

/** The bench policy. Migration 0027 seeds the identical immutable `composer_policy` row; a test
 * guards that the two never drift. A changed value is a new policy version, never an edit. */
export const COMPOSER_V3_POLICY: V3Policy = {
  version: COMPOSER_SEMANTIC_V3,
  slateSize: 3,
  maxPerSource: 2,
  maxPerConcept: 1,
  weights: { continuity: 1, useful: 1, depth: 1, novelty: 1, returnRelevance: 1, prior: 1, redundancy: 1, fatigue: 1, seen: 1 },
  familyDepth: { continue: 0.3, deepen: 0.8, bridge: 1.2, challenge: 0.7, revisit: 0.2, frontier: 0.4, seed: 0.3, fallback: 0 },
  continuityWindowHours: 72,
  explorationEvery: 3,
  fatigueWindow: 5,
  redundancyWindowDays: 30,
  revisitMinGapDays: 3,
  usefulSaturation: { exposureShare: 0.8, cap: 0.5 },
  terms: {
    continuity: 0.3, questionContinuity: 0.2, novelty: 0.5, returnRelevance: 0.3, prior: 0.1,
    redundancy: 0.6, redundancyShare: 0.5, fatigueStep: 0.15, usefulScale: 4, parentMassShare: 0.5,
    seenPerShowing: 10, maxMarks: 50,
  },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VERB: Record<MarkKind, string> = { keep: 'kept', branch: 'followed', ask: 'asked about' };

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function rootOf(concepts: ReadonlyMap<string, V3Concept>, code: string): string {
  let at = code;
  const seen = new Set<string>();
  while (!seen.has(at)) { seen.add(at); const parent = concepts.get(at)?.parentCode; if (!parent) break; at = parent; }
  return at;
}

export function renderReason(template: string, facts: Facts): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const value = facts[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

export function composeSemantic(state: V3State, policy: V3Policy): V3Result {
  const tree = { concepts: new Map([...state.concepts].map(([k, v]) => [k, { code: v.code, name: v.name, description: '', parentCode: v.parentCode }])) };
  const name = (code: string) => state.concepts.get(code)?.name ?? code;
  const assetById = new Map(state.assets.map(a => [a.assetId, a]));
  const markedConcepts = (m: V3Mark) => (assetById.get(m.assetId)?.concepts ?? []).filter(c => c.role !== 'mentioned').map(c => c.code);
  const raw: Omit<V3Candidate, 'gate' | 'terms' | 'score' | 'rank'>[] = [];
  const offer = (asset: V3Asset, family: Family, concept: string | null, explanationKey: string, facts: Facts, evidence: EvidenceStep[], bridgeId: string | null = null) =>
    raw.push({ assetId: asset.assetId, sourceKey: asset.sourceKey, family, concept, bridgeId, explanationKey, facts, evidence });
  const markStep = (m: V3Mark): EvidenceStep => ({ kind: 'mark', markKind: m.kind, assetId: m.assetId, title: assetById.get(m.assetId)?.title ?? '', at: new Date(m.atMs).toISOString(), eventId: m.eventId });
  const marks = state.marks.slice(0, policy.terms.maxMarks);
  const recentMarks = marks.filter(m => state.nowMs - m.atMs <= policy.continuityWindowHours * HOUR);

  // --- Families -------------------------------------------------------------------------------
  // continue: the same idea as something the reader acted on recently.
  for (const mark of recentMarks) {
    for (const code of markedConcepts(mark)) {
      for (const asset of state.assets) {
        if (asset.assetId === mark.assetId || !asset.primary || asset.primary !== code) continue;
        offer(asset, 'continue', code, 'v3_continue',
          { conceptName: name(code), markVerb: VERB[mark.kind], markTitle: assetById.get(mark.assetId)?.title ?? '' }, [markStep(mark)]);
      }
    }
  }
  // continue (question): near a question the reader asked and has not resolved.
  for (const code of state.openQuestionConcepts) {
    for (const asset of state.assets) {
      if (!asset.primary || !isWithin(tree, asset.primary, code)) continue;
      offer(asset, 'continue', code, 'v3_question', { conceptName: name(code) }, [{ kind: 'question', concept: code }]);
    }
  }
  // deepen: narrower parts of an idea the reader acted on.
  for (const mark of marks) {
    for (const code of markedConcepts(mark)) {
      for (const asset of state.assets) {
        if (!asset.primary || asset.primary === code || !isWithin(tree, asset.primary, code)) continue;
        offer(asset, 'deepen', asset.primary, 'v3_deepen', { parentName: name(code), conceptName: name(asset.primary) }, [markStep(mark)]);
      }
    }
  }
  // bridge: admitted, non-suppressed sourced connections from something the reader acted on.
  for (const mark of marks) {
    for (const code of markedConcepts(mark)) {
      for (const bridge of state.bridges) {
        const forward = isWithin(tree, code, bridge.from);
        const backward = isWithin(tree, code, bridge.to);
        if (!forward && !backward) continue;
        const destination = forward ? bridge.to : bridge.from;
        const phrase = forward ? bridge.phraseForward : (bridge.symmetric ? bridge.phraseForward : bridge.phraseReverse);
        const [fromName, toName] = forward ? [bridge.fromName, bridge.toName] : [bridge.toName, bridge.fromName];
        for (const asset of state.assets) {
          if (!asset.primary || !isWithin(tree, asset.primary, destination)) continue;
          offer(asset, 'bridge', destination, 'v3_bridge', { fromName, relationPhrase: phrase, toName, markTitle: assetById.get(mark.assetId)?.title ?? '' },
            [markStep(mark), { kind: 'bridge', bridgeId: bridge.id, sentence: `${fromName} ${phrase} ${toName}` }], bridge.id);
        }
      }
    }
  }
  // challenge: a source that says a common idea near what the reader acted on does not hold.
  for (const mark of marks) {
    for (const code of markedConcepts(mark)) {
      for (const c of state.contradictions) {
        if (!isWithin(tree, code, c.from) && !isWithin(tree, code, c.to) && !isWithin(tree, c.from, code) && !isWithin(tree, c.to, code)) continue;
        for (const asset of state.assets) {
          if (!asset.claimKeys.includes(c.claimKey)) continue;
          offer(asset, 'challenge', asset.primary, 'v3_challenge', { conceptName: name(code) }, [markStep(mark)]);
        }
      }
    }
  }
  // revisit: something seen before whose idea the reader has acted on since.
  for (const asset of state.assets) {
    const seen = state.exposures.get(asset.assetId);
    if (!seen || !asset.primary || state.nowMs - seen.lastAtMs < policy.revisitMinGapDays * DAY) continue;
    const later = marks.find(m => m.atMs > seen.lastAtMs && m.assetId !== asset.assetId && markedConcepts(m).some(c => isWithin(tree, c, asset.primary!) || isWithin(tree, asset.primary!, c)));
    if (later) offer(asset, 'revisit', asset.primary, 'v3_revisit', { conceptName: name(asset.primary), markVerb: VERB[later.kind], markTitle: assetById.get(later.assetId)?.title ?? '' }, [markStep(later)]);
  }
  // frontier: a domain this universe has never been shown. seed: the same doors, at cold start.
  const shownDomains = new Set<string>();
  for (const [assetId] of state.exposures) { const p = assetById.get(assetId)?.primary; if (p) shownDomains.add(rootOf(state.concepts, p)); }
  const coldStart = marks.length === 0;
  for (const asset of state.assets) {
    if (!asset.primary) continue;
    const domain = rootOf(state.concepts, asset.primary);
    if (shownDomains.has(domain)) continue;
    offer(asset, coldStart ? 'seed' : 'frontier', asset.primary, coldStart ? 'v3_seed' : 'v3_frontier', { domainName: name(domain) }, [{ kind: 'outside', domain }]);
  }
  // fallback: everything else, so no part of the library can stay hidden.
  for (const asset of state.assets) offer(asset, 'fallback', asset.primary, 'v3_fallback', {}, []);

  // --- Gates and terms -------------------------------------------------------------------------
  const suppressed = (family: Family, concept: string | null) => concept !== null && state.suppressedRoutes.some(r => r.family === family && isWithin(tree, concept, r.concept));
  const servedRecent = state.served.slice(0, policy.fatigueWindow);
  const redundantSince = state.nowMs - policy.redundancyWindowDays * DAY;
  // Arguments already made by *other* encounters; a Scroll's own earlier showing is the seen term.
  const recentClaimSources = new Map<string, Set<string>>();
  for (const s of state.served.filter(x => x.atMs >= redundantSince)) {
    for (const key of assetById.get(s.assetId)?.claimKeys ?? []) recentClaimSources.set(key, (recentClaimSources.get(key) ?? new Set()).add(s.assetId));
  }
  const madeElsewhere = (key: string, assetId: string) => [...(recentClaimSources.get(key) ?? [])].some(id => id !== assetId);

  const scored: V3Candidate[] = raw.map(c => {
    const asset = assetById.get(c.assetId)!;
    let gate: GateReason | null = null;
    if (state.kept.has(asset.assetId)) gate = 'kept';
    else if (asset.assetId === state.currentAssetId) gate = 'current_encounter';
    else if (suppressed(c.family, c.concept)) gate = 'suppressed_by_person';
    const primary = asset.primary;
    const seenCount = state.exposures.get(asset.assetId)?.count ?? 0;
    const account = primary ? state.accounts.get(primary) : undefined;
    const parentMass = primary ? ancestorMass(state, primary) : 0;
    const t = policy.terms;
    let useful = 1 - Math.exp(-((account?.mass ?? 0) + t.parentMassShare * parentMass) / t.usefulScale);
    if (account && account.exposureShare > policy.usefulSaturation.exposureShare) useful = Math.min(useful, policy.usefulSaturation.cap);
    const terms: Record<string, number> = {
      continuity: c.family === 'continue' ? (c.explanationKey === 'v3_question' ? t.questionContinuity : t.continuity) : 0,
      useful: round(useful),
      depth: policy.familyDepth[c.family],
      novelty: c.family !== 'fallback' && primary !== null && ![...state.exposures.keys()].some(id => assetById.get(id)?.primary === primary) ? t.novelty : 0,
      returnRelevance: c.family === 'revisit' ? t.returnRelevance : 0,
      prior: primary !== null && (c.family === 'continue' || c.family === 'deepen') && state.directionPriors.some(p => isWithin(tree, primary, p)) ? t.prior : 0,
      redundancy: asset.claimKeys.length > 0 && asset.claimKeys.filter(k => madeElsewhere(k, asset.assetId)).length / asset.claimKeys.length >= t.redundancyShare ? t.redundancy : 0,
      fatigue: round(t.fatigueStep * servedRecent.filter(s => primary !== null && assetById.get(s.assetId)?.primary === primary).length),
      // Exposure-aware reranking (ADR-0032 §3): a seen encounter stays available, in tiers by how
      // often it was seen, least-seen first. Each showing costs more than any relevance difference,
      // so no seen Scroll (a revisit included) outranks a less-seen one. Softer penalties let
      // relevant seen Scrolls fill the slate while less-seen ones waited: a false end of library.
      seen: round(t.seenPerShowing * seenCount),
    };
    const w = policy.weights;
    const score = round(w.continuity * terms.continuity! + w.useful * terms.useful! + w.depth * terms.depth! + w.novelty * terms.novelty!
      + w.returnRelevance * terms.returnRelevance! + w.prior * terms.prior! - w.redundancy * terms.redundancy! - w.fatigue * terms.fatigue! - w.seen * terms.seen!);
    return { ...c, gate, terms, score, rank: null };
  });

  // One record per (asset, family): keep the strongest evidence for each.
  const best = new Map<string, V3Candidate>();
  for (const c of scored) {
    const key = `${c.assetId}|${c.family}`;
    const prior = best.get(key);
    if (!prior || c.score > prior.score || (c.score === prior.score && tieKey(state, c) < tieKey(state, prior))) best.set(key, c);
  }
  const candidates = [...best.values()].sort((a, b) => order(state, a, b));

  // --- Selection over the rolling served sequence ----------------------------------------------
  const quotas: string[] = [];
  const eligible = candidates.filter(c => c.gate === null);
  const byAsset = new Map<string, V3Candidate>();
  for (const c of eligible) if (!byAsset.has(c.assetId)) byAsset.set(c.assetId, c);
  const pool = [...byAsset.values()];
  const recent = state.served.slice(0, policy.explorationEvery - 1);
  const explorationDue = recent.length >= policy.explorationEvery - 1 && recent.every(s => !s.family || !EXPLORATION_FAMILIES.includes(s.family));
  const lastPrimary = state.served[0] ? assetById.get(state.served[0].assetId)?.primary ?? null : null;
  const lastMarked = marks[0] && state.served[0] && marks[0].assetId === state.served[0].assetId;

  const selected: V3Candidate[] = [];
  const perSource = new Map<string, number>();
  const perConcept = new Map<string, number>();
  const take = (c: V3Candidate) => {
    const asset = assetById.get(c.assetId)!;
    selected.push({ ...c, rank: selected.length + 1 });
    perSource.set(asset.sourceKey, (perSource.get(asset.sourceKey) ?? 0) + 1);
    if (asset.primary) perConcept.set(asset.primary, (perConcept.get(asset.primary) ?? 0) + 1);
  };
  const fits = (c: V3Candidate) => {
    const asset = assetById.get(c.assetId)!;
    if ((perSource.get(asset.sourceKey) ?? 0) >= policy.maxPerSource) return false;
    if (asset.primary && (perConcept.get(asset.primary) ?? 0) >= policy.maxPerConcept) return false;
    return !selected.some(s => s.assetId === c.assetId);
  };

  let head: V3Candidate | undefined;
  if (explorationDue) {
    // Families are ordered by exploration value before score, so a fallback item is chosen only
    // when no bridge, frontier, challenge or revisit is eligible; an unseen encounter still comes
    // before a seen one, as everywhere else.
    const exploration = [...candidates]
      .filter(c => c.gate === null && EXPLORATION_FAMILIES.includes(c.family))
      .sort((a, b) => a.terms.seen! - b.terms.seen!
        || EXPLORATION_FAMILIES.indexOf(a.family) - EXPLORATION_FAMILIES.indexOf(b.family) || order(state, a, b));
    head = exploration[0];
    if (head) quotas.push(`exploration_floor:${head.family}`);
  }
  if (!head && lastPrimary && !lastMarked) {
    head = pool.find(c => assetById.get(c.assetId)!.primary !== lastPrimary);
    if (head && head !== pool[0]) quotas.push('no_adjacent_repeat');
  }
  head ??= pool[0];
  if (head) take(head);
  for (const c of pool) {
    if (selected.length >= policy.slateSize) break;
    if (fits(c)) take(c);
  }
  // Recorded rank follows serving order; the rank/score consistency invariant applies to the
  // candidates chosen after the head, which is where a quota can reorder.
  const rankOf = new Map(selected.map(s => [`${s.assetId}|${s.family}`, s.rank]));
  const recorded = candidates.map(c => ({ ...c, rank: rankOf.get(`${c.assetId}|${c.family}`) ?? null }));
  return { selected, candidates: recorded, quotas, window: { served: state.served.slice(0, policy.explorationEvery), explorationDue } };
}

function ancestorMass(state: V3State, code: string): number {
  let total = 0;
  let parent = state.concepts.get(code)?.parentCode ?? null;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) { seen.add(parent); total += state.accounts.get(parent)?.mass ?? 0; parent = state.concepts.get(parent)?.parentCode ?? null; }
  return total;
}

function tieKey(state: V3State, c: V3Candidate): number { return fnv(`${state.seed}:${c.assetId}`); }

const FAMILY_ORDER: readonly Family[] = ['continue', 'bridge', 'deepen', 'challenge', 'revisit', 'frontier', 'seed', 'fallback'];

/** Score, then coverage (a less-offered source first, so no source waits behind another forever),
 * then a salted hash (no id wins every tie), then id and family: a strict total order. */
function order(state: V3State, a: V3Candidate, b: V3Candidate): number {
  if (a.score !== b.score) return b.score - a.score;
  const coverage = (state.sourceExposures.get(a.sourceKey) ?? 0) - (state.sourceExposures.get(b.sourceKey) ?? 0);
  if (coverage !== 0) return coverage;
  const hash = tieKey(state, a) - tieKey(state, b);
  if (hash !== 0) return hash;
  if (a.assetId !== b.assetId) return a.assetId < b.assetId ? -1 : 1;
  return FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family);
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
