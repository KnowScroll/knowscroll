import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { PRESENCE, type PresencePreference } from '../domain/presence.js';
import type { PublishedSystem } from '../domain/visibility.js';
import { DEFAULT_VISIBILITY, type VisibilityStore, type VisibilityTx } from '../application/visibility-store.js';

const trxOf = (tx: VisibilityTx): Transaction<Database> =>
  'personal' in tx ? sharedTransactionOf(tx) : transactionOf(tx);
const personalTrx = (scope: PersonalScopeTx) => transactionOf(scope);
/** Rows are written a few hundred at a time: a person can share up to 100 systems with 100 planets each. */
function* inChunks<T>(items: readonly T[], size = 250): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) yield items.slice(start, start + size);
}
const asPreference = (value: string): PresencePreference =>
  value === 'online' || value === 'recently_active' ? value : 'hidden';

/** Postgres rows for visibility, the visitor audience, availability and the published copy (migration 0059). */
export const visibilityStore: VisibilityStore = {
  async settings(tx, accountId) {
    const row = await trxOf(tx)
      .selectFrom('social.visibility_settings')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (!row) return DEFAULT_VISIBILITY;
    return {
      audience: row.audience === 'chosen_friends' || row.audience === 'all_friends' ? row.audience : 'nobody',
      visibilityRevision: Number(row.visibility_revision),
      presencePreference: asPreference(row.presence_preference),
      presenceRevision: Number(row.presence_revision),
    };
  },

  async saveSettings(scope, accountId, settings) {
    await personalTrx(scope)
      .insertInto('social.visibility_settings')
      .values({
        account_id: accountId,
        audience: settings.audience,
        visibility_revision: settings.visibilityRevision,
        presence_preference: settings.presencePreference,
        presence_revision: settings.presenceRevision,
      })
      .onConflict((conflict) =>
        conflict.column('account_id').doUpdateSet({
          audience: settings.audience,
          visibility_revision: settings.visibilityRevision,
          presence_preference: settings.presencePreference,
          presence_revision: settings.presenceRevision,
        }),
      )
      .execute();
  },

  async chosenFriends(tx, ownerAccountId) {
    const rows = await trxOf(tx)
      .selectFrom('social.visibility_audience as a')
      .innerJoin('social.profiles as p', 'p.account_id', 'a.friend_account_id')
      .select(['a.friend_account_id', 'p.person_id'])
      .where('a.owner_account_id', '=', ownerAccountId)
      .orderBy('p.person_id')
      .execute();
    return rows.map((row) => ({ accountId: row.friend_account_id, personId: row.person_id }));
  },

  async currentFriends(scope, ownerAccountId, personIds) {
    if (personIds.length === 0) return [];
    const rows = await personalTrx(scope)
      .selectFrom('social.profiles as p')
      .innerJoin('social.pair_sides as mine', (join) => join.on('mine.account_id', '=', ownerAccountId))
      .innerJoin('social.pair_sides as theirs', (join) =>
        join.onRef('theirs.pair_id', '=', 'mine.pair_id').onRef('theirs.account_id', '=', 'p.account_id'),
      )
      .select(['p.account_id', 'p.person_id'])
      .where('p.person_id', 'in', [...personIds])
      .where('mine.public_state', '=', 'friends')
      .where('theirs.public_state', '=', 'friends')
      .where('mine.own_blocked', '=', false)
      .where('theirs.own_blocked', '=', false)
      .execute();
    return rows.map((row) => ({ accountId: row.account_id, personId: row.person_id }));
  },

  async replaceChosenFriends(scope, ownerAccountId, friendAccountIds) {
    const trx = personalTrx(scope);
    await trx.deleteFrom('social.visibility_audience').where('owner_account_id', '=', ownerAccountId).execute();
    if (friendAccountIds.length > 0)
      await trx
        .insertInto('social.visibility_audience')
        .values(friendAccountIds.map((friend) => ({ owner_account_id: ownerAccountId, friend_account_id: friend })))
        .execute();
  },

  async forgetChoiceBetween(lock, accountA, accountB) {
    await sharedTransactionOf(lock)
      .deleteFrom('social.visibility_audience')
      .where((where) =>
        where.or([
          where.and([where('owner_account_id', '=', accountA), where('friend_account_id', '=', accountB)]),
          where.and([where('owner_account_id', '=', accountB), where('friend_account_id', '=', accountA)]),
        ]),
      )
      .execute();
  },

  async presence(tx, accountId) {
    const row = await trxOf(tx)
      .selectFrom('social.presence')
      .select(['last_seen_at', 'window_number'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row
      ? { lastSeenAtMs: new Date(row.last_seen_at).getTime(), windowNumber: Number(row.window_number) }
      : undefined;
  },

  async clearPresence(scope, accountId) {
    await personalTrx(scope).deleteFrom('social.presence').where('account_id', '=', accountId).execute();
  },

  async publication(tx, universeId) {
    const trx = trxOf(tx);
    const header = await trx
      .selectFrom('social.visit_publications')
      .select(['projection_revision', 'geography_revision'])
      .where('universe_id', '=', universeId)
      .executeTakeFirst();
    if (!header) return undefined;
    const systems = await trx
      .selectFrom('social.visit_systems')
      .select(['system_id', 'public_system_id', 'label'])
      .where('universe_id', '=', universeId)
      .orderBy('label')
      .orderBy('public_system_id')
      .execute();
    const planets = await trx
      .selectFrom('social.visit_planets')
      .select(['planet_id', 'system_id', 'public_planet_id', 'label'])
      .where('universe_id', '=', universeId)
      .orderBy('label')
      .orderBy('public_planet_id')
      .execute();
    return {
      projectionRevision: Number(header.projection_revision),
      geographyRevision: Number(header.geography_revision),
      systems: systems.map((system): PublishedSystem => ({
        systemId: system.system_id,
        publicSystemId: system.public_system_id,
        label: system.label,
        planets: planets
          .filter((planet) => planet.system_id === system.system_id)
          .map((planet) => ({
            planetId: planet.planet_id,
            publicPlanetId: planet.public_planet_id,
            label: planet.label,
          })),
      })),
    };
  },

  async savePublication(scope, universeId, next) {
    const trx = personalTrx(scope);
    await trx
      .insertInto('social.visit_publications')
      .values({
        universe_id: universeId,
        projection_revision: next.projectionRevision,
        geography_revision: next.geographyRevision,
        refreshed_at: next.refreshedAt,
      })
      .onConflict((conflict) =>
        conflict.column('universe_id').doUpdateSet({
          projection_revision: next.projectionRevision,
          geography_revision: next.geographyRevision,
          refreshed_at: next.refreshedAt,
        }),
      )
      .execute();
    // Systems that stop being shared go, and their planets with them (cascade). The rest keep their
    // public identity: the upsert never touches `public_system_id` or `public_planet_id`.
    const systemIds = next.systems.map((system) => system.systemId);
    await trx
      .deleteFrom('social.visit_systems')
      .where('universe_id', '=', universeId)
      .$if(systemIds.length > 0, (query) => query.where('system_id', 'not in', systemIds))
      .execute();
    for (const rows of inChunks(next.systems)) {
      await trx
        .insertInto('social.visit_systems')
        .values(
          rows.map((system) => ({
            universe_id: universeId,
            system_id: system.systemId,
            public_system_id: system.publicSystemId,
            label: system.label,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['universe_id', 'system_id']).doUpdateSet((eb) => ({ label: eb.ref('excluded.label') })),
        )
        .execute();
    }
    const planets = next.systems.flatMap((system) => system.planets.map((planet) => ({ system, planet })));
    const planetIds = planets.map(({ planet }) => planet.planetId);
    await trx
      .deleteFrom('social.visit_planets')
      .where('universe_id', '=', universeId)
      .$if(planetIds.length > 0, (query) => query.where('planet_id', 'not in', planetIds))
      .execute();
    for (const rows of inChunks(planets)) {
      await trx
        .insertInto('social.visit_planets')
        .values(
          rows.map(({ system, planet }) => ({
            universe_id: universeId,
            planet_id: planet.planetId,
            system_id: system.systemId,
            public_planet_id: planet.publicPlanetId,
            label: planet.label,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['universe_id', 'planet_id']).doUpdateSet((eb) => ({ label: eb.ref('excluded.label') })),
        )
        .execute();
    }
  },
};

/**
 * Records one heartbeat for a person who shows availability, in one statement: nothing is written
 * for a person whose availability is hidden or who never changed the setting, so hiding stores
 * nothing. A heartbeat after more than the recently-active horizon starts a new window, which is the
 * `expiryRevision` of the answers friends read. Only an active account can send one.
 */
export async function recordHeartbeat(db: Kysely<Database>, accountId: string, now: Date): Promise<void> {
  await sql`
    insert into social.presence (account_id, last_seen_at, window_number)
    select settings.account_id, ${now}, 1
    from social.visibility_settings settings
    join identity.accounts account on account.id = settings.account_id and account.status = 'active'
    where settings.account_id = ${accountId}::uuid and settings.presence_preference <> 'hidden'
    on conflict (account_id) do update set
      window_number = case
        when social.presence.last_seen_at < ${now}::timestamptz - ${PRESENCE.recentMs} * interval '1 millisecond'
          then social.presence.window_number + 1
        else social.presence.window_number
      end,
      last_seen_at = excluded.last_seen_at`.execute(db);
}
