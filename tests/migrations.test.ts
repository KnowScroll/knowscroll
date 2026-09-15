import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { ORIGINAL_BOOTSTRAP_SHA256, runMigrations } from '../packages/db/src/migrations.ts';

const databaseUrl: string = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith('knowscroll_test_')) {
  throw new Error(`Migration tests require a disposable knowscroll_test_* database, received ${databaseName}`);
}

async function withSchema(
  name: string,
  fn: (pool: pg.Pool, directory: string) => Promise<void>,
): Promise<void> {
  const schema = `migration_${name}_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const directory = await mkdtemp(join(tmpdir(), 'knowscroll-migrations-'));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  try {
    await fn(pool, directory);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true });
  }
}

test('migration integrity against disposable PostgreSQL', async (t) => {
  await t.test('fresh install records checksums and repeat is a no-op', async () => {
    await withSchema('fresh', async (pool, directory) => {
      await writeFile(join(directory, '0001_create.sql'), 'CREATE TABLE sample (id integer PRIMARY KEY);\n');
      assert.deepEqual(await runMigrations(pool, { directory }), { applied: ['0001_create.sql'], adopted: [] });
      assert.deepEqual(await runMigrations(pool, { directory }), { applied: [], adopted: [] });
      const rows = await pool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
      assert.equal(rows.rows[0]?.name, '0001_create.sql');
      assert.match(rows.rows[0]?.checksum ?? '', /^[0-9a-f]{64}$/);
    });
  });

  await t.test('changed and missing applied migrations fail closed', async () => {
    await withSchema('drift', async (pool, directory) => {
      const path = join(directory, '0001_create.sql');
      await writeFile(path, 'CREATE TABLE sample (id integer PRIMARY KEY);\n');
      await runMigrations(pool, { directory });
      await writeFile(path, 'CREATE TABLE sample (id bigint PRIMARY KEY);\n');
      await assert.rejects(runMigrations(pool, { directory }), /checksum mismatch: 0001_create.sql/);
      await rm(path);
      await assert.rejects(runMigrations(pool, { directory }), /missing from disk: 0001_create.sql/);
    });
  });

  await t.test('failed migration rolls back its SQL and ledger row', async () => {
    await withSchema('rollback', async (pool, directory) => {
      await writeFile(
        join(directory, '0001_broken.sql'),
        'CREATE TABLE should_rollback (id integer);\nSELECT missing_column FROM should_rollback;\n',
      );
      await assert.rejects(runMigrations(pool, { directory }), /missing_column/);
      const tables = await pool.query("SELECT to_regclass('should_rollback') AS name, to_regclass('schema_migrations') AS ledger");
      assert.equal(tables.rows[0]?.name, null);
      assert.equal(tables.rows[0]?.ledger, null);
    });
  });

  await t.test('concurrent runners serialize and apply once', async () => {
    await withSchema('concurrent', async (pool, directory) => {
      await writeFile(
        join(directory, '0001_once.sql'),
        'CREATE TABLE migration_probe (id integer PRIMARY KEY);\nSELECT pg_sleep(0.2);\nINSERT INTO migration_probe VALUES (1);\n',
      );
      const results = await Promise.all([
        runMigrations(pool, { directory }),
        runMigrations(pool, { directory }),
      ]);
      assert.deepEqual(results.map((result) => result.applied.length).sort(), [0, 1]);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM migration_probe')).rows[0]?.count, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0]?.count, 1);
    });
  });

  await t.test('adopts only the known original bootstrap checksum', async () => {
    await withSchema('legacy', async (pool, directory) => {
      const bootstrap = await readFile('packages/db/migrations/0001_bootstrap.sql', 'utf8');
      await writeFile(join(directory, '0001_bootstrap.sql'), bootstrap);
      await pool.query(bootstrap);
      await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await pool.query("INSERT INTO schema_migrations(name) VALUES ('0001_bootstrap.sql')");
      const result = await runMigrations(pool, { directory });
      assert.deepEqual(result, { applied: [], adopted: ['0001_bootstrap.sql'] });
      assert.equal((await pool.query('SELECT checksum FROM schema_migrations')).rows[0]?.checksum, ORIGINAL_BOOTSTRAP_SHA256);
    });
  });

  await t.test('rejects arbitrary checksum-less legacy SQL', async () => {
    await withSchema('untrusted', async (pool, directory) => {
      await writeFile(join(directory, '0001_bootstrap.sql'), 'SELECT 1;\n');
      await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await pool.query("INSERT INTO schema_migrations(name) VALUES ('0001_bootstrap.sql')");
      await assert.rejects(runMigrations(pool, { directory }), /no trusted checksum: 0001_bootstrap.sql/);
      const columns = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='schema_migrations' AND column_name='checksum'",
      );
      assert.equal(columns.rowCount, 0);
    });
  });

  await t.test('unknown legacy rows reject before adoption or pending SQL', async () => {
    await withSchema('unknown', async (pool, directory) => {
      const bootstrap = await readFile('packages/db/migrations/0001_bootstrap.sql', 'utf8');
      await writeFile(join(directory, '0001_bootstrap.sql'), bootstrap);
      await writeFile(join(directory, '0002_pending.sql'), 'CREATE TABLE must_not_run (id integer);\n');
      await pool.query(bootstrap);
      await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await pool.query("INSERT INTO schema_migrations(name) VALUES ('0001_bootstrap.sql'), ('0099_unknown.sql')");
      await assert.rejects(runMigrations(pool, { directory }), /missing from disk: 0099_unknown.sql/);
      assert.equal((await pool.query("SELECT to_regclass('must_not_run') AS name")).rows[0]?.name, null);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='schema_migrations' AND column_name='checksum'")).rows[0]?.count,
        0,
      );
    });
  });

  await t.test('rejects an out-of-order migration before pending SQL', async () => {
    await withSchema('order', async (pool, directory) => {
      await writeFile(join(directory, '0001_first.sql'), 'CREATE TABLE first_done (id integer);\n');
      await writeFile(join(directory, '0002_gap.sql'), 'CREATE TABLE must_not_run (id integer);\n');
      await writeFile(join(directory, '0003_third.sql'), 'CREATE TABLE third_done (id integer);\n');
      await runMigrations(pool, { directory });
      await pool.query("DELETE FROM schema_migrations WHERE name='0002_gap.sql'");
      await pool.query('DROP TABLE must_not_run');
      await assert.rejects(runMigrations(pool, { directory }), /not an ordered prefix: expected 0002_gap.sql before 0003_third.sql/);
      assert.equal((await pool.query("SELECT to_regclass('must_not_run') AS name")).rows[0]?.name, null);
    });
  });
});
