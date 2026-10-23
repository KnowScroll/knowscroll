import { sql, type Kysely } from 'kysely';
import type { Database } from '../postgres/database.js';
import type { QueueDefinition } from '../jobs/queues.js';
import type { ModuleErasure } from './registry.js';

/** The personal roots themselves; their lifecycle is account deletion, not a module's eraser. */
const identityRoots = ['accounts', 'universes'];

/** Schemas owned by infrastructure libraries rather than modules; never personal by design. */
const infrastructureSchemas = ['pgboss', 'migrator', 'pg_catalog', 'information_schema'];

interface OwnerColumn {
  readonly table_schema: string;
  readonly table_name: string;
  readonly column_name: string;
}

/**
 * Every column that can name an owner: by name (`universe_id`, `account_id`, `*_account_id`,
 * `person_id`, `*_person_id`) or by a foreign key to a personal root, whatever the column is
 * called. A table with any of them must be declared; there is no list of exceptions by name.
 */
const readOwnerColumns = (db: Kysely<Database>) =>
  sql<OwnerColumn>`
    select c.table_schema, c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where t.table_type = 'BASE TABLE'
      and c.table_schema <> all(${infrastructureSchemas}::text[])
      and (c.column_name in ('universe_id', 'account_id', 'person_id')
        or c.column_name like '%\\_account\\_id' or c.column_name like '%\\_person\\_id')
    union
    select n.nspname, rel.relname, att.attname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.contype = 'f'
      and rel.relkind in ('r', 'p')
      and n.nspname <> all(${infrastructureSchemas}::text[])
      and con.confrelid in ('identity.accounts'::regclass, 'identity.universes'::regclass)
    order by 1, 2, 3`
    .execute(db)
    .then((result) => result.rows);

/** Tables from which a chain of foreign keys leads to a personal root, whether or not they hold an owner column. */
const readTablesLinkedToRoots = (db: Kysely<Database>) =>
  sql<{ table_name: string }>`
    with recursive linked(rel) as (
      select con.conrelid from pg_constraint con
      where con.contype = 'f' and con.confrelid in ('identity.accounts'::regclass, 'identity.universes'::regclass)
      union
      select con.conrelid from pg_constraint con join linked on con.confrelid = linked.rel
      where con.contype = 'f'
    )
    select distinct n.nspname || '.' || rel.relname as table_name
    from linked
    join pg_class rel on rel.oid = linked.rel
    join pg_namespace n on n.oid = rel.relnamespace
    where rel.relkind in ('r', 'p') and n.nspname <> all(${infrastructureSchemas}::text[])`
    .execute(db)
    .then((result) => new Set(result.rows.map((row) => row.table_name)));

/** Tables whose `universe_id` references `identity.universes` with ON DELETE RESTRICT. */
const readRestrictedUniverseTables = (db: Kysely<Database>) =>
  sql<{ table_name: string }>`
    select distinct (con.conrelid::regclass)::text as table_name
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
    where con.contype = 'f'
      and con.confrelid = 'identity.universes'::regclass
      and con.confdeltype = 'r'
      and att.attname = 'universe_id'`
    .execute(db)
    .then((result) => new Set(result.rows.map((row) => row.table_name)));

const readBaseTables = (db: Kysely<Database>) =>
  sql<{ table_name: string }>`
    select table_schema || '.' || table_name as table_name from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema <> all(${infrastructureSchemas}::text[])
    order by 1`
    .execute(db)
    .then((result) => new Set(result.rows.map((row) => row.table_name)));

const qualified = (item: { readonly schema: string; readonly table: string }) => `${item.schema}.${item.table}`;

/** Personal tables (`universe_id`): declared, existing, and RESTRICT-referenced from the root. */
function universeTableProblems(
  registry: readonly ModuleErasure[],
  ownerColumns: readonly OwnerColumn[],
  restrictedTables: ReadonlySet<string>,
): string[] {
  const present = new Set(
    ownerColumns
      .filter((row) => row.column_name === 'universe_id')
      .map((row) => `${row.table_schema}.${row.table_name}`),
  );
  const declared = new Set(registry.flatMap((module) => module.tables.map(qualified)));
  const problems: string[] = [];
  for (const table of present)
    if (!declared.has(table))
      problems.push(`${table} has a universe_id column but no module declares it in the erasure registry`);
  for (const table of declared) {
    if (!present.has(table))
      problems.push(`${table} is declared in the erasure registry but has no universe_id column`);
    else if (!restrictedTables.has(table))
      problems.push(`${table} does not reference identity.universes from universe_id with ON DELETE RESTRICT`);
  }
  return problems;
}

/** Account and person columns outside identity: each is declared by the module that owns it. */
function accountColumnProblems(registry: readonly ModuleErasure[], ownerColumns: readonly OwnerColumn[]): string[] {
  const present = new Set(
    ownerColumns
      .filter((row) => row.column_name !== 'universe_id' && row.table_schema !== 'identity')
      .map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`),
  );
  const declared = new Set(
    registry.flatMap((module) =>
      (module.accountColumns ?? []).map((column) => `${qualified(column)}.${column.column}`),
    ),
  );
  const problems: string[] = [];
  for (const column of present)
    if (!declared.has(column)) problems.push(`${column} links to an account or person but no module declares it`);
  for (const column of declared)
    if (!present.has(column)) problems.push(`${column} is declared as account-linked but does not exist`);
  return problems;
}

/**
 * Account-keyed tables: every identity table except the roots is declared. Account-lifetime
 * stores may also belong to modules outside identity; for those only existence is checked, and
 * declaring one never supplies a deletion executor or weakens identity's mandatory coverage.
 */
async function accountTableProblems(db: Kysely<Database>, registry: readonly ModuleErasure[]): Promise<string[]> {
  const baseTables = await readBaseTables(db);
  const identityTables = [...baseTables].filter(
    (table) => table.startsWith('identity.') && !identityRoots.includes(table.slice('identity.'.length)),
  );
  const declared = new Set(registry.flatMap((module) => (module.accountTables ?? []).map(qualified)));
  const problems: string[] = [];
  for (const table of identityTables)
    if (!declared.has(table))
      problems.push(`${table} holds account records but no module declares it as an account table`);
  for (const table of declared)
    if (!baseTables.has(table)) problems.push(`${table} is declared as an account table but does not exist`);
  return problems;
}

/**
 * Tables that reach a personal root only through other tables (a child of a personal table with
 * no owner column of its own) and that no module declares, in any of the three declaration kinds.
 */
function indirectLinkProblems(
  registry: readonly ModuleErasure[],
  ownerColumns: readonly OwnerColumn[],
  linkedToRoots: ReadonlySet<string>,
): string[] {
  const covered = new Set([
    ...ownerColumns.map((row) => `${row.table_schema}.${row.table_name}`),
    ...registry.flatMap((module) => [
      ...module.tables.map(qualified),
      ...(module.accountTables ?? []).map(qualified),
      ...(module.accountColumns ?? []).map(qualified),
    ]),
  ]);
  return [...linkedToRoots]
    .filter((table) => !table.startsWith('identity.') && !covered.has(table))
    .sort()
    .map((table) => `${table} reaches a personal root through foreign keys but no module declares it`);
}

/**
 * The schema inventory check (blueprint §5). Returns every problem found; an empty list means the
 * registry and the migrated database agree, so no table that holds a person's data can be forgotten:
 * - every base table with a `universe_id` column is declared by a module, and every declared table
 *   exists with that column;
 * - every declared personal table references the personal root (`identity.universes`) from
 *   `universe_id` with `ON DELETE RESTRICT`, so deletion can only go through the erasers;
 * - every account or person column outside the identity schema (named `account_id`, `*_account_id`,
 *   `person_id` or `*_person_id`, or holding a foreign key to `identity.accounts` or
 *   `identity.universes` under any name) is declared by a module (account deletion must handle it);
 * - every identity table other than the personal roots (`accounts`, `universes`) is declared as an
 *   account-keyed table, and every declared account table exists;
 * - every other table that reaches a personal root through foreign keys is declared too.
 *
 * Shared tables pass by having none of these links; their own inventories (Content and Reasoning
 * adapters) and tests prove that. CI runs this against the migrated schema, and every Clear runs
 * it again inside its transaction before erasing anything.
 */
export async function checkErasureInventory(
  db: Kysely<Database>,
  registry: readonly ModuleErasure[],
): Promise<readonly string[]> {
  const ownerColumns = await readOwnerColumns(db);
  return [
    ...universeTableProblems(registry, ownerColumns, await readRestrictedUniverseTables(db)),
    ...accountColumnProblems(registry, ownerColumns),
    ...(await accountTableProblems(db, registry)),
    ...indirectLinkProblems(registry, ownerColumns, await readTablesLinkedToRoots(db)),
  ];
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
