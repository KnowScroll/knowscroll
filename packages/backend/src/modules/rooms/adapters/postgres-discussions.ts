import { sql, type Transaction } from 'kysely';
import { BlockStateSnapshot } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { StoredSnippetAnchor } from '../../content/public.js';
import type {
  Counters,
  DiscussionFigures,
  DiscussionRow,
  DiscussionStore,
  MessageRow,
  RoomLock,
  WindowMessage,
} from '../application/ports.js';
import { contributionKindOf, discussionKindOf, inhabitantOf, speechTriggerOf, topicTagOf } from './columns.js';

interface DiscussionColumns {
  discussion_id: string;
  room_id: string;
  kind: string;
  title: string;
  title_derived: boolean;
  tag: string | null;
  root_asset_id: string | null;
  root_asset_revision: number | null;
  origin_message_id: string | null;
  started_by_account_id: string | null;
  pinned_at: Date | null;
  last_sequence: string;
  last_change_sequence: string;
  last_activity_at: Date | string;
  created_at: Date | string;
}

const DISCUSSION_COLUMNS = [
  'discussion_id',
  'room_id',
  'kind',
  'title',
  'title_derived',
  'tag',
  'root_asset_id',
  'root_asset_revision',
  'origin_message_id',
  'started_by_account_id',
  'pinned_at',
  'last_sequence',
  'last_change_sequence',
  'last_activity_at',
  'created_at',
] as const;

const discussionOf = (row: DiscussionColumns): DiscussionRow => ({
  discussionId: row.discussion_id,
  roomId: row.room_id,
  kind: discussionKindOf(row.kind),
  title: row.title,
  titleDerived: row.title_derived,
  tag: row.tag === null ? null : topicTagOf(row.tag),
  root:
    row.root_asset_id === null || row.root_asset_revision === null
      ? null
      : { assetId: row.root_asset_id, assetRevision: row.root_asset_revision },
  originMessageId: row.origin_message_id,
  startedByAccountId: row.started_by_account_id,
  pinned: row.pinned_at !== null,
  lastSequence: Number(row.last_sequence),
  lastChangeSequence: Number(row.last_change_sequence),
  lastActivityAt: new Date(row.last_activity_at),
  createdAt: new Date(row.created_at),
});

interface MessageColumns {
  sequence: string;
  change_sequence: string;
  message_id: string;
  command_id: string | null;
  recorded_at: Date | string;
  hidden_at: Date | null;
  author_account_id: string | null;
  inhabitant: string | null;
  ai_kind: string | null;
  body_text: string | null;
  asset_id: string | null;
  asset_revision: number | null;
  note: string | null;
  trigger: string | null;
  topic_discussion_id: string | null;
}

const MESSAGE_COLUMNS = [
  'sequence',
  'change_sequence',
  'message_id',
  'command_id',
  'recorded_at',
  'hidden_at',
  'author_account_id',
  'inhabitant',
  'ai_kind',
  'body_text',
  'asset_id',
  'asset_revision',
  'note',
  'trigger',
  'topic_discussion_id',
] as const;

const messageOf = (row: MessageColumns): MessageRow => ({
  sequence: Number(row.sequence),
  changeSequence: Number(row.change_sequence),
  messageId: row.message_id,
  commandId: row.command_id,
  recordedAt: new Date(row.recorded_at),
  hidden: row.hidden_at !== null,
  authorAccountId: row.author_account_id,
  inhabitant: row.inhabitant === null ? null : inhabitantOf(row.inhabitant),
  aiKind: row.ai_kind === null ? null : contributionKindOf(row.ai_kind),
  text: row.body_text,
  content:
    row.asset_id === null || row.asset_revision === null
      ? null
      : { assetId: row.asset_id, assetRevision: row.asset_revision },
  note: row.note,
  trigger: row.trigger === null ? null : speechTriggerOf(row.trigger),
  topicDiscussionId: row.topic_discussion_id,
});

const trxOf = (lock: RoomLock): Transaction<Database> => sharedTransactionOf(lock.shared);

interface SnippetColumns {
  message_id: string;
  kind: string;
  start_ms: number | null;
  end_ms: number | null;
  block_id: string | null;
  block_type: string | null;
  block_version: number | null;
  block_label: string | null;
  range_start: number | null;
  range_end: number | null;
  quote: string | null;
  quote_hash: string | null;
  settings: unknown;
  settings_description: string | null;
}

/** The checked anchor back from its row; a row the schema forbids (a broken check) reads as none. */
function snippetOf(row: SnippetColumns): StoredSnippetAnchor | undefined {
  if (row.kind === 'reel_range' && row.start_ms !== null && row.end_ms !== null)
    return { kind: 'reel_range', startMs: row.start_ms, endMs: row.end_ms };
  if (
    row.kind === 'scroll_passage' &&
    row.block_id !== null &&
    row.range_start !== null &&
    row.range_end !== null &&
    row.quote !== null &&
    row.quote_hash !== null
  )
    return {
      kind: 'scroll_passage',
      blockId: row.block_id,
      start: row.range_start,
      end: row.range_end,
      quote: row.quote,
      quoteHash: row.quote_hash,
    };
  if (row.kind === 'scroll_block' && row.block_id !== null && row.block_type !== null && row.block_version !== null) {
    const stored = row.settings === null ? undefined : BlockStateSnapshot.safeParse(row.settings);
    return {
      kind: 'scroll_block',
      blockId: row.block_id,
      blockType: row.block_type,
      blockVersion: row.block_version,
      label: row.block_label ?? '',
      ...(stored?.success ? { settings: { snapshot: stored.data, description: row.settings_description ?? '' } } : {}),
    };
  }
  return undefined;
}

/** Postgres discussion and message rows (migration 0062). The use cases decide who may read or write; this only runs queries. */
export const discussionStore: DiscussionStore = {
  async exists(lock, discussionId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.discussions')
      .select('discussion_id')
      .where('discussion_id', '=', discussionId)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    return row !== undefined;
  },

  async load(lock, discussionId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.discussions')
      .select(DISCUSSION_COLUMNS)
      .where('discussion_id', '=', discussionId)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    return row === undefined ? undefined : discussionOf(row);
  },

  async list(lock, limit) {
    const rows = await trxOf(lock)
      .selectFrom('rooms.discussions')
      .select(DISCUSSION_COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('kind', 'not in', ['general', 'today'])
      .orderBy(sql`pinned_at desc nulls last`)
      .orderBy('last_activity_at', 'desc')
      .orderBy('discussion_id')
      .limit(limit)
      .execute();
    return rows.map(discussionOf);
  },

  async listTopics(lock, query) {
    const base = trxOf(lock)
      .selectFrom('rooms.discussions')
      .select(DISCUSSION_COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('kind', '=', 'topic');
    const rows = await (query.tag === undefined ? base : base.where('tag', '=', query.tag))
      .orderBy(sql`pinned_at desc nulls last`)
      .orderBy('last_activity_at', 'desc')
      .orderBy('discussion_id')
      .limit(query.limit)
      .execute();
    return rows.map(discussionOf);
  },

  async figures(lock, discussionIds) {
    if (discussionIds.length === 0) return new Map();
    const result = await sql<{
      discussion_id: string;
      reply_count: string;
      useful_count: string;
      answered: boolean;
      last_account: string | null;
      last_inhabitant: string | null;
    }>`
      select discussion.discussion_id,
        -- The counter is every message ever appended; the removed ones and the cards are few and indexed, so this is not a
        -- count over the whole discussion (General can hold thousands of messages and is read with every room view).
        (discussion.last_sequence
          - (select count(*) from rooms.messages removed
              where removed.discussion_id = discussion.discussion_id and removed.hidden_at is not null)
          - (select count(*) from rooms.messages card
              where card.discussion_id = discussion.discussion_id and card.hidden_at is null
                and card.topic_discussion_id is not null)) as reply_count,
        (select count(*) from rooms.message_useful useful
          join rooms.messages message on message.message_id = useful.message_id
          where message.discussion_id = discussion.discussion_id and message.hidden_at is null) as useful_count,
        exists (select 1 from rooms.messages message
          where message.discussion_id = discussion.discussion_id and message.hidden_at is null
            and message.author_account_id is not null
            and message.author_account_id is distinct from discussion.started_by_account_id) as answered,
        newest.author_account_id as last_account, newest.inhabitant as last_inhabitant
      from rooms.discussions discussion
      left join lateral (
        select message.author_account_id, message.inhabitant from rooms.messages message
        where message.discussion_id = discussion.discussion_id and message.hidden_at is null
          and message.topic_discussion_id is null
          and (message.author_account_id is not null or message.author_kind = 'ai')
        order by message.sequence desc limit 1
      ) newest on true
      where discussion.room_id = ${lock.roomId}::uuid and discussion.discussion_id = any(${[...discussionIds]}::uuid[])`.execute(
      trxOf(lock),
    );
    return new Map(
      result.rows.map((row): [string, DiscussionFigures] => [
        row.discussion_id,
        {
          replyCount: Number(row.reply_count),
          usefulCount: Number(row.useful_count),
          answered: row.answered,
          lastReplyBy:
            row.last_account !== null
              ? { accountId: row.last_account }
              : row.last_inhabitant !== null
                ? { inhabitant: inhabitantOf(row.last_inhabitant) }
                : undefined,
        },
      ]),
    );
  },

  async windowMessages(lock, query): Promise<readonly WindowMessage[]> {
    const rows = await trxOf(lock)
      .selectFrom('rooms.messages as message')
      .innerJoin('rooms.discussions as discussion', 'discussion.discussion_id', 'message.discussion_id')
      .select([
        'discussion.kind as discussion_kind',
        'message.sequence',
        'message.change_sequence',
        'message.message_id',
        'message.command_id',
        'message.recorded_at',
        'message.hidden_at',
        'message.author_account_id',
        'message.inhabitant',
        'message.ai_kind',
        'message.body_text',
        'message.asset_id',
        'message.asset_revision',
        'message.note',
        'message.trigger',
        'message.topic_discussion_id',
      ])
      .where('discussion.room_id', '=', lock.roomId)
      .where('message.hidden_at', 'is', null)
      .where('message.recorded_at', '>', query.after)
      .where('message.recorded_at', '<=', query.through)
      .where((eb) => eb.or([eb('message.body_text', 'is not', null), eb('message.asset_id', 'is not', null)]))
      .orderBy('message.recorded_at', 'desc')
      .orderBy('message.sequence', 'desc')
      .limit(query.limit)
      .execute();
    return rows.reverse().map((row) => ({
      message: messageOf(row),
      discussionKind: discussionKindOf(row.discussion_kind),
    }));
  },

  async newMessagesFor(lock, accountId, since, limit) {
    const result = await sql<{ n: string }>`
      select count(*) as n from (
        select 1 from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        where discussion.room_id = ${lock.roomId}::uuid and message.hidden_at is null
          and message.recorded_at > ${since}
          and (message.body_text is not null or message.asset_id is not null)
          and message.author_account_id is distinct from ${accountId}::uuid
        limit ${limit}
      ) shown`.execute(trxOf(lock));
    return Number(result.rows[0]?.n ?? 0);
  },

  async setUseful(lock, messageId, accountId, marked, now) {
    const trx = trxOf(lock);
    if (marked)
      await trx
        .insertInto('rooms.message_useful')
        .values({ message_id: messageId, account_id: accountId, marked_at: now })
        .onConflict((conflict) => conflict.columns(['message_id', 'account_id']).doNothing())
        .execute();
    else
      await trx
        .deleteFrom('rooms.message_useful')
        .where('message_id', '=', messageId)
        .where('account_id', '=', accountId)
        .execute();
  },

  async usefulAmong(lock, accountId, messageIds) {
    if (messageIds.length === 0) return new Set();
    const rows = await trxOf(lock)
      .selectFrom('rooms.message_useful')
      .select('message_id')
      .where('account_id', '=', accountId)
      .where('message_id', 'in', [...messageIds])
      .execute();
    return new Set(rows.map((row) => row.message_id));
  },

  async general(lock) {
    const row = await trxOf(lock)
      .selectFrom('rooms.discussions')
      .select(DISCUSSION_COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('kind', '=', 'general')
      .executeTakeFirst();
    return row === undefined ? undefined : discussionOf(row);
  },

  async today(lock) {
    const row = await trxOf(lock)
      .selectFrom('rooms.discussions')
      .select(DISCUSSION_COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('kind', '=', 'today')
      .executeTakeFirst();
    return row === undefined ? undefined : discussionOf(row);
  },

  async lastMessageAt(lock) {
    // One probe of `messages_latest_visible` per discussion, newest first, so a read never scans a room's messages.
    const result = await sql<{ latest: Date | string | null }>`
      select max(newest.recorded_at) as latest
      from rooms.discussions discussion
      cross join lateral (
        select message.recorded_at from rooms.messages message
        where message.discussion_id = discussion.discussion_id and message.hidden_at is null
          and message.author_kind = 'person'
        order by message.recorded_at desc limit 1
      ) newest
      where discussion.room_id = ${lock.roomId}::uuid`.execute(trxOf(lock));
    const latest = result.rows[0]?.latest;
    return latest === undefined || latest === null ? undefined : new Date(latest);
  },

  async pinned(lock) {
    const row = await trxOf(lock)
      .selectFrom('rooms.discussions')
      .select(DISCUSSION_COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('pinned_at', 'is not', null)
      .orderBy('pinned_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : discussionOf(row);
  },

  async originsOf(lock, discussionIds) {
    if (discussionIds.length === 0) return new Map();
    const rows = await trxOf(lock)
      .selectFrom('rooms.discussions as discussion')
      .innerJoin('rooms.messages as origin', 'origin.message_id', 'discussion.origin_message_id')
      .select(['discussion.discussion_id', 'origin.author_account_id', 'origin.hidden_at', 'origin.body_text'])
      .where('discussion.room_id', '=', lock.roomId)
      .where('discussion.discussion_id', 'in', [...discussionIds])
      .execute();
    return new Map(
      rows.map((row) => [
        row.discussion_id,
        {
          shown: row.hidden_at === null && row.body_text !== null && row.author_account_id !== null,
          authorAccountId: row.author_account_id,
        },
      ]),
    );
  },

  async create(lock, discussion) {
    await trxOf(lock)
      .insertInto('rooms.discussions')
      .values({
        discussion_id: discussion.discussionId,
        room_id: lock.roomId,
        title: discussion.title,
        title_derived: discussion.titleDerived,
        tag: discussion.tag ?? null,
        root_asset_id: discussion.root?.assetId ?? null,
        root_asset_revision: discussion.root?.assetRevision ?? null,
        origin_message_id: discussion.originMessageId ?? null,
        started_by_account_id: discussion.startedByAccountId,
        notify_answer: discussion.notifyAnswer ?? false,
        last_activity_at: discussion.now,
        created_at: discussion.now,
      })
      .execute();
  },

  async setPinned(lock, discussionId, pinnedAt) {
    await trxOf(lock)
      .updateTable('rooms.discussions')
      .set({ pinned_at: pinnedAt })
      .where('discussion_id', '=', discussionId)
      .where('room_id', '=', lock.roomId)
      .execute();
  },

  async append(lock, discussionId, message): Promise<Counters> {
    const trx = trxOf(lock);
    // The counters are taken atomically from the discussion row, so sends stay gapless and an account
    // deletion can tombstone messages without the room lock.
    const counters = await trx
      .updateTable('rooms.discussions')
      .set({
        last_sequence: sql`last_sequence + 1`,
        last_change_sequence: sql`last_change_sequence + 1`,
        last_activity_at: sql`greatest(last_activity_at, ${message.recordedAt})`,
      })
      .where('discussion_id', '=', discussionId)
      .where('room_id', '=', lock.roomId)
      .returning(['last_sequence', 'last_change_sequence'])
      .executeTakeFirstOrThrow();
    const common = {
      discussion_id: discussionId,
      sequence: counters.last_sequence,
      change_sequence: counters.last_change_sequence,
      message_id: message.messageId,
      recorded_at: message.recordedAt,
    };
    await trx
      .insertInto('rooms.messages')
      .values(
        message.kind === 'ai'
          ? {
              ...common,
              author_kind: 'ai',
              inhabitant: message.inhabitant,
              ai_kind: message.aiKind,
              body_text: message.text,
              trigger: message.trigger ?? null,
            }
          : {
              ...common,
              author_kind: 'person',
              author_account_id: message.authorAccountId,
              command_id: message.commandId,
              ...(message.topicDiscussionId !== undefined
                ? { topic_discussion_id: message.topicDiscussionId }
                : message.text === undefined
                  ? {
                      asset_id: message.content?.assetId ?? null,
                      asset_revision: message.content?.assetRevision ?? null,
                      note: message.note ?? null,
                    }
                  : { body_text: message.text }),
            },
      )
      .execute();
    return { sequence: Number(counters.last_sequence), changeSequence: Number(counters.last_change_sequence) };
  },

  async messages(lock, discussionId, query) {
    const base = trxOf(lock)
      .selectFrom('rooms.messages')
      .select(MESSAGE_COLUMNS)
      .where('discussion_id', '=', discussionId);
    if (query.after !== undefined) {
      const rows = await base
        .where('change_sequence', '>', String(query.after))
        .orderBy('change_sequence', 'asc')
        .limit(query.limit)
        .execute();
      return rows.map(messageOf);
    }
    const older = query.before === undefined ? base : base.where('sequence', '<', String(query.before));
    const rows = await older.orderBy('sequence', 'desc').limit(query.limit).execute();
    return rows.reverse().map(messageOf);
  },

  async messageById(lock, discussionId, messageId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.messages')
      .select(MESSAGE_COLUMNS)
      .where('discussion_id', '=', discussionId)
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    return row === undefined ? undefined : messageOf(row);
  },

  async locate(lock, messageIds) {
    if (messageIds.length === 0) return new Map();
    const rows = await trxOf(lock)
      .selectFrom('rooms.messages as message')
      .innerJoin('rooms.discussions as discussion', 'discussion.discussion_id', 'message.discussion_id')
      .select([
        'message.message_id',
        'message.sequence',
        'discussion.discussion_id',
        'discussion.title',
        'discussion.title_derived',
      ])
      .where('discussion.room_id', '=', lock.roomId)
      .where('message.message_id', 'in', [...messageIds])
      .execute();
    return new Map(
      rows.map((row) => [
        row.message_id,
        {
          discussionId: row.discussion_id,
          discussionTitle: row.title,
          titleDerived: row.title_derived,
          sequence: Number(row.sequence),
        },
      ]),
    );
  },

  async messageInRoom(lock, messageId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.messages as message')
      .innerJoin('rooms.discussions as discussion', 'discussion.discussion_id', 'message.discussion_id')
      .select([
        'discussion.discussion_id as discussion_id',
        'message.sequence',
        'message.change_sequence',
        'message.message_id',
        'message.command_id',
        'message.recorded_at',
        'message.hidden_at',
        'message.author_account_id',
        'message.inhabitant',
        'message.ai_kind',
        'message.body_text',
        'message.asset_id',
        'message.asset_revision',
        'message.note',
        'message.trigger',
        'message.topic_discussion_id',
      ])
      .where('discussion.room_id', '=', lock.roomId)
      .where('message.message_id', '=', messageId)
      .executeTakeFirst();
    return row === undefined ? undefined : { discussionId: row.discussion_id, message: messageOf(row) };
  },

  async setHidden(lock, discussionId, messageId, hiddenAt) {
    const trx = trxOf(lock);
    const bumped = await trx
      .updateTable('rooms.discussions')
      .set({ last_change_sequence: sql`last_change_sequence + 1` })
      .where('discussion_id', '=', discussionId)
      .where('room_id', '=', lock.roomId)
      .returning('last_change_sequence')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('rooms.messages')
      .set({ hidden_at: hiddenAt, change_sequence: bumped.last_change_sequence })
      .where('discussion_id', '=', discussionId)
      .where('message_id', '=', messageId)
      .execute();
  },

  async saveSnippet(lock, messageId, anchor) {
    const common = { message_id: messageId, kind: anchor.kind };
    const values =
      anchor.kind === 'reel_range'
        ? { ...common, start_ms: anchor.startMs, end_ms: anchor.endMs }
        : anchor.kind === 'scroll_passage'
          ? {
              ...common,
              block_id: anchor.blockId,
              range_start: anchor.start,
              range_end: anchor.end,
              quote: anchor.quote,
              quote_hash: anchor.quoteHash,
            }
          : {
              ...common,
              block_id: anchor.blockId,
              block_type: anchor.blockType,
              block_version: anchor.blockVersion,
              block_label: anchor.label === '' ? null : anchor.label,
              settings: anchor.settings === undefined ? null : JSON.stringify(anchor.settings.snapshot),
              settings_description: anchor.settings?.description === '' ? null : (anchor.settings?.description ?? null),
            };
    await trxOf(lock).insertInto('rooms.message_snippets').values(values).execute();
  },

  async snippetsOf(lock, messageIds) {
    if (messageIds.length === 0) return new Map();
    const rows = await trxOf(lock)
      .selectFrom('rooms.message_snippets')
      .selectAll()
      .where('message_id', 'in', [...messageIds])
      .execute();
    const found = new Map<string, StoredSnippetAnchor>();
    for (const row of rows) {
      const anchor = snippetOf(row);
      if (anchor !== undefined) found.set(row.message_id, anchor);
    }
    return found;
  },

  async snippetOfMessage(lock, discussionId, messageId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.messages as message')
      .innerJoin('rooms.message_snippets as snippet', 'snippet.message_id', 'message.message_id')
      .selectAll('snippet')
      .select(['message.asset_id', 'message.asset_revision'])
      .where('message.discussion_id', '=', discussionId)
      .where('message.message_id', '=', messageId)
      .executeTakeFirst();
    const anchor = row === undefined ? undefined : snippetOf(row);
    if (row === undefined || row.asset_id === null || row.asset_revision === null || anchor === undefined)
      return undefined;
    return { target: { assetId: row.asset_id, assetRevision: row.asset_revision }, anchor };
  },
};
