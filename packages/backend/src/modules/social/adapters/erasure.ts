import { sql, type Transaction } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportReading, type ModuleErasure, type ModuleExport } from '../../../infrastructure/erasure/registry.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { bumpInboxHeads } from './inbox-heads.js';
import { releaseInvitees } from './invitee-links.js';
import {
  eraseVisibilityAccountRows,
  eraseVisitRows,
  exportVisibility,
  visibilityAccountColumns,
  visibilityAccountTables,
  visibilityLifecycle,
  visitTables,
} from './visibility-erasure.js';

/**
 * Every Social store is keyed by account, not universe, and each has an explicit answer for the
 * two erasures. `clear` is selective Clear (exploration history): it keeps everything here,
 * because friendships, conversations and links are explicit communication, not exploration
 * evidence. The exceptions are a party place (D-065), which says where the person is in a series, and a pick on a
 * thread's call (D-156), which is a play result (D-082): both are drawn from their own exploring, so Clear deletes
 * them. `onAccountErasure` is what deleting the account does (D-043). The profile and the
 * friendship rows go with the account, silently. Conversations are never deleted for the other
 * person: the author's messages become tombstones, their membership is removed and the
 * conversation closes, and the person who remains reads the history with "Deleted account" in
 * their place. Managed links are deleted.
 */
export const socialStoreLifecycle = {
  'social.profiles': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.pairs': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.pair_sides': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.requests': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.command_bindings': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.roster_entries': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.roster_heads': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.invites': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.conversations': {
    clear: 'preserve',
    onAccountErasure: 'a direct conversation is closed and kept for the other person; a thread goes on for the others',
  },
  'social.conversation_members': {
    clear: 'preserve',
    onAccountErasure: 'the account membership is removed; invitations it made no longer depend on it',
  },
  'social.messages': {
    clear: 'preserve',
    onAccountErasure: 'the account authored messages become tombstones, with no reply pointer',
  },
  'social.message_reactions': {
    clear: 'preserve',
    onAccountErasure: 'the account reactions, and every reaction on its tombstoned messages, are deleted',
  },
  'social.content_threads': {
    clear: 'preserve',
    onAccountErasure: 'the starter link is cleared; the thread stays for the others',
  },
  'social.message_snippets': {
    clear: 'preserve',
    onAccountErasure: 'deleted with the author tombstoned message',
  },
  'social.inbox_heads': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.content_shares': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.thread_places': { clear: 'erase', onAccountErasure: 'delete with the account' },
  'social.thread_calls': { clear: 'erase', onAccountErasure: 'delete with the account' },
  'social.thread_call_reveals': { clear: 'preserve', onAccountErasure: 'kept with the thread: no person, no pick' },
  ...visibilityLifecycle,
} as const;

/** Account-lifetime inventory. Exploration Clear retains profile, friendships, conversations and links. */
export const socialErasure = declareErasure({
  module: 'social',
  // The published copy of a universe (D-047); everything else here is keyed by account.
  tables: visitTables.map((table) => ({ schema: 'social', table, ownerColumn: 'universe_id' as const })),
  nonRowStores: [],
  accountTables: [
    ...visibilityAccountTables,
    { schema: 'social', table: 'roster_heads', ownerColumn: 'owner_account_id' },
    { schema: 'social', table: 'roster_entries', ownerColumn: 'owner_account_id,peer_account_id' },
    { schema: 'social', table: 'invites', ownerColumn: 'account_id' },
    { schema: 'social', table: 'profiles', ownerColumn: 'account_id' },
    { schema: 'social', table: 'pairs', ownerColumn: 'low_account_id,high_account_id' },
    { schema: 'social', table: 'pair_sides', ownerColumn: 'account_id' },
    { schema: 'social', table: 'requests', ownerColumn: 'sender_account_id,recipient_account_id' },
    { schema: 'social', table: 'command_bindings', ownerColumn: 'actor_account_id' },
    { schema: 'social', table: 'conversations', ownerColumn: 'pair_id' },
    { schema: 'social', table: 'conversation_members', ownerColumn: 'account_id' },
    { schema: 'social', table: 'messages', ownerColumn: 'author_account_id' },
    { schema: 'social', table: 'message_reactions', ownerColumn: 'account_id' },
    { schema: 'social', table: 'content_threads', ownerColumn: 'starter_account_id' },
    { schema: 'social', table: 'message_snippets', ownerColumn: 'message_id' },
    { schema: 'social', table: 'inbox_heads', ownerColumn: 'account_id' },
    { schema: 'social', table: 'content_shares', ownerColumn: 'owner_account_id' },
    { schema: 'social', table: 'thread_places', ownerColumn: 'account_id' },
    { schema: 'social', table: 'thread_calls', ownerColumn: 'account_id' },
    { schema: 'social', table: 'thread_call_reveals', ownerColumn: 'thread_id' },
  ],
  accountColumns: [
    ...visibilityAccountColumns,
    { schema: 'social', table: 'roster_heads', column: 'owner_account_id' },
    { schema: 'social', table: 'roster_entries', column: 'owner_account_id' },
    { schema: 'social', table: 'roster_entries', column: 'peer_account_id' },
    { schema: 'social', table: 'roster_entries', column: 'peer_person_id' },
    { schema: 'social', table: 'invites', column: 'account_id' },
    { schema: 'social', table: 'profiles', column: 'account_id' },
    { schema: 'social', table: 'profiles', column: 'person_id' },
    { schema: 'social', table: 'pairs', column: 'low_account_id' },
    { schema: 'social', table: 'pairs', column: 'high_account_id' },
    { schema: 'social', table: 'pair_sides', column: 'account_id' },
    { schema: 'social', table: 'requests', column: 'sender_account_id' },
    { schema: 'social', table: 'requests', column: 'recipient_account_id' },
    { schema: 'social', table: 'command_bindings', column: 'actor_account_id' },
    { schema: 'social', table: 'conversation_members', column: 'account_id' },
    { schema: 'social', table: 'conversation_members', column: 'invited_by_account_id' },
    { schema: 'social', table: 'content_threads', column: 'starter_account_id' },
    { schema: 'social', table: 'messages', column: 'author_account_id' },
    { schema: 'social', table: 'message_reactions', column: 'account_id' },
    { schema: 'social', table: 'inbox_heads', column: 'account_id' },
    { schema: 'social', table: 'content_shares', column: 'owner_account_id' },
    { schema: 'social', table: 'thread_places', column: 'account_id' },
    { schema: 'social', table: 'thread_calls', column: 'account_id' },
  ],
  /** Full erasure of one universe removes its published copy; conversations and friendships are account-keyed. */
  async erase(scope) {
    const removed = await eraseVisitRows(transactionOf(scope), scope.authority.universeId);
    return { module: 'social', status: 'completed', removed };
  },

  /**
   * Account deletion, after every universe eraser (D-043). Conversations first, then friendships.
   *
   * Conversations and links: the account's links are deleted. Each message it wrote becomes a
   * tombstone (no author, body, card or note; same place and number) with a fresh change number,
   * so the other person's catch-up replaces the bubble. Every conversation it was in closes, its
   * membership and inbox head go, and the other person's inbox is announced. The other person keeps
   * the history and reads "Deleted account" where this person was. Only rows keyed by this
   * account, and the conversation rows' atomic counters, are touched: no pair lock is needed, so it
   * is safe beside a concurrent send.
   *
   * Friendships: the profile, invite and every pair, request and roster entry naming the account
   * are deleted; the other person's list simply loses the entry, with no placeholder (nothing else
   * in Social outlives the friendship). Each affected list head is bumped in the heads' own lock
   * order. The pair rows going releases the conversations' `pair_id` (set to null).
   *
   * Idempotent: a second run finds nothing to change.
   */
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const account = scope.accountId;
    const now = new Date();
    let removed = await eraseVisibilityAccountRows(trx, account);

    await lockThreadsOf(trx, account);
    removed += Number(
      (await sql`delete from social.content_shares where owner_account_id = ${account}::uuid`.execute(trx))
        .numAffectedRows ?? 0,
    );
    removed += Number(
      (
        await sql`delete from social.message_snippets where message_id in (
          select message_id from social.messages where author_account_id = ${account}::uuid)`.execute(trx)
      ).numAffectedRows ?? 0,
    );
    removed += await eraseReactions(trx, account);
    // Before the membership rows go: a place and a pick follow their member's row.
    removed += await erasePlaces(trx, account);
    removed += await erasePicks(trx, account);
    const tombstoned = await sql`
      with mine as (
        select conversation_id, sequence,
          row_number() over (partition by conversation_id order by sequence) as position,
          count(*) over (partition by conversation_id) as total
        from social.messages where author_account_id = ${account}::uuid
      ), bumped as (
        update social.conversations c set last_change_sequence = c.last_change_sequence + t.total
        from (select conversation_id, max(total) as total from mine group by conversation_id) t
        where c.conversation_id = t.conversation_id
        returning c.conversation_id, c.last_change_sequence as top, t.total
      )
      update social.messages m set author_account_id = null, command_id = null, body_text = null,
        asset_id = null, asset_revision = null, note = null, reply_to_sequence = null, challenge_stop = null,
        change_sequence = bumped.top - bumped.total + mine.position
      from mine join bumped on bumped.conversation_id = mine.conversation_id
      where m.conversation_id = mine.conversation_id and m.sequence = mine.sequence`.execute(trx);
    removed += Number(tombstoned.numAffectedRows ?? 0);
    const others = await sql<{ account_id: string; universe_id: string }>`
      select distinct other.account_id, universe.id as universe_id
      from social.conversation_members own
      join social.conversation_members other
        on other.conversation_id = own.conversation_id and other.account_id <> own.account_id
      join identity.accounts account on account.id = other.account_id and account.status = 'active'
      join identity.universes universe on universe.account_id = other.account_id
      where own.account_id = ${account}::uuid`.execute(trx);
    removed += await releaseThreadLinks(trx, account, now);
    // A direct conversation closes with its person; a thread goes on for the others.
    await trx
      .updateTable('social.conversations')
      .set({ closed_at: now })
      .where('kind', '=', 'direct')
      .where('closed_at', 'is', null)
      .where(
        'conversation_id',
        'in',
        trx.selectFrom('social.conversation_members').select('conversation_id').where('account_id', '=', account),
      )
      .execute();
    removed += Number(
      (await sql`delete from social.conversation_members where account_id = ${account}::uuid`.execute(trx))
        .numAffectedRows ?? 0,
    );
    removed += Number(
      (await sql`delete from social.inbox_heads where account_id = ${account}::uuid`.execute(trx)).numAffectedRows ?? 0,
    );
    await bumpInboxHeads(
      trx,
      others.rows.map((row) => ({ accountId: row.account_id, universeId: row.universe_id })),
      uuidv7,
    );

    // Other people's lists change: bump each affected head (owner, then kind, the heads' own lock order).
    const affected = await sql<{ owner: string; kind: string }>`
      select distinct owner_account_id as owner, kind from social.roster_entries
      where peer_account_id = ${account}::uuid order by owner_account_id, kind`.execute(trx);
    for (const head of affected.rows)
      await sql`select social.bump_roster_head(${head.owner}::uuid, ${head.kind})`.execute(trx);
    const pairs = sql`(select pair_id from social.pairs
      where low_account_id = ${account}::uuid or high_account_id = ${account}::uuid)`;
    const statements = [
      sql`delete from social.roster_entries where owner_account_id = ${account}::uuid or peer_account_id = ${account}::uuid`,
      sql`delete from social.roster_heads where owner_account_id = ${account}::uuid`,
      sql`delete from social.invites where account_id = ${account}::uuid`,
      sql`delete from social.command_bindings where pair_id in ${pairs}`,
      sql`delete from social.pair_sides where pair_id in ${pairs}`,
      // Pairs and requests reference each other with RESTRICT: let the pair let go first.
      sql`update social.pairs set current_request_id = null, accepted_lineage = null
        where low_account_id = ${account}::uuid or high_account_id = ${account}::uuid`,
      sql`delete from social.requests where pair_id in ${pairs}`,
      sql`delete from social.pairs where low_account_id = ${account}::uuid or high_account_id = ${account}::uuid`,
      sql`delete from social.profiles where account_id = ${account}::uuid`,
    ];
    for (const statement of statements) removed += Number((await statement.execute(trx)).numAffectedRows ?? 0);
    return { module: 'social', status: 'completed', removed };
  },

  /**
   * Clearing exploration history keeps profiles, friendships, invites, conversations, links and the
   * person's sharing choices (including "hide where I am", a choice and not history), and removes the
   * published copy of their universe: friends who visit afterwards see an empty one. It also deletes
   * where the person was in each thread's series, which came from their exploring (D-065).
   */
  clear: {
    dispositions: Object.fromEntries(
      Object.entries(socialStoreLifecycle).map(([store, lifecycle]) => [store, lifecycle.clear]),
    ),
    async erase(scope) {
      const trx = clearCoreTransactionOf(scope);
      const removed =
        (await eraseVisitRows(trx, scope.binding.universeId)) +
        (await erasePlaces(trx, scope.binding.accountId)) +
        (await erasePicks(trx, scope.binding.accountId));
      return { module: 'social', status: 'completed', removed };
    },
  },
  export: (declaration) => exportSocial(declaration),
});

/** Deletes every party place the account has, in every thread. Idempotent; returns how many rows went. */
async function erasePlaces(trx: Transaction<Database>, accountId: string): Promise<number> {
  const result = await sql`delete from social.thread_places where account_id = ${accountId}::uuid`.execute(trx);
  return Number(result.numAffectedRows ?? 0);
}

/** Deletes every pick the account made on a thread's call, in every thread. Idempotent; returns how many rows went. */
async function erasePicks(trx: Transaction<Database>, accountId: string): Promise<number> {
  const result = await sql`delete from social.thread_calls where account_id = ${accountId}::uuid`.execute(trx);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * Takes the row of every thread the account is in, in id order, before anything else of theirs is
 * touched. A send in flight holds its thread's row and then the members' inbox heads; waiting here
 * first means deleting the account never holds a head while it waits for such a send.
 */
async function lockThreadsOf(trx: Transaction<Database>, account: string): Promise<void> {
  await sql`select conversation_id from social.conversations
    where kind = 'thread' and conversation_id in (
      select conversation_id from social.conversation_members where account_id = ${account}::uuid)
    order by conversation_id for update`.execute(trx);
}

/**
 * The account's reactions and every reaction on its own messages (those messages become tombstones next,
 * and a tombstone shows nothing). Each message of someone else that loses a reaction gets the
 * conversation's next change number, in one statement like the tombstones below, so the other person's
 * catch-up replaces it and the count drops. Returns how many rows went.
 */
async function eraseReactions(trx: Transaction<Database>, account: string): Promise<number> {
  await sql`
    with touched as (
      select distinct reaction.conversation_id, reaction.message_sequence as sequence
      from social.message_reactions reaction
      join social.messages message
        on message.conversation_id = reaction.conversation_id and message.sequence = reaction.message_sequence
      where reaction.account_id = ${account}::uuid and message.author_account_id is distinct from ${account}::uuid
    ), numbered as (
      select conversation_id, sequence,
        row_number() over (partition by conversation_id order by sequence) as position,
        count(*) over (partition by conversation_id) as total
      from touched
    ), bumped as (
      update social.conversations c set last_change_sequence = c.last_change_sequence + t.total
      from (select conversation_id, max(total) as total from numbered group by conversation_id) t
      where c.conversation_id = t.conversation_id
      returning c.conversation_id, c.last_change_sequence as top, t.total
    )
    update social.messages m set change_sequence = bumped.top - bumped.total + numbered.position
    from numbered join bumped on bumped.conversation_id = numbered.conversation_id
    where m.conversation_id = numbered.conversation_id and m.sequence = numbered.sequence`.execute(trx);
  const onOwnMessages = await sql`
    delete from social.message_reactions reaction using social.messages message
    where message.conversation_id = reaction.conversation_id and message.sequence = reaction.message_sequence
      and message.author_account_id = ${account}::uuid`.execute(trx);
  const own = await sql`delete from social.message_reactions where account_id = ${account}::uuid`.execute(trx);
  return Number(onOwnMessages.numAffectedRows ?? 0) + Number(own.numAffectedRows ?? 0);
}

/**
 * The links other rows hold to this account: it stops being the starter of threads, and the people it
 * invited stand on their own membership from now on (see `releaseInvitees`). Returns how many rows changed.
 */
async function releaseThreadLinks(trx: Transaction<Database>, account: string, now: Date): Promise<number> {
  const starters = await sql`update social.content_threads set starter_account_id = null
    where starter_account_id = ${account}::uuid`.execute(trx);
  return Number(starters.numAffectedRows ?? 0) + (await releaseInvitees(trx, account, now));
}

const SHARED_WORDS: Readonly<Record<string, string>> = {
  reel_range: 'a moment of a Reel',
  scroll_passage: 'a passage of a Scroll',
  scroll_block: 'a part of a Scroll',
};

/** What a card message shared, in words for the export. */
const sharedWords = (snippetKind: string | null): string =>
  (snippetKind === null ? undefined : SHARED_WORDS[snippetKind]) ?? 'a Reel or Scroll';

/** The most messages one export file carries; the file says how many there are and whether it was cut. */
const EXPORT_MESSAGE_LIMIT = 2000;

/**
 * The person's own sharing profile and invitation, how many people they are connected to, what they
 * wrote in conversations (their own words only, newest first) and the links they made. Other
 * people's names, handles, IDs and messages are never in the file: a friend list and a friend's
 * words are theirs to export.
 */
interface PickExportRow {
  readonly name: string | null;
  /** `direct` for a challenge a friend was sent (D-245), `thread` for a call of a thread. */
  readonly kind: string;
  readonly asset_id: string;
  readonly option: number;
  readonly day: string;
  readonly stop: { readonly prompt?: string; readonly options?: readonly string[] } | null;
}

function exportSocial(declaration: ModuleErasure): ModuleExport {
  return exportReading(
    declaration,
    [
      'social.profiles',
      'social.roster_entries',
      'social.invites',
      'social.conversations',
      'social.conversation_members',
      'social.messages',
      'social.message_reactions',
      'social.content_threads',
      'social.message_snippets',
      'social.thread_places',
      'social.thread_calls',
      'social.content_shares',
      'social.visibility_settings',
      'social.visibility_audience',
      'social.visit_systems',
    ],
    'Pair and request records are shared with the other person; roster heads, inbox heads and command bindings are internal bookkeeping; the heartbeat time is a signal that lapses within minutes and is never exported; thread call reveals are thread state that name no person and hold no pick; visit planets and the publication header are copies of places the universe section already lists.',
    async (scope, person) => {
      const trx = transactionOf(scope);
      const profile = await trx
        .selectFrom('social.profiles')
        .select(['handle', 'display_name'])
        .where('account_id', '=', person.accountId)
        .executeTakeFirst();
      const counts = await trx
        .selectFrom('social.roster_entries')
        .select(['kind', (eb) => eb.fn.countAll<string>().as('n')])
        .where('owner_account_id', '=', person.accountId)
        .groupBy('kind')
        .execute();
      const countOf = (kind: string) => Number(counts.find((row) => row.kind === kind)?.n ?? 0);
      const invite = await trx
        .selectFrom('social.invites')
        .select(['created_at', 'expires_at', 'revoked'])
        .where('account_id', '=', person.accountId)
        .executeTakeFirst();
      const messages = await trx
        .selectFrom('social.messages as m')
        .leftJoin('social.message_snippets as s', 's.message_id', 'm.message_id')
        .select([
          'm.recorded_at',
          'm.body_text',
          'm.asset_id',
          'm.note',
          'm.reply_to_sequence',
          's.kind as snippet_kind',
        ])
        .where('m.author_account_id', '=', person.accountId)
        .orderBy('m.recorded_at', 'desc')
        .orderBy('m.sequence', 'desc')
        .limit(EXPORT_MESSAGE_LIMIT)
        .execute();
      const reactions = await trx
        .selectFrom('social.message_reactions as r')
        .innerJoin('social.messages as m', (join) =>
          join.onRef('m.conversation_id', '=', 'r.conversation_id').onRef('m.sequence', '=', 'r.message_sequence'),
        )
        .select(['r.kind', 'r.reacted_at', 'm.author_account_id'])
        .where('r.account_id', '=', person.accountId)
        .orderBy('r.reacted_at', 'desc')
        .limit(EXPORT_MESSAGE_LIMIT)
        .execute();
      const reactionsGiven = await trx
        .selectFrom('social.message_reactions')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('account_id', '=', person.accountId)
        .executeTakeFirstOrThrow();
      const started = await trx
        .selectFrom('social.content_threads')
        .select(['name', 'created_at'])
        .where('starter_account_id', '=', person.accountId)
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute();
      const written = await trx
        .selectFrom('social.messages')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('author_account_id', '=', person.accountId)
        .executeTakeFirstOrThrow();
      const memberships = await trx
        .selectFrom('social.conversation_members as m')
        .innerJoin('social.conversations as c', 'c.conversation_id', 'm.conversation_id')
        .select(['c.kind', (eb) => eb.fn.countAll<string>().as('n')])
        .where('m.account_id', '=', person.accountId)
        .groupBy('c.kind')
        .execute();
      const membershipsOf = (kind: string) => Number(memberships.find((row) => row.kind === kind)?.n ?? 0);
      const placesShown = await trx
        .selectFrom('social.thread_places as place')
        .innerJoin('social.content_threads as thread', 'thread.thread_id', 'place.thread_id')
        .select(['thread.name', 'place.part', 'place.state', sql<string>`to_char(place.day, 'YYYY-MM-DD')`.as('day')])
        .where('place.account_id', '=', person.accountId)
        .orderBy('place.day', 'desc')
        .limit(500)
        .execute();
      // Their own picks on a thread's call (D-156) or on a challenge a friend sent or answered (D-245), in words: where, the
      // question and the option they picked. Not whether it was right: nothing stores that, and the reveal is the card's to give.
      const picks = await sql<PickExportRow>`
        select thread.name, conversation.kind, pick.asset_id, pick.option, to_char(pick.day, 'YYYY-MM-DD') as day,
          jsonb_path_query_first(revision.document, '$.stops[*] ? (@.id == $stop)', jsonb_build_object('stop', pick.stop_id)) as stop
        from social.thread_calls pick
        join social.conversations conversation on conversation.conversation_id = pick.thread_id
        left join social.content_threads thread on thread.thread_id = pick.thread_id
        left join content.asset_revisions revision
          on revision.asset_id = pick.asset_id and revision.revision = pick.revision
        where pick.account_id = ${person.accountId}::uuid
        order by pick.day desc
        limit 500`.execute(trx);
      const reachable = await person.reach([...new Set(picks.rows.map((pick) => pick.asset_id))]);
      const hidingIn = await trx
        .selectFrom('social.conversation_members as m')
        .innerJoin('social.conversations as c', 'c.conversation_id', 'm.conversation_id')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('m.account_id', '=', person.accountId)
        .where('c.kind', '=', 'thread')
        .where('m.place_hidden', '=', true)
        .executeTakeFirstOrThrow();
      const links = await trx
        .selectFrom('social.content_shares')
        .select(['created_at', 'expires_at', 'revoked_at', 'conversation_id'])
        .where('owner_account_id', '=', person.accountId)
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute();
      return {
        sharing: await exportVisibility(trx, person.accountId, scope.authority.universeId),
        profile: profile === undefined ? null : { handle: profile.handle, displayName: profile.display_name },
        connections: {
          friends: countOf('friends'),
          requestsReceived: countOf('incoming'),
          requestsSent: countOf('outgoing'),
          blocked: countOf('blocked'),
        },
        invitation:
          invite === undefined
            ? null
            : {
                createdAt: invite.created_at.toISOString(),
                expiresAt: invite.expires_at.toISOString(),
                revoked: invite.revoked,
              },
        conversations: {
          count: membershipsOf('direct'),
          messagesWritten: Number(written.n),
          truncated: Number(written.n) > messages.length,
          yourMessages: messages.map((message) => ({
            sentAt: message.recorded_at.toISOString(),
            ...(message.body_text === null
              ? {
                  shared: sharedWords(message.snippet_kind),
                  ...(message.note === null ? {} : { note: message.note }),
                }
              : { text: message.body_text }),
            ...(message.reply_to_sequence === null ? {} : { wasAReply: true }),
          })),
          reactionsGiven: Number(reactionsGiven.n),
          reactionsTruncated: Number(reactionsGiven.n) > reactions.length,
          yourReactions: reactions.map((reaction) => ({
            reactedAt: reaction.reacted_at.toISOString(),
            kind: reaction.kind,
            on: reaction.author_account_id === person.accountId ? 'your own message' : 'a message from someone else',
          })),
        },
        threads: {
          count: membershipsOf('thread'),
          started: started.map((thread) => ({
            startedAt: thread.created_at.toISOString(),
            ...(thread.name === null ? {} : { name: thread.name }),
          })),
          // Where the person told a thread they were in its series (D-065): their own, and only a part, a state and a day.
          placesShown: placesShown.map((place) => ({
            ...(place.name === null ? {} : { thread: place.name }),
            part: place.part,
            state: place.state === 'finished' ? 'finished' : 'on',
            day: place.day,
          })),
          hidingWhereIAmIn: Number(hidingIn.n),
          // What they locked on a thread's "Call it together" (D-156): their own pick, in words, and the day.
          callsMade: picks.rows.map((pick) => ({
            ...(pick.kind === 'direct' ? { challengeFromConversation: true } : {}),
            ...(pick.name === null ? {} : { thread: pick.name }),
            ...(reachable.has(pick.asset_id) && pick.stop?.prompt !== undefined ? { question: pick.stop.prompt } : {}),
            ...(reachable.has(pick.asset_id) && pick.stop?.options?.[pick.option] !== undefined
              ? { picked: pick.stop.options[pick.option] }
              : {}),
            day: pick.day,
          })),
        },
        sharedLinks: links.map((link) => ({
          createdAt: link.created_at.toISOString(),
          expiresAt: link.expires_at.toISOString(),
          stopped: link.revoked_at !== null,
          audience: link.conversation_id === null ? 'anyone with the link' : 'one conversation',
        })),
      };
    },
  );
}
