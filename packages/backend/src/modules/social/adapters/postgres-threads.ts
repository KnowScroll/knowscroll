import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { PublicPersonRefSchema, type PublicPersonRef } from '@knowscroll/contracts';
import { BlockStateSnapshot } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  enterSharedRoot,
  sharedTransactionOf,
  transactionOf,
} from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { StoredSnippetAnchor } from '../../content/public.js';
import { releaseInvitees } from './invitee-links.js';
import { selectLastMessages } from './postgres-conversations.js';
import type {
  FriendStanding,
  LoadedThread,
  ThreadInboxRow,
  ThreadLock,
  ThreadMember,
  ThreadRow,
  ThreadStore,
} from '../application/thread-ports.js';

/** The thread a command lands on, derived from the starter and the command so a retry finds it again. */
export function threadIdFor(accountId: string, commandId: string): string {
  const bytes = createHash('sha256')
    .update(`social.thread.v1\0${accountId.toLowerCase()}\0${commandId.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const trxOf = (reader: ThreadLock | PersonalScopeTx): Transaction<Database> =>
  'shared' in reader ? sharedTransactionOf(reader.shared) : transactionOf(reader);

/**
 * Whether a member's place still stands: the account and its universe are active and, when a friend's
 * invitation carried the member in, the friendship between the two still has the lineage recorded
 * then (Remove, Block and a new friendship all change it). Written against alias `member`.
 */
const memberStands = sql<boolean>`(
  account.status = 'active' and universe.status = 'active' and (
    member.invited_by_account_id is null or exists (
      select 1 from social.pairs pair
      where pair.low_account_id = least(member.account_id, member.invited_by_account_id)
        and pair.high_account_id = greatest(member.account_id, member.invited_by_account_id)
        and pair.accepted_lineage = member.invited_lineage
    )
  )
)`;

interface MemberColumns {
  account_id: string;
  universe_id: string;
  membership_id: string;
  membership_revision: string;
  pending: boolean;
  left_at: Date | null;
  stands: boolean;
  read_through_sequence: string;
  muted: boolean;
  invited_by_account_id: string | null;
  person_id: string;
  handle: string;
  display_name: string;
}

const personOf = (row: Pick<MemberColumns, 'person_id' | 'handle' | 'display_name'>): PublicPersonRef =>
  PublicPersonRefSchema.parse({
    kind: 'person',
    personId: row.person_id,
    handle: row.handle,
    displayName: row.display_name,
  });

const memberOf = (row: MemberColumns): ThreadMember => ({
  accountId: row.account_id,
  universeId: row.universe_id,
  person: personOf(row),
  membershipId: row.membership_id,
  membershipRevision: Number(row.membership_revision),
  pending: row.pending,
  left: row.left_at !== null,
  stands: row.stands,
  readThroughSequence: Number(row.read_through_sequence),
  muted: row.muted,
  inviterAccountId: row.invited_by_account_id,
});

/** The member rows of the given threads with profile, universe and standing; every column is read, none decides access. */
function selectMembers(trx: Transaction<Database>, threadIds: readonly string[]) {
  return sql<MemberColumns & { conversation_id: string }>`
    select member.conversation_id, member.account_id, universe.id as universe_id, member.membership_id,
      member.membership_revision, member.pending, member.left_at, ${memberStands} as stands,
      member.read_through_sequence, member.muted, member.invited_by_account_id,
      profile.person_id, profile.handle, profile.display_name
    from social.conversation_members member
    join social.profiles profile on profile.account_id = member.account_id
    join identity.accounts account on account.id = member.account_id
    join identity.universes universe on universe.account_id = member.account_id
    where member.conversation_id = any(${threadIds}::uuid[])
    order by member.conversation_id, member.account_id`.execute(trx);
}

interface ThreadColumns {
  conversation_id: string;
  last_sequence: string;
  last_change_sequence: string;
  last_activity_at: Date | string;
  created_at: Date | string;
  name: string | null;
  root_asset_id: string;
  root_asset_revision: number;
  starter_account_id: string | null;
}

const threadOf = (row: ThreadColumns): ThreadRow => ({
  threadId: row.conversation_id,
  name: row.name,
  root: { assetId: row.root_asset_id, assetRevision: row.root_asset_revision },
  starterAccountId: row.starter_account_id,
  lastSequence: Number(row.last_sequence),
  lastChangeSequence: Number(row.last_change_sequence),
  lastActivityAt: new Date(row.last_activity_at),
  createdAt: new Date(row.created_at),
});

function selectThreads(trx: Transaction<Database>, threadIds: readonly string[]) {
  return trx
    .selectFrom('social.conversations as c')
    .innerJoin('social.content_threads as t', 't.thread_id', 'c.conversation_id')
    .select([
      'c.conversation_id',
      'c.last_sequence',
      'c.last_change_sequence',
      'c.last_activity_at',
      't.name',
      't.root_asset_id',
      't.root_asset_revision',
      't.starter_account_id',
      't.created_at',
    ])
    .where('c.conversation_id', 'in', [...threadIds])
    .where('c.kind', '=', 'thread')
    .execute();
}

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

/** Postgres thread rows (migration 0058). The use cases decide who may read or write; this only runs queries. */
export const threadStore: ThreadStore = {
  async isMember(scope, accountId, threadId) {
    const row = await transactionOf(scope)
      .selectFrom('social.conversation_members as m')
      .innerJoin('social.conversations as c', 'c.conversation_id', 'm.conversation_id')
      .select('m.account_id')
      .where('m.conversation_id', '=', threadId)
      .where('m.account_id', '=', accountId)
      .where('m.left_at', 'is', null)
      .where('c.kind', '=', 'thread')
      .executeTakeFirst();
    return row !== undefined;
  },

  async exists(scope, threadId) {
    const row = await transactionOf(scope)
      .selectFrom('social.conversations')
      .select('conversation_id')
      .where('conversation_id', '=', threadId)
      .where('kind', '=', 'thread')
      .executeTakeFirst();
    return row !== undefined;
  },

  async lock(scope, threadId, mode) {
    const shared = await enterSharedRoot(scope, {
      kind: 'social_thread',
      id: threadId,
      lock: async (trx) => {
        if (typeof mode === 'object')
          await trx
            .insertInto('social.conversations')
            .values({
              conversation_id: threadId,
              kind: 'thread',
              pair_id: null,
              lineage: threadId,
              last_activity_at: mode.create,
              created_at: mode.create,
            })
            .onConflict((conflict) => conflict.doNothing())
            .execute();
        const row = trx
          .selectFrom('social.conversations')
          .select('conversation_id')
          .where('conversation_id', '=', threadId)
          .where('kind', '=', 'thread');
        const locked = await (mode === 'read' ? row.forShare() : row.forUpdate()).executeTakeFirst();
        return locked !== undefined;
      },
    });
    return shared === undefined ? undefined : { shared, threadId };
  },

  async load(lock, ownAccountId): Promise<LoadedThread | undefined> {
    const trx = sharedTransactionOf(lock.shared);
    const [thread] = await selectThreads(trx, [lock.threadId]);
    if (thread === undefined) return undefined;
    const members = (await selectMembers(trx, [lock.threadId])).rows.map(memberOf);
    const own = members.find((member) => member.accountId === ownAccountId);
    return own === undefined ? undefined : { thread: threadOf(thread), own, members };
  },

  async create(lock, thread) {
    const trx = sharedTransactionOf(lock.shared);
    await trx
      .insertInto('social.content_threads')
      .values({
        thread_id: thread.threadId,
        starter_account_id: thread.starter.accountId,
        root_asset_id: thread.root.assetId,
        root_asset_revision: thread.root.assetRevision,
        name: thread.name ?? null,
        created_at: thread.now,
      })
      .execute();
    await trx
      .insertInto('social.conversation_members')
      .values([
        {
          conversation_id: thread.threadId,
          account_id: thread.starter.accountId,
          membership_id: thread.starter.membershipId,
        },
        ...thread.invited.map((invited) => ({
          conversation_id: thread.threadId,
          account_id: invited.accountId,
          membership_id: invited.membershipId,
          pending: true,
          invited_by_account_id: thread.starter.accountId,
          invited_lineage: invited.lineage,
        })),
      ])
      .execute();
  },

  async respond(lock, accountId, response, now) {
    await sharedTransactionOf(lock.shared)
      .updateTable('social.conversation_members')
      .set(response === 'join' ? { pending: false } : { pending: false, left_at: now })
      .where('conversation_id', '=', lock.threadId)
      .where('account_id', '=', accountId)
      .execute();
  },

  async leave(lock, accountId, now) {
    const trx = sharedTransactionOf(lock.shared);
    await trx
      .updateTable('social.conversation_members')
      .set({ left_at: now })
      .where('conversation_id', '=', lock.threadId)
      .where('account_id', '=', accountId)
      .execute();
    // Whoever this person invited now stands on their own membership, unless their place had already ended.
    await releaseInvitees(trx, accountId, now, lock.threadId);
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
    await sharedTransactionOf(lock.shared).insertInto('social.message_snippets').values(values).execute();
  },

  async snippetsOf(reader, messageIds) {
    if (messageIds.length === 0) return new Map();
    const rows = await trxOf(reader)
      .selectFrom('social.message_snippets')
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

  async snippetOfMessage(lock, messageId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('social.messages as m')
      .innerJoin('social.message_snippets as s', 's.message_id', 'm.message_id')
      .selectAll('s')
      .select(['m.asset_id', 'm.asset_revision'])
      .where('m.conversation_id', '=', lock.threadId)
      .where('m.message_id', '=', messageId)
      .executeTakeFirst();
    const anchor = row === undefined ? undefined : snippetOf(row);
    if (row === undefined || row.asset_id === null || row.asset_revision === null || anchor === undefined)
      return undefined;
    return { target: { assetId: row.asset_id, assetRevision: row.asset_revision }, anchor };
  },

  async inbox(scope, accountId, limit): Promise<readonly ThreadInboxRow[]> {
    const trx = transactionOf(scope);
    const listed = await sql<{ conversation_id: string }>`
      select member.conversation_id
      from social.conversation_members member
      join social.conversations conversation on conversation.conversation_id = member.conversation_id
      join social.content_threads thread on thread.thread_id = member.conversation_id
      join identity.accounts account on account.id = member.account_id
      join identity.universes universe on universe.account_id = member.account_id
      where member.account_id = ${accountId}::uuid and member.left_at is null
        and conversation.kind = 'thread' and ${memberStands}
      -- An invitation is ordered by when the thread began: when the others last talked is not theirs to see yet.
      order by case when member.pending then thread.created_at else conversation.last_activity_at end desc,
        conversation.conversation_id asc
      limit ${limit}`.execute(trx);
    const threadIds = listed.rows.map((row) => row.conversation_id);
    if (threadIds.length === 0) return [];
    const threads = new Map((await selectThreads(trx, threadIds)).map((row) => [row.conversation_id, threadOf(row)]));
    const byThread = new Map<string, ThreadMember[]>();
    for (const row of (await selectMembers(trx, threadIds)).rows) {
      byThread.set(row.conversation_id, [...(byThread.get(row.conversation_id) ?? []), memberOf(row)]);
    }
    const rows = threadIds.flatMap((threadId): Omit<ThreadInboxRow, 'lastMessage'>[] => {
      const thread = threads.get(threadId);
      const members = byThread.get(threadId) ?? [];
      const own = members.find((member) => member.accountId === accountId);
      if (thread === undefined || own === undefined) return [];
      const people = members.filter((member) => !member.left && member.stands).map((member) => member.person);
      const inviter = members.find((member) => member.accountId === own.inviterAccountId)?.person;
      return [{ thread, own, people, inviter }];
    });
    // A pending invitation shows no message: reading starts when the person joins.
    const readable = rows
      .filter((row) => row.thread.lastSequence > 0 && !row.own.pending)
      .map((row) => ({ conversation_id: row.thread.threadId, last_sequence: String(row.thread.lastSequence) }));
    const lastMessages = await selectLastMessages(trx, readable);
    return rows.map((row) => ({ ...row, lastMessage: lastMessages.get(row.thread.threadId) }));
  },

  async friends(scope, ownAccountId, personIds): Promise<readonly FriendStanding[]> {
    if (personIds.length === 0) return [];
    const rows = await sql<{
      person_id: string;
      account_id: string;
      universe_id: string;
      lineage: string | null;
      active: boolean;
    }>`
      select profile.person_id, profile.account_id, universe.id as universe_id, pair.accepted_lineage as lineage,
        (account.status = 'active' and universe.status = 'active') as active
      from social.profiles profile
      join identity.accounts account on account.id = profile.account_id
      join identity.universes universe on universe.account_id = profile.account_id
      left join social.pairs pair
        on pair.low_account_id = least(profile.account_id, ${ownAccountId}::uuid)
       and pair.high_account_id = greatest(profile.account_id, ${ownAccountId}::uuid)
      where profile.person_id = any(${personIds}::uuid[]) and profile.account_id <> ${ownAccountId}::uuid`.execute(
      transactionOf(scope),
    );
    return rows.rows.map((row) => ({
      personId: row.person_id,
      accountId: row.account_id,
      universeId: row.universe_id,
      lineage: row.lineage,
      accountActive: row.active,
    }));
  },
};
