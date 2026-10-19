import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { AccountUniverse, UniverseAccess } from '../public.js';

/** Reads an account and its universe (read-only, no lock). One universe per account (unique). */
export async function readAccountUniverse(
  db: Kysely<Database>,
  accountId: string,
): Promise<AccountUniverse | undefined> {
  return db
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
    .executeTakeFirst();
}

/** Reads one universe's access state for its owner (read-only, no lock). */
export async function readUniverseAccess(
  db: Kysely<Database>,
  accountId: string,
  universeId: string,
): Promise<UniverseAccess | undefined> {
  const row = await db
    .selectFrom('identity.universes as universe')
    .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
    .select(['universe.revision', 'universe.privacy_epoch', 'universe.status', 'account.status as account_status'])
    .where('universe.id', '=', universeId)
    .where('universe.account_id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    revision: row.revision,
    privacyEpoch: row.privacy_epoch,
    active: row.status === 'active' && row.account_status === 'active',
  };
}
