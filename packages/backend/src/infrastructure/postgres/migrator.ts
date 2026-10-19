import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResult } from 'kysely/migration';

/**
 * One reviewed SQL migration from the static registry in `migrations/`. `name` sorts in apply
 * order (`NNNN_purpose`); `sql` is the file's full text; `sha256` is the registry's recorded hash
 * of that text.
 */
export interface RegisteredMigration {
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
}

/** Schema and tables that record applied migrations. Owned by this migrator. */
export const MIGRATION_SCHEMA = 'migrator';
export const MIGRATION_TABLE = 'kysely_migration';
const MIGRATION_LOCK_TABLE = 'kysely_migration_lock';
/** One row per applied migration with the SHA-256 of the exact text that was applied. */
const CHECKSUM_TABLE = 'migration_checksum';

export type MigrationOutcome =
  | { readonly kind: 'migrated'; readonly applied: readonly string[]; readonly latest: string }
  | {
      readonly kind: 'failed';
      /** Always empty: the whole pending batch runs in one transaction and was rolled back. */
      readonly applied: readonly [];
      readonly failedMigration: string | undefined;
      readonly error: unknown;
    }
  | { readonly kind: 'refused'; readonly reason: 'checksum_mismatch' | 'checksum_missing'; readonly migration: string };

/** Raised when a migration's text does not match the SHA-256 the registry recorded for it. */
export class MigrationChecksumError extends Error {
  override readonly name = 'MigrationChecksumError';
  readonly code = 'MIGRATION_CHECKSUM_MISMATCH';
}

/** SHA-256 of a migration's text, as the registry records it. */
export function migrationChecksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Applies every pending migration from `registry`, in order, inside Kysely's migration lock.
 *
 * Inputs: a Kysely instance connected as the schema owner and the static registry.
 * Checks before anything runs: every migration's text matches its recorded SHA-256
 * (`MigrationChecksumError` otherwise), and every migration already applied to this database was
 * applied with exactly the registry's text (`refused` with `checksum_mismatch`, or
 * `checksum_missing` for an applied migration that has no recorded checksum). An edited migration
 * can therefore never be skipped silently on old databases while new ones apply the new text.
 * Side effects: DDL from the registry; rows in `migrator.kysely_migration` and
 * `migrator.migration_checksum`, written in the same transaction as the migration itself.
 * Failure: Kysely runs the whole pending batch in **one** transaction, so a failure rolls back
 * every migration of that run: `failed` names the failing migration and reports nothing applied.
 * Consequently no migration may use statements that cannot run in a transaction (for example
 * `CREATE INDEX CONCURRENTLY`), which squawk's `assume_in_transaction` also assumes.
 * Migrations are forward-only (no `down`); recovery is restore from the verified pre-migration
 * backup (CF-27).
 * Invariants: an applied migration that is missing from the registry fails the run, so a deleted
 * or renamed file cannot be silently skipped.
 */
export async function migrateToLatest(
  db: Kysely<unknown>,
  registry: readonly RegisteredMigration[],
): Promise<MigrationOutcome> {
  assertOrdered(registry);
  for (const migration of registry) {
    if (migrationChecksum(migration.sql) !== migration.sha256) {
      throw new MigrationChecksumError(`${migration.name} does not match its recorded SHA-256`);
    }
  }
  await sql`create schema if not exists ${sql.id(MIGRATION_SCHEMA)}`.execute(db);
  await sql`create table if not exists ${sql.table(`${MIGRATION_SCHEMA}.${CHECKSUM_TABLE}`)} (
    name text primary key,
    sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz not null default now()
  )`.execute(db);
  const refusal = await checkAppliedChecksums(db, registry);
  if (refusal !== undefined) return refusal;

  const migrations: Record<string, Migration> = {};
  for (const migration of registry) {
    migrations[migration.name] = {
      async up(target) {
        await sql.raw(migration.sql).execute(target);
        await sql`insert into ${sql.table(`${MIGRATION_SCHEMA}.${CHECKSUM_TABLE}`)} (name, sha256) values (${migration.name}, ${migration.sha256})`.execute(
          target,
        );
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
  if (error !== undefined) {
    const failed = (results ?? []).find((result) => result.status === 'Error');
    return { kind: 'failed', applied: [], failedMigration: failed?.migrationName, error };
  }
  const applied = (results ?? [])
    .filter((result: MigrationResult) => result.status === 'Success')
    .map((result) => result.migrationName);
  return { kind: 'migrated', applied, latest: await readLatestMigration(db) };
}

async function checkAppliedChecksums(
  db: Kysely<unknown>,
  registry: readonly RegisteredMigration[],
): Promise<Extract<MigrationOutcome, { kind: 'refused' }> | undefined> {
  const applied = await readAppliedMigrations(db);
  if (applied.length === 0) return undefined;
  const recorded = await sql<{
    name: string;
    sha256: string;
  }>`select name, sha256 from ${sql.table(`${MIGRATION_SCHEMA}.${CHECKSUM_TABLE}`)}`.execute(db);
  const checksums = new Map(recorded.rows.map((row) => [row.name, row.sha256]));
  const expected = new Map(registry.map((migration) => [migration.name, migration.sha256]));
  for (const name of applied) {
    const stored = checksums.get(name);
    if (stored === undefined) return { kind: 'refused', reason: 'checksum_missing', migration: name };
    // An applied migration missing from the registry is Kysely's own refusal (run below).
    const wanted = expected.get(name);
    if (wanted !== undefined && wanted !== stored)
      return { kind: 'refused', reason: 'checksum_mismatch', migration: name };
  }
  return undefined;
}

async function readAppliedMigrations(db: Kysely<unknown>): Promise<readonly string[]> {
  const table = await sql<{
    present: boolean;
  }>`select to_regclass(${`${MIGRATION_SCHEMA}.${MIGRATION_TABLE}`}) is not null as present`.execute(db);
  if (table.rows[0]?.present !== true) return [];
  const rows = await sql<{
    name: string;
  }>`select name from ${sql.table(`${MIGRATION_SCHEMA}.${MIGRATION_TABLE}`)} order by name`.execute(db);
  return rows.rows.map((row) => row.name);
}

/**
 * The newest applied migration name, or `none` when nothing has been applied (including when
 * the migration table does not exist yet). Read-only.
 */
export async function readLatestMigration(db: Kysely<unknown>): Promise<string> {
  const applied = await readAppliedMigrations(db);
  return applied.at(-1) ?? 'none';
}

function assertOrdered(registry: readonly RegisteredMigration[]): void {
  const names = registry.map((migration) => migration.name);
  const sorted = [...names].sort();
  if (names.some((name, index) => name !== sorted[index]) || new Set(names).size !== names.length) {
    throw new Error('Migration registry must list unique names in ascending order');
  }
}
