/**
 * #160 (ADR-0040) — a source correction reaches the reader's places while they are away, over the
 * real Fastify app, database and worker. Every reader here builds real attention by reading and
 * keeping through the API (places formed from supplied accounts would retire at the first real
 * refresh), in a neighbourhood of their own, so a correction to it reaches no other test.
 *
 * The worker's pass refreshes each reader who is behind the append-only correction log, exactly as
 * their next action would have: the change appears on the return with its own cause, a paused
 * reader waits until they resume, a second pass does nothing, a correction that commits after a
 * refresh read the count is still caught up, one reader's failure holds no one else back, and Clear
 * and Reset erase the record.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { awayResponse } from '../packages/contracts/src/away.ts';
import type { SubstrateSeed } from '../packages/contracts/src/semantic.ts';
import { lockUniverse, pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { catchUpUniverse, runCorrectionRefreshPass } from '../packages/db/src/semantic/correction-refresh.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { refreshPersonalModel } from '../packages/db/src/semantic/personal-model.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { insertScroll } from './helpers/inquiry-fixture.ts';
import { readFirstOffered, readScroll } from './helpers/reading.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Correction refresh tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'));
await app.ready();
after(async () => { await app.close(); await pool.end(); });

type Reader = { universeId: string; headers: { authorization: string }; aurorasSource: string; planetId: string; sightingId: string };

/**
 * Magnetism, with two Scrolls from one source family and one from another, explains Auroras through
 * a claim only the auroras source supports. No Scroll is about Auroras, so reading never meets it:
 * it stays on Magnetism's horizon until that source goes.
 */
async function neighbourhood() {
  const tag = `c${randomBytes(5).toString('hex')}`;
  const codes = { magnetism: `${tag}.magnetism`, auroras: `${tag}.auroras` };
  const claims = { pull: `clm.${tag}.pull`, compass: `clm.${tag}.compass`, auroras: `clm.${tag}.auroras` };
  const sources = { lab: `src.${tag}.lab`, field: `src.${tag}.field`, auroras: `src.${tag}.auroras` };
  const url = (s: string) => `https://example.test/${tag}/${s}`;
  const scrolls = {
    lab: await insertScroll(pool, `${tag} A pull without touching`, 'Lab fixture', url('lab')),
    labAgain: await insertScroll(pool, `${tag} Iron filings draw the field`, 'Lab fixture', url('lab')),
    field: await insertScroll(pool, `${tag} Why a compass points north`, 'Field fixture', url('field')),
  };
  const quote = 'A verbatim passage long enough to be a quote.';
  const support = (sourceKey: string) => [{ sourceKey, quote, supportKind: 'supports' as const }];
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-09-25.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [
      { key: `fam.${tag}.lab`, kind: 'publisher', description: 'Synthetic correction test family' },
      { key: `fam.${tag}.field`, kind: 'publisher', description: 'A second synthetic correction test family' },
    ],
    sources: (['lab', 'field', 'auroras'] as const).map(s => ({
      key: sources[s], url: url(s), title: `${s[0]!.toUpperCase()}${s.slice(1)} fixture`, publisher: 'Fixture',
      familyKey: s === 'field' ? `fam.${tag}.field` : `fam.${tag}.lab`, retrievedAt: '2026-09-25', contentSha256: randomBytes(32).toString('hex'),
    })),
    concepts: [
      { code: tag, name: 'Correction fixture root', description: 'Root of a synthetic correction test substrate', kind: 'idea', parentCode: null },
      { code: codes.magnetism, name: 'Magnetism', description: 'The force between magnets and moving charges', kind: 'phenomenon', parentCode: tag },
      { code: codes.auroras, name: 'Auroras', description: 'Light in the polar sky from charged particles', kind: 'phenomenon', parentCode: tag },
    ],
    claims: [
      { key: claims.pull, statement: 'A magnet pulls on iron without touching it.', truthState: 'documented', concepts: [{ code: codes.magnetism, role: 'subject' }], support: support(sources.lab) },
      { key: claims.compass, statement: 'A compass needle lines up with the magnetic field of the Earth.', truthState: 'documented', concepts: [{ code: codes.magnetism, role: 'subject' }], support: support(sources.field) },
      { key: claims.auroras, statement: 'The magnetic field of the Earth guides charged particles into the polar sky, where they glow as auroras.', truthState: 'documented',
        concepts: [{ code: codes.magnetism, role: 'mechanism' }, { code: codes.auroras, role: 'subject' }], support: support(sources.auroras) },
    ],
    relations: [{ from: codes.magnetism, to: codes.auroras, kind: 'explains', claimKey: claims.auroras }],
    assets: [
      { assetId: scrolls.lab, concepts: [{ code: codes.magnetism, role: 'primary' }], claims: [claims.pull] },
      { assetId: scrolls.labAgain, concepts: [{ code: codes.magnetism, role: 'primary' }], claims: [claims.pull] },
      { assetId: scrolls.field, concepts: [{ code: codes.magnetism, role: 'primary' }], claims: [claims.compass] },
    ],
    bridgeProposals: [],
  };
  const loaded = await transaction(client => loadSubstrateSeed(client, JSON.stringify(seed)));
  if (loaded.status !== 'loaded') throw new Error('correction fixture substrate did not load');
  return { codes, sources, scrolls };
}

/** Two days of reading, compressed as in `tests/atlas-places.test.ts`' anchorGravity: yesterday's
 * rows are moved back a day in this disposable database. Magnetism forms, Auroras on its horizon. */
async function anchoredReader(): Promise<Reader> {
  const n = await neighbourhood();
  const identity = await provisionIdentity();
  const headers = { authorization: `Bearer ${identity.token}` };
  await readScroll(app, headers, n.scrolls.lab, true);
  await pool.query("UPDATE ledger SET created_at = created_at - interval '1 day' WHERE universe_id=$1", [identity.scope.universeId]);
  await readScroll(app, headers, n.scrolls.labAgain, true);
  await readScroll(app, headers, n.scrolls.field, true);
  const places = (await pool.query<{ id: string; kind: string; code: string }>(
    `SELECT p.id, p.kind, c.code FROM atlas_place p JOIN concept c ON c.id=p.anchor_concept_id WHERE p.universe_id=$1 AND p.state='live'`,
    [identity.scope.universeId])).rows;
  const planet = places.find(p => p.code === n.codes.magnetism && p.kind === 'planet');
  const sighting = places.find(p => p.code === n.codes.auroras && p.kind === 'sighting');
  assert.ok(planet && sighting, JSON.stringify(places));
  return { universeId: identity.scope.universeId, headers, aurorasSource: n.sources.auroras, planetId: planet.id, sightingId: sighting.id };
}

/** The publisher withdraws the page behind Auroras: an operator correction, committed. */
const withdraw = (sourceKey: string) => transaction(client =>
  correctSourceSnapshot(client, { sourceKey, action: 'revoked', reason: 'Test: the publisher withdrew this page' }, 'operator'));

const committedCorrections = async () => Number((await pool.query('SELECT count(*) FROM semantic_correction')).rows[0].count);
const record = async (r: Reader) => (await pool.query<{ corrections_seen: number; refreshed_at: Date }>(
  'SELECT corrections_seen, refreshed_at FROM correction_catch_up WHERE universe_id=$1', [r.universeId])).rows[0];
const sightingState = async (r: Reader) => (await pool.query<{ state: string }>('SELECT state FROM atlas_place WHERE id=$1', [r.sightingId])).rows[0]!.state;
const ledgerRows = async (r: Reader) => Number((await pool.query('SELECT count(*) FROM ledger WHERE universe_id=$1', [r.universeId])).rows[0].count);

async function away(r: Reader) {
  const response = await app.inject({ url: '/v1/away', headers: r.headers });
  assert.equal(response.statusCode, 200, response.body);
  return awayResponse.parse(response.json());
}
const privacy = (r: Reader, action: 'pause' | 'resume') =>
  app.inject({ method: 'POST', url: `/v1/privacy/${action}`, headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });

/** The worker's pass, run until it refreshes no one (other files' readers may be behind too).
 * Returns everyone it refreshed and everyone whose refresh failed. */
async function drain(): Promise<{ refreshed: Set<string>; failed: Set<string> }> {
  const refreshed = new Set<string>(), failed = new Set<string>();
  for (let pass = 0; pass < 100; pass += 1) {
    const result = await runCorrectionRefreshPass(pool, { limit: 50 });
    for (const id of result.failed) failed.add(id);
    if (result.refreshed.length === 0) return { refreshed, failed };
    for (const id of result.refreshed) refreshed.add(id);
  }
  throw new Error('the correction refresh never settled');
}

/** The place change the correction caused, as the reader sees it on the return. */
async function assertAurorasLeft(r: Reader) {
  assert.equal(await sightingState(r), 'retired');
  const retired = (await pool.query(`SELECT causal_class FROM atlas_delta WHERE place_id=$1 AND kind='sighting_retired'`, [r.sightingId])).rows;
  assert.deepEqual(retired, [{ causal_class: 'source_correction' }]);
  const item = (await away(r)).items.find(i => i.kind === 'place_changed');
  assert.ok(item && item.kind === 'place_changed', 'the change is away news');
  assert.deepEqual([item.change, item.placeId, item.cause, item.line],
    ['sighting_retired', r.sightingId, 'source_correction', 'Auroras left the horizon: the source behind it changed.']);
  assert.equal((await pool.query('SELECT state FROM atlas_place WHERE id=$1', [r.planetId])).rows[0].state, 'live', 'the planet itself is untouched');
}

test('a reader\'s own refresh records what it has seen of the correction log', async () => {
  const r = await anchoredReader();
  assert.equal((await record(r))?.corrections_seen, await committedCorrections());
});

test('a correction reaches the places of a reader who is away, with no action of theirs, as away news', async () => {
  const r = await anchoredReader();
  const events = await ledgerRows(r);
  await withdraw(r.aurorasSource);
  assert.equal(await sightingState(r), 'live', 'nothing reaches the places until a refresh');
  assert.deepEqual((await away(r)).items.filter(i => i.kind === 'place_changed'), []);

  assert.ok((await drain()).refreshed.has(r.universeId), 'the pass refreshed this reader');
  await assertAurorasLeft(r);
  assert.equal((await record(r))?.corrections_seen, await committedCorrections(), 'caught up');
  assert.equal(await ledgerRows(r), events, 'the reader did nothing');
});

test('a paused reader is left alone, then caught up once they resume', async () => {
  const r = await anchoredReader();
  assert.equal((await privacy(r, 'pause')).statusCode, 200);
  const before = await record(r);
  await withdraw(r.aurorasSource);

  assert.equal((await drain()).refreshed.has(r.universeId), false, 'the pass never picks a paused reader');
  assert.equal(await transaction(client => catchUpUniverse(client, r.universeId)), null, 'nor refreshes one under the lock');
  assert.equal(await sightingState(r), 'live', 'nothing personal is recomputed while paused');
  assert.deepEqual(await record(r), before);

  assert.equal((await privacy(r, 'resume')).statusCode, 200);
  assert.ok((await drain()).refreshed.has(r.universeId));
  await assertAurorasLeft(r);
});

test('a second pass does nothing until another correction is committed', async () => {
  const r = await anchoredReader();
  await withdraw(r.aurorasSource);
  assert.ok((await drain()).refreshed.has(r.universeId));
  const caughtUp = await record(r);
  const deltas = Number((await pool.query('SELECT count(*) FROM atlas_delta WHERE universe_id=$1', [r.universeId])).rows[0].count);

  assert.equal((await drain()).refreshed.has(r.universeId), false);
  assert.equal(await transaction(client => catchUpUniverse(client, r.universeId)), null);
  assert.deepEqual(await record(r), caughtUp);
  assert.equal(Number((await pool.query('SELECT count(*) FROM atlas_delta WHERE universe_id=$1', [r.universeId])).rows[0].count), deltas);
});

test('a correction that commits after a refresh read the count is still caught up (why a count, not times)', async () => {
  const r = await anchoredReader();
  const seen = await committedCorrections();
  const corrector = await pool.connect();
  try {
    await corrector.query('BEGIN');
    await correctSourceSnapshot(corrector, { sourceKey: r.aurorasSource, action: 'revoked', reason: 'Test: the publisher withdrew this page' }, 'operator');
    // A refresh runs before the correction commits, as a reader's action would: it cannot see it.
    await transaction(async client => { await lockUniverse(client, r.universeId); await refreshPersonalModel(client, r.universeId); });
    await corrector.query('COMMIT');
  } catch (error) {
    await corrector.query('ROLLBACK');
    throw error;
  } finally {
    corrector.release();
  }
  const correctedAt = (await pool.query<{ at: Date }>(
    'SELECT ss.status_changed_at AS at FROM source_snapshot ss JOIN semantic_source s ON s.id=ss.source_id WHERE s.key=$1', [r.aurorasSource])).rows[0]!.at;
  const stale = (await record(r))!;
  assert.equal(stale.corrections_seen, seen, 'the refresh saw only committed corrections');
  assert.ok(stale.refreshed_at > correctedAt, 'a rule on times would call this reader caught up');
  assert.equal(await sightingState(r), 'live');

  assert.ok((await drain()).refreshed.has(r.universeId));
  await assertAurorasLeft(r);
});

test('one reader\'s failed refresh holds no one else back, and is tried again on the next pass', async () => {
  const failing = await anchoredReader();
  const r = await anchoredReader();
  const failingBefore = await record(failing);
  await pool.query(`CREATE FUNCTION reject_correction_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.universe_id='${failing.universeId}'::uuid THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER reject_correction_refresh BEFORE INSERT OR UPDATE ON attention_account FOR EACH ROW EXECUTE FUNCTION reject_correction_refresh()');
  try {
    await withdraw(r.aurorasSource);
    const first = await drain();
    assert.ok(first.failed.has(failing.universeId) && !first.refreshed.has(failing.universeId));
    assert.ok(first.refreshed.has(r.universeId));
  } finally {
    await pool.query('DROP TRIGGER reject_correction_refresh ON attention_account');
    await pool.query('DROP FUNCTION reject_correction_refresh()');
  }
  await assertAurorasLeft(r);
  assert.deepEqual(await record(failing), failingBefore, 'the failed refresh recorded nothing');
  assert.ok((await drain()).refreshed.has(failing.universeId));
  assert.equal((await record(failing))?.corrections_seen, await committedCorrections());
});

test('Clear and Reset erase the record with the rest of the personal model', async () => {
  for (const [url, confirmation] of [['/v1/history/clear', 'clear-scroll-history'], ['/v1/privacy/reset', 'reset-personal-universe']] as const) {
    const identity = await provisionIdentity();
    const headers = { authorization: `Bearer ${identity.token}` };
    await readFirstOffered(app, headers);
    assert.equal(Number((await pool.query('SELECT count(*) FROM correction_catch_up WHERE universe_id=$1', [identity.scope.universeId])).rows[0].count), 1);
    const done = await app.inject({ method: 'POST', url, headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation } });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(Number((await pool.query('SELECT count(*) FROM correction_catch_up WHERE universe_id=$1', [identity.scope.universeId])).rows[0].count), 0, url);
  }
});

test('the worker\'s loop runs the pass on its interval, logging ids and counts only', async () => {
  const r = await anchoredReader();
  await withdraw(r.aurorasSource);
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/worker/src/main.ts'], {
    env: { ...process.env, KS_CORRECTION_REFRESH_INTERVAL_MS: '1000', KS_CORRECTION_REFRESH_BATCH: '100' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true,
  });
  let log = '';
  child.stdout!.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  const logged = () => log.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
    .find(line => Array.isArray(line.correctionRefresh) && line.correctionRefresh.includes(r.universeId));
  try {
    const end = Date.now() + 60_000;
    while (!logged() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 200));
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
  const line = logged();
  assert.ok(line, 'the worker caught the reader up and said so');
  assert.deepEqual(Object.keys(line).sort(), ['correctionRefresh', 'failed', 'placeChanges']);
  await assertAurorasLeft(r);
});
