import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';

/** An account with its personal universe, as authentication resolves a caller. */
export interface AccountUniverse {
  readonly accountId: string;
  readonly accountStatus: string;
  readonly universeId: string;
  readonly universeStatus: string;
  readonly privacyEpoch: number;
}

/**
 * Reads an account and its universe (read-only, no lock). Callers resolved from it are claims:
 * `withPersonalScope` rechecks them under the lock. Returns `undefined` when either is missing.
 */
export async function readAccountUniverse(
  db: Kysely<Database>,
  accountId: string,
): Promise<AccountUniverse | undefined> {
  const row = await db
    .selectFrom('identity.accounts as account')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'account.id')
    .select([
      'account.id as accountId',
      'account.status as accountStatus',
      'universe.id as universeId',
      'universe.status as universeStatus',
      'universe.privacy_epoch as privacyEpoch',
    ])
    .where('account.id', '=', accountId)
    .orderBy('universe.created_at')
    .limit(1)
    .executeTakeFirst();
  return row;
}
