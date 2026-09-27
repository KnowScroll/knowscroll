/**
 * #134/#165 — Relics (ADR-0039, ADR-0044): durable, private things the reader deliberately keeps — a
 * connection, one of their places, a passage of a Scroll they read, an answer to their own Ask. The
 * row is immutable and records its provenance here, at keep time; its state is derived when read
 * (core `relicState`: corrected beats doubted, which beats current), so a later source correction, a
 * newer revision or the reader's own doubt is shown on the kept Relic, never hidden. Release
 * removes the row. The new kinds carry their kept form and state only: no source, and none of the
 * provenance recorded for them.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  objectionInput, PASSAGE_LIST_LIMIT, RELIC_LIST_LIMIT, relicKeepInput, relicReleaseInput,
  type ObjectionInput, type ObjectionResponse, type PassagesResponse, type RelicKeepInput, type RelicKeepResponse, type RelicReleaseResponse, type RelicsResponse, type RelicWire,
} from '../../contracts/src/relics.ts';
import { parseRelicCursor, relicCursor, relicState, type RelicFacts } from '../../core/src/relics.ts';
import { DELTA_PLACES, deltaLines, type DeltaNaming } from './atlas.ts';
import { markedWrong, ReturnError } from './away.ts';
import type { AuthScope } from './identity.ts';
import { bridgeConnection } from './reasoning-inquiries.ts';
import { lockSubstrateShared } from './semantic/read-set.ts';

type RelicRow = {
  id: string; kind: RelicWire['kind']; kept_at: Date; kept_cursor: string; cited_claim_keys: string[];
  bridge_id: string | null; inquiry_id: string | null; validator_version: string | null;
  place_id: string | null; place_kind: 'planet' | 'region' | 'sighting' | null; formation_delta_id: string | null;
  asset_id: string | null; asset_revision: number | null; scroll_title: string | null; claim_id: string | null; ask_id: string | null;
};

/** `kept_cursor` is the keep time at the database's microseconds: a page never splits a millisecond. */
const COLUMNS = `id, kind, kept_at, to_char(kept_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS kept_cursor, cited_claim_keys,
  bridge_id, inquiry_id, validator_version, place_id, place_kind, formation_delta_id, asset_id, asset_revision, scroll_title, claim_id, ask_id`;

const paused = async (client: pg.PoolClient, universeId: string) =>
  (await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [universeId])).rows[0]!.paused;

// Reading --------------------------------------------------------------------------------------

/** A passage's or an answer's facts: the Scroll now, the claims it was kept on that lost their
 * support, and the reader's own objection to it. */
async function scrollFacts(client: pg.PoolClient, row: RelicRow): Promise<Extract<RelicFacts, { kind: 'passage' | 'answer' }>> {
  const f = (await client.query<{ current_revision: number; unsupported: number; objected: boolean }>(
    `SELECT a.revision AS current_revision,
       (SELECT count(*)::int FROM claim c WHERE c.key IN (SELECT jsonb_array_elements_text(r.cited_claim_keys)) AND NOT claim_is_supported(c.id)) AS unsupported,
       EXISTS (SELECT 1 FROM reader_objection o WHERE o.universe_id = r.universe_id AND o.privacy_epoch = r.privacy_epoch AND o.kind = r.kind
         AND (o.ask_id = r.ask_id OR (o.asset_id = r.asset_id AND o.claim_id = r.claim_id))) AS objected
     FROM relic r JOIN asset a ON a.id = r.asset_id WHERE r.id = $1`, [row.id])).rows[0]!;
  return { kind: row.kind as 'passage' | 'answer', keptRevision: row.asset_revision!, currentRevision: f.current_revision, unsupportedClaims: f.unsupported, seemsWrong: f.objected };
}

async function relicView(client: pg.PoolClient, scope: AuthScope, row: RelicRow): Promise<RelicWire> {
  const kept = { relicId: row.id, keptAt: row.kept_at.toISOString() };
  switch (row.kind) {
    case 'connection': {
      const connection = await bridgeConnection(client, row.bridge_id!);
      if (!connection) throw new Error('A Relic outlived its connection');
      return {
        ...kept, kind: 'connection', state: relicState({ kind: 'connection', bridgeStatus: connection.bridgeStatus, seemsWrong: await markedWrong(client, scope, row.bridge_id!) }),
        connection,
        provenance: { inquiryId: row.inquiry_id, validatorVersion: row.validator_version!, citedClaimKeys: row.cited_claim_keys },
      };
    }
    case 'place': {
      // The place as kept and the delta that formed it; corrected by a source correction since.
      const p = (await client.query<DeltaNaming & { state: string; name: string; formed_at: Date; corrected: boolean }>(
        `SELECT d.kind, d.causal_class, d.evidence, c.code AS anchor, pc.code AS parent_anchor, p.state, c.name, d.created_at AS formed_at,
           EXISTS (SELECT 1 FROM atlas_delta x WHERE x.place_id = r.place_id AND x.causal_class = 'source_correction' AND x.created_at > r.kept_at) AS corrected
         FROM relic r JOIN atlas_delta d ON d.id = r.formation_delta_id ${DELTA_PLACES} WHERE r.id = $1`, [row.id])).rows[0]!;
      return {
        ...kept, kind: 'place', state: relicState({ kind: 'place', correctedSinceKept: p.corrected, setAside: p.state === 'rejected' }),
        place: { placeId: row.place_id!, kind: row.place_kind!, anchor: { code: p.anchor, name: p.name }, formedAt: p.formed_at.toISOString(), formation: (await deltaLines(client, [p]))(p) },
      };
    }
    case 'passage': {
      const facts = await scrollFacts(client, row);
      const claim = (await client.query<{ key: string; statement: string }>('SELECT key, statement FROM claim WHERE id=$1', [row.claim_id])).rows[0]!;
      return {
        ...kept, kind: 'passage', state: relicState(facts),
        passage: { assetId: row.asset_id!, revision: row.asset_revision!, title: row.scroll_title!, claim: { claimKey: claim.key, statement: claim.statement, withdrawn: facts.unsupportedClaims > 0 } },
      };
    }
    case 'answer': {
      const facts = await scrollFacts(client, row);
      const a = (await client.query<{ question: string; answer: string; basis: { quote: string }[]; limits: string }>(
        `SELECT l.payload->>'question' AS question, a.answer, a.basis, a.limits
         FROM ask_answer a JOIN explicit_ask q ON q.id = a.ask_id JOIN ledger l ON l.id = q.event_id WHERE a.ask_id = $1`, [row.ask_id])).rows[0]!;
      return {
        ...kept, kind: 'answer', state: relicState(facts),
        answer: { askId: row.ask_id!, assetId: row.asset_id!, revision: row.asset_revision!, title: row.scroll_title!, question: a.question, answer: a.answer, basis: a.basis, limits: a.limits },
      };
    }
  }
}

// Keeping --------------------------------------------------------------------------------------

/** The `relic` columns that name what a keep names: one Relic per thing per epoch (params from $3). */
function thingOf(input: RelicKeepInput): { where: string; params: unknown[] } {
  switch (input.kind) {
    case 'connection': return { where: `kind='connection' AND bridge_id=$3`, params: [input.bridgeId] };
    case 'place': return { where: `kind='place' AND place_id=$3`, params: [input.placeId] };
    case 'passage': return { where: `kind='passage' AND asset_id=$3 AND asset_revision=$4 AND claim_id=(SELECT id FROM claim WHERE key=$5)`, params: [input.assetId, input.revision, input.claimKey] };
    case 'answer': return { where: `kind='answer' AND ask_id=$3`, params: [input.askId] };
  }
}

/** What the server records at keep time (ADR-0044 §2), or why this cannot be kept. */
type Provenance = { columns: Record<string, string | number | null>; cited: string[] };

/** The reader's own reading of a Scroll: the exposure and the selection it recorded (revision, title). */
const SELECTION = `JOIN decision d ON d.id = e.decision_id AND d.universe_id = e.universe_id
  CROSS JOIN LATERAL jsonb_array_elements(d.candidates) sel`;
const SELECTED = `lower(sel->>'assetId') = e.asset_id::text`;

async function currentRevision(client: pg.PoolClient, assetId: string): Promise<number> {
  return (await client.query<{ revision: number }>('SELECT revision FROM asset WHERE id=$1', [assetId])).rows[0]!.revision;
}

async function objected(client: pg.PoolClient, scope: AuthScope, where: string, params: unknown[]): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM reader_objection WHERE universe_id=$1 AND privacy_epoch=$2 AND ${where}`, [scope.universeId, scope.privacyEpoch, ...params])).rowCount! > 0;
}

async function provenanceOf(client: pg.PoolClient, scope: AuthScope, input: RelicKeepInput): Promise<Provenance> {
  switch (input.kind) {
    case 'connection': {
      const bridge = (await client.query<{ validator_version: string; proposal_id: string }>(
        `SELECT validator_version, proposal_id FROM bridge WHERE id=$1 AND status='admitted'
           AND (scope_kind='shared' OR (universe_id=$2 AND privacy_epoch=$3))`, [input.bridgeId, scope.universeId, scope.privacyEpoch])).rows[0];
      if (!bridge) throw new ReturnError(422, 'Unknown or withdrawn connection');
      if (await markedWrong(client, scope, input.bridgeId)) throw new ReturnError(422, 'You marked this connection as seeming wrong');
      const cited = (await client.query<{ key: string }>(
        'SELECT DISTINCT cl.key FROM bridge_evidence e JOIN claim cl ON cl.id = e.claim_id WHERE e.bridge_id=$1 ORDER BY cl.key LIMIT 12', [input.bridgeId])).rows.map(r => r.key);
      // The reader's own inquiry that found it, if any.
      const inquiry = (await client.query<{ id: string }>(
        "SELECT id FROM background_inquiry WHERE universe_id=$1 AND privacy_epoch=$2 AND status='admitted' AND proposal_id=$3",
        [scope.universeId, scope.privacyEpoch, bridge.proposal_id])).rows[0];
      return { columns: { bridge_id: input.bridgeId, inquiry_id: inquiry?.id ?? null, validator_version: bridge.validator_version }, cited };
    }
    case 'place': {
      const place = (await client.query<{ kind: 'planet' | 'region' | 'sighting'; formed_by: string }>(
        `SELECT p.kind, d.id AS formed_by FROM atlas_place p JOIN atlas_delta d ON d.place_id = p.id AND d.before IS NULL
         WHERE p.id=$1 AND p.universe_id=$2 AND p.state='live'`, [input.placeId, scope.universeId])).rows[0];
      if (!place) throw new ReturnError(422, 'Unknown place, or one that is no longer on your atlas');
      return { columns: { place_id: input.placeId, place_kind: place.kind, formation_delta_id: place.formed_by }, cited: [] };
    }
    case 'passage': {
      const read = (await client.query<{ exposure_id: string; revision: number; title: string }>(
        `SELECT e.id AS exposure_id, (sel->>'revision')::int AS revision, sel->>'title' AS title
         FROM exposure e JOIN ledger l ON l.id = e.event_id AND l.universe_id = e.universe_id ${SELECTION}
         WHERE e.universe_id=$1 AND l.privacy_epoch=$2 AND e.asset_id=$3 AND ${SELECTED} ORDER BY l.seq DESC LIMIT 1`,
        [scope.universeId, scope.privacyEpoch, input.assetId])).rows[0];
      if (!read) throw new ReturnError(422, 'You have not read this Scroll');
      if (read.revision !== input.revision || await currentRevision(client, input.assetId) !== input.revision) {
        throw new ReturnError(409, 'This Scroll has changed since you read it');
      }
      const claim = (await client.query<{ id: string; supported: boolean }>(
        'SELECT c.id, claim_is_supported(c.id) AS supported FROM asset_claim ac JOIN claim c ON c.id = ac.claim_id WHERE ac.asset_id=$1 AND c.key=$2',
        [input.assetId, input.claimKey])).rows[0];
      if (!claim) throw new ReturnError(422, 'This Scroll does not say that');
      if (!claim.supported) throw new ReturnError(422, 'What this passage rests on was withdrawn');
      if (await objected(client, scope, `kind='passage' AND asset_id=$3 AND claim_id=$4`, [input.assetId, claim.id])) {
        throw new ReturnError(422, 'You marked this passage as seeming wrong');
      }
      return { columns: { asset_id: input.assetId, asset_revision: input.revision, scroll_title: read.title, exposure_id: read.exposure_id, claim_id: claim.id }, cited: [input.claimKey] };
    }
    case 'answer': {
      const answered = (await client.query<{ asset_id: string; revision: number; title: string }>(
        `SELECT e.asset_id, (sel->>'revision')::int AS revision, sel->>'title' AS title
         FROM ask_answer a JOIN explicit_ask q ON q.id = a.ask_id JOIN exposure e ON e.id = q.exposure_id AND e.universe_id = q.universe_id ${SELECTION}
         WHERE a.ask_id=$1 AND a.universe_id=$2 AND a.privacy_epoch=$3 AND a.status='answered' AND ${SELECTED}`,
        [input.askId, scope.universeId, scope.privacyEpoch])).rows[0];
      if (!answered) throw new ReturnError(422, 'Unknown or unanswered Ask');
      if (await currentRevision(client, answered.asset_id) !== answered.revision) throw new ReturnError(409, 'This Scroll has changed since it was answered');
      if (await objected(client, scope, `kind='answer' AND ask_id=$3`, [input.askId])) throw new ReturnError(422, 'You marked this answer as seeming wrong');
      // What the answer rests on: every claim its Scroll presents, each still supported.
      const claims = (await client.query<{ key: string; supported: boolean }>(
        'SELECT c.key, claim_is_supported(c.id) AS supported FROM asset_claim ac JOIN claim c ON c.id = ac.claim_id WHERE ac.asset_id=$1 ORDER BY c.key',
        [answered.asset_id])).rows;
      if (claims.some(c => !c.supported)) throw new ReturnError(422, 'What this answer rests on was withdrawn');
      const cited = claims.map(c => c.key);
      return { columns: { ask_id: input.askId, asset_id: answered.asset_id, asset_revision: answered.revision, scroll_title: answered.title }, cited };
    }
  }
}

/** `POST /v1/relics`: 201 with the new Relic, or 200 with the one already kept (same request, or same thing). */
export async function keepRelic(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<{ created: boolean; body: RelicKeepResponse }> {
  const parsed = relicKeepInput.safeParse(raw);
  if (!parsed.success) throw new ReturnError(400, 'Invalid Relic');
  const input = parsed.data;
  const thing = thingOf(input);
  const replay = (await client.query<RelicRow & { same: boolean }>(`SELECT (${thing.where}) AS same, ${COLUMNS} FROM relic WHERE universe_id=$1 AND client_request_id=$2`,
    [scope.universeId, input.clientRequestId, ...thing.params])).rows[0];
  if (replay) {
    if (!replay.same) throw new ReturnError(409, 'Relic key reused for another thing');
    return { created: false, body: { privacyEpoch: scope.privacyEpoch, relic: await relicView(client, scope, replay) } };
  }
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new ReturnError(409, 'Privacy epoch is stale');
  const kept = (await client.query<RelicRow>(`SELECT ${COLUMNS} FROM relic WHERE universe_id=$1 AND privacy_epoch=$2 AND ${thing.where}`,
    [scope.universeId, scope.privacyEpoch, ...thing.params])).rows[0];
  if (kept) return { created: false, body: { privacyEpoch: scope.privacyEpoch, relic: await relicView(client, scope, kept) } };
  if (await paused(client, scope.universeId)) throw new ReturnError(409, 'Recording is paused');
  // A source correction takes this lock exclusively: what is read next cannot be withdrawn before
  // the insert, so a racing correction gives a clean refusal, never a guard error (review M2).
  await lockSubstrateShared(client);
  const { columns, cited } = await provenanceOf(client, scope, input);
  const names = Object.keys(columns);
  const row = (await client.query<RelicRow>(
    `INSERT INTO relic(id, universe_id, privacy_epoch, client_request_id, kind, cited_claim_keys, ${names.join(', ')})
     VALUES ($1, $2, $3, $4, $5, $6, ${names.map((_, i) => `$${i + 7}`).join(', ')}) RETURNING ${COLUMNS}`,
    [randomUUID(), scope.universeId, scope.privacyEpoch, input.clientRequestId, input.kind, JSON.stringify(cited), ...Object.values(columns)])).rows[0]!;
  return { created: true, body: { privacyEpoch: scope.privacyEpoch, relic: await relicView(client, scope, row) } };
}

/** `GET /v1/relics`: this epoch's Relics, newest first, a page at a time (ADR-0044 M8). */
export async function listRelics(client: pg.PoolClient, scope: AuthScope, page?: string): Promise<RelicsResponse> {
  const cursor = page === undefined ? null : parseRelicCursor(page);
  if (cursor === null && page !== undefined) throw new ReturnError(400, 'Invalid page');
  const rows = (await client.query<RelicRow>(
    `SELECT ${COLUMNS} FROM relic WHERE universe_id=$1 AND privacy_epoch=$2 AND ($3::timestamptz IS NULL OR (kept_at, id) < ($3::timestamptz, $4::uuid))
     ORDER BY kept_at DESC, id DESC LIMIT $5`,
    [scope.universeId, scope.privacyEpoch, cursor?.keptAt ?? null, cursor?.relicId ?? null, RELIC_LIST_LIMIT + 1])).rows;
  const shown = rows.slice(0, RELIC_LIST_LIMIT);
  const relics: RelicWire[] = [];
  for (const row of shown) relics.push(await relicView(client, scope, row));
  const last = shown.at(-1);
  return {
    privacyEpoch: scope.privacyEpoch, relics,
    nextPage: rows.length > RELIC_LIST_LIMIT && last ? relicCursor(last.kept_cursor, last.id) : null,
    recordingPaused: await paused(client, scope.universeId),
  };
}

/** `POST /v1/relics/:id/release`: let it go. Allowed while paused (it removes, it records nothing);
 * releasing one that is already gone is the same outcome and answers the same. */
export async function releaseRelic(client: pg.PoolClient, scope: AuthScope, relicId: string, raw: unknown): Promise<RelicReleaseResponse> {
  const parsed = relicReleaseInput.safeParse(raw);
  if (!parsed.success) throw new ReturnError(400, 'Invalid release');
  if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch) throw new ReturnError(409, 'Privacy epoch is stale');
  await client.query('DELETE FROM relic WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$3', [relicId, scope.universeId, scope.privacyEpoch]);
  return { privacyEpoch: scope.privacyEpoch, relicId, released: true };
}

// The reader's "seems wrong" on a passage or an answer (ADR-0044 §4) ----------------------------

/** The `reader_objection` columns that name what an objection names (params from $3). */
function objectionOf(input: ObjectionInput): { where: string; params: unknown[] } {
  return input.kind === 'passage'
    ? { where: `kind='passage' AND asset_id=$3 AND claim_id=(SELECT id FROM claim WHERE key=$4)`, params: [input.assetId, input.claimKey] }
    : { where: `kind='answer' AND ask_id=$3`, params: [input.askId] };
}

/** `POST /v1/objections`: 201 with the new objection, or 200 with the one already made. */
export async function recordObjection(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<{ created: boolean; body: ObjectionResponse }> {
  const parsed = objectionInput.safeParse(raw);
  if (!parsed.success) throw new ReturnError(400, 'Invalid objection');
  const input = parsed.data;
  const target = objectionOf(input);
  const replay = (await client.query<{ id: string; same: boolean }>(`SELECT id, (${target.where}) AS same FROM reader_objection WHERE universe_id=$1 AND client_request_id=$2`,
    [scope.universeId, input.clientRequestId, ...target.params])).rows[0];
  if (replay) {
    if (!replay.same) throw new ReturnError(409, 'Objection key reused for another thing');
    return { created: false, body: { privacyEpoch: scope.privacyEpoch, objectionId: replay.id } };
  }
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new ReturnError(409, 'Privacy epoch is stale');
  const made = (await client.query<{ id: string }>(`SELECT id FROM reader_objection WHERE universe_id=$1 AND privacy_epoch=$2 AND ${target.where}`,
    [scope.universeId, scope.privacyEpoch, ...target.params])).rows[0];
  if (made) return { created: false, body: { privacyEpoch: scope.privacyEpoch, objectionId: made.id } };
  if (await paused(client, scope.universeId)) throw new ReturnError(409, 'Recording is paused');
  const id = randomUUID();
  if (input.kind === 'passage') {
    const claim = (await client.query<{ id: string }>(
      `SELECT c.id FROM exposure e JOIN ledger l ON l.id = e.event_id AND l.universe_id = e.universe_id
       JOIN asset_claim ac ON ac.asset_id = e.asset_id JOIN claim c ON c.id = ac.claim_id
       WHERE e.universe_id=$1 AND l.privacy_epoch=$2 AND e.asset_id=$3 AND c.key=$4 LIMIT 1`,
      [scope.universeId, scope.privacyEpoch, input.assetId, input.claimKey])).rows[0];
    if (!claim) throw new ReturnError(422, 'Not a passage of a Scroll you read');
    await client.query(`INSERT INTO reader_objection(id, universe_id, privacy_epoch, client_request_id, kind, asset_id, claim_id) VALUES ($1,$2,$3,$4,'passage',$5,$6)`,
      [id, scope.universeId, scope.privacyEpoch, input.clientRequestId, input.assetId, claim.id]);
  } else {
    const answered = (await client.query('SELECT 1 FROM ask_answer WHERE ask_id=$1 AND universe_id=$2 AND privacy_epoch=$3 AND status=$4',
      [input.askId, scope.universeId, scope.privacyEpoch, 'answered'])).rowCount;
    if (!answered) throw new ReturnError(422, 'Unknown or unanswered Ask');
    await client.query(`INSERT INTO reader_objection(id, universe_id, privacy_epoch, client_request_id, kind, ask_id) VALUES ($1,$2,$3,$4,'answer',$5)`,
      [id, scope.universeId, scope.privacyEpoch, input.clientRequestId, input.askId]);
  }
  return { created: true, body: { privacyEpoch: scope.privacyEpoch, objectionId: id } };
}

/** `GET /v1/scrolls/:assetId/passages`: the Scroll's claims, each with this reader's own state. */
export async function readPassages(client: pg.PoolClient, scope: AuthScope, assetId: string): Promise<PassagesResponse> {
  const scroll = (await client.query<{ revision: number }>(`SELECT revision FROM asset WHERE id=$1 AND kind='Scroll'`, [assetId])).rows[0];
  if (!scroll) throw new ReturnError(404, 'No such Scroll');
  const passages = (await client.query<{ key: string; statement: string; withdrawn: boolean; kept: boolean; seems_wrong: boolean }>(
    `SELECT c.key, c.statement, NOT claim_is_supported(c.id) AS withdrawn,
       EXISTS (SELECT 1 FROM relic r WHERE r.universe_id=$2 AND r.privacy_epoch=$3 AND r.kind='passage' AND r.asset_id=$1 AND r.asset_revision=$4 AND r.claim_id=c.id) AS kept,
       EXISTS (SELECT 1 FROM reader_objection o WHERE o.universe_id=$2 AND o.privacy_epoch=$3 AND o.kind='passage' AND o.asset_id=$1 AND o.claim_id=c.id) AS seems_wrong
     FROM asset_claim ac JOIN claim c ON c.id = ac.claim_id WHERE ac.asset_id=$1 ORDER BY c.key LIMIT $5`,
    [assetId, scope.universeId, scope.privacyEpoch, scroll.revision, PASSAGE_LIST_LIMIT])).rows;
  return {
    privacyEpoch: scope.privacyEpoch, assetId, revision: scroll.revision, recordingPaused: await paused(client, scope.universeId),
    passages: passages.map(p => ({ claimKey: p.key, statement: p.statement, withdrawn: p.withdrawn, kept: p.kept, seemsWrong: p.seems_wrong })),
  };
}

// Privacy -------------------------------------------------------------------------------------

/** Clear/Reset/deletion: before the answers, places, exposures, inquiries and personal bridges a
 * Relic or an objection names. */
export async function eraseRelics(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM relic WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM reader_objection WHERE universe_id=$1', [universeId]);
}

/** Every Relic with the provenance recorded when it was kept, and the reader's objections. */
export async function exportRelics(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    relics: await q(`SELECT id, privacy_epoch, kind, kept_at, cited_claim_keys, bridge_id, inquiry_id, validator_version, place_id, place_kind,
      formation_delta_id, asset_id, asset_revision, scroll_title, exposure_id, claim_id, ask_id FROM relic WHERE universe_id=$1 ORDER BY kept_at, id`),
    objections: await q(`SELECT o.id, o.privacy_epoch, o.kind, o.asset_id, c.key AS claim_key, o.ask_id, o.objected_at
      FROM reader_objection o LEFT JOIN claim c ON c.id = o.claim_id WHERE o.universe_id=$1 ORDER BY o.objected_at, o.id`),
  };
}
