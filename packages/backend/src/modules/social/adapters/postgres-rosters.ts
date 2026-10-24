import { PublicPersonRefSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { RosterStore } from '../application/ports.js';
/** Current side index only; candidate reads have a hard row bound even across inactive runs. */
export const rosterStore: RosterStore = {
  async head(scope, filter) {
    if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
    const row = await transactionOf(scope)
      .selectFrom('social.roster_heads')
      .select('revision')
      .where('owner_account_id', '=', scope.authority.actor.accountId)
      .where('kind', '=', filter)
      .forShare()
      .executeTakeFirst();
    return Number(row?.revision ?? 1);
  },
  async scan(scope, filter, after, limit) {
    if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
    let q = transactionOf(scope)
      .selectFrom('social.roster_entries as e')
      .innerJoin('social.profiles as p', 'p.person_id', 'e.peer_person_id')
      .innerJoin('identity.accounts as a', 'a.id', 'e.peer_account_id')
      .innerJoin('identity.universes as u', 'u.account_id', 'a.id')
      .select([
        'e.peer_person_id',
        'e.public_revision',
        'e.request_id',
        'e.expires_at',
        'p.handle',
        'p.display_name',
        'a.status as account_status',
        'u.status as universe_status',
      ])
      .where('e.owner_account_id', '=', scope.authority.actor.accountId)
      .where('e.kind', '=', filter);
    if (after) q = q.where('e.peer_person_id', '>', after);
    const rows = await q.orderBy('e.peer_person_id').limit(limit).execute();
    return rows.map((r) => ({
      person: PublicPersonRefSchema.parse({
        kind: 'person',
        personId: r.peer_person_id,
        handle: r.handle,
        displayName: r.display_name,
      }),
      revision: Number(r.public_revision),
      requestId: r.request_id,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      eligible: r.account_status === 'active' && r.universe_status === 'active',
    }));
  },
  async deadline(scope, filter, now) {
    if (scope.authority.actor.kind !== 'account') throw new Error('SOCIAL_ACCOUNT_REQUIRED');
    const r = await transactionOf(scope)
      .selectFrom('social.roster_entries')
      .select('expires_at')
      .where('owner_account_id', '=', scope.authority.actor.accountId)
      .where('kind', '=', filter)
      .where('expires_at', '>', now)
      .orderBy('expires_at')
      .limit(1)
      .executeTakeFirst();
    return r?.expires_at ? new Date(r.expires_at) : undefined;
  },
};
