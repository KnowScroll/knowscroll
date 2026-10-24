import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';

/**
 * Social's visitor stores (D-047) and what each erasure does to them.
 *
 * The visit tables hold the published copy of one universe, keyed by `universe_id`: exploration
 * Clear and full erasure of the universe delete them, so a friend who visits after a Clear sees an
 * empty universe. Dependants first. The settings, the chosen friends and the heartbeat are
 * account-keyed: Clear keeps them (they are choices and a signal that lapses, not exploration
 * history), and deleting the account removes them.
 */
export const visitTables = ['visit_planets', 'visit_systems', 'visit_publications'] as const;

export const visibilityLifecycle = {
  'social.visibility_settings': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.visibility_audience': {
    clear: 'preserve',
    onAccountErasure: 'rows naming the account on either side deleted',
  },
  'social.presence': { clear: 'preserve', onAccountErasure: 'delete with the account' },
  'social.visit_publications': { clear: 'erase', onAccountErasure: 'deleted with the universe' },
  'social.visit_systems': { clear: 'erase', onAccountErasure: 'deleted with the universe' },
  'social.visit_planets': { clear: 'erase', onAccountErasure: 'deleted with the universe' },
} as const;

export const visibilityAccountTables = [
  { schema: 'social', table: 'visibility_settings', ownerColumn: 'account_id' },
  { schema: 'social', table: 'visibility_audience', ownerColumn: 'owner_account_id,friend_account_id' },
  { schema: 'social', table: 'presence', ownerColumn: 'account_id' },
] as const;

export const visibilityAccountColumns = [
  { schema: 'social', table: 'visibility_settings', column: 'account_id' },
  { schema: 'social', table: 'visibility_audience', column: 'owner_account_id' },
  { schema: 'social', table: 'visibility_audience', column: 'friend_account_id' },
  { schema: 'social', table: 'presence', column: 'account_id' },
] as const;

/** Deletes the published copy of one universe. Idempotent; returns how many rows went. */
export async function eraseVisitRows(trx: Transaction<Database>, universeId: string): Promise<number> {
  let removed = 0;
  for (const table of visitTables)
    removed += Number(
      (await sql`delete from ${sql.table(`social.${table}`)} where universe_id = ${universeId}::uuid`.execute(trx))
        .numAffectedRows ?? 0,
    );
  return removed;
}

/** Deletes an account's settings, heartbeat and every chosen-friend row that names it, as owner or as friend. */
export async function eraseVisibilityAccountRows(trx: Transaction<Database>, accountId: string): Promise<number> {
  let removed = 0;
  for (const statement of [
    sql`delete from social.visibility_audience where owner_account_id = ${accountId}::uuid or friend_account_id = ${accountId}::uuid`,
    sql`delete from social.visibility_settings where account_id = ${accountId}::uuid`,
    sql`delete from social.presence where account_id = ${accountId}::uuid`,
  ])
    removed += Number((await statement.execute(trx)).numAffectedRows ?? 0);
  return removed;
}

const AVAILABILITY_WORDS = { hidden: 'not shown', recently_active: 'Recently active', online: 'Online' } as const;
const AUDIENCE_WORDS = { nobody: 'nobody', chosen_friends: 'friends you chose', all_friends: 'all friends' } as const;

/**
 * What a person's export says about what they let friends see, in words: who may visit, how many
 * friends they chose (never who), how they show as available and the titles of the systems they
 * share. Never a heartbeat time, a public identity, another person or the planets (a copy of places
 * the Geography section already lists).
 */
export async function exportVisibility(trx: Transaction<Database>, accountId: string, universeId: string) {
  const settings = await trx
    .selectFrom('social.visibility_settings')
    .select(['audience', 'presence_preference'])
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  const chosen = await trx
    .selectFrom('social.visibility_audience')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('owner_account_id', '=', accountId)
    .executeTakeFirstOrThrow();
  const systems = await trx
    .selectFrom('social.visit_systems')
    .select('label')
    .where('universe_id', '=', universeId)
    .orderBy('label')
    .execute();
  const audience = settings?.audience ?? 'nobody';
  const preference = settings?.presence_preference ?? 'hidden';
  return {
    whoMayVisit: AUDIENCE_WORDS[audience as keyof typeof AUDIENCE_WORDS] ?? 'nobody',
    friendsYouChose: Number(chosen.n),
    availability: AVAILABILITY_WORDS[preference as keyof typeof AVAILABILITY_WORDS] ?? 'not shown',
    systemsYouShare: systems.map((system) => system.label),
  };
}
