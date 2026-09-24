/**
 * #162 — model-written Scrolls against real PostgreSQL and the real Fastify app (ADR-0041), with
 * the labelled fixture transport and a mocked network only. A written Scroll is admitted with its
 * whole lineage (source, snapshot, private material, claims with their quotes, annotations, the
 * writing record); the same material and request are never sent twice; a refused reply keeps reason
 * codes and no text; a page that changed, OpenStax, an unknown concept or a refusing route sends
 * nothing; the database guards the material's hash; the Composer serves the Scroll while no
 * response or export ever carries the material; and its claims are never offered to a background
 * inquiry. The page text here is a hand-written fixture.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { projectOne } from '../apps/worker/src/project.ts';
import { createFixtureScrollTransport, type ScrollFixtureMode } from '../apps/worker/src/providers/scroll-fixture.ts';
import { writeScroll, type WriteScrollDeps } from '../apps/worker/src/scrolls/write-scroll.ts';
import { selectInquiryPairs } from '../packages/core/src/reasoning/bridge-inquiry.ts';
import { extractVisibleText } from '../packages/core/src/scrolls/material.ts';
import { SCROLL_LIMITS } from '../packages/core/src/scrolls/writing.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { readInquiryInputs } from '../packages/db/src/reasoning-inquiry-context.ts';
import { admitModelScroll } from '../packages/db/src/semantic/model-scrolls.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { formPlaces, loadInquiryFixture } from './helpers/inquiry-fixture.ts';
import { makeSemanticFixture, type SemanticFixture } from './helpers/semantic-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Model-written Scroll tests require an isolated knowscroll_test_* database');
}
const app = buildApp(randomBytes(32).toString('hex'));
after(async () => { await app.close(); await pool.end(); });

const SENTINEL = 'A sentinel sentence no Scroll quotes: the harbour keeper logged every tide in a green ledger.';
const TEXT = `Fixture material, written by hand for tests. The Moon pulls on the whole Earth, but it pulls hardest on the side that faces it.
  Water on that side is drawn into a bulge, and a second bulge forms on the far side, where the pull is weakest.
  As Earth turns, a coast passes through both bulges, so many shores see two high tides and two low tides every day.
  When the Sun and the Moon line up, their pulls add together and the tides grow larger; these are called spring tides. ${SENTINEL}`;
const pageHtml = (text = TEXT) => `<!doctype html><html><head><title>What makes the tides</title></head><body><nav>Menu Search</nav>
<main><h1>Tides</h1><p>${text}</p></main><footer>Footer</footer></body></html>`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type Pages = Record<string, string>;
function network(pages: Pages) {
  const requested: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    requested.push(String(url));
    const body = pages[String(url)];
    if (body === undefined) throw new TypeError('fixture network: nothing there');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

async function setup(): Promise<SemanticFixture & { url: (page: string) => string }> {
  const fixture = await makeSemanticFixture(pool);
  assert.equal((await transaction(c => loadSubstrateSeed(c, fixture.raw))).status, 'loaded');
  return { ...fixture, url: page => `https://science.nasa.gov/fixture/${fixture.tag}/${page}/` };
}

function deps(pages: Pages, options: { mode?: ScrollFixtureMode; apply?: boolean; beforeSend?: WriteScrollDeps['beforeSend'] } = {}) {
  const calls = { count: 0 };
  const net = network(pages);
  const d: WriteScrollDeps = {
    transport: createFixtureScrollTransport(() => options.mode ?? 'scroll', calls), model: 'fixture-model', apply: options.apply ?? true,
    beforeSend: options.beforeSend ?? (async () => ({ ok: true })), signal: new AbortController().signal, fetchImpl: net.fetchImpl,
  };
  return { deps: d, calls, requested: net.requested };
}

test('a fixture-written Scroll is admitted with its whole lineage', async () => {
  const f = await setup();
  const url = f.url('tides');
  const before = (await pool.query<{ n: number }>('SELECT COALESCE(MAX(editorial_order), -1)::int AS n FROM asset')).rows[0]!.n;
  const { deps: d, calls } = deps({ [url]: pageHtml() });
  const result = await writeScroll(d, { url, conceptCodes: [f.codes.tides, f.codes.gravity] });
  assert.equal(result.status, 'admitted', JSON.stringify(result));
  assert.equal(calls.count, 1);
  assert.ok(result.inputBytes! > 0 && result.inputBytes! <= SCROLL_LIMITS.requestBytes);

  const asset = (await pool.query('SELECT * FROM asset WHERE id=$1', [result.assetId])).rows[0];
  assert.equal(asset.kind, 'Scroll');
  assert.equal(asset.truth_state, 'documented');
  assert.ok(asset.editorial_order > Math.max(before, 99_999), 'after the library\'s last, in a range of its own: the editorial seed numbers its Scrolls by index');
  assert.equal(asset.body.split('\n\n').length, 3, 'the beats are its paragraphs');
  assert.equal(asset.source_url, url);
  assert.equal(asset.source_title, 'NASA · What makes the tides');
  const annotations = (await pool.query(`SELECT c.code, ac.role FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id WHERE ac.asset_id=$1 ORDER BY ac.role`, [result.assetId])).rows;
  assert.deepEqual(annotations, [{ code: f.codes.tides, role: 'primary' }, { code: f.codes.gravity, role: 'secondary' }]);

  const source = (await pool.query(`SELECT s.key, s.publisher, f.key AS family, ss.id AS snapshot_id, ss.content_sha256, ss.retrieved_on::text AS retrieved_on, ss.revision
    FROM semantic_source s JOIN evidence_family f ON f.id = s.family_id JOIN source_snapshot ss ON ss.source_id = s.id WHERE s.url=$1`, [url])).rows[0];
  assert.match(source.key, /^nasa\.page-[0-9a-f]{16}$/);
  assert.deepEqual([source.publisher, source.family, source.revision], ['NASA', 'fam.nasa', 1]);
  const material = (await pool.query('SELECT content FROM source_material WHERE snapshot_id=$1', [source.snapshot_id])).rows[0].content as string;
  assert.ok(material.includes(SENTINEL), 'the whole page is kept');
  assert.equal(source.content_sha256, sha(material));
  assert.equal(result.materialSha256, source.content_sha256);

  const claims = (await pool.query(`SELECT cl.key, cl.created_by, cl.truth_state, cs.quote, cs.support_kind, cs.snapshot_id, claim_is_supported(cl.id) AS supported
    FROM asset_claim x JOIN claim cl ON cl.id = x.claim_id JOIN claim_support cs ON cs.claim_id = cl.id WHERE x.asset_id=$1 ORDER BY cl.key`, [result.assetId])).rows;
  assert.equal(claims.length, 2);
  for (const claim of claims) {
    assert.match(claim.key, /^clm\.model\.[0-9a-f]{16}\.[1-6]$/);
    assert.deepEqual([claim.created_by, claim.truth_state, claim.support_kind, claim.snapshot_id, claim.supported], ['model_proposal', 'documented', 'supports', source.snapshot_id, true]);
    assert.ok(material.includes(claim.quote), 'every quote is a passage of the stored material');
  }
  const writing = (await pool.query('SELECT * FROM scroll_writing WHERE asset_id=$1', [result.assetId])).rows[0];
  assert.deepEqual([writing.status, writing.reasons, writing.transport, writing.model, writing.snapshot_id, writing.material_sha256, writing.request_sha256, writing.input_bytes],
    ['admitted', [], 'fixture', 'fixture-model', source.snapshot_id, result.materialSha256, result.requestSha256, result.inputBytes]);
  assert.deepEqual(writing.versions, { prompt: 'scroll-writing-prompt-v1', reply: 'scroll-reply-v1', checks: 'scroll-checks-v2', hosts: 'material-hosts-v1' });
});

test('the same material and request are decided once and never sent again', async () => {
  const f = await setup();
  const url = f.url('once');
  const { deps: d, calls } = deps({ [url]: pageHtml() });
  const first = await writeScroll(d, { url, conceptCodes: [f.codes.tides] });
  assert.equal(first.status, 'admitted');
  const again = await writeScroll(d, { url, conceptCodes: [f.codes.tides] });
  assert.deepEqual([again.status, again.assetId, again.writingId, again.requestSha256], ['already_decided', first.assetId, first.writingId, first.requestSha256]);
  assert.equal(calls.count, 1, 'no second request');
  // Other concepts are another request over the same stored material and snapshot.
  const other = await writeScroll(d, { url, conceptCodes: [f.codes.gravity] });
  assert.equal(other.status, 'admitted');
  assert.notEqual(other.assetId, first.assetId);
  const counts = (await pool.query(`SELECT count(DISTINCT ss.id)::int AS snapshots, count(DISTINCT m.snapshot_id)::int AS materials, count(DISTINCT w.id)::int AS writings
    FROM semantic_source s JOIN source_snapshot ss ON ss.source_id = s.id LEFT JOIN source_material m ON m.snapshot_id = ss.id
    LEFT JOIN scroll_writing w ON w.snapshot_id = ss.id WHERE s.url=$1`, [url])).rows[0];
  assert.deepEqual(counts, { snapshots: 1, materials: 1, writings: 2 });
});

test('a page the substrate already holds, unchanged, keeps its source and snapshot and gains its material', async () => {
  const fixture = await makeSemanticFixture(pool);
  const url = `https://science.nasa.gov/fixture/${fixture.tag}/known/`;
  const text = extractVisibleText(pageHtml()).text;
  const seed = { ...fixture.seed, sources: fixture.seed.sources.map((s, i) => (i === 0 ? { ...s, url, contentSha256: sha(text) } : s)) };
  assert.equal((await transaction(c => loadSubstrateSeed(c, JSON.stringify(seed)))).status, 'loaded');
  const held = `SELECT s.id AS source_id, s.key, ss.id AS snapshot_id FROM semantic_source s JOIN source_snapshot ss ON ss.source_id = s.id WHERE s.url=$1`;
  const before = (await pool.query(held, [url])).rows;
  const result = await writeScroll(deps({ [url]: pageHtml() }).deps, { url, conceptCodes: [fixture.codes.tides] });
  assert.equal(result.status, 'admitted', JSON.stringify(result));
  assert.deepEqual((await pool.query(held, [url])).rows, before, 'the same source and snapshot, under the substrate\'s own key');
  assert.equal((await pool.query('SELECT content FROM source_material WHERE snapshot_id=$1', [before[0].snapshot_id])).rows[0].content, text);
  assert.equal((await pool.query('SELECT source_title FROM asset WHERE id=$1', [result.assetId])).rows[0].source_title, 'Fixture · Physics fixture');
  const supports = (await pool.query('SELECT DISTINCT cs.snapshot_id FROM asset_claim x JOIN claim_support cs ON cs.claim_id = x.claim_id WHERE x.asset_id=$1', [result.assetId])).rows;
  assert.deepEqual(supports, [{ snapshot_id: before[0].snapshot_id }]);
});

test('admission itself is idempotent under the substrate lock', async () => {
  const f = await setup();
  const url = f.url('admit-twice');
  const { deps: d } = deps({ [url]: pageHtml() });
  const written = await writeScroll(d, { url, conceptCodes: [f.codes.tides] });
  const row = (await pool.query('SELECT * FROM scroll_writing WHERE id=$1', [written.writingId])).rows[0];
  const replay = await transaction(c => admitModelScroll(c, {
    identity: { materialSha256: row.material_sha256, requestSha256: row.request_sha256 },
    material: { url, title: 'What makes the tides', text: 'not stored again', retrievedAt: new Date().toISOString(),
      host: { publisher: 'NASA', keyPrefix: 'nasa', family: { key: 'fam.nasa', kind: 'publisher', description: 'unused' } } },
    scroll: { title: 'unused', summary: 'unused', beats: [], body: '', concepts: [], claims: [] },
    record: { transport: 'fixture', model: 'fixture-model', inputBytes: 1, usage: {}, versions: {} },
  }));
  assert.deepEqual(replay, { status: 'already_decided', writingId: written.writingId, assetId: written.assetId, reasons: [] });
});

test('a refused reply records its reason codes and nothing a model wrote', async () => {
  const f = await setup();
  for (const [mode, reason] of [['invented_quote', 'quote_not_in_material'], ['copied_passage', 'copied_passage'], ['prose', 'not_one_json_object']] as const) {
    const url = f.url(`refused-${mode}`);
    // Each page's own text: the same text and request anywhere is one decision.
    const { deps: d, calls } = deps({ [url]: pageHtml(`${TEXT} Fixture page for ${mode}.`) }, { mode });
    const result = await writeScroll(d, { url, conceptCodes: [f.codes.tides] });
    assert.deepEqual([result.status, result.reasons, result.assetId], ['refused', [reason], null], mode);
    const row = (await pool.query('SELECT * FROM scroll_writing WHERE id=$1', [result.writingId])).rows[0];
    assert.deepEqual([row.status, row.reasons, row.asset_id, row.snapshot_id], ['refused', [reason], null, null]);
    assert.ok(!/Fixture |Moon|never contained|Here is/.test(JSON.stringify(row)), 'no model text and no material in the record');
    assert.equal((await pool.query('SELECT 1 FROM semantic_source WHERE url=$1', [url])).rowCount, 0, 'nothing admitted: no source, snapshot or material');
    assert.equal((await writeScroll(d, { url, conceptCodes: [f.codes.tides] })).status, 'already_decided');
    assert.equal(calls.count, 1, 'a refused request is not sent again');
  }
});

test('OpenStax, an off-allowlist page, an unknown concept and a changed page send nothing', async () => {
  const f = await setup();
  const url = f.url('changes');
  const { deps: d, calls, requested } = deps({ [url]: pageHtml() });
  const refused = async (item: { url: string; conceptCodes: string[] }) => { const r = await writeScroll(d, item); return [r.status, r.reasons]; };
  assert.deepEqual(await refused({ url: 'https://openstax.org/books/anatomy-and-physiology-2e/pages/1-5-homeostasis', conceptCodes: [f.codes.body] }), ['refused', ['openstax_excluded']]);
  assert.deepEqual(await refused({ url: 'https://en.wikipedia.org/wiki/Tide', conceptCodes: [f.codes.tides] }), ['refused', ['host_not_allowed']]);
  assert.deepEqual(requested, [], 'neither page is requested');
  assert.deepEqual(await refused({ url, conceptCodes: [`${f.tag}.no_such_concept`] }), ['refused', ['plan_concept_unknown']]);
  assert.equal(calls.count, 0);

  assert.equal((await writeScroll(d, { url, conceptCodes: [f.codes.tides] })).status, 'admitted');
  const changed = deps({ [url]: pageHtml(TEXT.replace('spring tides', 'spring tides, twice a month')) });
  const r = await writeScroll(changed.deps, { url, conceptCodes: [f.codes.gravity] });
  assert.deepEqual([r.status, r.reasons], ['refused', ['source_changed']], 'a changed page is a correction, not a replacement');
  assert.equal(changed.calls.count, 0);
});

test('a refusing route sends nothing; a failed request writes nothing; without apply nothing is sent', async () => {
  const f = await setup();
  const url = f.url('route');
  const pages = { [url]: pageHtml() };
  const notReady = deps(pages, { beforeSend: async () => ({ ok: false, reason: 'provider_quota_preflight_failed' }) });
  const refused = await writeScroll(notReady.deps, { url, conceptCodes: [f.codes.tides] });
  assert.deepEqual([refused.status, refused.reasons, notReady.calls.count], ['not_sent', ['provider_quota_preflight_failed'], 0]);

  for (const [mode, reason, httpStatus] of [['http_error', 'provider_error', 500], ['transport_loss', 'transport_lost', null]] as const) {
    const failing = deps(pages, { mode });
    const result = await writeScroll(failing.deps, { url, conceptCodes: [f.codes.tides] });
    assert.deepEqual([result.status, result.reasons, result.httpStatus, failing.calls.count], ['failed', [reason], httpStatus, 1], mode);
  }
  const dry = deps(pages, { apply: false });
  const ready = await writeScroll(dry.deps, { url, conceptCodes: [f.codes.tides] });
  assert.equal(ready.status, 'ready');
  assert.match(ready.requestSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(dry.calls.count, 0);
  assert.equal((await pool.query('SELECT 1 FROM scroll_writing WHERE source_url=$1', [url])).rowCount, 0, 'no decision was recorded');
  assert.equal((await pool.query('SELECT 1 FROM semantic_source WHERE url=$1', [url])).rowCount, 0);
});

test('the database keeps the material exactly its snapshot\'s text, and never edits it', async () => {
  const f = await setup();
  const url = f.url('guards');
  const written = await writeScroll(deps({ [url]: pageHtml() }).deps, { url, conceptCodes: [f.codes.tides] });
  const snapshot = (await pool.query('SELECT snapshot_id FROM scroll_writing WHERE id=$1', [written.writingId])).rows[0].snapshot_id;
  await assert.rejects(pool.query('UPDATE source_material SET content=$2 WHERE snapshot_id=$1', [snapshot, 'edited']), /immutable/);
  await assert.rejects(pool.query('DELETE FROM source_material WHERE snapshot_id=$1', [snapshot]), /immutable/);
  const other = (await pool.query(`SELECT ss.id FROM source_snapshot ss LEFT JOIN source_material m ON m.snapshot_id = ss.id WHERE m.snapshot_id IS NULL LIMIT 1`)).rows[0].id;
  await assert.rejects(pool.query(`INSERT INTO source_material(snapshot_id,content,retrieved_at) VALUES($1,'text that is not the snapshot',now())`, [other]), /exactly its snapshot/);
  await assert.rejects(pool.query(`INSERT INTO scroll_writing(id,material_sha256,request_sha256,source_url,transport,model,versions,input_bytes,usage,status,reasons,snapshot_id,asset_id)
    VALUES($1,$2,$2,$3,'fixture','fixture-model','{}',10,'{}','admitted','[]',$4,$5)`, [randomUUID(), 'a'.repeat(64), url, other, written.assetId]), /stored material/);
  await assert.rejects(pool.query('UPDATE scroll_writing SET reasons=$2 WHERE id=$1', [written.writingId, '["x"]']), /immutable/);
});

test('GET /v1/feed serves the written Scroll, and no response or export ever carries the material', async () => {
  const f = await setup();
  const url = f.url('served');
  // About axial tilt, a narrower idea within the seasons.
  const written = await writeScroll(deps({ [url]: pageHtml() }).deps, { url, conceptCodes: [f.codes.tilt, f.codes.seasons] });
  assert.equal(written.status, 'admitted');
  const quotes = (await pool.query<{ quote: string }>('SELECT cs.quote FROM asset_claim x JOIN claim_support cs ON cs.claim_id = x.claim_id WHERE x.asset_id=$1', [written.assetId])).rows.map(r => r.quote);
  const secrets = [SENTINEL, 'Menu Search', ...quotes];

  const identity = await provisionIdentity();
  const h = { authorization: `Bearer ${identity.token}` };
  const bodies: string[] = [];
  const get = async (path: string) => { const r = await app.inject({ url: path, headers: h }); assert.equal(r.statusCode, 200, `${path}: ${r.body}`); bodies.push(r.body); return r.json(); };
  const keep = async (decisionId: string, assetId: string) => {
    const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: h, payload: { decisionId, assetId, clientExposureId: randomUUID() } });
    assert.equal(exposure.statusCode, 201, exposure.body);
    const kept = await app.inject({ method: 'POST', url: '/v1/interactions', headers: h, payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId, kind: 'keep' } });
    assert.equal(kept.statusCode, 202, kept.body);
    await pool.query("UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1", [kept.json().jobId]);
    assert.equal((await projectOne())?.status, 'completed');
    return kept.json().eventId as string;
  };
  // The reader keeps the fixture library's own Scroll about the seasons (served to them directly),
  // so the Composer has a reason to offer a narrower idea within them: its "deepen" family.
  const seasons = (await pool.query(`SELECT id AS "assetId", revision, kind, title, summary, body, source_title AS "sourceTitle", source_url AS "sourceUrl", truth_state AS "truthState" FROM asset WHERE id=$1`, [f.assets.seasons])).rows[0];
  const direct = randomUUID();
  await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'model-scrolls-test-fixture',$3::jsonb,$4)`,
    [direct, identity.scope.universeId, JSON.stringify([seasons]), identity.scope.privacyEpoch]);
  await keep(direct, f.assets.seasons);

  const feed = await get('/v1/feed?kinds=Scroll');
  const item = (feed.items as { assetId: string; title: string; body: string; kind: string }[]).find(x => x.assetId === written.assetId);
  assert.ok(item, 'the Composer offers the written Scroll like any other');
  const stored = (await pool.query('SELECT title, body FROM asset WHERE id=$1', [written.assetId])).rows[0];
  assert.deepEqual([item.kind, item.title, item.body], ['Scroll', stored.title, stored.body]);
  const why = (await pool.query(`SELECT family FROM decision_candidate WHERE decision_id=$1 AND asset_id=$2 AND rank IS NOT NULL`, [feed.decisionId, written.assetId])).rows[0];
  assert.equal(why.family, 'deepen');
  const keptEvent = await keep(feed.decisionId, written.assetId!);

  for (const path of ['/v1/universe', '/v1/worlds', '/v1/atlas', '/v1/away', '/v1/relics', '/v1/inquiries',
    `/v1/assets/${written.assetId}/branches`, `/v1/decisions/${feed.decisionId}/why?assetId=${written.assetId}`, `/v1/traces/${keptEvent}`]) await get(path);
  const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: h, payload: { requestId: randomUUID(), expectedPrivacyEpoch: identity.scope.privacyEpoch } });
  assert.equal(exported.statusCode, 200, exported.body);
  bodies.push(exported.body);
  assert.ok(exported.body.includes(written.assetId!), 'the export carries the reader\'s own history of the Scroll');
  for (const body of bodies) for (const secret of secrets) assert.ok(!body.includes(secret), `a response carried material: ${secret.slice(0, 30)}…`);
  assert.equal((await pool.query('SELECT 1 FROM source_material m JOIN scroll_writing w ON w.snapshot_id = m.snapshot_id WHERE w.id=$1', [written.writingId])).rowCount, 1);
});

test('a model-written Scroll\'s claims are never offered to a background inquiry (#181, ADR-0041 §10)', async () => {
  const own = await loadInquiryFixture(pool);
  const url = `https://science.nasa.gov/fixture/${own.tag}/gravity/`;
  // Its claims are about Gravity, one side of the reader's candidate pair with the Sun.
  const written = await writeScroll(deps({ [url]: pageHtml() }).deps, { url, conceptCodes: [own.codes.gravity] });
  assert.equal(written.status, 'admitted', JSON.stringify(written));
  const modelClaims = (await pool.query<{ key: string }>('SELECT cl.key FROM asset_claim x JOIN claim cl ON cl.id = x.claim_id WHERE x.asset_id=$1', [written.assetId])).rows.map(r => r.key);
  assert.equal(modelClaims.length, 2);

  const identity = await provisionIdentity();
  await formPlaces(identity.scope.universeId, [own.codes.gravity, own.codes.sun]);
  const inputs = await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [identity.scope.universeId]);
    return readInquiryInputs(client, identity.scope.universeId, identity.scope.privacyEpoch);
  });
  assert.deepEqual(inputs.claims.filter(c => modelClaims.includes(c.key)), [], 'model prose is not inquiry evidence until reviewed');
  const [pair] = selectInquiryPairs(inputs).filter(p => p.a.code === own.codes.gravity || p.b.code === own.codes.gravity);
  assert.ok(pair, 'the pair is still offered, on its editorial claims');
  assert.deepEqual([...pair.claimsA, ...pair.claimsB, ...pair.both].map(c => c.key).filter(key => key.startsWith('clm.model.')), []);
});
