import { sql } from 'kysely';
import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';

/**
 * Every Social store is keyed by account, not universe, and each has an explicit answer for the
 * two erasures. `clear` is selective Clear (exploration history): it keeps everything here,
 * because friendships, conversations and links are explicit communication, not exploration
 * evidence. `onAccountErasure` is what deleting the account does: the profile and the pair rows
 * go with the account; conversations are never deleted for the other person, so the author's
 * messages become tombstones, the person's membership ends and the conversation closes; managed
 * links are revoked.
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
  'social.conversations': { clear: 'preserve', onAccountErasure: 'closed; kept for the other person' },
  'social.conversation_members': { clear: 'preserve', onAccountErasure: 'membership ended' },
  'social.messages': { clear: 'preserve', onAccountErasure: 'authored messages become tombstones' },
  'social.inbox_heads': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.content_shares': { clear: 'preserve', onAccountErasure: 'revoked' },
} as const;

/** Account-lifetime inventory only. Exploration clear retains profile, friendships and conversations. */
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

  /**
   * Account erasure of conversations and links, inside the account's personal scope. It touches
   * only rows keyed by this account or the conversation rows' atomic counters, never the pair
   * lock, so it is safe beside a peer's concurrent send. Friendships, profiles and the pair rows
   * are removed by the account-deletion lifecycle, not here. Idempotent: a second run finds nothing.
   *
   * 1. Revokes every live link the account made.
   * 2. Turns each message the account wrote into a tombstone (no author, body, card or note;
   *    same place and number) and gives it a fresh change number, so the other person's
   *    catch-up replaces the bubble.
   * 3. Ends the account's memberships and closes those conversations: the other person keeps
   *    their history and can send nothing more.
   * Live hints are not sent; the other person's client picks the change up on its next catch-up.
   */
  async erase(scope) {
    const actor = scope.authority.actor;
    if (actor.kind !== 'account') return { module: 'social', status: 'completed', removed: 0 };
    const trx = transactionOf(scope);
    const accountId = actor.accountId;
    const now = new Date();
    const links = await trx
      .updateTable('social.content_shares')
      .set({ revoked_at: now })
      .where('owner_account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const tombstoned = await sql<{ conversation_id: string }>`
      with mine as (
        select conversation_id, sequence,
          row_number() over (partition by conversation_id order by sequence) as position,
          count(*) over (partition by conversation_id) as total
        from social.messages where author_account_id = ${accountId}
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
      where m.conversation_id = mine.conversation_id and m.sequence = mine.sequence
      returning m.conversation_id`.execute(trx);
    const left = await trx
      .updateTable('social.conversation_members')
      .set({ left_at: now })
      .where('account_id', '=', accountId)
      .where('left_at', 'is', null)
      .returning('conversation_id')
      .execute();
    if (left.length > 0)
      await trx
        .updateTable('social.conversations')
        .set({ closed_at: now })
        .where('closed_at', 'is', null)
        .where(
          'conversation_id',
          'in',
          left.map((row) => row.conversation_id),
        )
        .execute();
    return {
      module: 'social',
      status: 'completed',
      removed: Number(links.numUpdatedRows) + tombstoned.rows.length + left.length,
    };
  },

  /** Clearing exploration history keeps profiles, friendships, invites, conversations and links. */
  clearExploration: {
    dispositions: Object.fromEntries(
      Object.entries(socialStoreLifecycle).map(([store, lifecycle]) => [store, lifecycle.clear]),
    ),
    erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),
  },
};
