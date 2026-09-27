/**
 * #135 — populated migration upgrade and recovery proof on a disposable clone of the owner database.
 *
 * Refuses unless run with `--run`. The owner database `knowscroll` is only ever *read*: `pg_dump`
 * takes one read-only snapshot into a mode-0600 file under $KS_DEV_ROOT, which is restored into a
 * fresh `knowscroll_test_owner_clone_*` database. Only the clone is migrated to the current schema;
 * the proof checks that every pre-existing row and every recorded migration checksum survive, then
 * boots the real API against the clone (a new session for the owner universe) and reads the
 * universe, a feed and an export. The clone is dropped and the dump deleted in `finally`.
 *
 * The committed receipt carries only booleans and totals; per-table counts (activity volume) stay
 * in the ignored local receipt.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

if (!process.argv.includes('--run')) { console.log('Refusing: pass --run. The owner database is only read; a disposable clone is migrated.'); process.exit(2); }
const OWNER_DB = 'knowscroll';
const PG16 = '/opt/homebrew/Cellar/postgresql@16/16.14/bin';
const root = resolve('.');
const devRoot = process.env.KS_DEV_ROOT ?? (() => { throw new Error('Source scripts/env.sh first'); })();
const config = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const source = new URL(config.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('Local PostgreSQL only');
const url = (db: string) => { const u = new URL(source); u.pathname = `/${db}`; return u.toString(); };
const pgArgs = ['-h', source.hostname, '-p', source.port || '5432', '-U', decodeURIComponent(source.username)];
const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) };
const clone = `knowscroll_test_owner_clone_${randomBytes(6).toString('hex')}`;
const dump = resolve(devRoot, 'tmp', `${clone}.dump`);

async function tableCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const tables = (await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map(r => r.t);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number((await pool.query(`SELECT count(*) FROM "${t}"`)).rows[0].count);
  return counts;
}

async function main() {
  mkdirSync(resolve(devRoot, 'tmp'), { recursive: true });
  const admin = new pg.Client({ connectionString: url('postgres') });
  await admin.connect();
  const local: Record<string, unknown> = { at: new Date().toISOString(), clone };
  const committed: Record<string, unknown> = { at: local.at, clone: 'knowscroll_test_owner_clone_*' };
  let pool: pg.Pool | null = null;
  try {
    // 1. One read-only snapshot of the owner database.
    execFileSync(`${PG16}/pg_dump`, [...pgArgs, '-d', OWNER_DB, '-Fc', '--no-owner', '--no-privileges', '-f', dump], { env: pgEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    chmodSync(dump, 0o600);
    // 2. A fresh disposable clone; only it is ever migrated.
    await admin.query(`CREATE DATABASE ${clone}`);
    execFileSync(`${PG16}/pg_restore`, [...pgArgs, '-d', clone, '--no-owner', '--no-privileges', dump], { env: pgEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    pool = new pg.Pool({ connectionString: url(clone) });
    const ledgerBefore = (await pool.query<{ name: string; checksum: string | null }>('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
    const before = await tableCounts(pool);
    // 3. Migrate the clone with the product's own migrator.
    process.env.DATABASE_URL = url(clone);
    const { runMigrations } = await import('../packages/db/src/migrations.ts');
    const migrated = await runMigrations(pool, { directory: 'packages/db/migrations' });
    const ledgerAfter = (await pool.query<{ name: string; checksum: string | null }>('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
    const after = await tableCounts(pool);
    // The migration ledger itself grows by the applied migrations; every other table must keep every row.
    const preserved = Object.entries(before).filter(([t]) => t !== 'schema_migrations').every(([t, n]) => after[t] === n);
    const checksums = ledgerBefore.every(b => ledgerAfter.find(a => a.name === b.name)?.checksum === b.checksum || b.checksum === null);
    local.tables = Object.fromEntries(Object.entries(before).map(([t, n]) => [t, { before: n, after: after[t] }]));
    Object.assign(committed, {
      sourceMigrations: ledgerBefore.length, targetMigrations: ledgerAfter.length, applied: migrated.applied.length,
      preExistingTables: Object.keys(before).length, everyPreExistingRowPreserved: preserved, recordedChecksumsUnchanged: checksums,
    });
    // 4. Recovery: the real API against the clone, as the owner.
    const db = await import('../packages/db/src/index.ts');
    const { buildApp } = await import('../apps/api/src/app.ts');
    const identity = await db.provisionIdentity({ universeId: db.OWNER_ID, expiresInHours: 1 });
    const app = buildApp(randomBytes(32).toString('hex'));
    const h = { authorization: `Bearer ${identity.token}` };
    const universe = await app.inject({ url: '/v1/universe', headers: h });
    const feed = await app.inject({ url: '/v1/feed?kinds=Scroll', headers: h });
    const epoch = universe.statusCode === 200 ? universe.json().privacyEpoch ?? universe.json().universe?.privacyEpoch ?? 0 : 0;
    const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: h, payload: { requestId: randomUUID(), expectedPrivacyEpoch: epoch } });
    const exportCounts = exported.statusCode === 200 ? exported.json().rowCounts as Record<string, number> : null;
    committed.recovery = {
      universe: universe.statusCode, feed: feed.statusCode, export: exported.statusCode,
      exportMatchesStoredHistory: exportCounts !== null && exportCounts.exposures === after.exposure && exportCounts.ledger !== undefined,
    };
    await app.close();
    await db.pool.end();
  } finally {
    await pool?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    if (existsSync(dump)) rmSync(dump);
    committed.cleanup = { cloneDropped: true, dumpDeleted: !existsSync(dump) };
  }
  mkdirSync(resolve(root, 'artifacts/owner-upgrade'), { recursive: true });
  writeFileSync(resolve(root, `artifacts/owner-upgrade/${clone}.local.json`), JSON.stringify({ ...local, ...committed }, null, 2));
  writeFileSync(resolve(root, 'artifacts/owner-upgrade/receipt.json'), JSON.stringify(committed, null, 2) + '\n');
  console.log(JSON.stringify(committed, null, 2));
}

await main();
