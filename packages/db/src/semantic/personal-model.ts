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
import { eraseAtlas, exportAtlas, runCartographer, runKeeper } from '../atlas.ts';
import { withdrawCorrectedBindings } from '../inventory/demand.ts';
import { postInquiryMail } from '../reasoning-inquiries.ts';
import { eraseRooms, exportRooms } from '../rooms.ts';

type Row = Record<string, unknown>;
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

export interface PersonalEvidence {
  episodes: EpisodeEvidence[];
  negatives: NegativeEvidence[];
  marks: { eventId: string; atMs: number; assetId: string; exposureId: string; kind: MarkKind; concepts: string[] }[];
  /** The reader's Asks; `concept` is the primary concept of the Scroll each was asked from. */
  asks: { askId: string; askEventId: string; exposureId: string; assetId: string; atMs: number; concept: string | null; resolved: boolean }[];
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
    `SELECT a.id, l.id AS event_id, a.exposure_id, e.asset_id, l.created_at FROM explicit_ask a JOIN ledger l ON l.id = a.event_id
     JOIN exposure e ON e.id = a.exposure_id WHERE a.universe_id = $1 ORDER BY l.created_at, a.id`, [universeId],
  )).rows.map(r => {
    const primary = (annotations.get(String(r.asset_id)) ?? []).find(c => c.role === 'primary')?.code ?? null;
    // No answer path exists yet (#132): a recorded question stays open until one does.
    return { askId: String(r.id), askEventId: String(r.event_id), exposureId: String(r.exposure_id), assetId: String(r.asset_id), atMs: ms(r.created_at), concept: primary, resolved: false };
  });
  return { episodes, negatives, marks, asks, conceptNames, conceptIds };
}

export interface PersonalModelResult { accounts: number; transitions: number; hypotheses: { upserted: number; rejected: number }; places: number; rooms: number }

/** ADR-0040: how much of the correction log is committed. It is append-only, so this only grows, and
 * a count sees committed rows only (a correction's own time is taken before it commits). */
export const CORRECTIONS_COMMITTED = '(SELECT count(*)::int FROM semantic_correction)';

/** Recompute accounts and hypotheses for one universe. Caller holds the universe lock. */
export async function refreshPersonalModel(client: pg.PoolClient, universeId: string): Promise<PersonalModelResult> {
  const universe = (await client.query<{ privacy_epoch: number; now: Date; paused: boolean; corrections: number }>(
    `SELECT privacy_epoch, clock_timestamp() AS now, recording_paused_at IS NOT NULL AS paused, ${CORRECTIONS_COMMITTED} AS corrections FROM universe WHERE id=$1`, [universeId])).rows[0];
  if (!universe) throw new Error('Universe not found');
  // While recording is paused nothing personal is recomputed or dated inside the pause. A correction
  // made meanwhile is already stored (its route suppression applies at once) and counts as
  // counterevidence at the first refresh after recording resumes.
  if (universe.paused) return { accounts: 0, transitions: 0, hypotheses: { upserted: 0, rejected: 0 }, places: 0, rooms: 0 };
  // ADR-0040: what this refresh has seen of the correction log, read before anything else it loads,
  // so a correction committed from here on is still ahead of it and the worker catches it up.
  await client.query(
    `INSERT INTO correction_catch_up(universe_id,corrections_seen,refreshed_at) VALUES($1,$2,clock_timestamp())
     ON CONFLICT (universe_id) DO UPDATE SET corrections_seen=EXCLUDED.corrections_seen, refreshed_at=EXCLUDED.refreshed_at`,
    [universeId, universe.corrections],
  );
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

  // #134: places follow the accounts just written (ADR-0036), and #163: rooms follow the places and
  // the reader's Asks (ADR-0045); nothing runs while paused (above).
  const places = await runCartographer(client, universeId, [...accounts.values()]);
  const rooms = await runKeeper(client, universeId, evidence.asks);
  // #164: a Scroll bound to this reader's need that a correction left unsupported is withdrawn (ADR-0046 §5).
  await withdrawCorrectedBindings(client, universeId);

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
  const statusBefore = new Map((await client.query<{ kind: string; concept_id: string; status: string }>(
    'SELECT kind, concept_id, status FROM personal_hypothesis WHERE universe_id=$1', [universeId])).rows.map(h => [`${h.kind}:${h.concept_id}`, h.status]));
  const livePlaces = new Set((await client.query<{ anchor_concept_id: string }>(
    `SELECT anchor_concept_id FROM atlas_place WHERE universe_id=$1 AND state='live' AND kind IN ('planet','region')`, [universeId])).rows.map(r => r.anchor_concept_id));
  let upserted = 0, rejected = 0;
  for (const p of proposals) {
    const verdict = validateHypothesis(p, { proposer: 'rule', knownEvidence: known, knownConcepts: new Set(evidence.conceptIds.keys()) });
    if (!verdict.ok) { rejected += 1; continue; }
    const conceptId = evidence.conceptIds.get(p.concept)!;
    const written = await upsertHypothesis(client, universeId, universe.privacy_epoch, conceptId, p);
    upserted += 1;
    // ADR-0042 §5.2: what the reader seems to be doing at one of their places changed, so a look may be worth it.
    if (written && written.status !== statusBefore.get(`${p.kind}:${conceptId}`) && livePlaces.has(conceptId)) {
      await postInquiryMail(client, universeId, { kind: 'hypothesis_changed', hypothesisId: written.id, revision: written.revision });
    }
  }
  return { accounts: accounts.size, transitions, hypotheses: { upserted, rejected }, places, rooms };
}

/** Writes the hypothesis if it is new or what it says changed; returns the row then, and nothing otherwise. */
async function upsertHypothesis(client: pg.PoolClient, universeId: string, epoch: number, conceptId: string, p: HypothesisProposal): Promise<{ id: string; revision: number; status: string } | undefined> {
  const payload = [p.statement, p.confidenceLabel, p.status, p.permittedUses, JSON.stringify(p.evidence), JSON.stringify(p.alternatives), JSON.stringify(p.counterevidence), JSON.stringify(p.decay)];
  // A revision is counted only when what the hypothesis says or may do actually changed.
  return (await client.query<{ id: string; revision: number; status: string }>(
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
            EXCLUDED.evidence, EXCLUDED.alternatives, EXCLUDED.counterevidence)
     RETURNING id, revision, status`,
    [randomUUID(), universeId, epoch, p.kind, conceptId, p.ruleVersion, ...payload],
  )).rows[0];
}

/** Clear/Reset: the personal model goes with the history it was computed from. */
export async function erasePersonalModel(client: pg.PoolClient, universeId: string): Promise<void> {
  // A v3 candidate may name the universe's own bridge, which the semantic erase removes next; the
  // decision records go first (their decisions follow later in the same Clear). Rooms name places
  // and Asks, so they go before both.
  await eraseRooms(client, universeId);
  await eraseAtlas(client, universeId);
  await client.query('DELETE FROM decision_candidate WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM decision_context WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM encounter_feedback WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM personal_hypothesis WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM attention_transition WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM attention_account WHERE universe_id=$1', [universeId]);
  // Bookkeeping, never history: erased with the model, and not exported.
  await client.query('DELETE FROM correction_catch_up WHERE universe_id=$1', [universeId]);
}

export async function exportPersonalModel(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    attentionAccounts: await q(`SELECT c.code AS concept, a.policy_version, a.mass, a.mass_at, a.episodes, a.voluntary, a.returns, a.days_active, a.span_days,
      a.source_families, a.exposure_share, a.negatives, a.state, a.evidence FROM attention_account a JOIN concept c ON c.id = a.concept_id WHERE a.universe_id=$1 ORDER BY c.code`),
    hypotheses: await q(`SELECT h.id, h.kind, c.code AS concept, h.proposer_kind, h.rule_version, h.statement, h.confidence_label, h.status, h.permitted_uses,
      h.evidence, h.alternatives, h.counterevidence, h.decay, h.revision, h.created_at, h.revised_at FROM personal_hypothesis h JOIN concept c ON c.id = h.concept_id WHERE h.universe_id=$1 ORDER BY h.created_at`),
    attentionTransitions: await q(`SELECT c.code AS concept, t.from_state, t.to_state, t.policy_version, t.at FROM attention_transition t
      JOIN concept c ON c.id = t.concept_id WHERE t.universe_id=$1 ORDER BY t.at, t.id`),
    ...await exportAtlas(client, universeId),
    ...await exportRooms(client, universeId),
    encounterFeedback: await q(`SELECT f.id, f.privacy_epoch, f.decision_id, f.asset_id, f.kind, f.family, c.code AS concept, f.bridge_id, f.suppress_until, f.created_at
      FROM encounter_feedback f LEFT JOIN concept c ON c.id = f.concept_id WHERE f.universe_id=$1 ORDER BY f.created_at, f.id`),
  };
}
