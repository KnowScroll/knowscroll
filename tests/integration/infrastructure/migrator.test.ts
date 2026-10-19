import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, readLatestMigration } from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations, migrationRegistry } from '@knowscroll/migrations';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

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

  it('rolls back a failing migration and names it', async () => {
    const broken = [
      ...loadMigrations(),
      { name: '9990_broken', sql: 'create table public.probe_rolled_back (id int); select 1 / 0;' },
    ];
    const outcome = await migrateToLatest(database.db, broken);
    expect(outcome).toMatchObject({ kind: 'failed', failedMigration: '9990_broken' });
    const table = await sql<{
      present: boolean;
    }>`select to_regclass('public.probe_rolled_back') is not null as present`.execute(database.db);
    expect(table.rows[0]?.present).toBe(false);
  });

  it('refuses to run when an applied migration is missing from the registry', async () => {
    const extended = [...loadMigrations(), { name: '9991_probe', sql: 'create table public.probe_applied (id int);' }];
    expect(await migrateToLatest(database.db, extended)).toMatchObject({ kind: 'migrated', applied: ['9991_probe'] });
    expect(await readLatestMigration(database.db)).toBe('9991_probe');
    expect(await migrateToLatest(database.db, loadMigrations())).toMatchObject({ kind: 'failed' });
  });
});
