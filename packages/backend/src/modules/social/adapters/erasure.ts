import { sql } from 'kysely';
import { exportReading, type ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { bumpInboxHeads } from './inbox-heads.js';

/**
 * Every Social store is keyed by account, not universe, and each has an explicit answer for the
 * two erasures. `clear` is selective Clear (exploration history): it keeps everything here,
 * because friendships, conversations and links are explicit communication, not exploration
 * evidence. `onAccountErasure` is what deleting the account does (D-043). The profile and the
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
  'social.conversations': { clear: 'preserve', onAccountErasure: 'closed and kept for the other person' },
  'social.conversation_members': { clear: 'preserve', onAccountErasure: 'the account membership is removed' },
  'social.messages': { clear: 'preserve', onAccountErasure: 'the account authored messages become tombstones' },
  'social.inbox_heads': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.content_shares': { clear: 'preserve', onAccountErasure: 'delete with the account' },
} as const;

/** Account-lifetime inventory. Exploration Clear retains profile, friendships, conversations and links. */
export const socialErasure: ModuleErasure = {
  module: 'social',
  tables: [],
  nonRowStores: [],
  accountTables: [
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
    { schema: 'social', table: 'inbox_heads', ownerColumn: 'account_id' },
    { schema: 'social', table: 'content_shares', ownerColumn: 'owner_account_id' },
  ],
  accountColumns: [
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
    { schema: 'social', table: 'messages', column: 'author_account_id' },
    { schema: 'social', table: 'inbox_heads', column: 'account_id' },
    { schema: 'social', table: 'content_shares', column: 'owner_account_id' },
  ],
  erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),

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
    let removed = 0;

    removed += Number(
      (await sql`delete from social.content_shares where owner_account_id = ${account}::uuid`.execute(trx))
        .numAffectedRows ?? 0,
    );
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
        asset_id = null, asset_revision = null, note = null,
        change_sequence = bumped.top - bumped.total + mine.position
      from mine join bumped on bumped.conversation_id = mine.conversation_id
      where m.conversation_id = mine.conversation_id and m.sequence = mine.sequence`.execute(trx);
    removed += Number(tombstoned.numAffectedRows ?? 0);
    const others = await sql<{ account_id: string; universe_id: string }>`
      select distinct other.account_id, universe.id as universe_id
      from social.conversation_members own
      join social.conversation_members other
        on other.conversation_id = own.conversation_id and other.account_id <> own.account_id
      join identity.universes universe on universe.account_id = other.account_id
      where own.account_id = ${account}::uuid`.execute(trx);
    await trx
      .updateTable('social.conversations')
      .set({ closed_at: now })
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

  /** Clearing exploration history keeps profiles, friendships, invites, conversations and links. */
  clearExploration: {
    dispositions: Object.fromEntries(
      Object.entries(socialStoreLifecycle).map(([store, lifecycle]) => [store, lifecycle.clear]),
    ),
    erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),
  },
};

/** The most messages one export file carries; the file says how many there are and whether it was cut. */
const EXPORT_MESSAGE_LIMIT = 2000;

/**
 * The person's own sharing profile and invitation, how many people they are connected to, what they
 * wrote in conversations (their own words only, newest first) and the links they made. Other
 * people's names, handles, IDs and messages are never in the file: a friend list and a friend's
 * words are theirs to export.
 */
socialErasure.export = exportReading(
  socialErasure,
  [
    'social.profiles',
    'social.roster_entries',
    'social.invites',
    'social.conversations',
    'social.conversation_members',
    'social.messages',
    'social.content_shares',
  ],
  'Pair and request records are shared with the other person; roster heads, inbox heads and command bindings are internal bookkeeping.',
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
      .selectFrom('social.messages')
      .select(['recorded_at', 'body_text', 'asset_id', 'note'])
      .where('author_account_id', '=', person.accountId)
      .orderBy('recorded_at', 'desc')
      .orderBy('sequence', 'desc')
      .limit(EXPORT_MESSAGE_LIMIT)
      .execute();
    const written = await trx
      .selectFrom('social.messages')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('author_account_id', '=', person.accountId)
      .executeTakeFirstOrThrow();
    const conversations = await trx
      .selectFrom('social.conversation_members')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('account_id', '=', person.accountId)
      .executeTakeFirstOrThrow();
    const links = await trx
      .selectFrom('social.content_shares')
      .select(['created_at', 'expires_at', 'revoked_at', 'conversation_id'])
      .where('owner_account_id', '=', person.accountId)
      .orderBy('created_at', 'desc')
      .limit(500)
      .execute();
    return {
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
        count: Number(conversations.n),
        messagesWritten: Number(written.n),
        truncated: Number(written.n) > messages.length,
        yourMessages: messages.map((message) =>
          message.body_text === null
            ? {
                sentAt: message.recorded_at.toISOString(),
                shared: 'a Reel or Scroll',
                ...(message.note === null ? {} : { note: message.note }),
              }
            : { sentAt: message.recorded_at.toISOString(), text: message.body_text },
        ),
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
