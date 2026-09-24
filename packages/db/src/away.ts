/**
 * #134 — "While you were away" (ADR-0039 §1-2): what changed in this universe and epoch since the
 * reader's marker that they did not cause, and the marker they move once they have seen it.
 *
 * Sources, each limited to the current epoch:
 *   - background inquiry outcomes (ADR-0038): found, nothing found, did not hold up;
 *   - atlas and room deltas caused by a source correction (ADR-0036/0037/0045): every other cause
 *     follows the reader's own reading, so they saw it happen;
 *   - corrections to a bridge they were shown as found or kept as a Relic.
 * Nothing here calls a model or words anything but a delta's own chronicle line.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AWAY_LIST_LIMIT, awayAcknowledgeInput, type AwayAcknowledgeResponse, type AwayItem, type AwayResponse } from '../../contracts/src/away.ts';
import { awayCursor, clampLine, nextMarker, parseAwayCursor, selectAway } from '../../core/src/away.ts';
import { roomChronicleLine, type RoomRole } from '../../core/src/rooms/keeper.ts';
import { DELTA_PLACES, deltaLines, type DeltaNaming } from './atlas.ts';
import type { AuthScope } from './identity.ts';
import { bridgeConnection } from './reasoning-inquiries.ts';
import { lockSubstrateShared } from './semantic/read-set.ts';

export class ReturnError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 422, message: string) { super(message); this.name = 'ReturnError'; }
}

const iso = (d: Date) => d.toISOString();
type Keyed = AwayItem & { key: string };

async function currentMarker(client: pg.PoolClient, scope: AuthScope): Promise<Date | null> {
  return (await client.query<{ through: Date | null }>(
    'SELECT max(through) AS through FROM away_acknowledgement WHERE universe_id=$1 AND privacy_epoch=$2', [scope.universeId, scope.privacyEpoch])).rows[0]?.through ?? null;
}

async function paused(client: pg.PoolClient, universeId: string): Promise<boolean> {
  return (await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [universeId])).rows[0]!.paused;
}

/**
 * `GET /v1/away`, a page at a time (ADR-0044 M7): the newest page, or the one after `page`'s cursor.
 *
 * Commit order (M6): every item's time is taken under a lock this read also holds while it reads.
 * Inquiry outcomes and place changes are written under the universe lock (the caller's), and a
 * correction to a connection under the substrate lock, taken here shared. An item this read cannot
 * see is therefore stamped after it, and a marker moved from what it showed never passes that item.
 */
export async function readAway(client: pg.PoolClient, scope: AuthScope, page?: string): Promise<AwayResponse> {
  const cursor = page === undefined ? null : parseAwayCursor(page);
  if (cursor === null && page !== undefined) throw new ReturnError(400, 'Invalid page');
  await lockSubstrateShared(client);
  const since = await currentMarker(client, scope);
  const after = since ?? new Date(0);
  const take = AWAY_LIST_LIMIT + 1;
  const candidates: Keyed[] = [];
  let total = 0;
  // Each source's own parameters, then the cursor's three and the cap (see `pageOf`).
  const paged = (params: unknown[]) => [...params, cursor?.at ?? null, cursor?.kind ?? null, cursor?.key ?? null, take];

  // Every comparison with the marker is at millisecond precision, the precision of the wire: a
  // marker set to an item's `at` covers that item, though the database keeps its microseconds.
  // Background inquiry outcomes, closed since the marker; only rows that can be shown are counted.
  const inquiryKind = `(CASE status WHEN 'admitted' THEN 'connection_found' WHEN 'rejected' THEN 'connection_did_not_hold_up' ELSE 'nothing_found' END)`;
  const inquiryPage = pageOf('closed_at', inquiryKind, 'id', 4);
  const inquiryWhere = `universe_id=$1 AND privacy_epoch=$2 AND date_trunc('milliseconds', closed_at) > $3 AND (
      (status = 'admitted' AND proposal_id IS NOT NULL)
      OR (status = 'none' AND pairs IS NOT NULL)
      OR (status = 'rejected' AND pairs IS NOT NULL AND jsonb_array_length(reasons) > 0)) AND ${inquiryPage.after}`;
  const inquiryParams = paged([scope.universeId, scope.privacyEpoch, after]);
  total += Number((await client.query(`SELECT count(*) FROM background_inquiry WHERE ${inquiryWhere}`, inquiryParams.slice(0, -1))).rows[0].count);
  const inquiries = (await client.query<{ id: string; status: string; closed_at: Date; pairs: Array<{ a: { code: string; name: string }; b: { code: string; name: string } }> | null; reasons: string[]; proposal_id: string | null }>(
    `SELECT id, status, closed_at, pairs, reasons, proposal_id FROM background_inquiry WHERE ${inquiryWhere} ${inquiryPage.order} LIMIT $7`, inquiryParams)).rows;
  for (const r of inquiries) {
    const at = iso(r.closed_at);
    const pairs = r.pairs ?? [];
    if (r.status === 'admitted' && r.proposal_id) {
      const found = await bridgeConnectionByProposal(client, r.proposal_id);
      if (found) candidates.push({ kind: 'connection_found', at, inquiryId: r.id, found, seemsWrong: await markedWrong(client, scope, found.bridgeId), key: r.id });
    } else if (r.status === 'rejected' && pairs.length > 0 && r.reasons.length > 0) {
      candidates.push({ kind: 'connection_did_not_hold_up', at, inquiryId: r.id, pairs, reasons: r.reasons, key: r.id });
    } else if (r.status === 'none' && pairs.length > 0) {
      candidates.push({ kind: 'nothing_found', at, inquiryId: r.id, pairs, key: r.id });
    }
  }

  // Place changes a source correction caused. Deltas carry no epoch: Clear/Reset erase them all.
  const deltaPage = pageOf('d.created_at', `'place_changed'::text`, 'd.id', 3);
  const deltaWhere = `d.universe_id=$1 AND d.causal_class='source_correction' AND date_trunc('milliseconds', d.created_at) > $2
    AND d.kind IN ('place_formed','sighting_appeared','sighting_promoted','sighting_retired','place_released','foundation_recognised','foundation_withdrawn')
    AND ${deltaPage.after}`;
  const deltaParams = paged([scope.universeId, after]);
  total += Number((await client.query(`SELECT count(*) FROM atlas_delta d WHERE ${deltaWhere}`, deltaParams.slice(0, -1))).rows[0].count);
  const deltas = (await client.query<DeltaNaming & { id: string; place_id: string; kind: AwayChange; created_at: Date }>(
    `SELECT d.id, d.place_id, d.kind, d.causal_class, d.created_at, d.evidence, c.code AS anchor, pc.code AS parent_anchor
     FROM atlas_delta d ${DELTA_PLACES} WHERE ${deltaWhere} ${deltaPage.order} LIMIT $6`, deltaParams)).rows;
  const lineOf = await deltaLines(client, deltas);
  for (const d of deltas) {
    candidates.push({ kind: 'place_changed', at: iso(d.created_at), deltaId: d.id, placeId: d.place_id, change: d.kind, cause: 'source_correction', key: d.id, line: clampLine(lineOf(d)) });
  }

  // Room changes a source correction caused (ADR-0045): a position that lost a claim's support, an
  // inhabitant that left, a room whose place went. Erased with the rooms by Clear/Reset.
  const roomPage = pageOf('d.created_at', `'room_changed'::text`, 'd.id', 3);
  const roomWhere = `d.universe_id=$1 AND d.causal_class='source_correction' AND date_trunc('milliseconds', d.created_at) > $2
    AND d.kind IN ('position_changed','inhabitant_unseated','room_retired') AND ${roomPage.after}`;
  const roomParams = paged([scope.universeId, after]);
  total += Number((await client.query(`SELECT count(*) FROM room_delta d WHERE ${roomWhere}`, roomParams.slice(0, -1))).rows[0].count);
  const roomDeltas = (await client.query<{ id: string; room_id: string; place_id: string; kind: RoomChange; role: RoomRole | null; created_at: Date; place_name: string }>(
    `SELECT d.id, d.room_id, r.place_id, d.kind, d.role, d.created_at, c.name AS place_name
     FROM room_delta d JOIN room r ON r.id = d.room_id JOIN atlas_place p ON p.id = r.place_id JOIN concept c ON c.id = p.anchor_concept_id
     WHERE ${roomWhere} ${roomPage.order} LIMIT $6`, roomParams)).rows;
  for (const d of roomDeltas) {
    candidates.push({
      kind: 'room_changed', at: iso(d.created_at), deltaId: d.id, roomId: d.room_id, placeId: d.place_id, change: d.kind, cause: 'source_correction', key: d.id,
      line: clampLine(roomChronicleLine({ kind: d.kind, causalClass: 'source_correction', role: d.role, placeName: d.place_name })),
    });
  }

  // Corrections to a connection the reader was shown as found, or kept, in this epoch.
  const correctedPage = pageOf('b.status_changed_at', `'connection_corrected'::text`, 'b.id', 4);
  const correctedWhere = `b.status IN ('revoked','superseded') AND date_trunc('milliseconds', b.status_changed_at) > $3 AND (
      EXISTS (SELECT 1 FROM background_inquiry i WHERE i.universe_id=$1 AND i.privacy_epoch=$2 AND i.status='admitted' AND i.proposal_id = b.proposal_id)
      OR EXISTS (SELECT 1 FROM relic r WHERE r.universe_id=$1 AND r.privacy_epoch=$2 AND r.bridge_id = b.id)) AND ${correctedPage.after}`;
  const correctedParams = paged([scope.universeId, scope.privacyEpoch, after]);
  total += Number((await client.query(`SELECT count(*) FROM bridge b WHERE ${correctedWhere}`, correctedParams.slice(0, -1))).rows[0].count);
  const corrected = (await client.query<{ id: string; status: 'revoked' | 'superseded'; status_changed_at: Date; from_code: string; from_name: string; to_code: string; to_name: string }>(
    `SELECT b.id, b.status, b.status_changed_at, f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
     FROM bridge b JOIN concept f ON f.id = b.from_concept_id JOIN concept t ON t.id = b.to_concept_id
     WHERE ${correctedWhere} ${correctedPage.order} LIMIT $7`, correctedParams)).rows;
  for (const b of corrected) {
    candidates.push({ kind: 'connection_corrected', at: iso(b.status_changed_at), bridgeId: b.id, status: b.status,
      fromConcept: { code: b.from_code, name: b.from_name }, toConcept: { code: b.to_code, name: b.to_name }, seemsWrong: await markedWrong(client, scope, b.id), key: b.id });
  }

  const picked = selectAway(candidates, since ? iso(since) : null, AWAY_LIST_LIMIT, total);
  const last = picked.items.at(-1);
  return {
    privacyEpoch: scope.privacyEpoch, since: since ? iso(since) : null,
    items: picked.items.map(({ key: _key, ...item }) => item as AwayItem),
    more: picked.more, nextPage: picked.more > 0 && last ? awayCursor(last) : null,
    recordingPaused: await paused(client, scope.universeId),
  };
}

type AwayChange = Extract<AwayItem, { kind: 'place_changed' }>['change'];
type RoomChange = Extract<AwayItem, { kind: 'room_changed' }>['change'];

/**
 * One source's part of a page, in the list's total order (core `compareAway`): newest millisecond
 * first, then kind and key compared byte-wise. `after` keeps what follows the cursor, whose `at`,
 * kind and key are parameters `first`..`first + 2` (all null for the first page).
 */
function pageOf(time: string, kind: string, key: string, first: number): { after: string; order: string } {
  const [at, cursorKind, cursorKey] = [`$${first}::timestamptz`, `$${first + 1}::text`, `$${first + 2}::text`];
  const ms = `date_trunc('milliseconds', ${time})`;
  return {
    after: `(${at} IS NULL OR ${ms} < ${at} OR (${ms} = ${at}
      AND (${kind} COLLATE "C", ${key}::text COLLATE "C") > (${cursorKind} COLLATE "C", ${cursorKey} COLLATE "C")))`,
    order: `ORDER BY ${ms} DESC, ${kind} COLLATE "C", ${key}::text COLLATE "C"`,
  };
}

/** Whether this reader marked the connection "seems wrong" (ADR-0031), carried so no client offers it again (M5). */
export async function markedWrong(client: pg.PoolClient, scope: AuthScope, bridgeId: string): Promise<boolean> {
  return (await client.query("SELECT 1 FROM connection_feedback WHERE universe_id=$1 AND bridge_id=$2 AND objection='seems_wrong'",
    [scope.universeId, bridgeId])).rowCount! > 0;
}

async function bridgeConnectionByProposal(client: pg.PoolClient, proposalId: string) {
  const bridge = (await client.query<{ id: string }>('SELECT id FROM bridge WHERE proposal_id=$1', [proposalId])).rows[0];
  return bridge ? bridgeConnection(client, bridge.id) : null;
}

/** `POST /v1/away/acknowledge`: move the marker to the newest item the client displayed. */
export async function acknowledgeAway(client: pg.PoolClient, scope: AuthScope, raw: unknown): Promise<AwayAcknowledgeResponse> {
  const parsed = awayAcknowledgeInput.safeParse(raw);
  if (!parsed.success) throw new ReturnError(400, 'Invalid acknowledgement');
  const input = parsed.data;
  const replay = (await client.query<{ through: Date }>(
    'SELECT through FROM away_acknowledgement WHERE universe_id=$1 AND client_request_id=$2', [scope.universeId, input.clientRequestId])).rows[0];
  if (replay) {
    if (replay.through.getTime() !== Date.parse(input.through)) throw new ReturnError(409, 'Acknowledgement key reused with a different time');
    return { privacyEpoch: scope.privacyEpoch, since: iso((await currentMarker(client, scope))!) };
  }
  if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new ReturnError(409, 'Privacy epoch is stale');
  if (await paused(client, scope.universeId)) throw new ReturnError(409, 'Recording is paused');
  const current = await currentMarker(client, scope);
  if (current && nextMarker(iso(current), input.through) === null) return { privacyEpoch: scope.privacyEpoch, since: iso(current) };
  const inFuture = (await client.query<{ future: boolean }>('SELECT $1::timestamptz > clock_timestamp() AS future', [input.through])).rows[0]!.future;
  if (inFuture) throw new ReturnError(422, 'A return cannot be acknowledged in the future');
  await client.query('INSERT INTO away_acknowledgement(id, universe_id, privacy_epoch, client_request_id, through) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), scope.universeId, scope.privacyEpoch, input.clientRequestId, input.through]);
  return { privacyEpoch: scope.privacyEpoch, since: iso((await currentMarker(client, scope))!) };
}

// Privacy -------------------------------------------------------------------------------------

/** Clear/Reset/deletion (after the epoch advanced). */
export async function eraseAway(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM away_acknowledgement WHERE universe_id=$1', [universeId]);
}

export async function exportAway(client: pg.PoolClient, universeId: string) {
  return (await client.query('SELECT id, privacy_epoch, through, acknowledged_at FROM away_acknowledgement WHERE universe_id=$1 ORDER BY acknowledged_at, id', [universeId])).rows;
}
