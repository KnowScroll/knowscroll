import { sql, type Kysely } from 'kysely';
import type { Database } from '../postgres/database.js';
import type { QueueDefinition } from '../jobs/queues.js';
import type { ModuleErasure } from './registry.js';

/** The personal roots themselves; their lifecycle is account deletion, not a module's eraser. */
const identityRoots = ['accounts', 'universes'];

/** Schemas owned by infrastructure libraries rather than modules; never personal by design. */
const infrastructureSchemas = ['pgboss', 'migrator', 'pg_catalog', 'information_schema'];

/**
 * The schema inventory check (blueprint §5). Returns every problem found; an empty list means the
 * registry and the database agree:
 * - every base table with a `universe_id` column is declared by a module, and every declared table
 *   exists with that column;
 * - every declared personal table references the personal root (`identity.universes`) from
 *   `universe_id` with `ON DELETE RESTRICT`, so deletion can only go through the erasers;
 * - every account-linked column (`account_id` or `*_account_id`) outside the identity schema is
 *   declared by a module (account deletion must handle it);
 * - every identity table other than the personal roots (`accounts`, `universes`) is declared as an
 *   account-keyed table, and every declared account table exists.
 */
export async function checkErasureInventory(
  db: Kysely<Database>,
  registry: readonly ModuleErasure[],
): Promise<readonly string[]> {
  const columns = await sql<{ table_schema: string; table_name: string; column_name: string }>`
    select c.table_schema, c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where t.table_type = 'BASE TABLE'
      and c.table_schema <> all(${infrastructureSchemas}::text[])
      and (c.column_name = 'universe_id' or c.column_name = 'account_id' or c.column_name like '%\\_account\\_id')
    order by 1, 2, 3`.execute(db);
  const personal = new Set(
    columns.rows
      .filter((row) => row.column_name === 'universe_id')
      .map((row) => `${row.table_schema}.${row.table_name}`),
  );
  const accountLinked = new Set(
    columns.rows
      .filter((row) => row.column_name !== 'universe_id' && row.table_schema !== 'identity')
      .map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`),
  );
  const declared = new Set(
    registry.flatMap((module) => module.tables.map((table) => `${table.schema}.${table.table}`)),
  );
  const declaredAccountColumns = new Set(
    registry.flatMap((module) =>
      (module.accountColumns ?? []).map((column) => `${column.schema}.${column.table}.${column.column}`),
    ),
  );

  const restricted = await sql<{ table_name: string }>`
    select distinct (con.conrelid::regclass)::text as table_name
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.contype = 'f'
      and con.confrelid = 'identity.universes'::regclass
      and con.confdeltype = 'r'
      and att.attname = 'universe_id'`.execute(db);
  const restrictedTables = new Set(restricted.rows.map((row) => row.table_name));

  const problems: string[] = [];
  for (const table of personal)
    if (!declared.has(table))
      problems.push(`${table} has a universe_id column but no module declares it in the erasure registry`);
  for (const table of declared) {
    if (!personal.has(table))
      problems.push(`${table} is declared in the erasure registry but has no universe_id column`);
    else if (!restrictedTables.has(table))
      problems.push(`${table} does not reference identity.universes from universe_id with ON DELETE RESTRICT`);
  }
  for (const column of accountLinked)
    if (!declaredAccountColumns.has(column)) problems.push(`${column} links to an account but no module declares it`);
  for (const column of declaredAccountColumns)
    if (!accountLinked.has(column)) problems.push(`${column} is declared as account-linked but does not exist`);

  const identityTables = await sql<{ table_name: string }>`
    select table_schema || '.' || table_name as table_name
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema = 'identity' and table_name <> all(${identityRoots}::text[])
    order by 1`.execute(db);
  const existingIdentityAccountTables = new Set(identityTables.rows.map((row) => row.table_name));
  // Account-lifetime stores may belong to modules outside Identity. This validates existence
  // only; registration never supplies a deletion executor or weakens mandatory Identity coverage.
  const baseTables = await sql<{ table_name: string }>`
    select table_schema || '.' || table_name as table_name from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema <> all(${infrastructureSchemas}::text[])`.execute(db);
  const existingAccountTables = new Set(baseTables.rows.map((row) => row.table_name));
  const declaredAccountTables = new Set(
    registry.flatMap((module) => (module.accountTables ?? []).map((table) => `${table.schema}.${table.table}`)),
  );
  for (const table of existingIdentityAccountTables)
    if (!declaredAccountTables.has(table))
      problems.push(`${table} holds account records but no module declares it as an account table`);
  for (const table of declaredAccountTables)
    if (!existingAccountTables.has(table)) problems.push(`${table} is declared as an account table but does not exist`);
  return problems;
}

/**
 * Queue payloads are a personal store SQL introspection cannot see: every declared queue whose
 * payload schema carries `universeId` must be declared as the non-row store `pgboss/<queue>` by
 * some module (with an eraser that removes its payloads).
 */
export function checkQueuePayloadStores(
  queues: readonly QueueDefinition<unknown>[],
  registry: readonly ModuleErasure[],
): readonly string[] {
  const stores = new Set(registry.flatMap((module) => module.nonRowStores.map((store) => store.name)));
  return queues
    .filter((queue) => {
      const shape: unknown = (queue.payload as { shape?: unknown }).shape;
      return typeof shape === 'object' && shape !== null && 'universeId' in shape;
    })
    .filter((queue) => !stores.has(`pgboss/${queue.name}`))
    .map(
      (queue) =>
        `queue ${queue.name} carries universeId in its payload but no module declares the store pgboss/${queue.name}`,
    );
}
