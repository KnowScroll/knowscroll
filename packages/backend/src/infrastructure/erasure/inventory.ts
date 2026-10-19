import { sql, type Kysely } from 'kysely';
import type { Database } from '../postgres/database.js';
import type { ModuleErasure } from './registry.js';

/** Schemas owned by infrastructure libraries rather than modules; never personal by design. */
const infrastructureSchemas = ['pgboss', 'migrator', 'pg_catalog', 'information_schema'];

/**
 * The schema inventory check (blueprint §5): every base table with a `universe_id` column must
 * be declared by exactly one module, and every declared table must exist with that column.
 * Returns the problems; an empty list means registry and database agree.
 */
export async function checkErasureInventory(
  db: Kysely<Database>,
  registry: readonly ModuleErasure[],
): Promise<readonly string[]> {
  const result = await sql<{ table_schema: string; table_name: string }>`
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.column_name = 'universe_id' and t.table_type = 'BASE TABLE'
      and c.table_schema <> all(${infrastructureSchemas}::text[])
    order by 1, 2`.execute(db);
  const present = new Set(result.rows.map((row) => `${row.table_schema}.${row.table_name}`));
  const declared = new Set(
    registry.flatMap((module) => module.tables.map((table) => `${table.schema}.${table.table}`)),
  );
  const problems: string[] = [];
  for (const table of present)
    if (!declared.has(table))
      problems.push(`${table} has a universe_id column but no module declares it in the erasure registry`);
  for (const table of declared)
    if (!present.has(table))
      problems.push(`${table} is declared in the erasure registry but has no universe_id column`);
  return problems;
}
