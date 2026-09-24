/**
 * #133 — `composer-semantic-v3` persistence (ADR-0032 §3–§5): load the state snapshot with bounded
 * SQL, run the pure policy, and record every candidate, the served window and quotas, and the
 * rendered reasons in the caller's authenticated transaction. The database's commit-time triggers
 * (migration 0027) refuse a recorded decision that contradicts itself.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FeedAsset } from '../../../contracts/src/inventory.ts';
import {
  COMPOSER_SEMANTIC_V3,
  composeSemantic,
  renderReason,
  type Family,
  type V3Asset,
  type V3Policy,
  type V3State,
} from '../../../core/src/composer/semantic.ts';
import { SYMMETRIC_BRIDGE_TYPES, type BridgeRelationType } from '../../../contracts/src/semantic.ts';
import { decayedMass, ATTENTION_V1 } from '../../../core/src/semantic/attention.ts';
import type { AuthScope } from '../identity.ts';
import { BRANCH_POLICY_VERSION } from '../semantic/branches.ts';

type Row = Record<string, unknown>;
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const PHRASES: Record<BridgeRelationType, [string, string]> = {
  explains: ['explains', 'is explained by'], prerequisite_for: ['comes before understanding', 'builds on'],
  applies_to: ['applies to', 'is an application of'], compares_mechanism: ['works like', 'works like'], analogous_in: ['is like', 'is like'],
};

export async function loadV3Policy(client: pg.PoolClient): Promise<V3Policy> {
  const row = (await client.query('SELECT version, weights, slate_size, max_per_source FROM composer_policy WHERE version=$1', [COMPOSER_SEMANTIC_V3])).rows[0];
  if (!row) throw new Error(`composer_policy '${COMPOSER_SEMANTIC_V3}' is not registered`);
  const w = row.weights as Omit<V3Policy, 'version' | 'slateSize' | 'maxPerSource'>;
  return { version: row.version, slateSize: row.slate_size, maxPerSource: row.max_per_source, ...w };
}

export async function loadReasonTemplates(client: pg.PoolClient): Promise<Map<string, string>> {
  return new Map((await client.query<{ explanation_key: string; template: string }>('SELECT explanation_key, template FROM composer_reason_template')).rows.map(r => [r.explanation_key, r.template]));
}

/** Everything the pure policy reads, for one universe and the requested kinds. */
export async function loadV3State(client: pg.PoolClient, universeId: string, eligible: readonly FeedAsset[], nowMs: number): Promise<V3State> {
  const concepts = new Map((await client.query<{ code: string; name: string; parent_code: string | null }>(
    'SELECT c.code, c.name, p.code AS parent_code FROM concept c LEFT JOIN concept p ON p.id = c.parent_id',
  )).rows.map(r => [r.code, { code: r.code, name: r.name, parentCode: r.parent_code }]));

  const ids = eligible.map(a => a.assetId);
  const annotations = new Map<string, V3Asset['concepts'][number][]>();
  const claims = new Map<string, string[]>();
  if (ids.length) {
    for (const r of (await client.query<{ asset_id: string; code: string; role: 'primary' | 'secondary' | 'mentioned' }>(
      'SELECT ac.asset_id, c.code, ac.role FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id WHERE ac.asset_id = ANY($1::uuid[]) ORDER BY c.code', [ids],
    )).rows) annotations.set(r.asset_id, [...(annotations.get(r.asset_id) ?? []), { code: r.code, role: r.role }]);
    for (const r of (await client.query<{ asset_id: string; key: string }>(
      'SELECT x.asset_id, cl.key FROM asset_claim x JOIN claim cl ON cl.id = x.claim_id WHERE x.asset_id = ANY($1::uuid[]) ORDER BY cl.key', [ids],
    )).rows) claims.set(r.asset_id, [...(claims.get(r.asset_id) ?? []), r.key]);
  }
  const editorial = new Map((await client.query<{ id: string; editorial_order: number }>('SELECT id, editorial_order FROM asset WHERE id = ANY($1::uuid[])', [ids])).rows.map(r => [r.id, r.editorial_order]));
  const assets: V3Asset[] = eligible.map(a => {
    const own = annotations.get(a.assetId) ?? [];
    return { assetId: a.assetId, title: a.title, kind: a.kind, sourceKey: a.sourceUrl, editorialOrder: editorial.get(a.assetId) ?? 0,
      primary: own.find(c => c.role === 'primary')?.code ?? null, concepts: own, claimKeys: claims.get(a.assetId) ?? [] };
  });

  const kept = new Set<string>(((await client.query('SELECT kept_asset_ids FROM accounts WHERE universe_id=$1', [universeId])).rows[0]?.kept_asset_ids as string[]) ?? []);
  const exposureRows = (await client.query<Row>(
    `SELECT e.asset_id, e.decision_id, l.created_at, a.source_url, d.policy_version, dc.family
     FROM exposure e JOIN ledger l ON l.id = e.event_id JOIN asset a ON a.id = e.asset_id JOIN decision d ON d.id = e.decision_id
     LEFT JOIN decision_candidate dc ON dc.decision_id = e.decision_id AND dc.asset_id = e.asset_id AND dc.rank IS NOT NULL
     WHERE e.universe_id = $1 ORDER BY l.created_at DESC, e.id`, [universeId],
  )).rows;
  const exposures = new Map<string, { count: number; lastAtMs: number }>();
  const sourceExposures = new Map<string, number>();
  for (const r of exposureRows) {
    const id = String(r.asset_id);
    const prior = exposures.get(id);
    exposures.set(id, { count: (prior?.count ?? 0) + 1, lastAtMs: Math.max(prior?.lastAtMs ?? 0, ms(r.created_at)) });
    sourceExposures.set(String(r.source_url), (sourceExposures.get(String(r.source_url)) ?? 0) + 1);
  }
  // An explicit branch is the reader's own exploration: it counts toward the exploration floor.
  const served = exposureRows.map(r => ({ assetId: String(r.asset_id), atMs: ms(r.created_at),
    family: (r.policy_version === BRANCH_POLICY_VERSION ? 'bridge' : (r.family as Family | null)) ?? null }));

  const marks = (await client.query<Row>(
    `SELECT l.id, l.kind, l.created_at, e.asset_id FROM ledger l JOIN exposure e ON e.event_id = l.causation_id
     WHERE l.universe_id = $1 AND l.kind IN ('keep','branch')
     UNION ALL
     SELECT l.id, 'ask', l.created_at, e.asset_id FROM explicit_ask q JOIN ledger l ON l.id = q.event_id JOIN exposure e ON e.id = q.exposure_id
     WHERE q.universe_id = $1
     ORDER BY created_at DESC, id`, [universeId],
  )).rows.map(r => ({ eventId: String(r.id), assetId: String(r.asset_id), kind: r.kind as 'keep' | 'branch' | 'ask', atMs: ms(r.created_at) }));

  const accounts = new Map((await client.query<Row>(
    'SELECT c.code, a.mass, a.mass_at, a.exposure_share FROM attention_account a JOIN concept c ON c.id = a.concept_id WHERE a.universe_id = $1', [universeId],
  )).rows.map(r => [String(r.code), { mass: decayedMass(Number(r.mass), ms(r.mass_at), nowMs, ATTENTION_V1.halfLifeDays), exposureShare: Number(r.exposure_share) }]));

  const bridges = (await client.query<Row>(
    `SELECT b.id, b.relation_type, f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
     FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
     WHERE b.status = 'admitted' AND (b.universe_id IS NULL OR b.universe_id = $1)
       AND NOT EXISTS (SELECT 1 FROM connection_feedback cf WHERE cf.universe_id = $1 AND cf.bridge_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM encounter_feedback ef WHERE ef.universe_id = $1 AND ef.bridge_id = b.id AND ef.suppress_until > to_timestamp($2/1000.0))
     ORDER BY b.id`, [universeId, nowMs],
  )).rows.map(r => {
    const type = r.relation_type as BridgeRelationType;
    return { id: String(r.id), from: String(r.from_code), to: String(r.to_code), symmetric: SYMMETRIC_BRIDGE_TYPES.includes(type),
      phraseForward: PHRASES[type][0], phraseReverse: PHRASES[type][1], fromName: String(r.from_name), toName: String(r.to_name) };
  });
  const contradictions = (await client.query<Row>(
    `SELECT f.code AS from_code, t.code AS to_code, cl.key FROM concept_relation r JOIN concept f ON f.id = r.from_concept_id
     JOIN concept t ON t.id = r.to_concept_id JOIN claim cl ON cl.id = r.claim_id
     WHERE r.kind = 'contradicts' AND r.status = 'active' AND claim_is_supported(cl.id) ORDER BY cl.key`,
  )).rows.map(r => ({ from: String(r.from_code), to: String(r.to_code), claimKey: String(r.key) }));
  const hypotheses = (await client.query<Row>(
    `SELECT h.kind, c.code, h.permitted_uses FROM personal_hypothesis h JOIN concept c ON c.id = h.concept_id WHERE h.universe_id = $1 AND h.status = 'active'`, [universeId],
  )).rows;
  const suppressedRoutes = (await client.query<Row>(
    `SELECT f.family, c.code FROM encounter_feedback f JOIN concept c ON c.id = f.concept_id
     WHERE f.universe_id = $1 AND f.kind = 'less_like_this' AND f.suppress_until > to_timestamp($2/1000.0)`, [universeId, nowMs],
  )).rows.map(r => ({ family: r.family as Family, concept: String(r.code) }));
  const windows = Number((await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM decision_context WHERE universe_id = $1`, [universeId],
  )).rows[0]!.n);

  return {
    nowMs, seed: `${universeId}:${windows}`, concepts, assets, kept, exposures, sourceExposures, marks, served, accounts, bridges, contradictions,
    openQuestionConcepts: hypotheses.filter(h => h.kind === 'open_question' && (h.permitted_uses as string[]).includes('composer.continuity')).map(h => String(h.code)),
    directionPriors: hypotheses.filter(h => h.kind === 'direction' && (h.permitted_uses as string[]).includes('composer.family_prior')).map(h => String(h.code)),
    suppressedRoutes, currentAssetId: null,
  };
}

export type ComposedFeed = { decisionId: string; items: (FeedAsset & { reason: string })[]; policyVersion: string };

/** Compose and record one v3 decision. The caller holds the universe lock (authenticateAndLock). */
export async function composeAndRecordV3(client: pg.PoolClient, scope: AuthScope, eligible: readonly FeedAsset[], accountRevision: number): Promise<ComposedFeed> {
  const nowMs = ((await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now).getTime();
  const policy = await loadV3Policy(client);
  const templates = await loadReasonTemplates(client);
  const state = await loadV3State(client, scope.universeId, eligible, nowMs);
  const result = composeSemantic(state, policy);
  const byId = new Map(eligible.map(a => [a.assetId, a]));
  const reasonFor = (key: string, facts: Record<string, string | number | null>) => {
    const template = templates.get(key);
    if (template === undefined) throw new Error(`No registered composer_reason_template '${key}'`);
    return renderReason(template, facts);
  };
  const items = result.selected.map(c => ({ ...byId.get(c.assetId)!, reason: reasonFor(c.explanationKey, c.facts) }));

  const decisionId = randomUUID();
  await client.query(
    'INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch,ranking_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [decisionId, scope.universeId, accountRevision, 'semantic-retrieval-v3', JSON.stringify(items), scope.privacyEpoch, policy.version],
  );
  await client.query(
    'INSERT INTO decision_context(decision_id,universe_id,policy_version,seed,served_window,quotas,exploration_due) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [decisionId, scope.universeId, policy.version, state.seed, JSON.stringify(result.window.served), JSON.stringify(result.quotas), result.window.explorationDue],
  );
  const conceptIds = new Map((await client.query<{ code: string; id: string }>('SELECT code, id FROM concept')).rows.map(r => [r.code, r.id]));
  for (const c of result.candidates) {
    await client.query(
      `INSERT INTO decision_candidate(id,decision_id,universe_id,asset_id,family,concept_id,bridge_id,gate,terms,score,rank,explanation_key,facts,evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), decisionId, scope.universeId, c.assetId, c.family, c.concept ? conceptIds.get(c.concept) ?? null : null, c.bridgeId,
        c.gate, JSON.stringify(c.terms), c.score, c.rank, c.explanationKey, JSON.stringify(c.facts), JSON.stringify(c.evidence)],
    );
  }
  return { decisionId, items, policyVersion: policy.version };
}

export type WhyResponse = {
  decisionId: string; assetId: string; policyVersion: string; family: Family; reason: string;
  evidence: unknown[]; terms: Record<string, number>; quotas: string[];
  corrections: ('less_like_this' | 'wrong_connection')[];
};

/** The recorded explanation for one served candidate, exactly as decided. */
export async function readWhy(client: pg.PoolClient, scope: AuthScope, decisionId: string, assetId: string): Promise<WhyResponse | null> {
  const row = (await client.query<Row>(
    `SELECT dc.family, dc.facts, dc.evidence, dc.terms, dc.explanation_key, dc.bridge_id, t.template, ctx.quotas, ctx.policy_version
     FROM decision_candidate dc JOIN decision d ON d.id = dc.decision_id AND d.universe_id = $1
     JOIN composer_reason_template t ON t.explanation_key = dc.explanation_key JOIN decision_context ctx ON ctx.decision_id = dc.decision_id
     WHERE dc.decision_id = $2 AND dc.asset_id = $3 AND dc.rank IS NOT NULL`, [scope.universeId, decisionId, assetId],
  )).rows[0];
  if (!row) return null;
  return {
    decisionId, assetId, policyVersion: String(row.policy_version), family: row.family as Family,
    reason: renderReason(String(row.template), row.facts as Record<string, string>), evidence: row.evidence as unknown[],
    terms: row.terms as Record<string, number>, quotas: row.quotas as string[],
    corrections: row.bridge_id ? ['less_like_this', 'wrong_connection'] : (row.family === 'fallback' ? [] : ['less_like_this']),
  };
}
