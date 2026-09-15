import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Optional local configuration; never required or loaded implicitly in deployment.
export function loadLocalEnv() {
  try { for (const line of readFileSync(resolve('.env'), 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!;
  }} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
loadLocalEnv();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required; see docs/operations/development.md');
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 });
export const OWNER_ID = '00000000-0000-4000-8000-000000000001';
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
 const c = await pool.connect();
 try { await c.query('BEGIN'); const out=await fn(c); await c.query('COMMIT'); return out; }
 catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export async function lockUniverse(c: pg.PoolClient) { await c.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [OWNER_ID]); }
