import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { notifyRoomChanged } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/production-scope.js';
import type { FeedStore, FeedTurn, MemoryMessage } from '../application/feed-ports.js';
import type { FeedReadStore } from '../application/ports.js';
import { dayStartOf } from '../domain/feed.js';
import { inhabitantOf, statusOf, topicKindOf } from './columns.js';

const HOUR_MS = 60 * 60 * 1000;

/** A turn that was allowed and cost a call, or may have: the refused and the ones that never reached the provider are not counted. */
const COUNTED = sql`turn.state <> 'refused' and (turn.state <> 'failed' or turn.dispatched)`;

/** Current members of the room whose AI level is not Off: the ones a resident speaks to. */
const listenersOf = (room: RawBuilder<unknown>) =>
  sql`(select count(*) from rooms.members member
        where member.room_id = ${room} and member.ended_at is null and member.ai_level <> 'off')`;

/**
 * Which of `assetIds` this room has seen: a find about it, a find turn that was made or is being made, or a card of it that
 * a member shared or started a thread from. One rule for the pool read and for the read under the lock.
 */
async function seenIn(
  trx: Kysely<Database> | Transaction<Database>,
  roomId: string,
  assetIds: readonly string[],
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const ids = [...assetIds];
  const result = await sql<{ asset_id: string }>`
    select discussion.root_asset_id as asset_id from rooms.discussions discussion
      where discussion.room_id = ${roomId}::uuid and discussion.root_asset_id = any(${ids}::uuid[])
    union
    select message.asset_id from rooms.messages message
      join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
      where discussion.room_id = ${roomId}::uuid and message.asset_id = any(${ids}::uuid[]) and message.hidden_at is null
    union
    select turn.find_asset_id as asset_id from rooms.ai_turns turn
      where turn.room_id = ${roomId}::uuid and turn.trigger = 'feed_find' and turn.find_asset_id = any(${ids}::uuid[])
        and ${COUNTED}`.execute(trx);
  return new Set(result.rows.map((row) => row.asset_id));
}

/** The messages a memory may read, as SQL: shown, plain text, by a member who does not keep theirs out. */
const READABLE = sql`message.author_kind = 'person' and message.author_account_id is not null and message.body_text is not null
  and message.hidden_at is null and message.topic_discussion_id is null and member.keep_out = false`;

const turnKindOf = (value: string): FeedTurn['kind'] => {
  if (value === 'feed_find' || value === 'memory_refresh') return value;
  throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: trigger');
};
const turnStateOf = (value: string): FeedTurn['state'] => {
  if (value === 'queued' || value === 'completed' || value === 'declined' || value === 'failed' || value === 'refused')
    return value;
  throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: state');
};

/**
 * Postgres rows of the residents' feed and the room's memory (migration 0091). A pass runs in the nonpersonal `rooms` scope's
 * transaction and takes the room row FOR UPDATE, so every cap is an exact count. Nothing here reads a person: a member is only
 * a count of listeners or a flag that decides whose words are never read.
 */
export function feedStore(db: Kysely<Database>): FeedStore {
  return {
    async roomsToLook(limit) {
      const rows = await sql<{ room_id: string; slug: string; topic_kind: string; topic_id: string }>`
        select room.room_id, room.slug, room.topic_kind, room.topic_id from rooms.rooms room
        where room.status = 'open'
          and exists (select 1 from rooms.room_cast resident where resident.room_id = room.room_id)
          and ${listenersOf(sql.ref('room.room_id'))} > 0
        order by room.room_id limit ${limit}`.execute(db);
      return rows.rows.map((row) => ({
        roomId: row.room_id,
        slug: row.slug,
        topic: { kind: topicKindOf(row.topic_kind), id: row.topic_id },
      }));
    },

    async roomBySlug(slug) {
      const row = await db
        .selectFrom('rooms.rooms')
        .select(['room_id', 'slug', 'topic_kind', 'topic_id'])
        .where('slug', '=', slug)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { roomId: row.room_id, slug: row.slug, topic: { kind: topicKindOf(row.topic_kind), id: row.topic_id } };
    },

    seenAmong: (roomId, assetIds) => seenIn(db, roomId, assetIds),

    async lockRoom(scope, roomId) {
      const trx = productionTransactionOf(scope);
      const room = await trx
        .selectFrom('rooms.rooms')
        .select(['room_id', 'slug', 'name', 'topic_kind', 'topic_id', 'status'])
        .where('room_id', '=', roomId)
        .forUpdate()
        .executeTakeFirst();
      if (room === undefined) return undefined;
      const cast = await trx
        .selectFrom('rooms.room_cast')
        .select(['inhabitant', 'name'])
        .where('room_id', '=', roomId)
        .orderBy('position')
        .execute();
      const listeners = await sql<{ n: string }>`select ${listenersOf(sql`${roomId}::uuid`)} as n`.execute(trx);
      return {
        roomId: room.room_id,
        slug: room.slug,
        name: room.name,
        topic: { kind: topicKindOf(room.topic_kind), id: room.topic_id },
        status: statusOf(room.status),
        cast: cast.map((member) => ({ inhabitant: inhabitantOf(member.inhabitant), name: member.name })),
        listeners: Number(listeners.rows[0]?.n ?? 0),
      };
    },

    async lapseLost(scope, roomId, before, at) {
      await sql`update rooms.ai_turns set state = 'failed', settled_at = ${at}, dispatched = true
        where room_id = ${roomId}::uuid and trigger in ('feed_find', 'memory_refresh') and state = 'queued'
          and created_at < ${before}`.execute(productionTransactionOf(scope));
    },

    async turn(scope, turnId) {
      const row = await productionTransactionOf(scope)
        .selectFrom('rooms.ai_turns')
        .select(['turn_id', 'trigger', 'inhabitant', 'state', 'find_asset_id', 'find_asset_revision', 'created_at'])
        .where('turn_id', '=', turnId)
        .where('trigger', 'in', ['feed_find', 'memory_refresh'])
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        turnId: row.turn_id,
        kind: turnKindOf(row.trigger),
        inhabitant: inhabitantOf(row.inhabitant),
        state: turnStateOf(row.state),
        asset:
          row.find_asset_id === null || row.find_asset_revision === null
            ? undefined
            : { assetId: row.find_asset_id, assetRevision: row.find_asset_revision },
        createdAt: new Date(row.created_at),
      };
    },

    async feedFacts(scope, roomId, now) {
      const trx = productionTransactionOf(scope);
      const hourStart = new Date(now.getTime() - HOUR_MS);
      const dayStart = dayStartOf(now);
      const counts = await sql<{ room_hour: string; room_day: string; feed_day: string }>`
        select count(*) filter (where turn.created_at >= ${hourStart}) as room_hour,
          count(*) filter (where turn.created_at >= ${dayStart}) as room_day,
          count(*) filter (where turn.created_at >= ${dayStart} and turn.trigger = 'feed_find') as feed_day
        from rooms.ai_turns turn
        where turn.room_id = ${roomId}::uuid and turn.trigger <> 'asked' and ${COUNTED}
          and turn.created_at >= ${dayStart < hourStart ? dayStart : hourStart}`.execute(trx);
      const last = await sql<{ inhabitant: string; at: Date | string }>`
        select turn.inhabitant, max(turn.created_at) as at from rooms.ai_turns turn
        where turn.room_id = ${roomId}::uuid and turn.trigger = 'feed_find' and ${COUNTED}
        group by turn.inhabitant`.execute(trx);
      const row = counts.rows[0];
      return {
        lastFindAt: Object.fromEntries(last.rows.map((entry) => [inhabitantOf(entry.inhabitant), new Date(entry.at)])),
        counts: {
          roomLastHour: Number(row?.room_hour ?? 0),
          roomToday: Number(row?.room_day ?? 0),
          feedToday: Number(row?.feed_day ?? 0),
        },
      };
    },

    async seen(scope, roomId, assetId) {
      return (await seenIn(productionTransactionOf(scope), roomId, [assetId])).has(assetId);
    },

    async insertTurn(scope, turn) {
      const refused = turn.decision.kind === 'refused';
      const inserted = await productionTransactionOf(scope)
        .insertInto('rooms.ai_turns')
        .values({
          turn_id: turn.turnId,
          room_id: turn.roomId,
          inhabitant: turn.inhabitant,
          trigger: turn.kind,
          state: refused ? 'refused' : 'queued',
          decided_by: turn.decision.kind === 'refused' ? turn.decision.cap : 'caps_clear',
          caps: JSON.stringify(turn.counts),
          find_asset_id: turn.asset?.assetId ?? null,
          find_asset_revision: turn.asset?.assetRevision ?? null,
          created_at: turn.now,
          ...(refused ? { settled_at: turn.now } : {}),
        })
        .onConflict((conflict) => conflict.column('turn_id').doNothing())
        .executeTakeFirst();
      return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async settleTurn(scope, turnId, outcome) {
      const base = productionTransactionOf(scope)
        .updateTable('rooms.ai_turns')
        .where('turn_id', '=', turnId)
        .where('state', '=', 'queued');
      if (outcome.state === 'completed') {
        await base
          .set({
            state: 'completed',
            settled_at: outcome.at,
            role_version: outcome.provenance.roleVersion,
            prompt_version: outcome.provenance.promptVersion,
            model: outcome.provenance.model,
            attempt_id: outcome.provenance.attemptId ?? null,
            dispatched: true,
          })
          .execute();
        return;
      }
      // A turn that reached the provider stays counted whatever a later step believes: `dispatched` is never lowered.
      await base
        .set({
          state: outcome.state,
          settled_at: outcome.at,
          dispatched: sql<boolean>`dispatched or ${outcome.dispatched}`,
        })
        .execute();
    },

    async postFind(scope, find) {
      const trx = productionTransactionOf(scope);
      await trx
        .insertInto('rooms.discussions')
        .values({
          discussion_id: find.discussionId,
          room_id: find.roomId,
          title: find.title,
          kind: 'find',
          root_asset_id: find.asset.assetId,
          root_asset_revision: find.asset.assetRevision,
          started_by_account_id: null,
          last_sequence: '1',
          last_change_sequence: '1',
          last_activity_at: find.at,
          created_at: find.at,
        })
        .execute();
      await trx
        .insertInto('rooms.messages')
        .values({
          discussion_id: find.discussionId,
          sequence: '1',
          change_sequence: '1',
          message_id: find.messageId,
          author_kind: 'ai',
          inhabitant: find.inhabitant,
          ai_kind: 'find',
          body_text: find.note,
          trigger: 'feed_find',
          recorded_at: find.at,
        })
        .execute();
      await trx
        .updateTable('rooms.ai_turns')
        .set({
          state: 'completed',
          settled_at: find.at,
          discussion_id: find.discussionId,
          message_id: find.messageId,
          role_version: find.provenance.roleVersion,
          prompt_version: find.provenance.promptVersion,
          model: find.provenance.model,
          attempt_id: find.provenance.attemptId ?? null,
          dispatched: true,
        })
        .where('turn_id', '=', find.turnId)
        .where('state', '=', 'queued')
        .execute();
      // Members read the room again within seconds; the hint is disposable and names only the room.
      await notifyRoomChanged(trx, { roomId: find.roomId, revision: find.at.getTime(), eventId: uuidv7() });
    },

    async memory(scope, roomId) {
      const row = await productionTransactionOf(scope)
        .selectFrom('rooms.room_memory')
        .select(['state', 'source', 'body', 'covers_through'])
        .where('room_id', '=', roomId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        state: row.state === 'ready' ? 'ready' : 'stale',
        source: row.source === 'moderator' ? 'moderator' : 'derived',
        body: row.body,
        coversThrough: row.covers_through === null ? undefined : new Date(row.covers_through),
      };
    },

    async memoryWindow(scope, roomId, limit) {
      const rows = await sql<{
        message_id: string;
        author_account_id: string;
        body_text: string;
        recorded_at: Date | string;
      }>`
        select message.message_id, message.author_account_id, message.body_text, message.recorded_at
        from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        join rooms.members member on member.room_id = discussion.room_id and member.account_id = message.author_account_id
        where discussion.room_id = ${roomId}::uuid and ${READABLE}
        order by message.recorded_at desc, message.message_id desc limit ${limit}`.execute(
        productionTransactionOf(scope),
      );
      return rows.rows
        .map((row): MemoryMessage => ({
          messageId: row.message_id,
          accountId: row.author_account_id,
          text: row.body_text,
          recordedAt: new Date(row.recorded_at),
        }))
        .reverse();
    },

    async stillReadable(scope, roomId, messageIds) {
      if (messageIds.length === 0) return 0;
      const rows = await sql<{ n: string }>`
        select count(*) as n from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        join rooms.members member on member.room_id = discussion.room_id and member.account_id = message.author_account_id
        where discussion.room_id = ${roomId}::uuid and message.message_id = any(${[...messageIds]}::uuid[]) and ${READABLE}`.execute(
        productionTransactionOf(scope),
      );
      return Number(rows.rows[0]?.n ?? 0);
    },

    async lastUnwrittenRefreshAt(scope, roomId, since) {
      const row = await sql<{ at: Date | string | null }>`
        select max(turn.settled_at) as at from rooms.ai_turns turn
        where turn.room_id = ${roomId}::uuid and turn.trigger = 'memory_refresh' and turn.dispatched
          and turn.state in ('declined', 'failed') and turn.settled_at >= ${since}`.execute(
        productionTransactionOf(scope),
      );
      const at = row.rows[0]?.at;
      return at === null || at === undefined ? undefined : new Date(at);
    },

    async storeMemory(scope, memory) {
      // A moderator's text stands: only a derived row (or none) is written over.
      await sql`
        insert into rooms.room_memory (room_id, state, source, body, covers_from, covers_through, messages_read, turn_id, updated_at)
        values (${memory.roomId}::uuid, 'ready', 'derived', ${memory.body}, ${memory.coversFrom}, ${memory.coversThrough},
          ${memory.messagesRead}, ${memory.turnId}::uuid, ${memory.at})
        on conflict (room_id) do update set state = 'ready', source = 'derived', body = excluded.body,
          covers_from = excluded.covers_from, covers_through = excluded.covers_through, messages_read = excluded.messages_read,
          turn_id = excluded.turn_id, edited_by_account_id = null, edited_at = null, updated_at = excluded.updated_at
        where rooms.room_memory.source = 'derived'`.execute(productionTransactionOf(scope));
    },
  };
}

/** Where a derived memory is made stale, as SQL; `byAccount` covers every room when the room is not named (account deletion). */
export const staleMemoryOf = (
  cause: { readonly coveringAt: Date } | { readonly byAccount: string },
  roomId?: string,
) =>
  'coveringAt' in cause
    ? sql`update rooms.room_memory memory set state = 'stale', body = null, covers_from = null, covers_through = null,
        messages_read = 0, updated_at = now()
      where memory.room_id = ${roomId}::uuid and memory.source = 'derived' and memory.state = 'ready'
        and memory.covers_from <= ${cause.coveringAt} and memory.covers_through >= ${cause.coveringAt}`
    : sql`update rooms.room_memory memory set state = 'stale', body = null, covers_from = null, covers_through = null,
        messages_read = 0, updated_at = now()
      where ${roomId === undefined ? sql`true` : sql`memory.room_id = ${roomId}::uuid`}
        and memory.source = 'derived' and memory.state = 'ready' and exists (
          select 1 from rooms.messages message
          join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
          where discussion.room_id = memory.room_id and message.author_account_id = ${cause.byAccount}::uuid
            and message.recorded_at >= memory.covers_from and message.recorded_at <= memory.covers_through)`;

/** The feed and the memory as a member's own use cases read them, inside the personal scope and the room's lock. */
export const feedReadStore: FeedReadStore = {
  async finds(lock, limit) {
    const rows = await sql<{
      discussion_id: string;
      root_asset_id: string;
      root_asset_revision: number;
      created_at: Date | string;
      inhabitant: string;
      body_text: string;
      replies: string;
    }>`
      select discussion.discussion_id, discussion.root_asset_id, discussion.root_asset_revision, discussion.created_at,
        note.inhabitant, note.body_text,
        (select count(*) from rooms.messages reply
          where reply.discussion_id = discussion.discussion_id and reply.sequence > 1 and reply.hidden_at is null
            and (reply.author_account_id is not null or reply.author_kind = 'ai')) as replies
      from rooms.discussions discussion
      join rooms.messages note on note.discussion_id = discussion.discussion_id and note.sequence = 1
      where discussion.room_id = ${lock.roomId}::uuid and discussion.kind = 'find'
        and note.author_kind = 'ai' and note.hidden_at is null
      order by discussion.created_at desc, discussion.discussion_id limit ${limit}`.execute(
      sharedTransactionOf(lock.shared),
    );
    return rows.rows.map((row) => ({
      discussionId: row.discussion_id,
      inhabitant: inhabitantOf(row.inhabitant),
      asset: { assetId: row.root_asset_id, assetRevision: row.root_asset_revision },
      postedAt: new Date(row.created_at),
      note: row.body_text,
      replies: Number(row.replies),
    }));
  },

  async memory(lock) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.room_memory')
      .select(['state', 'source', 'body'])
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          state: row.state === 'ready' ? 'ready' : 'stale',
          source: row.source === 'moderator' ? 'moderator' : 'derived',
          body: row.body,
        };
  },

  async replaceMemory(lock, input) {
    const trx = sharedTransactionOf(lock.shared);
    await sql`
      insert into rooms.room_memory (room_id, state, source, body, messages_read, edited_by_account_id, edited_at, updated_at)
      values (${lock.roomId}::uuid, 'ready', 'moderator', ${input.text}, 0, ${input.byAccountId}::uuid, ${input.now}, ${input.now})
      on conflict (room_id) do update set state = 'ready', source = 'moderator', body = excluded.body, covers_from = null,
        covers_through = null, messages_read = 0, turn_id = null, edited_by_account_id = excluded.edited_by_account_id,
        edited_at = excluded.edited_at, updated_at = excluded.updated_at`.execute(trx);
    await trx
      .insertInto('rooms.memory_edits')
      .values({
        edit_id: input.editId,
        room_id: lock.roomId,
        by_account_id: input.byAccountId,
        action: 'replace',
        body_sha256: input.sha256,
        at: input.now,
      })
      .execute();
  },

  async clearMemory(lock, input) {
    const trx = sharedTransactionOf(lock.shared);
    await sql`
      update rooms.room_memory set state = 'stale', source = 'derived', body = null, covers_from = null, covers_through = null,
        messages_read = 0, turn_id = null, edited_by_account_id = null, edited_at = null, updated_at = ${input.now}
      where room_id = ${lock.roomId}::uuid`.execute(trx);
    await trx
      .insertInto('rooms.memory_edits')
      .values({
        edit_id: input.editId,
        room_id: lock.roomId,
        by_account_id: input.byAccountId,
        action: 'clear',
        at: input.now,
      })
      .execute();
  },

  async markMemoryStale(lock, cause) {
    await staleMemoryOf(cause, lock.roomId).execute(sharedTransactionOf(lock.shared));
  },
};
