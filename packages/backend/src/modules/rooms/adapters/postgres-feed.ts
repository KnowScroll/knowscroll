import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { notifyRoomChanged } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/production-scope.js';
import type { FeedStore, FeedTurn, MemoryMessage, PostAuthor } from '../application/feed-ports.js';
import type { FeedReadStore } from '../application/ports.js';
import { dayStartOf } from '../domain/feed.js';
import { inhabitantOf, statusOf, topicKindOf } from './columns.js';
import { scoutLooks } from './postgres-scouts.js';

const HOUR_MS = 60 * 60 * 1000;

/** A turn that was allowed and cost a call, or may have: the refused and the ones that never reached the provider are not counted. */
const COUNTED = sql`turn.state <> 'refused' and (turn.state <> 'failed' or turn.dispatched)`;

/** Current members of the room whose AI level is not Off: the ones a resident speaks to. */
const listenersOf = (room: RawBuilder<unknown>) =>
  sql`(select count(*) from rooms.members member
        where member.room_id = ${room} and member.ended_at is null and member.ai_level <> 'off')`;

/**
 * Which of `assetIds` this room has seen: a find about it, a find turn that was made or is being made, or a card of it that
 * a member shared or started a thread from. An asset counts as seen when any asset of the same explanation (`explanation_unit_id`:
 * a Reel and the Scroll made from one explanation) has been seen, so a twin is never a second find. One rule for the pool
 * read and for the read under the lock. The unit is the only column read of the library's tables.
 */
async function seenIn(
  trx: Kysely<Database> | Transaction<Database>,
  roomId: string,
  assetIds: readonly string[],
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const ids = [...assetIds];
  const result = await sql<{ asset_id: string }>`
    with seen as (
      select discussion.root_asset_id as asset_id from rooms.discussions discussion
        where discussion.room_id = ${roomId}::uuid and discussion.root_asset_id is not null
      union
      select message.asset_id from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        where discussion.room_id = ${roomId}::uuid and message.asset_id is not null and message.hidden_at is null
      union
      select turn.find_asset_id as asset_id from rooms.ai_turns turn
        where turn.room_id = ${roomId}::uuid and turn.trigger in ('feed_find', 'scout_find') and turn.find_asset_id is not null
          and ${COUNTED}
    )
    select candidate.asset_id from unnest(${ids}::uuid[]) as candidate(asset_id)
      where candidate.asset_id in (select asset_id from seen)
        or exists (
          select 1 from content.asset_revisions unit
          join content.asset_revisions twin on twin.explanation_unit_id = unit.explanation_unit_id
          where unit.asset_id = candidate.asset_id and twin.asset_id in (select asset_id from seen))`.execute(trx);
  return new Set(result.rows.map((row) => row.asset_id));
}

/** The messages a memory may read, as SQL: shown, plain text, by a member who does not keep theirs out. */
const READABLE = sql`message.author_kind = 'person' and message.author_account_id is not null and message.body_text is not null
  and message.hidden_at is null and message.topic_discussion_id is null and member.keep_out = false`;

const turnKindOf = (value: string): FeedTurn['kind'] => {
  if (value === 'feed_find' || value === 'memory_refresh' || value === 'scout_find') return value;
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
        where room_id = ${roomId}::uuid and trigger in ('feed_find', 'memory_refresh', 'scout_find') and state = 'queued'
          and created_at < ${before}`.execute(productionTransactionOf(scope));
    },

    async turn(scope, turnId) {
      const row = await productionTransactionOf(scope)
        .selectFrom('rooms.ai_turns')
        .select([
          'turn_id',
          'trigger',
          'inhabitant',
          'requested_by_account_id',
          'state',
          'find_asset_id',
          'find_asset_revision',
          'created_at',
        ])
        .where('turn_id', '=', turnId)
        .where('trigger', 'in', ['feed_find', 'memory_refresh', 'scout_find'])
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        turnId: row.turn_id,
        kind: turnKindOf(row.trigger),
        // The owner link of a scout's turn is cleared with the owner's account, and every queued turn of it is ended first: an
        // empty owner is only ever read from a turn that is already over.
        author:
          row.trigger === 'scout_find'
            ? { kind: 'scout', ownerAccountId: row.requested_by_account_id ?? '' }
            : { kind: 'resident', inhabitant: inhabitantOf(row.inhabitant) },
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
          inhabitant: turn.author.kind === 'resident' ? turn.author.inhabitant : null,
          requested_by_account_id: turn.author.kind === 'scout' ? turn.author.ownerAccountId : null,
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
          // A scout's note names its owner and has no resident; a resident's note names the resident and no person.
          ...(find.author.kind === 'resident'
            ? { author_kind: 'ai', inhabitant: find.author.inhabitant, trigger: 'feed_find' }
            : { author_kind: 'agent', agent_owner_account_id: find.author.ownerAccountId, trigger: 'scout_find' }),
          ai_kind: 'find',
          body_text: find.note,
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
      // FOR SHARE: a removal, a keep-out or a deletion that has changed one of these rows and not yet committed is waited for,
      // and the row is read again as committed. The count in the outer query cannot take a lock itself.
      const rows = await sql<{ n: string }>`
        select count(*) as n from (
          select message.message_id from rooms.messages message
          join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
          join rooms.members member on member.room_id = discussion.room_id and member.account_id = message.author_account_id
          where discussion.room_id = ${roomId}::uuid and message.message_id = any(${[...messageIds]}::uuid[]) and ${READABLE}
          for share of message, member
        ) readable`.execute(productionTransactionOf(scope));
      return Number(rows.rows[0]?.n ?? 0);
    },

    async memberNames(scope, roomId) {
      const rows = await sql<{ display_name: string; handle: string }>`
        select profile.display_name, profile.handle from rooms.members member
        join social.profiles profile on profile.account_id = member.account_id
        where member.room_id = ${roomId}::uuid limit 1000`.execute(productionTransactionOf(scope));
      return rows.rows.flatMap((row) => [row.display_name, row.handle]);
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

    ...scoutLooks(db),
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

/** Who wrote a post's first message: a resident, a member's scout, or the member. */
function authorOf(row: {
  readonly inhabitant: string | null;
  readonly agent_owner_account_id: string | null;
  readonly author_account_id: string | null;
}): PostAuthor {
  if (row.author_account_id !== null) return { kind: 'person', accountId: row.author_account_id };
  if (row.agent_owner_account_id !== null) return { kind: 'scout', ownerAccountId: row.agent_owner_account_id };
  return { kind: 'resident', inhabitant: inhabitantOf(row.inhabitant) };
}

/** The feed and the memory as a member's own use cases read them, inside the personal scope and the room's lock. */
export const feedReadStore: FeedReadStore = {
  async finds(lock, query) {
    const who =
      query.by === 'people'
        ? sql`note.author_kind = 'person' and note.author_account_id is not null`
        : query.by === 'agents'
          ? sql`note.author_kind in ('ai', 'agent')`
          : sql`(note.author_kind in ('ai', 'agent') or note.author_account_id is not null)`;
    const since = query.since === undefined ? sql`true` : sql`discussion.created_at >= ${query.since}`;
    const order =
      query.sort === 'top'
        ? sql`votes desc, discussion.created_at desc, discussion.discussion_id desc`
        : sql`discussion.created_at desc, discussion.discussion_id desc`;
    const rows = await sql<{
      discussion_id: string;
      root_asset_id: string | null;
      root_asset_revision: number | null;
      source_url: string | null;
      intro_inhabitant: string | null;
      title: string;
      created_at: Date | string;
      inhabitant: string | null;
      agent_owner_account_id: string | null;
      author_account_id: string | null;
      body_text: string;
      reply_groups: readonly { signer: string | null; own_voice: boolean; count: number }[];
      votes: string;
      voted: boolean;
    }>`
      select discussion.discussion_id, discussion.root_asset_id, discussion.root_asset_revision, discussion.source_url,
        discussion.intro_inhabitant, discussion.title, discussion.created_at, note.inhabitant, note.agent_owner_account_id, note.author_account_id, note.body_text,
        (select coalesce(json_agg(json_build_object('signer', grouped.signer, 'own_voice', grouped.own_voice, 'count', grouped.n)), '[]'::json)
          from (select coalesce(reply.author_account_id, reply.agent_owner_account_id) as signer,
              (reply.author_kind in ('ai', 'agent') and (reply.agent_owner_account_id is not null or reply.trigger is not null)) as own_voice,
              count(*) as n
            from rooms.messages reply
            where reply.discussion_id = discussion.discussion_id and reply.sequence > 1 and reply.hidden_at is null
              and (reply.author_account_id is not null or reply.author_kind in ('ai', 'agent'))
            group by 1, 2) grouped) as reply_groups,
        (select count(*) from rooms.post_votes vote where vote.discussion_id = discussion.discussion_id) as votes,
        exists (select 1 from rooms.post_votes mine
          where mine.discussion_id = discussion.discussion_id and mine.account_id = ${query.readerAccountId}::uuid) as voted
      from rooms.discussions discussion
      join rooms.messages note on note.discussion_id = discussion.discussion_id and note.sequence = 1
      where discussion.room_id = ${lock.roomId}::uuid and discussion.kind in ('find', 'intro')
        and note.hidden_at is null and note.body_text is not null and ${who} and ${since}
      order by ${order} limit ${query.limit}`.execute(sharedTransactionOf(lock.shared));
    return rows.rows.map((row) => ({
      discussionId: row.discussion_id,
      author: authorOf(row),
      asset:
        row.root_asset_id === null || row.root_asset_revision === null
          ? undefined
          : { assetId: row.root_asset_id, assetRevision: row.root_asset_revision },
      source: row.source_url ?? undefined,
      introduces: row.intro_inhabitant === null ? undefined : inhabitantOf(row.intro_inhabitant),
      title: row.title,
      postedAt: new Date(row.created_at),
      note: row.body_text,
      replies: row.reply_groups.map((group) => ({
        signer: group.signer,
        ownVoice: group.own_voice,
        count: group.count,
      })),
      votes: Number(row.votes),
      votedByReader: row.voted,
    }));
  },

  async residentFacts(lock, inhabitant) {
    const trx = sharedTransactionOf(lock.shared);
    const room = await sql<{ since: Date | string }>`
      select created_at as since from rooms.rooms where room_id = ${lock.roomId}::uuid`.execute(trx);
    const turns = await sql<{ last_at: Date | string | null; last_find_at: Date | string | null }>`
      select max(turn.created_at) filter (where turn.state = 'completed' and turn.trigger <> 'memory_refresh') as last_at,
        max(turn.created_at) filter (where turn.trigger = 'feed_find' and ${COUNTED}) as last_find_at
      from rooms.ai_turns turn
      where turn.room_id = ${lock.roomId}::uuid and turn.inhabitant = ${inhabitant}`.execute(trx);
    const introduced = await sql<{ found: boolean }>`
      select exists (select 1 from rooms.discussions
        where room_id = ${lock.roomId}::uuid and kind = 'intro' and intro_inhabitant = ${inhabitant}) as found`.execute(
      trx,
    );
    const recent = await sql<{ discussion_id: string; message_id: string; title: string; created_at: Date | string }>`
      select discussion.discussion_id, note.message_id, discussion.title, discussion.created_at
      from rooms.discussions discussion
      join rooms.messages note on note.discussion_id = discussion.discussion_id and note.sequence = 1
      where discussion.room_id = ${lock.roomId}::uuid and discussion.kind = 'find' and note.author_kind = 'ai'
        and note.inhabitant = ${inhabitant} and note.hidden_at is null
      order by discussion.created_at desc, discussion.discussion_id desc limit 3`.execute(trx);
    const at = (value: Date | string | null | undefined) =>
      value === null || value === undefined ? undefined : new Date(value);
    return {
      roomSince: new Date(room.rows[0]!.since),
      lastAt: at(turns.rows[0]?.last_at),
      lastFindAt: at(turns.rows[0]?.last_find_at),
      introduced: introduced.rows[0]?.found === true,
      recent: recent.rows.map((row) => ({
        discussionId: row.discussion_id,
        messageId: row.message_id,
        title: row.title,
        postedAt: new Date(row.created_at),
      })),
    };
  },

  async liveEvents(lock, since, limit) {
    const rows = await sql<{
      kind: 'posted' | 'replied';
      discussion_id: string;
      at: Date | string;
      author_account_id: string | null;
      agent_owner_account_id: string | null;
      inhabitant: string | null;
    }>`
      select events.kind, events.discussion_id, events.at, events.author_account_id, events.agent_owner_account_id, events.inhabitant
      from (
        select 'posted' as kind, discussion.discussion_id, discussion.created_at as at, first.author_account_id,
          first.agent_owner_account_id, first.inhabitant
        from rooms.discussions discussion
        join rooms.messages first on first.discussion_id = discussion.discussion_id and first.sequence = 1
        where discussion.room_id = ${lock.roomId}::uuid and discussion.kind in ('find', 'intro')
          and first.hidden_at is null and first.body_text is not null and discussion.created_at >= ${since}
        union all
        select 'replied', discussion.discussion_id, reply.recorded_at, reply.author_account_id, null::uuid, null::text
        from rooms.messages reply
        join rooms.discussions discussion on discussion.discussion_id = reply.discussion_id
        join rooms.messages first on first.discussion_id = discussion.discussion_id and first.sequence = 1
        where discussion.room_id = ${lock.roomId}::uuid and discussion.kind in ('find', 'intro')
          and first.hidden_at is null and first.body_text is not null
          and reply.sequence > 1 and reply.author_account_id is not null and reply.hidden_at is null
          and reply.recorded_at >= ${since}
      ) events
      order by events.at desc limit ${limit}`.execute(sharedTransactionOf(lock.shared));
    return rows.rows.map((row) => ({
      kind: row.kind,
      discussionId: row.discussion_id,
      at: new Date(row.at),
      author: authorOf(row),
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
