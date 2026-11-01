import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/production-scope.js';
import type { FeedStore, ScoutRef } from '../application/feed-ports.js';
import type { ScoutReadStore } from '../application/ports.js';
import { dayStartOf } from '../domain/feed.js';
import type { ScoutCadence } from '../domain/scout.js';
import { topicKindOf } from './columns.js';

/** A turn that was allowed and cost a call, or may have: the refused and the ones that never reached the provider are not counted. */
const COUNTED = sql`turn.state <> 'refused' and (turn.state <> 'failed' or turn.dispatched)`;

const cadenceOf = (value: string): ScoutCadence => {
  if (value === 'daily' || value === 'weekly') return value;
  throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: cadence');
};

/** The owner's newest counted scout turn in a room: when it last posted, or was about to. */
const lastCounted = (roomId: unknown, ownerAccountId: unknown) => sql`
  (select max(turn.created_at) from rooms.ai_turns turn
    where turn.room_id = ${roomId} and turn.trigger = 'scout_find' and turn.requested_by_account_id = ${ownerAccountId}
      and ${COUNTED})`;

interface ScoutRefRow {
  room_id: string;
  slug: string;
  topic_kind: string;
  topic_id: string;
  owner_account_id: string;
  interests: string[];
}

const refOf = (row: ScoutRefRow): ScoutRef => ({
  room: { roomId: row.room_id, slug: row.slug, topic: { kind: topicKindOf(row.topic_kind), id: row.topic_id } },
  ownerAccountId: row.owner_account_id,
  interests: row.interests,
});

/**
 * Postgres reads of the scouts' heartbeat (migration 0095), as the other methods of the feed store: a pass runs in the nonpersonal
 * `rooms` scope's transaction with the room row locked, so each count is exact. The one read of a personal fact is whether the
 * owner's recording is on, taken without a lock on purpose: a personal lock after the room's would invert the lock order, and the
 * answer is read again just before a note is posted (D-259).
 */
export function scoutLooks(db: Kysely<Database>): Pick<FeedStore, 'scoutsToLook' | 'scoutIn' | 'scoutStanding'> {
  return {
    async scoutsToLook(limit) {
      const rows = await sql<ScoutRefRow>`
        select room.room_id, room.slug, room.topic_kind, room.topic_id, scout.owner_account_id, scout.interests
        from rooms.scouts scout
        join rooms.rooms room on room.room_id = scout.room_id and room.status = 'open'
        join rooms.members owner on owner.room_id = scout.room_id and owner.account_id = scout.owner_account_id
          and owner.ended_at is null
        join identity.accounts account on account.id = scout.owner_account_id and account.status = 'active'
        join identity.universes universe on universe.account_id = scout.owner_account_id and universe.status = 'active'
          and universe.recording_on
        where not scout.paused and scout.stopped_at is null
          and exists (select 1 from rooms.members other where other.room_id = scout.room_id and other.ended_at is null
            and other.ai_level <> 'off' and other.account_id <> scout.owner_account_id)
        order by ${lastCounted(sql.ref('scout.room_id'), sql.ref('scout.owner_account_id'))} asc nulls first, scout.scout_id
        limit ${limit}`.execute(db);
      return rows.rows.map(refOf);
    },

    async scoutIn(slug, ownerHandle) {
      const row = await sql<ScoutRefRow>`
        select room.room_id, room.slug, room.topic_kind, room.topic_id, scout.owner_account_id, scout.interests
        from rooms.scouts scout
        join rooms.rooms room on room.room_id = scout.room_id
        join social.profiles profile on profile.account_id = scout.owner_account_id
        where room.slug = ${slug} and profile.handle = ${ownerHandle}`.execute(db);
      const [found] = row.rows;
      return found === undefined ? undefined : refOf(found);
    },

    async scoutStanding(scope, roomId, ownerAccountId, now) {
      const trx = productionTransactionOf(scope);
      const scout = await trx
        .selectFrom('rooms.scouts')
        .select(['cadence', 'interests', 'paused', 'stopped_at'])
        .where('room_id', '=', roomId)
        .where('owner_account_id', '=', ownerAccountId)
        .executeTakeFirst();
      const facts = await sql<{
        is_member: boolean;
        recording: boolean;
        listeners: string;
        last_post_at: Date | string | null;
        scouts_today: string;
      }>`
        select exists (select 1 from rooms.members owner where owner.room_id = ${roomId}::uuid
            and owner.account_id = ${ownerAccountId}::uuid and owner.ended_at is null) as is_member,
          coalesce((select universe.recording_on and universe.status = 'active' and account.status = 'active'
            from identity.universes universe join identity.accounts account on account.id = universe.account_id
            where universe.account_id = ${ownerAccountId}::uuid), false) as recording,
          (select count(*) from rooms.members other where other.room_id = ${roomId}::uuid and other.ended_at is null
            and other.ai_level <> 'off' and other.account_id <> ${ownerAccountId}::uuid) as listeners,
          ${lastCounted(sql`${roomId}::uuid`, sql`${ownerAccountId}::uuid`)} as last_post_at,
          (select count(*) from rooms.ai_turns turn where turn.room_id = ${roomId}::uuid and turn.trigger = 'scout_find'
            and ${COUNTED} and turn.created_at >= ${dayStartOf(now)}) as scouts_today`.execute(trx);
      const row = facts.rows[0];
      return {
        scout:
          scout === undefined
            ? undefined
            : {
                cadence: cadenceOf(scout.cadence),
                interests: scout.interests,
                paused: scout.paused,
                stopped: scout.stopped_at !== null,
              },
        ownerIsMember: row?.is_member ?? false,
        recording: row?.recording ?? false,
        otherListeners: Number(row?.listeners ?? 0),
        lastPostAt:
          row?.last_post_at === null || row?.last_post_at === undefined ? undefined : new Date(row.last_post_at),
        scoutsToday: Number(row?.scouts_today ?? 0),
      };
    },
  };
}

/** A member's own scout, read and changed inside their personal scope and the room's lock (migration 0095). */
export const scoutReadStore: ScoutReadStore = {
  async scoutOf(lock, accountId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.scouts')
      .select(['scout_id', 'interests', 'cadence', 'paused', 'stopped_at'])
      .where('room_id', '=', lock.roomId)
      .where('owner_account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          scoutId: row.scout_id,
          interests: row.interests,
          cadence: cadenceOf(row.cadence),
          paused: row.paused,
          stopped: row.stopped_at !== null,
        };
  },

  async recordingOn(lock, accountId) {
    const row = await sql<{ recording_on: boolean }>`
      select recording_on from identity.universes where account_id = ${accountId}::uuid`.execute(
      sharedTransactionOf(lock.shared),
    );
    return row.rows[0]?.recording_on ?? false;
  },

  async lastPostOf(lock, accountId) {
    const row = await sql<{ at: Date | string | null }>`
      select ${lastCounted(sql`${lock.roomId}::uuid`, sql`${accountId}::uuid`)} as at`.execute(
      sharedTransactionOf(lock.shared),
    );
    const at = row.rows[0]?.at;
    return at === null || at === undefined ? undefined : new Date(at);
  },

  async save(lock, input) {
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.scouts')
      .values({
        scout_id: input.scoutId,
        room_id: lock.roomId,
        owner_account_id: input.accountId,
        interests: [...input.interests],
        cadence: input.cadence,
        paused: input.paused,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((conflict) =>
        conflict.columns(['room_id', 'owner_account_id']).doUpdateSet({
          interests: [...input.interests],
          cadence: input.cadence,
          paused: input.paused,
          updated_at: input.now,
        }),
      )
      .execute();
  },

  async forgetMember(lock, accountId) {
    await sharedTransactionOf(lock.shared)
      .deleteFrom('rooms.scouts')
      .where('room_id', '=', lock.roomId)
      .where('owner_account_id', '=', accountId)
      .execute();
  },

  async takeBack(lock, accountId, now) {
    const trx = sharedTransactionOf(lock.shared);
    // A scout nobody stopped is simply gone. One a moderator stopped stays, paused, so that sending it again is still stopped.
    await trx
      .deleteFrom('rooms.scouts')
      .where('room_id', '=', lock.roomId)
      .where('owner_account_id', '=', accountId)
      .where('stopped_at', 'is', null)
      .execute();
    await trx
      .updateTable('rooms.scouts')
      .set({ paused: true, updated_at: now })
      .where('room_id', '=', lock.roomId)
      .where('owner_account_id', '=', accountId)
      .where('stopped_at', 'is not', null)
      .execute();
  },

  async setStopped(lock, input) {
    const updated = await sharedTransactionOf(lock.shared)
      .updateTable('rooms.scouts')
      .set(
        input.stopped
          ? { stopped_at: input.now, stopped_by_account_id: input.byAccountId, updated_at: input.now }
          : { stopped_at: null, stopped_by_account_id: null, updated_at: input.now },
      )
      .where('room_id', '=', lock.roomId)
      .where('owner_account_id', '=', input.accountId)
      .executeTakeFirst();
    return (updated.numUpdatedRows ?? 0n) > 0n;
  },
};
