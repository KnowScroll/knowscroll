/**
 * #131 — the private personal model (ADR-0032 §1–§2): attention accounts and rule hypotheses,
 * recomputed from this universe's Ledger in the same transaction that records new evidence.
 *
 * The caller holds the universe lock. Everything here is a projection: Clear/Reset erase it with
 * the history it was computed from, and a recompute from the same Ledger yields the same rows.
 * The evidence load is O(this universe's history), which is right for a personal product; a larger
 * history needs incremental episodes with the same arithmetic.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ATTENTION_V1, computeAttentionAccounts, type EpisodeEvidence, type MarkKind, type NegativeEvidence } from '../../../core/src/semantic/attention.ts';
import { proposeHypotheses, validateHypothesis, type HypothesisProposal } from '../../../core/src/semantic/hypotheses.ts';
import { BRANCH_POLICY_VERSION } from './branches.ts';

type Row = Record<string, unknown>;
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

export interface PersonalEvidence {
  episodes: EpisodeEvidence[];
  negatives: NegativeEvidence[];
  marks: { eventId: string; atMs: number; assetId: string; exposureId: string; kind: MarkKind; concepts: string[] }[];
  asks: { askEventId: string; exposureId: string; atMs: number; concept: string | null; resolved: boolean }[];
  conceptNames: Map<string, string>;
  conceptIds: Map<string, string>;
}

export async function loadPersonalEvidence(client: pg.PoolClient, universeId: string): Promise<PersonalEvidence> {
  const concepts = (await client.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM concept')).rows;
  const conceptNames = new Map(concepts.map(c => [c.code, c.name]));
  const conceptIds = new Map(concepts.map(c => [c.code, c.id]));

  const annotations = new Map<string, { code: string; role: 'primary' | 'secondary' | 'mentioned' }[]>();
  for (const r of (await client.query<{ asset_id: string; code: string; role: 'primary' | 'secondary' | 'mentioned' }>(
    'SELECT ac.asset_id, c.code, ac.role FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id ORDER BY ac.asset_id, c.code',
  )).rows) annotations.set(r.asset_id, [...(annotations.get(r.asset_id) ?? []), { code: r.code, role: r.role }]);

  const exposures = (await client.query<Row>(
    `SELECT e.id, e.asset_id, e.event_id, l.created_at, d.policy_version, f.key AS family_key
     FROM exposure e JOIN ledger l ON l.id = e.event_id JOIN decision d ON d.id = e.decision_id JOIN asset a ON a.id = e.asset_id
     LEFT JOIN semantic_source s ON s.url = a.source_url LEFT JOIN evidence_family f ON f.id = s.family_id
     WHERE e.universe_id = $1 ORDER BY l.created_at, e.id`,
    [universeId],
  )).rows;
  const byEvent = new Map(exposures.map(e => [String(e.event_id), e]));
  const byExposure = new Map(exposures.map(e => [String(e.id), e]));

  const markRows = (await client.query<Row>(
    `SELECT l.id, l.kind, l.created_at, l.causation_id FROM ledger l
     WHERE l.universe_id = $1 AND l.kind IN ('keep','branch') AND l.causation_id IS NOT NULL
     UNION ALL
     SELECT l.id, 'ask' AS kind, l.created_at, (SELECT event_id FROM exposure WHERE id = a.exposure_id) AS causation_id
     FROM explicit_ask a JOIN ledger l ON l.id = a.event_id WHERE a.universe_id = $1
     ORDER BY created_at, id`,
    [universeId],
  )).rows;
  const marks: PersonalEvidence['marks'] = [];
  const marksByExposure = new Map<string, EpisodeEvidence['marks'][number][]>();
  for (const r of markRows) {
    const exposure = byEvent.get(String(r.causation_id));
    if (!exposure) continue;
    const kind = r.kind as MarkKind;
    const mark = { eventId: String(r.id), kind, atMs: ms(r.created_at) };
    marksByExposure.set(String(exposure.id), [...(marksByExposure.get(String(exposure.id)) ?? []), mark]);
    const concepts = (annotations.get(String(exposure.asset_id)) ?? []).filter(c => c.role !== 'mentioned').map(c => c.code);
    marks.push({ eventId: mark.eventId, atMs: mark.atMs, assetId: String(exposure.asset_id), exposureId: String(exposure.id), kind, concepts });
  }

  const episodes: EpisodeEvidence[] = exposures.map(e => ({
    exposureId: String(e.id), atMs: ms(e.created_at), assetId: String(e.asset_id),
    concepts: annotations.get(String(e.asset_id)) ?? [], familyKey: e.family_key === null ? null : String(e.family_key),
    systemOffered: e.policy_version !== BRANCH_POLICY_VERSION, marks: marksByExposure.get(String(e.id)) ?? [],
  })).filter(e => e.concepts.length > 0);

  // Counterevidence: "less like this" on a concept, and connections the reader hid.
  const negatives: NegativeEvidence[] = [
    ...(await client.query<Row>(
      `SELECT f.id, f.created_at, c.code FROM encounter_feedback f JOIN concept c ON c.id = f.concept_id WHERE f.universe_id = $1`, [universeId],
    )).rows.map(r => ({ ref: String(r.id), atMs: ms(r.created_at), concepts: [String(r.code)] })),
    ...(await client.query<Row>(
      `SELECT cf.id, cf.created_at, t.code AS to_code, fr.code AS from_code FROM connection_feedback cf JOIN bridge b ON b.id = cf.bridge_id
       JOIN concept t ON t.id = b.to_concept_id JOIN concept fr ON fr.id = b.from_concept_id WHERE cf.universe_id = $1`, [universeId],
    )).rows.map(r => ({ ref: String(r.id), atMs: ms(r.created_at), concepts: [String(r.to_code)] })),
  ];

  const asks = (await client.query<Row>(
    `SELECT l.id AS event_id, a.exposure_id, l.created_at FROM explicit_ask a JOIN ledger l ON l.id = a.event_id WHERE a.universe_id = $1`, [universeId],
  )).rows.map(r => {
    const exposure = byExposure.get(String(r.exposure_id));
    const primary = exposure ? (annotations.get(String(exposure.asset_id)) ?? []).find(c => c.role === 'primary')?.code ?? null : null;
    // No answer path exists yet (#132): a recorded question stays open until one does.
    return { askEventId: String(r.event_id), exposureId: String(r.exposure_id), atMs: ms(r.created_at), concept: primary, resolved: false };
  });
  return { episodes, negatives, marks, asks, conceptNames, conceptIds };
}

export interface PersonalModelResult { accounts: number; transitions: number; hypotheses: { upserted: number; rejected: number } }

/** Recompute accounts and hypotheses for one universe. Caller holds the universe lock. */
export async function refreshPersonalModel(client: pg.PoolClient, universeId: string): Promise<PersonalModelResult> {
  const universe = (await client.query<{ privacy_epoch: number; now: Date }>('SELECT privacy_epoch, clock_timestamp() AS now FROM universe WHERE id=$1', [universeId])).rows[0];
  if (!universe) throw new Error('Universe not found');
  const nowMs = universe.now.getTime();
  const evidence = await loadPersonalEvidence(client, universeId);
  const accounts = computeAttentionAccounts(evidence.episodes, evidence.negatives, nowMs, ATTENTION_V1);

  const previous = new Map((await client.query<{ code: string; state: string }>(
    'SELECT c.code, a.state FROM attention_account a JOIN concept c ON c.id = a.concept_id WHERE a.universe_id = $1', [universeId],
  )).rows.map(r => [r.code, r.state]));
  let transitions = 0;
  for (const a of accounts.values()) {
    const conceptId = evidence.conceptIds.get(a.concept);
    if (!conceptId) continue;
    await client.query(
      `INSERT INTO attention_account(universe_id,concept_id,policy_version,mass,mass_at,episodes,voluntary,returns,days_active,span_days,source_families,exposure_share,negatives,state,evidence)
       VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (universe_id,concept_id) DO UPDATE SET policy_version=EXCLUDED.policy_version, mass=EXCLUDED.mass, mass_at=EXCLUDED.mass_at,
         episodes=EXCLUDED.episodes, voluntary=EXCLUDED.voluntary, returns=EXCLUDED.returns, days_active=EXCLUDED.days_active,
         span_days=EXCLUDED.span_days, source_families=EXCLUDED.source_families, exposure_share=EXCLUDED.exposure_share,
         negatives=EXCLUDED.negatives, state=EXCLUDED.state, evidence=EXCLUDED.evidence, computed_at=clock_timestamp()`,
      [universeId, conceptId, ATTENTION_V1.version, a.mass, a.massAtMs, a.episodes, a.voluntary, a.returns, a.daysActive, a.spanDays,
        a.sourceFamilies, a.exposureShare, a.negatives, a.state, JSON.stringify(a.evidence)],
    );
    const before = previous.get(a.concept) ?? null;
    if (before !== a.state) {
      transitions += 1;
      await client.query('INSERT INTO attention_transition(id,universe_id,concept_id,from_state,to_state,policy_version) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), universeId, conceptId, before, a.state, ATTENTION_V1.version]);
    }
  }

  const offeredEpisodes = new Map<string, string[]>();
  for (const e of evidence.episodes) if (e.systemOffered) for (const c of e.concepts) offeredEpisodes.set(c.code, [...(offeredEpisodes.get(c.code) ?? []), e.exposureId]);
  const proposals = proposeHypotheses({
    nowMs, accounts, conceptNames: evidence.conceptNames, marks: evidence.marks, offeredEpisodes,
    asks: evidence.asks, feedback: evidence.negatives,
  });
  const known = new Set<string>([
    ...evidence.episodes.map(e => `exposure:${e.exposureId}`), ...evidence.marks.map(m => `mark:${m.eventId}`),
    ...evidence.asks.map(a => `ask:${a.askEventId}`), ...evidence.negatives.map(n => `feedback:${n.ref}`),
  ]);
  let upserted = 0, rejected = 0;
  for (const p of proposals) {
    const verdict = validateHypothesis(p, { proposer: 'rule', knownEvidence: known, knownConcepts: new Set(evidence.conceptIds.keys()) });
    if (!verdict.ok) { rejected += 1; continue; }
    await upsertHypothesis(client, universeId, universe.privacy_epoch, evidence.conceptIds.get(p.concept)!, p);
    upserted += 1;
  }
  return { accounts: accounts.size, transitions, hypotheses: { upserted, rejected } };
}

async function upsertHypothesis(client: pg.PoolClient, universeId: string, epoch: number, conceptId: string, p: HypothesisProposal): Promise<void> {
  const payload = [p.statement, p.confidenceLabel, p.status, p.permittedUses, JSON.stringify(p.evidence), JSON.stringify(p.alternatives), JSON.stringify(p.counterevidence), JSON.stringify(p.decay)];
  // A revision is counted only when what the hypothesis says or may do actually changed.
  await client.query(
    `INSERT INTO personal_hypothesis(id,universe_id,privacy_epoch,kind,concept_id,proposer_kind,rule_version,statement,confidence_label,status,permitted_uses,evidence,alternatives,counterevidence,decay)
     VALUES($1,$2,$3,$4,$5,'rule',$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (universe_id,kind,concept_id) DO UPDATE SET
       statement=EXCLUDED.statement, confidence_label=EXCLUDED.confidence_label, status=EXCLUDED.status, permitted_uses=EXCLUDED.permitted_uses,
       evidence=EXCLUDED.evidence, alternatives=EXCLUDED.alternatives, counterevidence=EXCLUDED.counterevidence, decay=EXCLUDED.decay,
       rule_version=EXCLUDED.rule_version, privacy_epoch=EXCLUDED.privacy_epoch,
       revision=personal_hypothesis.revision + 1, revised_at=clock_timestamp()
     WHERE (personal_hypothesis.statement, personal_hypothesis.confidence_label, personal_hypothesis.status, personal_hypothesis.permitted_uses,
            personal_hypothesis.evidence, personal_hypothesis.alternatives, personal_hypothesis.counterevidence)
       IS DISTINCT FROM (EXCLUDED.statement, EXCLUDED.confidence_label, EXCLUDED.status, EXCLUDED.permitted_uses,
            EXCLUDED.evidence, EXCLUDED.alternatives, EXCLUDED.counterevidence)`,
    [randomUUID(), universeId, epoch, p.kind, conceptId, p.ruleVersion, ...payload],
  );
}

/** Clear/Reset: the personal model goes with the history it was computed from. */
export async function erasePersonalModel(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM encounter_feedback WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM personal_hypothesis WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM attention_transition WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM attention_account WHERE universe_id=$1', [universeId]);
}

export async function exportPersonalModel(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    attentionAccounts: await q(`SELECT c.code AS concept, a.policy_version, a.mass, a.mass_at, a.episodes, a.voluntary, a.returns, a.days_active, a.span_days,
      a.source_families, a.exposure_share, a.negatives, a.state, a.evidence FROM attention_account a JOIN concept c ON c.id = a.concept_id WHERE a.universe_id=$1 ORDER BY c.code`),
    hypotheses: await q(`SELECT h.id, h.kind, c.code AS concept, h.proposer_kind, h.rule_version, h.statement, h.confidence_label, h.status, h.permitted_uses,
      h.evidence, h.alternatives, h.counterevidence, h.decay, h.revision, h.created_at, h.revised_at FROM personal_hypothesis h JOIN concept c ON c.id = h.concept_id WHERE h.universe_id=$1 ORDER BY h.created_at`),
    encounterFeedback: await q('SELECT id, privacy_epoch, decision_id, asset_id, kind, family, suppress_until, created_at FROM encounter_feedback WHERE universe_id=$1 ORDER BY created_at'),
  };
}
