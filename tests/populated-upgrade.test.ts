/**
 * #168 (ADR-0047) — a populated upgrade from migration 0009 to head, on a disposable schema; the
 * owner database is never migrated to prove this. A schema is built from the released migrations up
 * to 0009 and filled with history exactly as the 0009-era API and worker wrote it: the owner
 * universe after one Clear (its receipt), a live and a stale device session, served decisions,
 * exposures, keeps with their completed projection jobs and Traces, and an explicit Ask. It is then
 * migrated to head. Every row that existed keeps every column it had, byte for byte, and the
 * checksums of 0001–0009 are unchanged. The current API then reads that history back: the live
 * session authenticates and the stale one does not, the Traces list with their titles, a saved
 * Trace reopens, and the export counts every row.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

import { runMigrations } from '../packages/db/src/migrations.ts';

const databaseUrl = process.env.DATABASE_URL!;
if (!new URL(databaseUrl).pathname.startsWith('/knowscroll_test_')) throw new Error('requires a disposable knowscroll_test_* database');
const FROM = '0009_explicit_asks.sql';
const OWNER_ID = '00000000-0000-4000-8000-000000000001';

async function released(): Promise<string[]> {
  return (await readFile('packages/db/migrations/RELEASED.txt', 'utf8')).split('\n').map(l => l.trim()).filter(l => l.endsWith('.sql'));
}

async function install(directory: string, names: string[]): Promise<void> {
  for (const name of names) await writeFile(join(directory, name), await readFile(join('packages/db/migrations', name)));
}

/** Every table's rows, each reduced to [columns] -- the columns the table had at 0009. */
async function snapshot(pool: pg.Pool, columns: Map<string, string[]>) {
  const tables: Record<string, unknown[]> = {};
  for (const [table, names] of columns) {
    const list = names.map(n => `"${n}"`).join(',');
    tables[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows
      FROM (SELECT ${list} FROM "${table}") t`)).rows[0]!.rows;
  }
  return tables;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('history written at 0009 survives the upgrade to head unchanged and the current API reads it', async () => {
  const schema = `upgrade_0009_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'knowscroll-populated-upgrade-'));
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  try {
    const names = await released();
    const upTo0009 = names.slice(0, names.indexOf(FROM) + 1);
    await install(directory, upTo0009);
    assert.deepEqual((await runMigrations(pool, { directory })).applied, upTo0009);

    // --- The owner's history in the 0009 shape ------------------------------------------------
    const scrolls = [1, 2, 3].map(order => ({
      assetId: randomUUID(), revision: 1, kind: 'Scroll', title: `Upgrade Scroll ${order}`, summary: `Summary ${order}`,
      body: `Body ${order}`, sourceTitle: `Source ${order}`, sourceUrl: `https://example.test/upgrade/${order}`, truthState: 'documented', order,
    }));
    for (const s of scrolls) {
      await pool.query(`INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s.assetId, s.revision, s.kind, s.title, s.summary, s.body, s.sourceTitle, s.sourceUrl, s.truthState, s.order]);
    }
    const candidate = (s: typeof scrolls[number], reason: string) => {
      const { order: _order, ...snapshotFields } = s;
      return { ...snapshotFields, reason };
    };
    // One Clear already happened: epoch 0 -> 1. Clear rolled the calling session forward; the other
    // device's session stayed at epoch 0 and was later revoked.
    const liveToken = randomBytes(32).toString('base64url'), staleToken = randomBytes(32).toString('base64url');
    const liveSession = randomUUID(), liveDevice = randomUUID(), staleSession = randomUUID(), staleDevice = randomUUID();
    await pool.query('INSERT INTO universe(id,revision,privacy_epoch) VALUES($1,4,1)', [OWNER_ID]);
    await pool.query('INSERT INTO accounts(universe_id,revision,kept_asset_ids) VALUES($1,3,$2)', [OWNER_ID, [scrolls[0]!.assetId, scrolls[2]!.assetId]]);
    await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,created_at,expires_at)
      VALUES($1,$2,$3,$4,1,now()-interval '2 days',now()+interval '28 days')`, [liveSession, OWNER_ID, liveDevice, sha256(liveToken)]);
    await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,created_at,expires_at,revoked_at)
      VALUES($1,$2,$3,$4,0,now()-interval '3 days',now()+interval '27 days',now()-interval '1 day')`, [staleSession, OWNER_ID, staleDevice, sha256(staleToken)]);
    await pool.query(`INSERT INTO history_clear_receipt(id,universe_id,request_id,epoch_before,epoch_after,cleared_at)
      VALUES($1,$2,$3,0,1,now()-interval '2 days')`, [randomUUID(), OWNER_ID, randomUUID()]);

    const firstDecision = randomUUID(), secondDecision = randomUUID();
    await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'editorial-unkept-v1',$3,1)`,
      [firstDecision, OWNER_ID, JSON.stringify(scrolls.map(s => candidate(s, 'An editorial starting encounter. No interests have been inferred.')))]);
    await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,1,'editorial-unkept-v1',$3,1)`,
      [secondDecision, OWNER_ID, JSON.stringify(scrolls.slice(1).map(s => candidate(s, 'A different sourced encounter; already-kept Scrolls are excluded.')))]);

    const expose = async (decisionId: string, assetId: string) => {
      const exposureId = randomUUID(), eventId = randomUUID(), clientExposureId = randomUUID();
      await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,'exposure',$3,$4,1)`,
        [eventId, OWNER_ID, clientExposureId, JSON.stringify({ decisionId, assetId, clientExposureId, exposureId })]);
      await pool.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)',
        [exposureId, OWNER_ID, decisionId, assetId, eventId, clientExposureId]);
      return { exposureId, eventId, decisionId, assetId };
    };
    const keep = async (exposure: Awaited<ReturnType<typeof expose>>) => {
      const eventId = randomUUID(), clientEventId = randomUUID();
      await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,'keep',$3,$4,$5,1)`,
        [eventId, OWNER_ID, clientEventId, exposure.eventId, JSON.stringify({ clientEventId, exposureId: exposure.exposureId, assetId: exposure.assetId, kind: 'keep' })]);
      await pool.query(`INSERT INTO job(id,universe_id,event_id,kind,privacy_epoch,status,attempts,completed_at) VALUES($1,$2,$3,'project_keep',1,'completed',1,now())`,
        [randomUUID(), OWNER_ID, eventId]);
      await pool.query('INSERT INTO trace(universe_id,asset_id,event_id) VALUES($1,$2,$3)', [OWNER_ID, exposure.assetId, eventId]);
      return eventId;
    };
    const first = await expose(firstDecision, scrolls[0]!.assetId);
    const asked = await expose(firstDecision, scrolls[1]!.assetId);
    const third = await expose(secondDecision, scrolls[2]!.assetId);
    const keptFirst = await keep(first), keptThird = await keep(third);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const askEvent = randomUUID(), clientAskId = randomUUID();
      await client.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,'ask',$3,$4,$5,1)`,
        [askEvent, OWNER_ID, clientAskId, asked.eventId, JSON.stringify({ question: 'Why does this matter?', exposureId: asked.exposureId,
          decisionId: asked.decisionId, assetId: asked.assetId, sessionId: liveSession, clientAskId, expectedPrivacyEpoch: 1 })]);
      await client.query(`INSERT INTO explicit_ask(id,event_id,universe_id,privacy_epoch,session_id,client_ask_id,exposure_id) VALUES($1,$2,$3,1,$4,$5,$6)`,
        [randomUUID(), askEvent, OWNER_ID, liveSession, clientAskId, asked.exposureId]);
      await client.query('COMMIT');
    } finally { client.release(); }

    // --- Upgrade --------------------------------------------------------------------------------
    const columns = new Map((await pool.query<{ table_name: string; columns: string[] }>(`SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns WHERE table_schema=current_schema() AND table_name<>'schema_migrations' GROUP BY table_name`)).rows.map(r => [r.table_name, r.columns]));
    const before = await snapshot(pool, columns);
    const checksumsBefore = (await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;

    const toHead = names.slice(upTo0009.length);
    await install(directory, toHead);
    assert.deepEqual((await runMigrations(pool, { directory })).applied, toHead);
    assert.deepEqual((await runMigrations(pool, { directory })).applied, [], 'a second run applies nothing');

    assert.deepEqual(await snapshot(pool, columns), before, 'every row that existed keeps every column it had');
    assert.deepEqual((await pool.query('SELECT name,checksum FROM schema_migrations WHERE name<=$1 ORDER BY name', [FROM])).rows, checksumsBefore);
    const counts = (table: string) => (before[table] as unknown[]).length;
    assert.deepEqual(
      { sessions: counts('device_session'), clears: counts('history_clear_receipt'), decisions: counts('decision'), ledger: counts('ledger'),
        exposures: counts('exposure'), jobs: counts('job'), traces: counts('trace'), asks: counts('explicit_ask') },
      { sessions: 2, clears: 1, decisions: 2, ledger: 6, exposures: 3, jobs: 2, traces: 2, asks: 1 },
    );

    // --- The current API reads it -----------------------------------------------------------------
    process.env.DATABASE_URL = url.toString();
    const db = await import('../packages/db/src/index.ts');
    const { buildApp } = await import('../apps/api/src/app.ts');
    const app = buildApp(randomBytes(32).toString('hex'));
    try {
      const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
      const session = await app.inject({ url: '/v1/session', headers: bearer(liveToken) });
      assert.equal(session.statusCode, 200);
      const { sessionId, deviceId, universeId, privacyEpoch } = session.json() as Record<string, unknown>;
      assert.deepEqual({ sessionId, deviceId, universeId, privacyEpoch }, { sessionId: liveSession, deviceId: liveDevice, universeId: OWNER_ID, privacyEpoch: 1 });
      assert.equal((await app.inject({ url: '/v1/session', headers: bearer(staleToken) })).statusCode, 401, 'the revoked, stale session stays ended');

      const universe = await app.inject({ url: '/v1/universe', headers: bearer(liveToken) });
      assert.equal(universe.statusCode, 200);
      assert.equal(universe.json().privacyEpoch, 1);
      assert.deepEqual(
        universe.json().traces.map((t: { eventId: string; assetId: string; title: string }) => [t.eventId, t.assetId, t.title]).sort(),
        [[keptFirst, scrolls[0]!.assetId, scrolls[0]!.title], [keptThird, scrolls[2]!.assetId, scrolls[2]!.title]].sort(),
      );
      const revisit = await app.inject({ url: `/v1/traces/${keptThird}`, headers: bearer(liveToken) });
      assert.equal(revisit.statusCode, 200);
      assert.equal(revisit.json().exposureId, third.exposureId);
      assert.equal(revisit.json().scroll.title, scrolls[2]!.title);

      const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: bearer(liveToken),
        payload: { requestId: randomUUID(), expectedPrivacyEpoch: 1 } });
      assert.equal(exported.statusCode, 200);
      const { rowCounts } = exported.json();
      assert.deepEqual(
        { decisions: rowCounts.decisions, ledger: rowCounts.ledger, exposures: rowCounts.exposures, traces: rowCounts.traces, jobs: rowCounts.jobs },
        { decisions: 2, ledger: 6, exposures: 3, traces: 2, jobs: 2 },
      );
      // The two recorded devices, plus the development session every API start enrolls.
      assert.equal(rowCounts.deviceSessions, 3);
    } finally {
      await app.close();
      await db.pool.end();
    }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true });
  }
});
