import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationChecksumError,
  migrateToLatest,
  readLatestMigration,
} from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations, migrationRegistry } from '@knowscroll/migrations';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

/** A migration for this test only, with its correct checksum. */
function probeMigration(name: string, text: string) {
  return { name, sql: text, sha256: createHash('sha256').update(text).digest('hex') };
}

describe('the Kysely migrator with the static registry (real database)', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('migrator');
  });
  afterAll(async () => {
    await database.drop();
  });

  it('reports the newest registered migration of a migrated database', async () => {
    const expected = migrationRegistry.at(-1)?.name ?? 'none';
    expect(await readLatestMigration(database.db)).toBe(expected);
  });

  it('applies nothing when the database is current', async () => {
    const outcome = await migrateToLatest(database.db, loadMigrations());
    expect(outcome).toMatchObject({ kind: 'migrated', applied: [] });
  });

  it('rolls back the whole failing batch and reports nothing applied', async () => {
    const batch = [
      ...loadMigrations(),
      probeMigration('9989_good_before_failure', 'create table public.probe_batch_first (id int);'),
      probeMigration('9990_broken', 'create table public.probe_rolled_back (id int); select 1 / 0;'),
    ];
    const outcome = await migrateToLatest(database.db, batch);
    expect(outcome).toMatchObject({ kind: 'failed', failedMigration: '9990_broken', applied: [] });
    for (const table of ['public.probe_batch_first', 'public.probe_rolled_back']) {
      const present = await sql<{ present: boolean }>`select to_regclass(${table}) is not null as present`.execute(
        database.db,
      );
      expect({ table, present: present.rows[0]?.present }).toEqual({ table, present: false });
    }
  });

  it('refuses a migration whose text does not match its recorded SHA-256', async () => {
    const tampered = { ...probeMigration('9992_tampered', 'select 1;'), sql: 'select 2;' };
    await expect(migrateToLatest(database.db, [...loadMigrations(), tampered])).rejects.toBeInstanceOf(
      MigrationChecksumError,
    );
  });

  it('refuses to run when an applied migration was applied with different text than the registry now holds', async () => {
    const original = probeMigration('9993_checksummed', 'create table public.probe_checksummed (id int);');
    expect(await migrateToLatest(database.db, [...loadMigrations(), original])).toMatchObject({
      kind: 'migrated',
      applied: ['9993_checksummed'],
    });
    const edited = probeMigration('9993_checksummed', 'create table public.probe_checksummed (id bigint);');
    expect(await migrateToLatest(database.db, [...loadMigrations(), edited])).toEqual({
      kind: 'refused',
      reason: 'checksum_mismatch',
      migration: '9993_checksummed',
    });
  });

  it('refuses to run when an applied migration is missing from the registry', async () => {
    // 9993_checksummed was applied by the previous test and is not in the release's registry.
    expect(await readLatestMigration(database.db)).toBe('9993_checksummed');
    expect(await migrateToLatest(database.db, loadMigrations())).toMatchObject({ kind: 'failed' });
  });
});
