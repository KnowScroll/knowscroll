import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResult } from 'kysely/migration';

/**
 * One reviewed SQL migration from the static registry in `migrations/`. `name` sorts in apply
 * order (`NNNN_purpose`); `sql` is the file's full text.
 */
export interface RegisteredMigration {
  readonly name: string;
  readonly sql: string;
}

/** Schema and table that record applied migrations. Owned by this migrator. */
export const MIGRATION_SCHEMA = 'migrator';
export const MIGRATION_TABLE = 'kysely_migration';
const MIGRATION_LOCK_TABLE = 'kysely_migration_lock';

export type MigrationOutcome =
  | { readonly kind: 'migrated'; readonly applied: readonly string[]; readonly latest: string }
  | {
      readonly kind: 'failed';
      readonly applied: readonly string[];
      readonly failedMigration: string | undefined;
      readonly error: unknown;
    };

/**
 * Applies every pending migration from `registry`, in order, inside Kysely's migration lock.
 *
 * Inputs: a Kysely instance connected as the schema owner and the static registry.
 * Side effects: DDL from the registry; rows in `migrator.kysely_migration`.
 * Failure: returns `failed` with the migration that failed; PostgreSQL rolls back that
 * migration's transaction. Migrations are forward-only (no `down`); recovery is restore from the
 * verified pre-migration backup (CF-27).
 * Invariants: an applied migration that is missing from the registry fails the run, so a deleted
 * or renamed file cannot be silently skipped.
 */
export async function migrateToLatest(
  db: Kysely<unknown>,
  registry: readonly RegisteredMigration[],
): Promise<MigrationOutcome> {
  assertOrdered(registry);
  const migrations: Record<string, Migration> = {};
  for (const migration of registry) {
    migrations[migration.name] = {
      async up(target) {
        await sql.raw(migration.sql).execute(target);
      },
    };
  }
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    migrationTableSchema: MIGRATION_SCHEMA,
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
  });
  const { error, results } = await migrator.migrateToLatest();
  const applied = (results ?? [])
    .filter((result: MigrationResult) => result.status === 'Success')
    .map((result) => result.migrationName);
  if (error !== undefined) {
    const failed = (results ?? []).find((result) => result.status === 'Error');
    return { kind: 'failed', applied, failedMigration: failed?.migrationName, error };
  }
  return { kind: 'migrated', applied, latest: await readLatestMigration(db) };
}

/**
 * The newest applied migration name, or `none` when nothing has been applied (including when
 * the migration table does not exist yet). Read-only.
 */
export async function readLatestMigration(db: Kysely<unknown>): Promise<string> {
  const table = await sql<{
    present: boolean;
  }>`select to_regclass(${`${MIGRATION_SCHEMA}.${MIGRATION_TABLE}`}) is not null as present`.execute(db);
  if (table.rows[0]?.present !== true) return 'none';
  const latest = await sql<{
    name: string;
  }>`select name from ${sql.table(`${MIGRATION_SCHEMA}.${MIGRATION_TABLE}`)} order by name desc limit 1`.execute(db);
  return latest.rows[0]?.name ?? 'none';
}

function assertOrdered(registry: readonly RegisteredMigration[]): void {
  const names = registry.map((migration) => migration.name);
  const sorted = [...names].sort();
  if (names.some((name, index) => name !== sorted[index]) || new Set(names).size !== names.length) {
    throw new Error('Migration registry must list unique names in ascending order');
  }
}
