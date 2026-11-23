import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  countSteps,
  namesOldRevision,
  runSteps,
  type ModuleRemovalReport,
  type OldScrollRemoval,
  type RemovalCount,
  type RemovalStep,
} from '../../../infrastructure/erasure/index.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { bumpInboxHeads } from './inbox-heads.js';

/**
 * What Social does when the Scrolls of the retired document formats leave the database (`content cleanup-old-scrolls`, #791, D-437).
 * Content has written the old revisions to its temporary table first; Social reads it.
 *
 * - A thread rooted at an old revision has no revision to be about once the revision is gone, and no later revision of that
 *   Scroll to point at instead, so the whole thread goes: its messages, snippets, reactions, call reveals, links and members.
 *   (A member's own picks and places were removed by Clear, which the cleanup runs for every account first.)
 * - In a thread that stays and in every direct conversation, a card to an old revision becomes a tombstone, the way account
 *   deletion makes one (`erasure.ts`): no author, words, card or note, the same place and number, a fresh change number, so every
 *   member's catch-up replaces the bubble. Its snippets and reactions go with it.
 * - Managed share links to an old revision, and a thread's revealed calls on one, are deleted.
 * - Each member of a conversation that lost something gets the next inbox revision, so the list is read again.
 */
const OLD_THREADS = 'old_scroll_threads';

/** Writes the ids of the threads rooted at an old revision to a temporary table, so a step still knows them after their link is deleted. */
async function prepareThreads(trx: Transaction<Database>): Promise<void> {
  await sql`create temporary table ${sql.table(OLD_THREADS)} on commit drop as
    select link.thread_id from social.content_threads link
    where ${namesOldRevision('link', 'root_asset_id', 'root_asset_revision')}`.execute(trx);
}

const inRemovedThread = (column: string): RawBuilder<boolean> =>
  sql<boolean>`${sql.ref(column)} in (select thread_id from ${sql.table(OLD_THREADS)})`;

/** A card of a message to an old revision. */
const cardToOldRevision = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${sql.ref(`${alias}.asset_id`)} is not null and ${namesOldRevision(alias, 'asset_id', 'asset_revision')})`;

/** A message that is deleted with its thread, or becomes a tombstone where the thread stays. */
const messageLeaves = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${inRemovedThread(`${alias}.conversation_id`)} or ${cardToOldRevision(alias)})`;

/** The cards that become tombstones: those in a conversation that stays. */
const tombstoned = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${cardToOldRevision(alias)} and not ${inRemovedThread(`${alias}.conversation_id`)})`;

const tombstoneStatement = (where: RawBuilder<unknown>) => sql`
  with mine as (
    select t.conversation_id, t.sequence,
      row_number() over (partition by t.conversation_id order by t.sequence) as position,
      count(*) over (partition by t.conversation_id) as total
    from social.messages t where ${where}
  ), bumped as (
    update social.conversations c set last_change_sequence = c.last_change_sequence + counted.total
    from (select conversation_id, max(total) as total from mine group by conversation_id) counted
    where c.conversation_id = counted.conversation_id
    returning c.conversation_id, c.last_change_sequence as top, counted.total
  )
  update social.messages m set author_account_id = null, command_id = null, body_text = null,
    asset_id = null, asset_revision = null, note = null, reply_to_sequence = null, challenge_stop = null,
    change_sequence = bumped.top - bumped.total + mine.position
  from mine join bumped on bumped.conversation_id = mine.conversation_id
  where m.conversation_id = mine.conversation_id and m.sequence = mine.sequence`;

function socialSteps(): readonly RemovalStep[] {
  const tombstoneWhere = tombstoned('t');
  return [
    {
      table: 'social.thread_call_reveals',
      action: 'delete',
      where: sql<boolean>`${inRemovedThread('t.thread_id')} or ${namesOldRevision('t', 'asset_id', 'revision')}`,
    },
    {
      table: 'social.message_reactions',
      action: 'delete',
      where: sql<boolean>`exists (select 1 from social.messages m
        where m.conversation_id = t.conversation_id and m.sequence = t.message_sequence and ${messageLeaves('m')})`,
    },
    {
      table: 'social.message_snippets',
      action: 'delete',
      where: sql<boolean>`exists (select 1 from social.messages m where m.message_id = t.message_id and ${messageLeaves('m')})`,
    },
    {
      table: 'social.content_shares',
      action: 'delete',
      where: sql<boolean>`(t.conversation_id is not null and ${inRemovedThread('t.conversation_id')})
        or ${namesOldRevision('t', 'asset_id', 'asset_revision')}`,
    },
    {
      table: 'social.messages',
      action: 'tombstone',
      where: tombstoneWhere,
      run: tombstoneStatement(tombstoneWhere),
    },
    {
      table: 'social.messages',
      action: 'delete',
      label: 'in a removed thread',
      where: inRemovedThread('t.conversation_id'),
    },
    { table: 'social.conversation_members', action: 'delete', where: inRemovedThread('t.conversation_id') },
    { table: 'social.content_threads', action: 'delete', where: inRemovedThread('t.thread_id') },
    { table: 'social.conversations', action: 'delete', where: inRemovedThread('t.conversation_id') },
  ];
}

interface ThreadFate {
  readonly conversationId: string;
  readonly kind: string;
  readonly fate: 'removed' | 'kept';
  readonly members: number;
  readonly messages: number;
  readonly cardsToTombstone: number;
  readonly sharesToDelete: number;
  readonly revealsToDelete: number;
}

/** What happens to each conversation the cleanup touches: ids and counts only. */
async function describe(trx: Transaction<Database>): Promise<readonly ThreadFate[]> {
  const rows = await sql<{
    conversationId: string;
    kind: string;
    removed: boolean;
    members: string;
    messages: string;
    cards: string;
    shares: string;
    reveals: string;
  }>`
    select c.conversation_id as "conversationId", c.kind,
      c.conversation_id in (select thread_id from ${sql.table(OLD_THREADS)}) as removed,
      (select count(*) from social.conversation_members member where member.conversation_id = c.conversation_id)::text as members,
      (select count(*) from social.messages m where m.conversation_id = c.conversation_id)::text as messages,
      (select count(*) from social.messages t where t.conversation_id = c.conversation_id and ${tombstoned('t')})::text as cards,
      (select count(*) from social.content_shares t where t.conversation_id = c.conversation_id
        and (${inRemovedThread('t.conversation_id')} or ${namesOldRevision('t', 'asset_id', 'asset_revision')}))::text as shares,
      (select count(*) from social.thread_call_reveals t where t.thread_id = c.conversation_id
        and (${inRemovedThread('t.thread_id')} or ${namesOldRevision('t', 'asset_id', 'revision')}))::text as reveals
    from social.conversations c
    where c.conversation_id in (select thread_id from ${sql.table(OLD_THREADS)})
      or exists (select 1 from social.messages t where t.conversation_id = c.conversation_id and ${tombstoned('t')})
      or exists (select 1 from social.content_shares t where t.conversation_id = c.conversation_id
        and ${namesOldRevision('t', 'asset_id', 'asset_revision')})
      or exists (select 1 from social.thread_call_reveals t where t.thread_id = c.conversation_id
        and ${namesOldRevision('t', 'asset_id', 'revision')})
    order by c.conversation_id`.execute(trx);
  return rows.rows.map((row) => ({
    conversationId: row.conversationId,
    kind: row.kind,
    fate: row.removed ? 'removed' : 'kept',
    members: Number(row.members),
    messages: Number(row.messages),
    cardsToTombstone: Number(row.cards),
    sharesToDelete: Number(row.shares),
    revealsToDelete: Number(row.reveals),
  }));
}

/** Every active member of a conversation that loses a message, a thread or a link: their inbox is read again afterwards. */
async function affectedMembers(trx: Transaction<Database>): Promise<{ accountId: string; universeId: string }[]> {
  const rows = await sql<{ accountId: string; universeId: string }>`
    select distinct member.account_id as "accountId", universe.id as "universeId"
    from social.conversation_members member
    join identity.accounts account on account.id = member.account_id and account.status = 'active'
    join identity.universes universe on universe.account_id = member.account_id
    where ${inRemovedThread('member.conversation_id')}
      or exists (select 1 from social.messages t where t.conversation_id = member.conversation_id and ${tombstoned('t')})`.execute(
    trx,
  );
  return [...rows.rows];
}

/** Social's part of the cleanup. */
export const socialOldScrollRemoval: OldScrollRemoval = {
  module: 'social',
  async count(trx): Promise<ModuleRemovalReport> {
    await prepareThreads(trx);
    return { tables: await countSteps(trx, socialSteps()), detail: { conversations: await describe(trx) } };
  },
  async run(trx): Promise<ModuleRemovalReport> {
    await prepareThreads(trx);
    const detail = { conversations: await describe(trx) };
    const members = await affectedMembers(trx);
    const tables: RemovalCount[] = await runSteps(trx, socialSteps());
    await bumpInboxHeads(trx, members, uuidv7);
    return { tables, detail };
  },
};
