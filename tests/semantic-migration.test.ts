/**
 * #131 — populated upgrade to migration 0026. A schema is built from every released migration
 * before 0026, filled with real bootstrap history (universe, decision, exposure/keep ledger
 * events, a projected Trace and a derived world system), then upgraded. Every prior row, column
 * and checksum must survive unchanged, the ledger must still accept its old kinds plus `branch`,
 * and the new tables start empty (no knowledge is invented by a migration).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

import { runMigrations } from '../packages/db/src/migrations.ts';
import { projectWorldsForEncounter } from '../packages/db/src/worlds.ts';

const databaseUrl = process.env.DATABASE_URL!;
if (!new URL(databaseUrl).pathname.startsWith('/knowscroll_test_')) throw new Error('requires a disposable knowscroll_test_* database');
const TARGET = '0026_semantic_substrate.sql';

async function releasedBefore(target: string): Promise<string[]> {
  const names = (await readFile('packages/db/migrations/RELEASED.txt', 'utf8')).split('\n').map(l => l.trim()).filter(l => l.endsWith('.sql'));
  return names.slice(0, names.indexOf(target));
}

async function snapshot(pool: pg.Pool) {
  const tables = (await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'schema_migrations' ORDER BY table_name`)).rows;
  return Promise.all(tables.map(async ({ table_name }) => ({ table: table_name, rows: (await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${table_name}" t`)).rows[0]!.rows })));
}

test('0026 upgrades populated history exactly once without rewriting prior rows or checksums', async () => {
  const schema = `migration_semantic_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'knowscroll-semantic-migration-'));
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  try {
    const prior = await releasedBefore(TARGET);
    for (const name of prior) await writeFile(join(directory, name), await readFile(join('packages/db/migrations', name)));
    assert.deepEqual((await runMigrations(pool, { directory })).applied, prior);

    // Real bootstrap history: a Scroll, a decision naming it, an exposure and a keep with its job,
    // a projected Trace, and the derived world system the exposure projection maintains.
    const universeId = randomUUID(), assetId = randomUUID(), decisionId = randomUUID();
    const exposureEvent = randomUUID(), keepEvent = randomUUID(), exposureId = randomUUID();
    await pool.query('INSERT INTO universe(id) VALUES($1)', [universeId]);
    await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [universeId]);
    await pool.query(`INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
      VALUES($1,1,'Scroll','Upgrade fixture','Summary','Body','Fixture source','https://example.test/upgrade','documented',1)`, [assetId]);
    await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'upgrade-fixture',$3,0)`,
      [decisionId, universeId, JSON.stringify([{ assetId, kind: 'Scroll' }])]);
    await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,'exposure',$3,'{}',0)`, [exposureEvent, universeId, randomUUID()]);
    await pool.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)', [exposureId, universeId, decisionId, assetId, exposureEvent, randomUUID()]);
    await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,'keep',$3,$4,'{}',0)`, [keepEvent, universeId, randomUUID(), exposureEvent]);
    await pool.query(`INSERT INTO job(id,universe_id,event_id,kind,privacy_epoch,status,completed_at) VALUES($1,$2,$3,'project_keep',0,'completed',now())`, [randomUUID(), universeId, keepEvent]);
    await pool.query('INSERT INTO trace(universe_id,asset_id,event_id) VALUES($1,$2,$3)', [universeId, assetId, keepEvent]);
    const client = await pool.connect();
    try { await client.query('BEGIN'); await projectWorldsForEncounter(client, universeId); await client.query('COMMIT'); } finally { client.release(); }

    const before = await snapshot(pool);
    const checksumsBefore = (await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;

    await writeFile(join(directory, TARGET), await readFile(join('packages/db/migrations', TARGET)));
    assert.deepEqual((await runMigrations(pool, { directory })).applied, [TARGET]);
    assert.deepEqual((await runMigrations(pool, { directory })).applied, []);

    const after = await snapshot(pool);
    const priorTables = new Set(before.map(t => t.table));
    assert.deepEqual(after.filter(t => priorTables.has(t.table)), before, 'every prior row is unchanged');
    for (const t of after.filter(t => !priorTables.has(t.table))) assert.deepEqual(t.rows, [], `${t.table} starts empty`);
    assert.deepEqual((await pool.query('SELECT name,checksum FROM schema_migrations WHERE name<>$1 ORDER BY name', [TARGET])).rows, checksumsBefore);

    // Old kinds still insert; `branch` is newly admissible; anything else is still refused.
    for (const kind of ['exposure', 'keep', 'branch']) {
      await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,$3,$4,$5,'{}',0)`,
        [randomUUID(), universeId, kind, randomUUID(), exposureEvent]);
    }
    await assert.rejects(pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,'watch',$3,'{}',0)`, [randomUUID(), universeId, randomUUID()]), /ledger_kind_check/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true });
  }
});
