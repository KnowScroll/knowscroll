/**
 * #163 — the reader's Idea Rooms (ADR-0045). Loads the Keeper's inputs, applies its deltas under the
 * caller's universe lock, reads the rooms for the atlas and the room sheet, and records the reader
 * setting one aside. Every room and inhabitant change is written with its delta in the same
 * transaction (the schema refuses anything else). No model is called, and no source is ever
 * returned: a claim is its statement and truth state.
 *
 * The Keeper runs where the Cartographer runs (`atlas.ts`), after places, over the places as that
 * plan left them; this module never reads the atlas itself.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ROOM_CHRONICLE_LIMIT, roomSetAsideInput, type RoomClaim, type RoomDeltaResponse, type RoomResponse, type RoomSummary } from '../../contracts/src/rooms.ts';
import type { ConceptNode, TypedRelation } from '../../core/src/atlas/cartographer.ts';
import {
  isLiveRoom, planRetirements, planRooms, planSetAside, roomChronicleLine, ROOM_ROLES,
  type AskEvidence, type HeldClaim, type KeeperAsk, type KeeperBridge, type KeeperClaim, type KeeperPlace, type RoomDelta, type RoomRole, type RoomState, type RoomView,
} from '../../core/src/rooms/keeper.ts';
import type { AuthScope } from './identity.ts';

export class RoomError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409, message: string) { super(message); this.name = 'RoomError'; }
}

type Seats = Partial<Record<RoomRole, HeldClaim[]>>;
type RoomRow = { id: string; place_id: string; place_name: string; state: RoomState; created_at: Date; ask_ids: string[]; question: string; seats: Seats };
/** Every room of a universe with its place's name, its question (the reader's own words, from the
 * Ask) and its seated inhabitants. */
const ROOM_ROWS = `SELECT r.id, r.place_id, pc.name AS place_name, r.state, r.created_at, r.ask_ids::text[] AS ask_ids, l.payload->>'question' AS question,
    COALESCE((SELECT jsonb_object_agg(i.role, i.claims) FROM room_inhabitant i WHERE i.room_id = r.id AND i.seated), '{}') AS seats
  FROM room r JOIN explicit_ask a ON a.id = r.question_ask_id JOIN ledger l ON l.id = a.event_id
  JOIN atlas_place p ON p.id = r.place_id JOIN concept pc ON pc.id = p.anchor_concept_id WHERE r.universe_id = $1`;

const roomView = (r: RoomRow): RoomView =>
  ({ roomId: r.id, placeId: r.place_id, state: r.state, openedAtMs: r.created_at.getTime(), askIds: r.ask_ids, seats: r.seats });

async function loadRooms(client: pg.PoolClient, universeId: string): Promise<RoomView[]> {
  return (await client.query<RoomRow>(`${ROOM_ROWS} ORDER BY r.created_at, r.id`, [universeId])).rows.map(roomView);
}

/** Every currently supported claim, the concepts it is about, and whether a current source qualifies or contradicts it. */
async function loadClaims(client: pg.PoolClient): Promise<KeeperClaim[]> {
  return (await client.query<{ id: string; key: string; about: string[]; doubt: KeeperClaim['doubt'] }>(
    `SELECT cl.id, cl.key, COALESCE(array_agg(c.code ORDER BY c.code) FILTER (WHERE cc.role IN ('subject','mechanism')), '{}') AS about,
       (SELECT cs.support_kind FROM claim_support cs JOIN source_snapshot ss ON ss.id = cs.snapshot_id AND ss.status = 'current'
        WHERE cs.claim_id = cl.id AND cs.support_kind <> 'supports' ORDER BY cs.support_kind = 'contradicts' DESC LIMIT 1) AS doubt
     FROM claim cl LEFT JOIN claim_concept cc ON cc.claim_id = cl.id LEFT JOIN concept c ON c.id = cc.concept_id
     WHERE claim_is_supported(cl.id) GROUP BY cl.id`,
  )).rows.map(r => ({ claimId: r.id, key: r.key, about: r.about, doubt: r.doubt }));
}

/** The admitted bridges among the relations: the claims each cites, and those its proposal recorded as counterevidence. */
async function loadBridges(client: pg.PoolClient, relations: readonly TypedRelation[]): Promise<Map<string, KeeperBridge>> {
  const ids = relations.flatMap(r => ('bridgeId' in r.ref ? [r.ref.bridgeId] : []));
  return new Map((await client.query<{ id: string; cites: string[]; counterevidence: string[] }>(
    `SELECT b.id, ARRAY(SELECT DISTINCT e.claim_id FROM bridge_evidence e WHERE e.bridge_id = b.id)::text[] AS cites,
       ARRAY(SELECT cl.id FROM claim cl WHERE cl.key IN (SELECT jsonb_array_elements_text(b.counterevidence->'claimKeys')))::text[] AS counterevidence
     FROM bridge b WHERE b.id = ANY($1::uuid[])`, [ids],
  )).rows.map(r => [r.id, { cites: r.cites, counterevidence: r.counterevidence }]));
}

async function insertDelta(client: pg.PoolClient, universeId: string, roomId: string, role: RoomRole | null,
  d: { kind: string; causalClass: string; policyVersion: string; evidence: unknown }, before: object | null, after: object): Promise<void> {
  await client.query(
    `INSERT INTO room_delta(id,universe_id,room_id,role,kind,causal_class,policy_version,evidence,before,after) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), universeId, roomId, role, d.kind, d.causalClass, d.policyVersion, JSON.stringify(d.evidence), before ? JSON.stringify(before) : null, JSON.stringify(after)],
  );
}

/** Applies deltas in plan order; a room opened earlier in the plan is found by its opening reference. */
async function applyRoomDeltas(client: pg.PoolClient, universeId: string, rooms: readonly RoomView[], deltas: readonly RoomDelta[]): Promise<number> {
  if (deltas.length === 0) return 0;
  const epoch = (await client.query<{ privacy_epoch: number }>('SELECT privacy_epoch FROM universe WHERE id=$1', [universeId])).rows[0]!.privacy_epoch;
  const current = new Map<string, { roomId: string; state: RoomState; askIds: readonly string[]; seats: Seats }>(
    rooms.map(r => [r.roomId, { roomId: r.roomId, state: r.state, askIds: r.askIds, seats: { ...r.seats } as Seats }]));
  for (const d of deltas) {
    if (d.kind === 'room_opened') {
      const id = randomUUID();
      await client.query('INSERT INTO room(id,universe_id,privacy_epoch,place_id,question_ask_id,ask_ids,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, universeId, epoch, d.placeId, d.questionAskId, d.askIds, d.policyVersion]);
      await insertDelta(client, universeId, id, null, d, null, { state: 'opened', askIds: d.askIds });
      current.set(d.room, { roomId: id, state: 'opened', askIds: d.askIds, seats: {} });
      continue;
    }
    const room = current.get(d.room)!;
    if (d.kind === 'question_joined') {
      await client.query('UPDATE room SET ask_ids=$2 WHERE id=$1', [room.roomId, d.askIds]);
      await insertDelta(client, universeId, room.roomId, null, d, { askIds: room.askIds }, { askIds: d.askIds });
      room.askIds = d.askIds;
    } else if (d.kind === 'room_set_aside' || d.kind === 'room_retired') {
      // Its inhabitants are unseated with it.
      const state = d.kind === 'room_set_aside' ? 'set_aside' : 'retired';
      await client.query('UPDATE room SET state=$2 WHERE id=$1', [room.roomId, state]);
      await client.query(`UPDATE room_inhabitant SET seated=false, claims='[]' WHERE room_id=$1 AND seated`, [room.roomId]);
      await insertDelta(client, universeId, room.roomId, null, d, { state: room.state, seats: room.seats }, { state, seats: {} });
      room.state = state; room.seats = {};
    } else {
      const claims = d.kind === 'inhabitant_unseated' ? [] : d.claims;
      const before = room.seats[d.role] ?? [];
      await client.query(
        `INSERT INTO room_inhabitant(id,room_id,universe_id,role,seated,claims) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (room_id, role) DO UPDATE SET seated=EXCLUDED.seated, claims=EXCLUDED.claims`,
        [randomUUID(), room.roomId, universeId, d.role, claims.length > 0, JSON.stringify(claims)]);
      // The ladder moves only with the doubter's seat, recorded by this same delta.
      if (d.state !== room.state) await client.query('UPDATE room SET state=$2 WHERE id=$1', [room.roomId, d.state]);
      await insertDelta(client, universeId, room.roomId, d.role, d, { seated: before.length > 0, claims: before, state: room.state }, { seated: claims.length > 0, claims, state: d.state });
      room.seats[d.role] = claims; room.state = d.state;
    }
  }
  return deltas.length;
}

/** The Keeper (ADR-0045 §5): wherever the Cartographer runs, after places, over the places as it
 * left them and the Asks the personal model loaded. Never while paused (the refresh does not run). */
export async function keepRooms(client: pg.PoolClient, universeId: string, substrate: { concepts: readonly ConceptNode[]; relations: readonly TypedRelation[] },
  places: readonly KeeperPlace[], asks: readonly KeeperAsk[]): Promise<number> {
  const rooms = await loadRooms(client, universeId);
  const deltas = planRooms({
    concepts: substrate.concepts, relations: substrate.relations, bridges: await loadBridges(client, substrate.relations),
    claims: await loadClaims(client), places, asks, rooms,
  });
  return applyRoomDeltas(client, universeId, rooms, deltas);
}

/** The reader set a place aside: its rooms retire in the same transaction (ADR-0045 §6). */
export async function retireRooms(client: pg.PoolClient, universeId: string, places: readonly KeeperPlace[]): Promise<number> {
  const rooms = await loadRooms(client, universeId);
  return applyRoomDeltas(client, universeId, rooms, planRetirements(rooms, places));
}

/** `POST /v1/rooms/:roomId/set-aside`. Setting aside a room already set aside is the same answer. */
export async function setRoomAside(client: pg.PoolClient, scope: AuthScope, roomId: string, raw: unknown): Promise<void> {
  const parsed = roomSetAsideInput.safeParse(raw);
  if (!parsed.success) throw new RoomError(400, 'Invalid set-aside request');
  if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch) throw new RoomError(409, 'Privacy epoch changed');
  if ((await client.query<{ paused: boolean }>('SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1', [scope.universeId])).rows[0]!.paused) {
    throw new RoomError(409, 'Recording is paused');
  }
  const rooms = await loadRooms(client, scope.universeId);
  const room = rooms.find(r => r.roomId === roomId);
  if (!room) throw new RoomError(404, 'Not found');
  if (room.state === 'set_aside') return;
  if (!isLiveRoom(room)) throw new RoomError(409, 'Only a live room can be set aside');
  await applyRoomDeltas(client, scope.universeId, rooms, [planSetAside(room, parsed.data.clientRequestId)]);
}

// Reads ------------------------------------------------------------------------------------------

const iso = (v: Date) => v.toISOString();

/** A held claim as the reader sees it: its sentence and truth state, never its source. */
async function describeClaims(client: pg.PoolClient, held: readonly HeldClaim[]): Promise<(c: HeldClaim) => RoomClaim> {
  const claims = new Map((await client.query<{ id: string; key: string; statement: string; truth_state: RoomClaim['truthState'] }>(
    'SELECT id, key, statement, truth_state FROM claim WHERE id = ANY($1::uuid[])', [held.map(c => c.claimId)],
  )).rows.map(r => [r.id, r]));
  return c => {
    const claim = claims.get(c.claimId)!;
    return { key: claim.key, statement: claim.statement, truthState: claim.truth_state, supportKind: c.supportKind };
  };
}

const inhabitantsOf = (seats: Seats, describe: (c: HeldClaim) => RoomClaim) =>
  ROOM_ROLES.filter(role => (seats[role] ?? []).length > 0).map(role => ({ role, claims: seats[role]!.map(describe) }));

/** Each live place's live rooms, oldest first, for `GET /v1/atlas`. */
export async function readPlaceRooms(client: pg.PoolClient, universeId: string): Promise<Map<string, RoomSummary[]>> {
  const rows = (await client.query<RoomRow>(`${ROOM_ROWS} AND r.state IN ('opened','arguing') ORDER BY r.created_at, r.id`, [universeId])).rows;
  const describe = await describeClaims(client, rows.flatMap(r => Object.values(r.seats).flat()));
  const byPlace = new Map<string, RoomSummary[]>();
  for (const r of rows) {
    byPlace.set(r.place_id, [...(byPlace.get(r.place_id) ?? []), {
      roomId: r.id, question: r.question, state: r.state as RoomSummary['state'], inhabitants: inhabitantsOf(r.seats, describe), openedAt: iso(r.created_at),
    }]);
  }
  return byPlace;
}

type DeltaRow = { id: string; room_id: string; place_id: string; place_name: string; kind: RoomDelta['kind']; causal_class: RoomDelta['causalClass'];
  role: RoomRole | null; policy_version: string; created_at: Date; evidence: { asks?: AskEvidence[]; claims?: HeldClaim[]; previous?: HeldClaim[] } };
const DELTA_ROWS = `SELECT d.id, d.room_id, r.place_id, c.name AS place_name, d.kind, d.causal_class, d.role, d.policy_version, d.created_at, d.evidence
  FROM room_delta d JOIN room r ON r.id = d.room_id JOIN atlas_place p ON p.id = r.place_id JOIN concept c ON c.id = p.anchor_concept_id
  WHERE d.universe_id = $1`;

const heldIn = (d: DeltaRow) => [...(d.evidence.claims ?? []), ...(d.evidence.previous ?? [])];
function change(d: DeltaRow, describe: (c: HeldClaim) => RoomClaim) {
  return {
    deltaId: d.id, kind: d.kind, causalClass: d.causal_class, role: d.role, at: iso(d.created_at),
    line: roomChronicleLine({ kind: d.kind, causalClass: d.causal_class, role: d.role, placeName: d.place_name }),
    evidence: {
      asks: (d.evidence.asks ?? []).map(a => ({ askId: a.askId, day: a.day })),
      claims: (d.evidence.claims ?? []).map(describe), previous: (d.evidence.previous ?? []).map(describe),
    },
  };
}

/** `GET /v1/rooms/:roomId`: one of the reader's rooms, whatever its state, with its chronicle and each line's evidence. */
export async function readRoom(client: pg.PoolClient, universeId: string, roomId: string): Promise<RoomResponse> {
  const room = (await client.query<RoomRow>(`${ROOM_ROWS} AND r.id = $2`, [universeId, roomId])).rows[0];
  if (!room) throw new RoomError(404, 'Not found');
  const deltas = (await client.query<DeltaRow>(`${DELTA_ROWS} AND d.room_id = $2 ORDER BY d.created_at DESC, d.id LIMIT $3`, [universeId, roomId, ROOM_CHRONICLE_LIMIT])).rows;
  const describe = await describeClaims(client, [...Object.values(room.seats).flat(), ...deltas.flatMap(heldIn)]);
  return {
    roomId: room.id, placeId: room.place_id, placeName: room.place_name, question: room.question, state: room.state,
    inhabitants: inhabitantsOf(room.seats, describe), openedAt: iso(room.created_at), chronicle: deltas.map(d => change(d, describe)),
  };
}

/** `GET /v1/rooms/deltas/:deltaId`: one change and its evidence, readable only in its own universe. */
export async function readRoomDelta(client: pg.PoolClient, universeId: string, deltaId: string): Promise<RoomDeltaResponse> {
  const d = (await client.query<DeltaRow>(`${DELTA_ROWS} AND d.id = $2`, [universeId, deltaId])).rows[0];
  if (!d) throw new RoomError(404, 'Not found');
  return { ...change(d, await describeClaims(client, heldIn(d))), roomId: d.room_id, placeId: d.place_id, policyVersion: d.policy_version };
}

// Privacy -------------------------------------------------------------------------------------

/** Clear/Reset/deletion: before the places and Asks the rooms name. */
export async function eraseRooms(client: pg.PoolClient, universeId: string): Promise<void> {
  await client.query('DELETE FROM room_delta WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM room_inhabitant WHERE universe_id=$1', [universeId]);
  await client.query('DELETE FROM room WHERE universe_id=$1', [universeId]);
}

export async function exportRooms(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    rooms: await q(`SELECT id, privacy_epoch, place_id, question_ask_id, ask_ids, state, policy_version, created_at, changed_at
      FROM room WHERE universe_id=$1 ORDER BY created_at, id`),
    roomInhabitants: await q(`SELECT id, room_id, role, seated, claims, created_at, changed_at FROM room_inhabitant WHERE universe_id=$1 ORDER BY created_at, id`),
    roomDeltas: await q(`SELECT id, room_id, role, kind, causal_class, policy_version, evidence, before, after, created_at
      FROM room_delta WHERE universe_id=$1 ORDER BY created_at, id`),
  };
}
