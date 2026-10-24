import { sql } from 'kysely';
import { exportReading, type ModuleErasure } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
/**
 * Account-lifetime stores. Exploration Clear retains all of them. Account deletion (`eraseAccount`)
 * removes the person's profile, invite and friendship rows, and every pair, request and roster
 * entry that names them: the friendship ends for the other person too, silently and without a
 * placeholder, because nothing else in Social outlives it. Where shared history does remain
 * (conversations, threads, rooms) its owner shows the neutral "Deleted account" (D-043).
 */
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
  ],
  erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const account = scope.accountId;
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
    let removed = 0;
    for (const statement of statements) removed += Number((await statement.execute(trx)).numAffectedRows ?? 0);
    return { module: 'social', status: 'completed', removed };
  },
};

/** Clearing exploration history keeps profiles, friendships and invites: nothing here is erased. */
socialErasure.clearExploration = {
  dispositions: Object.fromEntries([
    ...socialErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'preserve']),
    ...(socialErasure.accountTables ?? []).map((t) => [`${t.schema}.${t.table}`, 'preserve']),
    ...(socialErasure.accountColumns ?? []).map((t) => [`${t.schema}.${t.table}`, 'preserve']),
    ...socialErasure.nonRowStores.map((s) => [`store:${s.name}`, 'preserve']),
  ]) as Record<string, 'preserve'>,
  erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),
};

/**
 * The person's own sharing profile and invitation, and how many people they are connected to.
 * Other people's names, handles and IDs are never in the file: a friend list is theirs to export.
 */
socialErasure.export = exportReading(
  socialErasure,
  ['social.profiles', 'social.roster_entries', 'social.invites'],
  'Pair and request records are shared with the other person; roster heads and command bindings are internal bookkeeping.',
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
    };
  },
);
