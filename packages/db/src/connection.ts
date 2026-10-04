// Database connection and the two locks every domain transaction starts from. Importing this
// module has side effects, on purpose: it copies an optional local .env into unset process.env
// keys, refuses to start without DATABASE_URL, and creates the process's single pg pool. Every db
// module that needs the pool imports it from here, so loading any of them loads the environment
// exactly once (ADR-0048).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Optional local configuration; never required or loaded implicitly in deployment.
export function loadLocalEnv() {
  try {
    for (const line of readFileSync(resolve('.env'), 'utf8').split('\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (match && process.env[match[1]!] === undefined)
        process.env[match[1]!] = match[2]!;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
loadLocalEnv();
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL required; see docs/operations/development.md');
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
});
export const OWNER_ID = '00000000-0000-4000-8000-000000000001';
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  db: pg.Pool = pool,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function lockUniverse(c: pg.PoolClient, universeId = OWNER_ID) {
  const row = await c.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [
    universeId,
  ]);
  if (!row.rowCount) throw new Error('Universe not found');
}
