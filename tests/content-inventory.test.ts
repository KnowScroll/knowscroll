/**
 * #164 — inventory v1 (ADR-0046) over the real Fastify app, PostgreSQL and the worker's writing loop,
 * with the labelled fixture transport and a mocked network only. Real reading exhausts a place; the
 * feed that observed it records the demand and the Quartermaster funds a shared request; the worker
 * writes and admits a Scroll; the reader is served it first, with the binding as evidence. A second
 * universe joins the same request; pause, Clear and Reset cancel only their own waiter; a funded
 * request holds its route's unit, so another need is told `no_budget`; a real source correction
 * withdraws the binding, reopens the demand and is away news; a spent budget, a lost transport and
 * two refusals each end in `cannot_meet` with their reason; a continuation opened or offered into a
 * concept with nothing unseen is a need, and its binding keeps the origin. No inventory response
 * names a source. Every page here is a hand-written fixture.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { createMiniMaxAnswerTransport } from '../apps/worker/src/providers/minimax-answer.ts';
import { createFixtureScrollTransport, type ScrollFixtureMode } from '../apps/worker/src/providers/scroll-fixture.ts';
import { runSupplyPass, scrollTransportsFromEnvironment } from '../apps/worker/src/scrolls/supply-worker.ts';
import { atlasResponseSchema } from '../packages/contracts/src/atlas.ts';
import { awayResponse } from '../packages/contracts/src/away.ts';
import { inventoryResponse } from '../packages/contracts/src/inventory.ts';
import type pg from 'pg';
import { lockUniverse, pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { observeBranchGap } from '../packages/db/src/inventory/demand.ts';
import { loadBoundScrolls } from '../packages/db/src/inventory/read.ts';
import { admitRequest, installMaterialCandidates, installScrollWritingRoute } from '../packages/db/src/inventory/supply.ts';
import { catchUpUniverse } from '../packages/db/src/semantic/correction-refresh.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { fixtureNetwork, makeInventoryFixture, materialPage, readTidesInFull, type InventoryFixture } from './helpers/inventory-fixture.ts';
import { readScroll } from './helpers/reading.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inventory tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'));
await app.ready();
// The writing route is deployment-wide: leave none of this file's enabled for the files after it.
after(async () => { await pool.query('UPDATE scroll_writing_route SET enabled=false WHERE enabled AND id LIKE \'fixture-i%\''); await app.close(); await pool.end(); });

const SENTINEL = 'A sentinel sentence no Scroll quotes: the harbour keeper logged every tide in a green ledger.';

type Reader = { token: string; universeId: string; h: Record<string, string> };
async function reader(): Promise<Reader> {
  const identity = await provisionIdentity();
  return { token: identity.token, universeId: identity.scope.universeId, h: { authorization: `Bearer ${identity.token}` } };
}
const epochOf = async (r: Reader) => (await app.inject({ url: '/v1/universe', headers: r.h })).json().privacyEpoch as number;
async function get(r: Reader, url: string) {
  const response = await app.inject({ url, headers: r.h });
  assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
  return response;
}
const feed = async (r: Reader) => (await get(r, '/v1/feed?kinds=Scroll')).json() as { decisionId: string; items: { assetId: string; title: string; reason: string }[] };
const inventory = async (r: Reader) => inventoryResponse.parse((await get(r, '/v1/inventory')).json());
const atlas = async (r: Reader) => atlasResponseSchema.parse((await get(r, '/v1/atlas')).json());
async function post(r: Reader, url: string, payload: object, status = 200) {
  const response = await app.inject({ method: 'POST', url, headers: r.h, payload });
  assert.equal(response.statusCode, status, `${url}: ${response.body}`);
  return response.json();
}
async function expose(r: Reader, decisionId: string, assetId: string): Promise<string> {
  return (await post(r, '/v1/exposures', { decisionId, assetId, clientExposureId: randomUUID() }, 201)).exposureId;
}

async function setup(options: { requestCap: number; material: { name: string; concepts?: (keyof InventoryFixture['codes'])[] }[] }) {
  const f = await makeInventoryFixture();
  await transaction(c => installScrollWritingRoute(c, { id: `fixture-${f.tag}`, transport: 'fixture', model: 'fixture-model', requestCap: options.requestCap }));
  await transaction(c => installMaterialCandidates(c, options.material.map(m => ({ url: f.material(m.name), conceptCodes: (m.concepts ?? ['tides']).map(k => f.codes[k]) }))));
  const net = fixtureNetwork(Object.fromEntries(options.material.map(m => [f.material(m.name), materialPage(`tides ${m.name}`, SENTINEL)])));
  let mode: ScrollFixtureMode = 'scroll';
  const calls = { count: 0 };
  const transport = createFixtureScrollTransport(() => mode, calls);
  return {
    f, calls, requested: net.requested,
    setMode: (m: ScrollFixtureMode) => { mode = m; },
    pass: () => runSupplyPass({ pool, transports: { fixture: transport }, signal: new AbortController().signal, fetchImpl: net.fetchImpl }),
  };
}

type DemandRow = { id: string; status: string; decision: string | null; reason: string | null; causes: Record<string, unknown>[]; decisions: Record<string, unknown>[] };
async function demandOf(r: Pick<Reader, 'universeId'>, concept: string): Promise<DemandRow> {
  return (await pool.query<DemandRow>(
    `SELECT d.id, d.status, d.decision, d.reason, d.causes, d.decisions FROM content_demand d JOIN concept c ON c.id = d.concept_id
     WHERE d.universe_id = $1 AND c.code = $2 ORDER BY d.created_at DESC LIMIT 1`, [r.universeId, concept])).rows[0]!;
}
const requestsFor = async (concept: string) => (await pool.query<{ id: string; status: string; reasons: string[]; candidate_id: string; asset_id: string | null; offered_codes: string[]; rights_policy: string }>(
  'SELECT r.* FROM supply_request r JOIN concept c ON c.id = r.concept_id WHERE c.code = $1 ORDER BY r.created_at', [concept])).rows;
const waitersOf = async (r: Reader) => (await pool.query<{ request_id: string; status: string; reason: string | null }>(
  'SELECT request_id, status, reason FROM demand_waiter WHERE universe_id = $1 ORDER BY created_at', [r.universeId])).rows;
const bindingsOf = async (r: Reader) => (await pool.query<{ id: string; asset_id: string; status: string; withdrawn_reason: string | null; place_id: string | null; origin_bridge_id: string | null; origin_exposure_id: string | null }>(
  'SELECT * FROM encounter_binding WHERE universe_id = $1 ORDER BY bound_at', [r.universeId])).rows;
const withoutAt = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ at: _at, ...rest }) => rest);
const placeOf = async (r: Reader, concept: string) => (await atlas(r)).places.find(p => p.anchor.code === concept)!;
const bucketOf = async (f: InventoryFixture) => (await pool.query<{ reserved: number; consumed: number }>(
  'SELECT b.reserved::int, b.consumed::int FROM scroll_writing_route r JOIN reasoning_bucket b ON b.id = r.request_bucket_id WHERE r.id=$1', [`fixture-${f.tag}`])).rows[0];
const exposureOf = async (r: Reader, assetId: string) => (await pool.query<{ id: string }>(
  'SELECT id FROM exposure WHERE universe_id=$1 AND asset_id=$2', [r.universeId, assetId])).rows[0]!.id;

test('real reading exhausts a place: the feed records the demand, the worker writes a Scroll and the reader is served it first', async () => {
  const s = await setup({ requestCap: 1, material: [{ name: 'more' }] });
  const { f } = s;
  const a = await reader();
  await readTidesInFull(app, a.h, a.universeId, f);
  const place = await placeOf(a, f.codes.tides);
  assert.equal(place.kind, 'planet', 'Tides is anchored by real reading');
  assert.deepEqual(place.scrolls, { total: 3, seen: 3 });

  // The feed that sees the place exhausted records the need, and the Quartermaster funds a request.
  const observed = await feed(a);
  const demand = await demandOf(a, f.codes.tides);
  assert.deepEqual([demand.status, demand.decision, demand.reason], ['waiting', 'fund', null]);
  assert.deepEqual(withoutAt(demand.causes), [{ kind: 'exhaustion', decisionId: observed.decisionId, placeId: place.placeId, seen: 3, total: 3 }]);
  const [request] = await requestsFor(f.codes.tides);
  assert.deepEqual([request!.status, request!.offered_codes, request!.rights_policy], ['open', [f.codes.tides], 'material-hosts-v1']);
  assert.deepEqual(withoutAt(demand.decisions), [{ version: 'quartermaster-v1', adapt: 'unavailable', decision: 'fund', requestId: request!.id, trigger: 'demand_written' }]);
  assert.deepEqual(await waitersOf(a), [{ request_id: request!.id, status: 'waiting', reason: null }]);
  assert.deepEqual((await placeOf(a, f.codes.tides)).demand, { demandId: demand.id, status: 'waiting', reason: null, scroll: null, withdrawn: false });
  // Observing the same need again joins nothing new and decides nothing new.
  await feed(a);
  assert.deepEqual(await demandOf(a, f.codes.tides), demand);

  // The worker writes it once, with the fixture transport, and binds it for the reader.
  const written = await s.pass();
  assert.deepEqual(written.kind === 'done' && [written.status, written.reasons], ['fulfilled', []]);
  assert.equal(s.calls.count, 1);
  const [fulfilled] = await requestsFor(f.codes.tides);
  assert.equal(fulfilled!.status, 'fulfilled');
  const assetId = fulfilled!.asset_id!;
  const [binding] = await bindingsOf(a);
  assert.deepEqual([binding!.asset_id, binding!.status, binding!.place_id, binding!.origin_bridge_id], [assetId, 'active', place.placeId, null]);
  assert.deepEqual(await waitersOf(a), [{ request_id: request!.id, status: 'bound', reason: null }]);
  assert.deepEqual((await demandOf(a, f.codes.tides)).status, 'bound');
  assert.equal((await s.pass()).kind, 'idle', 'nothing more to write');

  // Served first, as a continuation of the reader's own need, with the binding as its evidence.
  const next = await feed(a);
  assert.equal(next.items[0]!.assetId, assetId);
  assert.equal(next.items[0]!.reason, 'More about Tides: you had already seen everything here.');
  const why = (await get(a, `/v1/decisions/${next.decisionId}/why?assetId=${assetId}`)).json();
  assert.equal(why.family, 'continue');
  assert.deepEqual(why.evidence, [{ kind: 'demand', demandId: demand.id, bindingId: binding!.id, concept: f.codes.tides, placeId: place.placeId, origin: null }]);
  assert.deepEqual(why.quotas, ['demand_bound']);
  // A better-scoring candidate follows it: the database accepted the head because the quota that chose it is recorded.
  const scores = (await pool.query<{ score: number }>('SELECT score FROM decision_candidate WHERE decision_id=$1 AND rank IS NOT NULL ORDER BY rank', [next.decisionId])).rows.map(r => r.score);
  assert.ok(scores[0]! < Math.max(...scores), JSON.stringify(scores));
  const title = (await pool.query('SELECT title FROM asset WHERE id=$1', [assetId])).rows[0].title as string;
  const listed = (await inventory(a)).demands;
  assert.deepEqual(listed.map(d => [d.demandId, d.status, d.decision, d.concept, d.scroll, d.withdrawn, d.origin, d.causes]),
    [[demand.id, 'bound', 'reuse', { code: f.codes.tides, name: 'Tides' }, { assetId, title }, false, null, ['exhaustion']]]);
  assert.deepEqual((await placeOf(a, f.codes.tides)).demand, { demandId: demand.id, status: 'bound', reason: null, scroll: { assetId, title }, withdrawn: false });
  const writtenFrom = (await pool.query('SELECT source_title FROM asset WHERE id=$1', [assetId])).rows[0].source_title as string;
  for (const body of [(await get(a, '/v1/inventory')).body, JSON.stringify((await placeOf(a, f.codes.tides)).demand)]) {
    for (const secret of [SENTINEL, writtenFrom, 'NASA', 'science.nasa.gov']) assert.ok(!body.includes(secret), `an inventory read named a source: ${secret}`);
  }

  // Once read, the need returns; the route's one request is spent, so it cannot be met, and says so.
  await expose(a, next.decisionId, assetId);
  await feed(a);
  const spent = await demandOf(a, f.codes.tides);
  assert.deepEqual([spent.status, spent.decision, spent.reason], ['cannot_meet', 'cannot_meet', 'no_budget']);
  assert.deepEqual((await placeOf(a, f.codes.tides)).demand, { demandId: demand.id, status: 'cannot_meet', reason: 'no_budget', scroll: null, withdrawn: false });
  assert.equal((await requestsFor(f.codes.tides)).length, 1, 'no second request');
});

test('a second universe joins the open request, and each gets its own fresh binding', async () => {
  const s = await setup({ requestCap: 2, material: [{ name: 'shared' }] });
  const [a, b] = [await reader(), await reader()];
  for (const r of [a, b]) { await readTidesInFull(app, r.h, r.universeId, s.f); await feed(r); }
  const [request] = await requestsFor(s.f.codes.tides);
  const joined = await demandOf(b, s.f.codes.tides);
  assert.deepEqual([joined.status, joined.decision, withoutAt(joined.decisions)],
    ['waiting', 'join', [{ version: 'quartermaster-v1', adapt: 'unavailable', decision: 'join', requestId: request!.id, trigger: 'demand_written' }]]);
  for (const r of [a, b]) assert.deepEqual(await waitersOf(r), [{ request_id: request!.id, status: 'waiting', reason: null }]);

  assert.equal((await s.pass()).kind, 'done');
  assert.equal(s.calls.count, 1, 'one request serves both');
  const assetId = (await requestsFor(s.f.codes.tides))[0]!.asset_id!;
  for (const r of [a, b]) {
    const bindings = await bindingsOf(r);
    assert.deepEqual(bindings.map(x => [x.asset_id, x.status]), [[assetId, 'active']]);
    assert.equal((await feed(r)).items[0]!.assetId, assetId);
  }
  const ids = new Set([...(await bindingsOf(a)), ...(await bindingsOf(b))].map(x => x.id));
  assert.equal(ids.size, 2, 'bindings are private: one each');
});

test('pause, Clear and Reset cancel only their own waiter; a request no one waits for is never sent', async () => {
  const s = await setup({ requestCap: 2, material: [{ name: 'lonely' }] });
  const [a, b] = [await reader(), await reader()];
  for (const r of [a, b]) { await readTidesInFull(app, r.h, r.universeId, s.f); await feed(r); }
  const [request] = await requestsFor(s.f.codes.tides);
  const openRequest = async () => (await requestsFor(s.f.codes.tides)).map(r => r.status);

  await post(a, '/v1/privacy/pause', { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  assert.deepEqual(await waitersOf(a), [{ request_id: request!.id, status: 'cancelled', reason: 'recording_paused' }]);
  assert.deepEqual([(await demandOf(a, s.f.codes.tides)).status, (await demandOf(a, s.f.codes.tides)).reason], ['cancelled', 'recording_paused']);
  assert.deepEqual((await waitersOf(b)).map(w => w.status), ['waiting']);
  assert.deepEqual(await openRequest(), ['open']);
  // Nothing is recorded while paused.
  const before = (await pool.query('SELECT count(*)::int AS n FROM content_demand WHERE universe_id=$1', [a.universeId])).rows[0].n;
  await feed(a);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM content_demand WHERE universe_id=$1', [a.universeId])).rows[0].n, before);
  await post(a, '/v1/privacy/resume', { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  await feed(a);
  assert.deepEqual([(await demandOf(a, s.f.codes.tides)).status, (await waitersOf(a)).at(-1)!.status], ['waiting', 'waiting'], 'after resuming, the need joins again');

  // Export carries the reader's demands; Clear erases them and only them.
  const exported = await post(b, '/v1/privacy/export', { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  assert.equal(exported.rowCounts.demands, 1);
  assert.deepEqual([exported.inventory.demands.length, exported.inventory.waiters.length, exported.inventory.bindings.length], [1, 1, 0]);
  await post(b, '/v1/history/clear', { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' });
  for (const table of ['content_demand', 'demand_waiter', 'encounter_binding']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE universe_id=$1`, [b.universeId])).rows[0].n, 0, table);
  }
  assert.deepEqual((await waitersOf(a)).at(-1)!.status, 'waiting');
  assert.deepEqual(await openRequest(), ['open']);
  await post(a, '/v1/privacy/reset', { requestId: randomUUID(), expectedPrivacyEpoch: await epochOf(a), confirmation: 'reset-personal-universe' });
  assert.deepEqual(await openRequest(), ['open'], 'the shared request is never erased with a reader');

  // No one waits any more: the worker cancels it and sends nothing, and its unit is the route's again.
  assert.deepEqual(await bucketOf(s.f), { reserved: 1, consumed: 0 });
  const pass = await s.pass();
  assert.deepEqual(pass.kind === 'done' && [pass.status, pass.reasons], ['cancelled', ['no_waiters']]);
  assert.deepEqual([s.calls.count, s.requested.length], [0, 1], 'the page was read, nothing was sent');
  assert.deepEqual(await bucketOf(s.f), { reserved: 0, consumed: 0 });
  // A request cancelled before it was sent never used its material: a new need funds it again.
  await readTidesInFull(app, b.h, b.universeId, s.f);
  await feed(b);
  const [, again] = await requestsFor(s.f.codes.tides);
  assert.deepEqual([(await demandOf(b, s.f.codes.tides)).decision, again?.candidate_id], ['fund', request!.candidate_id]);
});

test('deciding several needs in one transaction takes one supply lock, so two readers in opposite orders never wait on each other', async () => {
  const { f } = await setup({ requestCap: 1, material: [] });
  // Each reader was shown everything about Tides and Gravity: a continuation into either is a need.
  const shown = async () => {
    const identity = await provisionIdentity();
    let exposureId = '';
    for (const id of [...f.scrolls.tides, f.scrolls.gravity]) exposureId = await readScroll(app, { authorization: `Bearer ${identity.token}` }, id, false);
    return { scope: identity.scope, exposureId };
  };
  const [a, b] = [await shown(), await shown()];
  const gap = (client: pg.PoolClient, r: typeof a, concept: string) =>
    observeBranchGap(client, r.scope, { concept, bridgeId: f.bridgeId, exposureId: r.exposureId, served: null });
  const [one, two] = [await pool.connect(), await pool.connect()];
  try {
    for (const [client, r] of [[one, a], [two, b]] as const) { await client.query('BEGIN'); await lockUniverse(client, r.scope.universeId); }
    await gap(one, a, f.codes.tides);
    const pid = (await two.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const second = gap(two, b, f.codes.gravity).then(() => null, (error: unknown) => error);
    const deadline = Date.now() + 10_000;
    while ((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type !== 'Lock') {
      assert.ok(Date.now() < deadline, 'the second reader never waited');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // The first reader's next need, in the opposite order: it must not wait on the second reader.
    await gap(one, a, f.codes.gravity);
    await one.query('COMMIT');
    assert.equal(await second, null);
    await gap(two, b, f.codes.tides);
    await two.query('COMMIT');
  } catch (error) {
    await one.query('ROLLBACK');
    await two.query('ROLLBACK');
    throw error;
  } finally {
    one.release();
    two.release();
  }
  for (const r of [a, b]) {
    for (const concept of [f.codes.tides, f.codes.gravity]) {
      const { status, reason } = await demandOf(r.scope, concept);
      assert.deepEqual([status, reason], ['cannot_meet', 'no_material'], concept);
    }
  }
});

test('an offered continuation into a concept with nothing unseen is a need; a funded request holds the route\'s unit, so another need is told no_budget, never left waiting', async () => {
  const s = await setup({ requestCap: 1, material: [{ name: 'held', concepts: ['tides', 'gravity'] }] });
  const { f } = s;
  const a = await reader();
  await readTidesInFull(app, a.h, a.universeId, f);
  await feed(a);
  assert.deepEqual([(await demandOf(a, f.codes.tides)).decision, await bucketOf(f)], ['fund', { reserved: 1, consumed: 0 }], 'funding holds the one unit');

  // From a Tides Scroll, the continuation back to Gravity is offered, and its only Scroll was already shown.
  const b = await reader();
  await readScroll(app, b.h, f.scrolls.gravity, false);
  await readScroll(app, b.h, f.scrolls.tides[0], false);
  const origin = await exposureOf(b, f.scrolls.tides[0]);
  const listed = (await get(b, `/v1/assets/${f.scrolls.tides[0]}/branches`)).json();
  const back = listed.branches.find((x: { bridgeId: string }) => x.bridgeId === f.bridgeId);
  assert.deepEqual([back.toConcept.code, back.target.assetId, back.seen], [f.codes.gravity, f.scrolls.gravity, true]);
  const gap = await demandOf(b, f.codes.gravity);
  assert.deepEqual([gap.status, gap.decision, gap.reason, withoutAt(gap.causes)],
    ['cannot_meet', 'cannot_meet', 'no_budget', [{ kind: 'branch_gap', bridgeId: f.bridgeId, exposureId: origin }]]);
  assert.equal((await requestsFor(f.codes.gravity)).length, 0);
  // Offered again, the same need records nothing new; offered while recording is paused, nothing at all.
  await get(b, `/v1/assets/${f.scrolls.tides[0]}/branches`);
  assert.deepEqual(await demandOf(b, f.codes.gravity), gap);
  const c = await reader();
  await readScroll(app, c.h, f.scrolls.gravity, false);
  await readScroll(app, c.h, f.scrolls.tides[0], false);
  await post(c, '/v1/privacy/pause', { requestId: randomUUID(), expectedPrivacyEpoch: 0 });
  assert.equal((await get(c, `/v1/assets/${f.scrolls.tides[0]}/branches`)).json().branches[0].seen, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM content_demand WHERE universe_id=$1', [c.universeId])).rows[0].n, 0);
  // The database, not goodwill, holds the cap.
  await assert.rejects(pool.query(`INSERT INTO supply_request(id,concept_id,modality,rights_policy,route_id,candidate_id,offered_codes,status)
    SELECT $1, (SELECT id FROM concept WHERE code=$2), 'scroll', 'material-hosts-v1', $3, m.id, ARRAY[$2], 'open' FROM scroll_material_candidate m WHERE m.url=$4`,
    [randomUUID(), f.codes.gravity, `fixture-${f.tag}`, f.material('held')]), /no budget left/);

  // Sent, the unit is consumed.
  assert.equal((await s.pass()).kind, 'done');
  assert.deepEqual(await bucketOf(f), { reserved: 0, consumed: 1 });
});

test('a real source correction withdraws the binding, reopens the demand, cancels revoked material and is away news', async () => {
  const s = await setup({ requestCap: 3, material: [{ name: 'first', concepts: ['tides', 'gravity'] }, { name: 'second' }] });
  const a = await reader();
  await readTidesInFull(app, a.h, a.universeId, s.f);
  await feed(a);
  assert.equal((await s.pass()).kind, 'done');
  const [binding] = await bindingsOf(a);
  const source = (await pool.query<{ key: string; id: string }>(
    `SELECT s.key, s.id FROM supply_request r JOIN scroll_writing w ON w.id = r.writing_id JOIN source_snapshot ss ON ss.id = w.snapshot_id
     JOIN semantic_source s ON s.id = ss.source_id WHERE r.asset_id = $1`, [binding!.asset_id])).rows[0]!;
  // Another concept's request from the same page is still open when the page is revoked.
  const gravity = randomUUID();
  await pool.query(`INSERT INTO supply_request(id,concept_id,modality,rights_policy,route_id,candidate_id,offered_codes,status)
    SELECT $1, (SELECT id FROM concept WHERE code=$2), 'scroll', 'material-hosts-v1', $3, m.id, ARRAY[$2], 'open' FROM scroll_material_candidate m WHERE m.url=$4`,
    [gravity, s.f.codes.gravity, `fixture-${s.f.tag}`, s.f.material('first')]);

  await transaction(c => correctSourceSnapshot(c, { sourceKey: source.key, action: 'revoked', reason: 'Test: the page this Scroll was written from was withdrawn' }, 'operator'));
  assert.deepEqual((await pool.query('SELECT status, reasons FROM supply_request WHERE id=$1', [gravity])).rows[0], { status: 'cancelled', reasons: ['material_revoked'] });
  assert.equal((await bindingsOf(a))[0]!.status, 'active', 'the reader\'s own rows wait for their catch-up');
  // The Composer rechecks eligibility when it serves: a Scroll that lost its support is not served first.
  assert.deepEqual(await transaction(c => loadBoundScrolls(c, a.universeId)), []);

  // The correction catch-up (ADR-0040) withdraws the binding and reopens the demand.
  assert.ok(await transaction(c => catchUpUniverse(c, a.universeId)));
  const [withdrawn] = await bindingsOf(a);
  assert.deepEqual([withdrawn!.status, withdrawn!.withdrawn_reason], ['withdrawn', 'source_correction']);
  const reopened = await demandOf(a, s.f.codes.tides);
  assert.deepEqual([reopened.status, reopened.decision], ['waiting', 'fund'], 'the next material is funded');
  assert.deepEqual(withoutAt(reopened.decisions).map(d => [d.decision, d.trigger]), [['fund', 'demand_written'], ['reuse', 'supply_settled'], ['fund', 'binding_withdrawn']]);
  assert.deepEqual((await placeOf(a, s.f.codes.tides)).demand, { demandId: reopened.id, status: 'waiting', reason: null, scroll: null, withdrawn: true });
  const listed = (await inventory(a)).demands[0]!;
  assert.deepEqual([listed.status, listed.withdrawn, listed.scroll], ['waiting', true, null]);
  assert.notEqual((await feed(a)).items[0]?.assetId, binding!.asset_id);

  const away = awayResponse.parse((await get(a, '/v1/away')).json());
  const item = away.items.find(i => i.kind === 'scroll_withdrawn');
  assert.deepEqual(item && { ...item, at: undefined }, { kind: 'scroll_withdrawn', at: undefined, bindingId: withdrawn!.id, concept: { code: s.f.codes.tides, name: 'Tides' } });
  assert.ok(!(await get(a, '/v1/away')).body.includes('science.nasa.gov'));

  // The schema: a binding only to an eligible Scroll; decisions and causes only appended; shared
  // requests never deleted; private rows erased only after their epoch ends.
  await assert.rejects(pool.query(`INSERT INTO encounter_binding(id,demand_id,universe_id,privacy_epoch,asset_id,status) VALUES($1,$2,$3,0,$4,'active')`,
    [randomUUID(), reopened.id, a.universeId, binding!.asset_id]), /only to an eligible Scroll/);
  await assert.rejects(pool.query(`UPDATE content_demand SET decisions='[]' WHERE id=$1`, [reopened.id]), /only ever appended/);
  await assert.rejects(pool.query(`UPDATE encounter_binding SET status='active', withdrawn_at=NULL, withdrawn_reason=NULL WHERE id=$1`, [withdrawn!.id]), /only ever withdrawn/);
  await assert.rejects(pool.query('DELETE FROM supply_request WHERE id=$1', [gravity]), /never deleted/);
  await assert.rejects(pool.query('DELETE FROM content_demand WHERE id=$1', [reopened.id]), /only after their privacy epoch ends/);
  await assert.rejects(pool.query(`INSERT INTO content_demand(id,universe_id,privacy_epoch,concept_id,modality,status,causes)
    SELECT $1,$2,0,id,'scroll','open','[{"kind":"exhaustion"}]' FROM concept WHERE code=$3`, [randomUUID(), a.universeId, s.f.codes.tides]), /content_demand_one_live/);
});

test('a lost transport is never retried: one call, the request failed, and the demand says it cannot be met', async () => {
  const s = await setup({ requestCap: 3, material: [{ name: 'lost' }, { name: 'untouched' }] });
  s.setMode('transport_loss');
  const a = await reader();
  await readTidesInFull(app, a.h, a.universeId, s.f);
  await feed(a);
  const failed = await s.pass();
  assert.deepEqual(failed.kind === 'done' && [failed.status, failed.reasons], ['failed', ['transport_lost']]);
  assert.equal(s.calls.count, 1);
  const demand = await demandOf(a, s.f.codes.tides);
  assert.deepEqual([demand.status, demand.reason], ['cannot_meet', 'request_failed']);
  assert.deepEqual((await waitersOf(a)).map(w => w.status), ['released']);
  s.setMode('scroll');
  assert.equal((await s.pass()).kind, 'idle');
  await feed(a);
  assert.equal((await s.pass()).kind, 'idle');
  assert.deepEqual([s.calls.count, (await requestsFor(s.f.codes.tides)).length, (await demandOf(a, s.f.codes.tides)).reason], [1, 1, 'request_failed']);
  // The route bucket counted the one request that may have reached the provider.
  assert.equal((await pool.query(`SELECT b.consumed::int AS n FROM scroll_writing_route r JOIN reasoning_bucket b ON b.id = r.request_bucket_id WHERE r.id=$1`, [`fixture-${s.f.tag}`])).rows[0].n, 1);
});

test('a refused Scroll funds the next material once; a second refusal is checks_failed; a send left unsettled is failed as unknown', async () => {
  const s = await setup({ requestCap: 4, material: [{ name: 'refused-one' }, { name: 'refused-two' }, { name: 'never' }] });
  s.setMode('invented_quote');
  const a = await reader();
  await readTidesInFull(app, a.h, a.universeId, s.f);
  await feed(a);
  const first = await s.pass();
  assert.deepEqual(first.kind === 'done' && [first.status, first.reasons], ['refused', ['quote_not_in_material']]);
  assert.deepEqual([(await demandOf(a, s.f.codes.tides)).decision, (await requestsFor(s.f.codes.tides)).map(r => r.status)], ['fund', ['refused', 'open']]);
  await s.pass();
  const stopped = await demandOf(a, s.f.codes.tides);
  assert.deepEqual([stopped.status, stopped.reason, s.calls.count], ['cannot_meet', 'checks_failed', 2]);

  // A request the worker marked as sending but never settled (a crash mid-send) is not sent again.
  const b = await reader();
  const f2 = await setup({ requestCap: 2, material: [{ name: 'crash' }] });
  await readTidesInFull(app, b.h, b.universeId, f2.f);
  await feed(b);
  const [request] = await requestsFor(f2.f.codes.tides);
  assert.deepEqual(await transaction(c => admitRequest(c, request!.id)), { ok: true });
  await pool.query(`UPDATE supply_request SET sent_at = sent_at - interval '2 hours' WHERE id=$1`, [request!.id]);
  await f2.pass();
  assert.deepEqual((await requestsFor(f2.f.codes.tides)).map(r => [r.status, r.reasons]), [['failed', ['outcome_unknown']]]);
  assert.deepEqual([(await demandOf(b, f2.f.codes.tides)).reason, f2.calls.count], ['request_failed', 0]);
});

test('a continuation into a concept with nothing unseen records a branch gap, and its binding keeps the origin', async () => {
  const s = await setup({ requestCap: 1, material: [{ name: 'gap' }] });
  const { f } = s;
  const b = await reader();
  for (const assetId of [f.scrolls.tides[1], f.scrolls.tides[2], f.scrolls.gravity]) await readScroll(app, b.h, assetId, false);
  const origin = (await pool.query<{ id: string }>('SELECT id FROM exposure WHERE universe_id=$1 AND asset_id=$2', [b.universeId, f.scrolls.gravity])).rows[0]!.id;
  const branches = (await get(b, `/v1/assets/${f.scrolls.gravity}/branches`)).json();
  const branch = branches.branches.find((x: { bridgeId: string }) => x.bridgeId === f.bridgeId);
  assert.equal(branch.target.assetId, f.scrolls.tides[0]);
  await post(b, '/v1/branches', { clientBranchId: randomUUID(), fromExposureId: origin, bridgeId: f.bridgeId, targetAssetId: branch.target.assetId, expectedPrivacyEpoch: 0 }, 201);
  const demand = await demandOf(b, f.codes.tides);
  assert.deepEqual([demand.status, demand.decision, withoutAt(demand.causes)], ['waiting', 'fund', [{ kind: 'branch_gap', bridgeId: f.bridgeId, exposureId: origin }]]);

  assert.equal((await s.pass()).kind, 'done');
  const [binding] = await bindingsOf(b);
  assert.deepEqual([binding!.place_id, binding!.origin_bridge_id, binding!.origin_exposure_id], [null, f.bridgeId, origin]);
  assert.deepEqual((await inventory(b)).demands[0]!.origin, { bridgeId: f.bridgeId, exposureId: origin });
  // It opens as the continuation it was needed for, from the exposure it was needed from.
  const opened = await post(b, '/v1/branches', { clientBranchId: randomUUID(), fromExposureId: origin, bridgeId: f.bridgeId, targetAssetId: binding!.asset_id, expectedPrivacyEpoch: 0 }, 201);
  assert.equal(opened.items[0].assetId, binding!.asset_id);
});

test('a worker writes supply requests only with the Scroll-writing transport its own environment names', () => {
  assert.equal(scrollTransportsFromEnvironment({}), null);
  assert.equal(scrollTransportsFromEnvironment({ KS_SCROLL_TRANSPORT: 'fixture' })?.fixture?.kind, 'fixture');
  assert.throws(() => scrollTransportsFromEnvironment({ KS_SCROLL_TRANSPORT: 'fixture', KS_SCROLL_FIXTURE_MODE: 'hang' }), /KS_SCROLL_FIXTURE_MODE/);
  assert.throws(() => scrollTransportsFromEnvironment({ KS_SCROLL_TRANSPORT: 'minimax' }), /needs MINIMAX_API_KEY/);
  assert.throws(() => scrollTransportsFromEnvironment({ KS_SCROLL_TRANSPORT: 'minimax', MINIMAX_API_KEY: 'sk-api-paygo' }), /subscription \(sk-cp-\) key/);
  // The answer path's MiniMax client, and so its quota readiness, is the one Scroll writing uses.
  const answers = { minimax: createMiniMaxAnswerTransport({ apiKey: `sk-cp-${'k'.repeat(24)}` }) };
  assert.equal(scrollTransportsFromEnvironment({ KS_SCROLL_TRANSPORT: 'minimax' }, answers)?.minimax, answers.minimax);
  assert.throws(() => scrollTransportsFromEnvironment({ KS_SCROLL_TRANSPORT: 'openai' }), /fixture or minimax/);
});
