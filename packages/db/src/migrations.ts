import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const MIGRATION_LOCK_ID = 4_310_001;
const BOOTSTRAP_NAME = '0001_bootstrap.sql';

// Digest of the original bootstrap committed in 211f7d3. This constant makes the
// legacy adoption path an explicit compatibility decision, not a blanket trust
// of whichever SQL happens to be on disk.
export const ORIGINAL_BOOTSTRAP_SHA256 = 'c0c881a391eeb063502e94ad1af768bb3ee09996b9c58a4a7788736f49a06188';

export interface MigrationResult {
  applied: string[];
  adopted: string[];
}

export interface MigrationOptions {
  directory: string;
}

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, checksum: sha256(sql) };
  }));
}

export async function runMigrations(pool: pg.Pool, options: MigrationOptions): Promise<MigrationResult> {
  const migrations = await readMigrations(options.directory);
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], adopted: [] };

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Bootstrap installations created before checksums have this table without
    // the column. It stays nullable until every row has passed validation.
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');

    const applied = await client.query<{ name: string; checksum: string | null }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );

    for (const row of applied.rows) {
      const migration = byName.get(row.name);
      if (!migration) throw new Error(`Applied migration is missing from disk: ${row.name}`);

      if (row.checksum === null) {
        if (row.name !== BOOTSTRAP_NAME || migration.checksum !== ORIGINAL_BOOTSTRAP_SHA256) {
          throw new Error(`Migration has no trusted checksum: ${row.name}`);
        }
        await client.query('UPDATE schema_migrations SET checksum=$1 WHERE name=$2 AND checksum IS NULL', [
          ORIGINAL_BOOTSTRAP_SHA256,
          BOOTSTRAP_NAME,
        ]);
        result.adopted.push(row.name);
      } else if (row.checksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch: ${row.name}`);
      }
    }

    for (const [index, row] of applied.rows.entries()) {
      const expected = migrations[index]?.name;
      if (row.name !== expected) {
        throw new Error(`Applied migrations are not an ordered prefix: expected ${expected ?? 'no entry'} before ${row.name}`);
      }
    }

    for (const migration of migrations) {
      if (applied.rows.some((row) => row.name === migration.name)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      result.applied.push(migration.name);
    }

    await client.query('ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
