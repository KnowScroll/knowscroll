import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/production-scope.js';
import type { NewRitual, RitualRoom, RitualRow, RitualStore } from '../application/ritual-ports.js';
import { RITUAL_VERSION, type RitualKind, type RitualState } from '../domain/rituals.js';
import { topicKindOf } from './columns.js';

/** The date column as `YYYY-MM-DD`: the driver would otherwise turn it into a local-time `Date`. */
const dayText = sql<string>`to_char(ritual.day, 'YYYY-MM-DD')`;

const kindOf = (value: string): RitualKind => {
  if (value === 'question' || value === 'flaw') return value;
  throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: ritual kind');
};
const stateOf = (value: string): RitualState => {
  if (value === 'draft' || value === 'approved' || value === 'rejected') return value;
  throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: ritual state');
};

const roomOf = (row: { room_id: string; slug: string; topic_kind: string; topic_id: string }): RitualRoom => ({
  roomId: row.room_id,
  slug: row.slug,
  topic: { kind: topicKindOf(row.topic_kind), id: row.topic_id },
});

const insertValues = (item: NewRitual) => ({
  ritual_id: item.ritualId,
  room_id: item.roomId,
  day: item.day,
  kind: item.kind,
  payload: JSON.stringify(item.payload),
  payload_version: RITUAL_VERSION,
  state: 'draft' as const,
  made_by: item.madeBy,
  role_version: item.roleVersion ?? null,
  model: item.model ?? null,
  attempt_id: item.attemptId ?? null,
  created_at: item.at,
});

/**
 * Postgres rows of the room's daily items (migration 0085). Not personal: nothing here reads a message or a person, and
 * who decided is the operator's login as `cli:<name>`. A room's item is unique by (room, day, kind), so a retried batch
 * inserts nothing the second time.
 */
export function ritualStore(db: Kysely<Database>): RitualStore {
  const rows = () =>
    db
      .selectFrom('rooms.rituals as ritual')
      .innerJoin('rooms.rooms as room', 'room.room_id', 'ritual.room_id')
      .select([
        'ritual.ritual_id',
        'ritual.kind',
        'ritual.state',
        'ritual.payload',
        'ritual.payload_version',
        'ritual.made_by',
        'ritual.created_at',
        'ritual.decided_by',
        'room.room_id',
        'room.slug',
        'room.topic_kind',
        'room.topic_id',
        dayText.as('day'),
      ]);
  type Joined = Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number];
  const rowOf = (row: Joined): RitualRow => ({
    ritualId: row.ritual_id,
    room: roomOf(row),
    day: row.day,
    kind: kindOf(row.kind),
    state: stateOf(row.state),
    payload: row.payload,
    payloadVersion: row.payload_version,
    madeBy: row.made_by === 'model' ? 'model' : 'template',
    createdAt: row.created_at,
    decidedBy: row.decided_by,
  });

  return {
    async roomsWithMembers() {
      const found = await db
        .selectFrom('rooms.rooms as room')
        .select(['room.room_id', 'room.slug', 'room.topic_kind', 'room.topic_id'])
        .where('room.status', '=', 'open')
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('rooms.members as member')
              .select('member.account_id')
              .whereRef('member.room_id', '=', 'room.room_id')
              .where('member.ended_at', 'is', null),
          ),
        )
        .orderBy('room.slug')
        .execute();
      return found.map(roomOf);
    },

    async roomBySlug(slug) {
      const row = await db
        .selectFrom('rooms.rooms')
        .select(['room_id', 'slug', 'topic_kind', 'topic_id'])
        .where('slug', '=', slug)
        .where('status', '=', 'open')
        .executeTakeFirst();
      return row === undefined ? undefined : roomOf(row);
    },

    async kindsOn(roomId, day) {
      const found = await db
        .selectFrom('rooms.rituals')
        .select('kind')
        .where('room_id', '=', roomId)
        .where(sql<boolean>`day = ${day}::date`)
        .execute();
      return new Set(found.map((row) => kindOf(row.kind)));
    },

    async recentSources(roomId, day, days) {
      const found = await sql<{ asset: string }>`
        select distinct payload -> 'source' ->> 'assetId' as asset from rooms.rituals
        where room_id = ${roomId}::uuid and state <> 'rejected'
          and day < ${day}::date and day >= ${day}::date - ${days}::integer`.execute(db);
      return new Set(found.rows.flatMap((row) => (row.asset === null ? [] : [row.asset])));
    },

    async insertDraft(item) {
      const inserted = await db
        .insertInto('rooms.rituals')
        .values(insertValues(item))
        .onConflict((conflict) => conflict.columns(['room_id', 'day', 'kind']).doNothing())
        .executeTakeFirst();
      return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async insertDraftIn(scope, item) {
      const inserted = await productionTransactionOf(scope)
        .insertInto('rooms.rituals')
        .values(insertValues(item))
        .onConflict((conflict) => conflict.columns(['room_id', 'day', 'kind']).doNothing())
        .executeTakeFirst();
      return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async list(filter, limit) {
      let query = rows();
      if (filter.state !== undefined) query = query.where('ritual.state', '=', filter.state);
      const found = await query.orderBy('ritual.created_at', 'desc').limit(limit).execute();
      return found.map(rowOf);
    },

    async one(ritualId) {
      const found = await rows().where('ritual.ritual_id', '=', ritualId).executeTakeFirst();
      return found === undefined ? undefined : rowOf(found);
    },

    async decide({ ritualId, decision, by, at }) {
      const decided = await db
        .updateTable('rooms.rituals')
        .set({ state: decision, decided_at: at, decided_by: by })
        .where('ritual_id', '=', ritualId)
        .where('state', '=', 'draft')
        .executeTakeFirst();
      if ((decided.numUpdatedRows ?? 0n) > 0n) return 'decided';
      const exists = await db
        .selectFrom('rooms.rituals')
        .select('ritual_id')
        .where('ritual_id', '=', ritualId)
        .executeTakeFirst();
      return exists === undefined ? 'unknown' : 'not_draft';
    },
  };
}
