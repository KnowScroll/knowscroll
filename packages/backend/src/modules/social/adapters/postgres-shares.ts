import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ContentCard, ContentRef, ShareRow, ShareStore } from '../application/conversation-ports.js';

type ReadContent = (scope: PersonalScopeTx, refs: readonly ContentRef[]) => Promise<readonly ContentCard[]>;
type ReadPublicContent = (refs: readonly ContentRef[]) => Promise<readonly ContentCard[]>;

const shareOf = (row: {
  share_id: string;
  owner_account_id: string;
  command_id: string;
  asset_id: string;
  asset_revision: number;
  conversation_id: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}): ShareRow => ({
  shareId: row.share_id,
  ownerAccountId: row.owner_account_id,
  commandId: row.command_id,
  target: { assetId: row.asset_id, assetRevision: row.asset_revision },
  conversationId: row.conversation_id,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
  revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
});

/** Postgres share-link rows (migration 0054). Only a token's hash is ever stored or compared. */
export function shareStore(
  db: Kysely<Database>,
  readContent: ReadContent,
  readPublicContent: ReadPublicContent,
): ShareStore {
  return {
    async insert(scope, share) {
      await transactionOf(scope)
        .insertInto('social.content_shares')
        .values({
          share_id: share.shareId,
          owner_account_id: share.ownerAccountId,
          command_id: share.commandId,
          token_hash: share.tokenHash,
          asset_id: share.target.assetId,
          asset_revision: share.target.assetRevision,
          conversation_id: share.conversationId,
          created_at: share.createdAt,
          expires_at: share.expiresAt,
        })
        .execute();
    },

    async byId(scope, shareId) {
      const row = await transactionOf(scope)
        .selectFrom('social.content_shares')
        .selectAll()
        .where('share_id', '=', shareId)
        .executeTakeFirst();
      return row && shareOf(row);
    },

    async byCommand(scope, accountId, commandId) {
      const row = await transactionOf(scope)
        .selectFrom('social.content_shares')
        .selectAll()
        .where('owner_account_id', '=', accountId)
        .where('command_id', '=', commandId)
        .executeTakeFirst();
      return row && shareOf(row);
    },

    async byTokenHash(scope, tokenHash) {
      return byTokenHash(transactionOf(scope), tokenHash);
    },

    async revoke(scope, shareId, now) {
      const result = await transactionOf(scope)
        .updateTable('social.content_shares')
        .set({ revoked_at: now })
        .where('share_id', '=', shareId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async live(scope, accountId, now, limit) {
      const rows = await transactionOf(scope)
        .selectFrom('social.content_shares')
        .selectAll()
        .where('owner_account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(shareOf);
    },

    async openMembership(scope, accountId, conversationId) {
      const row = await transactionOf(scope)
        .selectFrom('social.conversation_members as m')
        .innerJoin('social.conversations as c', 'c.conversation_id', 'm.conversation_id')
        .innerJoin('social.pairs as pair', (join) =>
          join.onRef('pair.pair_id', '=', 'c.pair_id').onRef('pair.accepted_lineage', '=', 'c.lineage'),
        )
        .select(['m.membership_id', 'm.membership_revision'])
        .where('m.conversation_id', '=', conversationId)
        .where('m.account_id', '=', accountId)
        .where('m.left_at', 'is', null)
        .where('c.closed_at', 'is', null)
        .executeTakeFirst();
      return row && { membershipId: row.membership_id, membershipRevision: Number(row.membership_revision) };
    },

    cards: (scope, refs) => readContent(scope, refs),

    anonymous: {
      byTokenHash: (tokenHash) => byTokenHash(db, tokenHash),
      cards: readPublicContent,
    },
  };
}

async function byTokenHash(reader: Kysely<Database>, tokenHash: string): Promise<ShareRow | undefined> {
  const row = await reader
    .selectFrom('social.content_shares')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  return row && shareOf(row);
}
