import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { InviteStore } from '../application/ports.js';
export const inviteStore: InviteStore = {
  async read(scope, by) {
    let q = transactionOf(scope).selectFrom('social.invites').selectAll();
    q = 'accountId' in by ? q.where('account_id', '=', by.accountId) : q.where('token_hash', '=', by.tokenHash);
    const r = await q.executeTakeFirst();
    return r
      ? {
          accountId: r.account_id,
          linkId: r.link_id,
          tokenHash: r.token_hash,
          revision: Number(r.revision),
          createdAt: new Date(r.created_at).toISOString(),
          expiresAt: new Date(r.expires_at).toISOString(),
          revoked: r.revoked,
        }
      : undefined;
  },
  async save(scope, r) {
    await transactionOf(scope)
      .insertInto('social.invites')
      .values({
        account_id: r.accountId,
        link_id: r.linkId,
        token_hash: r.tokenHash,
        revision: r.revision,
        created_at: new Date(r.createdAt),
        expires_at: new Date(r.expiresAt),
        revoked: r.revoked,
      })
      .onConflict((oc) =>
        oc.column('account_id').doUpdateSet({
          link_id: r.linkId,
          token_hash: r.tokenHash,
          revision: r.revision,
          created_at: new Date(r.createdAt),
          expires_at: new Date(r.expiresAt),
          revoked: r.revoked,
        }),
      )
      .execute();
  },
};
