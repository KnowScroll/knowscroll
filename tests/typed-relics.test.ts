/**
 * #165 — typed Relics (ADR-0044) against real PostgreSQL, the real Fastify app and the answer worker
 * over the labelled fixture transport. A place, a passage of a Scroll and an answer to the reader's
 * own Ask are kept with their kept form and no source; keeping is idempotent and refused while
 * paused or for what the reader doubted or never read; a real source correction and a newer revision
 * mark them corrected, the reader's "seems wrong" and "Set aside" mark them doubted; let go, Clear,
 * Reset and export; and the Relic list pages so the oldest can be let go (M8).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { objectionResponse, passagesResponse, relicKeepResponse, relicsResponse, type RelicKeepInput, type RelicWire } from '../packages/contracts/src/relics.ts';
import type { SubstrateSeed } from '../packages/contracts/src/semantic.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerAuthority, answerFairnessPolicy, installAskAnswerRoute } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { runAnswerPass } from '../apps/worker/src/reasoning/answer-worker.ts';
import { createFixtureAnswerTransport } from '../apps/worker/src/providers/answer-fixture.ts';
import { formPlaces, loadInquiryFixture, type InquiryFixture } from './helpers/inquiry-fixture.ts';
import { readScroll } from './helpers/reading.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Typed Relic tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'typed-relics-test-v1';
const fixture = createFixtureAnswerTransport(() => 'answer');

before(async () => {
  await createReasoningFairness(pool, answerAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
  await transaction(client => installAskAnswerRoute(client, { policyVersion: POLICY, routeId: `fixture-${POLICY}`, routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 200, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 600, remoteSlots: 16 }));
});
after(async () => { await app.close(); await pool.end(); });

type Reader = { token: string; universeId: string; epoch: number; f: InquiryFixture };
const headers = (r: Reader) => ({ authorization: `Bearer ${r.token}` });
type Target = { kind: 'place'; placeId: string } | { kind: 'passage'; assetId: string; revision: number; claimKey: string } | { kind: 'answer'; askId: string };
type Kept = { r: Reader; place: Target; passage: Target; answer: Target; askId: string };

/** A reader with their own substrate, so a source correction here reaches no other test. */
async function reader(): Promise<Reader> {
  const identity = await provisionIdentity();
  return { token: identity.token, universeId: identity.scope.universeId, epoch: 0, f: await loadInquiryFixture(pool) };
}

const placeOf = async (r: Reader, code: string) => (await pool.query(
  `SELECT p.id FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id WHERE p.universe_id=$1 AND p.state='live' AND c.code=$2`, [r.universeId, code])).rows[0].id as string;

/** Gravity is a place (with Tides on its horizon), and the reader read the Gravity Scroll, asked about
 * it and had it answered: the three things they may keep. */
async function prepared(): Promise<Kept> {
  const r = await reader();
  await formPlaces(r.universeId, [r.f.codes.gravity]);
  const exposureId = await readScroll(app, headers(r), r.f.assets.gravity, false);
  const asked = await app.inject({ method: 'POST', url: '/v1/asks', headers: headers(r),
    payload: { clientAskId: randomUUID(), exposureId, expectedPrivacyEpoch: r.epoch, question: 'What pulls things together?' } });
  assert.equal(asked.statusCode, 201, asked.body);
  const askId: string = asked.json().askId;
  const requested = await app.inject({ method: 'POST', url: `/v1/asks/${askId}/answer`, headers: headers(r), payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: r.epoch } });
  assert.equal(requested.statusCode, 202, requested.body);
  for (let i = 0; i < 20 && (await answerView(r, askId)).status !== 'answered'; i += 1) {
    await runAnswerPass({ pool, owner: 'typed-relics-test-worker', leaseMs: 60_000, transports: { fixture }, signal: new AbortController().signal });
  }
  assert.equal((await answerView(r, askId)).status, 'answered');
  return {
    r, askId,
    place: { kind: 'place', placeId: await placeOf(r, r.f.codes.tides) },
    passage: { kind: 'passage', assetId: r.f.assets.gravity, revision: 1, claimKey: r.f.claims.gravity },
    answer: { kind: 'answer', askId },
  };
}

async function answerView(r: Reader, askId: string) {
  const response = await app.inject({ url: `/v1/asks/${askId}/answer`, headers: headers(r) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { status: string; kept: boolean; seemsWrong: boolean };
}
const keep = (r: Reader, target: Target, clientRequestId: string = randomUUID(), expectedPrivacyEpoch = r.epoch) =>
  app.inject({ method: 'POST', url: '/v1/relics', headers: headers(r), payload: { clientRequestId, expectedPrivacyEpoch, ...target } satisfies RelicKeepInput });
async function kept(r: Reader, target: Target): Promise<RelicWire> {
  const response = await keep(r, target);
  assert.equal(response.statusCode, 201, response.body);
  return relicKeepResponse.parse(response.json()).relic;
}
async function relics(r: Reader, page?: string) {
  const response = await app.inject({ url: `/v1/relics${page ? `?page=${encodeURIComponent(page)}` : ''}`, headers: headers(r) });
  assert.equal(response.statusCode, 200, response.body);
  noSource(r, response.body);
  return relicsResponse.parse(response.json());
}
const object = (r: Reader, target: { kind: 'passage'; assetId: string; claimKey: string } | { kind: 'answer'; askId: string }, clientRequestId: string = randomUUID()) =>
  app.inject({ method: 'POST', url: '/v1/objections', headers: headers(r), payload: { clientRequestId, expectedPrivacyEpoch: r.epoch, ...target } });
async function passages(r: Reader, assetId: string) {
  const response = await app.inject({ url: `/v1/scrolls/${assetId}/passages`, headers: headers(r) });
  assert.equal(response.statusCode, 200, response.body);
  noSource(r, response.body);
  return passagesResponse.parse(response.json());
}
const release = (r: Reader, relicId: string) =>
  app.inject({ method: 'POST', url: `/v1/relics/${relicId}/release`, headers: headers(r), payload: { expectedPrivacyEpoch: r.epoch } });
const privacy = (r: Reader, action: 'pause' | 'resume') =>
  app.inject({ method: 'POST', url: `/v1/privacy/${action}`, headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: r.epoch } });
const byKind = (list: RelicWire[]) => Object.fromEntries(list.map(relic => [relic.kind, relic]));

/** Readers never see a source (owner decision, #161): not its title, publisher, address or key. */
function noSource(r: Reader, body: string) {
  for (const s of ['physics', 'stars', 'bridge', 'biology'] as const) {
    assert.ok(!body.includes(r.f.sources[s]), `the ${s} source key`);
    assert.ok(!body.includes(`${s[0]!.toUpperCase()}${s.slice(1)} fixture`), `the ${s} source title`);
  }
  assert.ok(!body.includes('example.test'), 'a source address');
  assert.ok(!/source|publisher/i.test(body), body.slice(0, 400));
}

test('a place, a passage and an answer are kept with their kept form and state, and no source', async () => {
  const k = await prepared();
  const listed = await passages(k.r, k.r.f.assets.gravity);
  assert.equal(listed.revision, 1);
  assert.deepEqual(listed.passages, [{ claimKey: k.r.f.claims.gravity, statement: 'Every mass attracts every other mass through gravity.', withdrawn: false, kept: false, seemsWrong: false }]);

  const place = await kept(k.r, k.place);
  assert.ok(place.kind === 'place');
  assert.deepEqual([place.state, place.place.kind, place.place.anchor.name, place.place.formation],
    ['current', 'sighting', 'Tides', 'Tides appeared near Gravity: Gravity explains Tides.']);
  const passage = await kept(k.r, k.passage);
  assert.ok(passage.kind === 'passage');
  assert.deepEqual([passage.state, passage.passage.title, passage.passage.revision, passage.passage.claim.statement, passage.passage.claim.withdrawn],
    ['current', `${k.r.f.tag} Gravity pulls`, 1, 'Every mass attracts every other mass through gravity.', false]);
  const answer = await kept(k.r, k.answer);
  assert.ok(answer.kind === 'answer');
  assert.equal(answer.state, 'current');
  assert.equal(answer.answer.question, 'What pulls things together?');
  assert.equal(answer.answer.title, `${k.r.f.tag} Gravity pulls`);
  assert.ok(answer.answer.answer.startsWith('Fixture answer') && answer.answer.basis.length === 1 && answer.answer.limits.length > 0);

  const list = await relics(k.r);
  assert.deepEqual(list.relics.map(x => x.kind), ['answer', 'passage', 'place'], 'newest first');
  assert.deepEqual([list.nextPage, list.recordingPaused], [null, false]);
  assert.equal((await passages(k.r, k.r.f.assets.gravity)).passages[0]!.kept, true);
  assert.deepEqual(await answerView(k.r, k.askId).then(v => [v.kept, v.seemsWrong]), [true, false]);
  // Another reader sees none of it, and cannot keep this reader's place or answer.
  const stranger = await reader();
  assert.deepEqual((await relics(stranger)).relics, []);
  for (const target of [k.place, k.answer]) assert.equal((await keep(stranger, target)).statusCode, 422, target.kind);
});

test('keeping is idempotent, one Relic per thing, and a key names one thing', async () => {
  const k = await prepared();
  for (const target of [k.place, k.passage, k.answer]) {
    const key = randomUUID();
    const first = await keep(k.r, target, key);
    assert.equal(first.statusCode, 201, first.body);
    const replay = await keep(k.r, target, key);
    assert.deepEqual([replay.statusCode, replay.json().relic.relicId], [200, first.json().relic.relicId], `${target.kind}: a replay is the same Relic`);
    const again = await keep(k.r, target);
    assert.deepEqual([again.statusCode, again.json().relic.relicId], [200, first.json().relic.relicId], `${target.kind}: one per thing`);
    const other = target.kind === 'answer' ? k.place : k.answer;
    assert.equal((await keep(k.r, other, key)).statusCode, 409, `${target.kind}: a key reused for another thing`);
  }
  assert.equal((await relics(k.r)).relics.length, 3);
});

test('nothing is kept or doubted while paused, nor what the reader has not read or cannot keep', async () => {
  const k = await prepared();
  assert.equal((await privacy(k.r, 'pause')).statusCode, 200);
  for (const target of [k.place, k.passage, k.answer]) assert.equal((await keep(k.r, target)).statusCode, 409, `${target.kind} while paused`);
  assert.equal((await object(k.r, { kind: 'answer', askId: k.askId })).statusCode, 409, 'an objection while paused');
  assert.equal((await relics(k.r)).recordingPaused, true);
  assert.equal((await passages(k.r, k.r.f.assets.gravity)).recordingPaused, true);
  assert.equal((await privacy(k.r, 'resume')).statusCode, 200);

  assert.equal((await keep(k.r, k.place, randomUUID(), 1)).statusCode, 409, 'a stale epoch');
  assert.equal((await keep(k.r, { kind: 'passage', assetId: k.r.f.assets.sun, revision: 1, claimKey: k.r.f.claims.sun })).statusCode, 422, 'a Scroll never read');
  assert.equal((await keep(k.r, { kind: 'passage', assetId: k.r.f.assets.gravity, revision: 1, claimKey: k.r.f.claims.sun })).statusCode, 422, 'a claim the Scroll does not present');
  assert.equal((await keep(k.r, { kind: 'passage', assetId: k.r.f.assets.gravity, revision: 2, claimKey: k.r.f.claims.gravity })).statusCode, 409, 'a revision the reader did not read');
  assert.equal((await keep(k.r, { kind: 'place', placeId: randomUUID() })).statusCode, 422, 'an unknown place');
  assert.equal((await keep(k.r, { kind: 'answer', askId: randomUUID() })).statusCode, 422, 'an unknown answer');
  assert.equal((await object(k.r, { kind: 'passage', assetId: k.r.f.assets.sun, claimKey: k.r.f.claims.sun })).statusCode, 422, 'an objection to a Scroll never read');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/relics', headers: headers(k.r), payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0, kind: 'moon', placeId: randomUUID() } })).statusCode, 400);
  assert.equal((await app.inject({ url: `/v1/scrolls/${randomUUID()}/passages`, headers: headers(k.r) })).statusCode, 404);
  assert.deepEqual((await relics(k.r)).relics, []);
});

test('a real source correction marks each kind corrected, and the kept forms stay readable', async () => {
  const k = await prepared();
  const before = byKind([await kept(k.r, k.place), await kept(k.r, k.passage), await kept(k.r, k.answer)]);
  // The publisher withdraws the physics page: it alone supports the Gravity claim and the relation
  // that put Tides on Gravity's horizon.
  await transaction(client => correctSourceSnapshot(client, { sourceKey: k.r.f.sources.physics, action: 'revoked', reason: 'Fixture: the publisher withdrew this page' }, 'editorial'));
  await formPlaces(k.r.universeId, [], [k.r.f.codes.gravity]); // the Cartographer's next refresh

  const after = byKind((await relics(k.r)).relics);
  assert.deepEqual(['place', 'passage', 'answer'].map(kind => after[kind]!.state), ['corrected', 'corrected', 'corrected']);
  const { state: _p, ...placeForm } = after.place!;
  const { state: _q, ...placeBefore } = before.place!;
  assert.deepEqual(placeForm, placeBefore, 'the place as kept');
  assert.ok(after.passage!.kind === 'passage' && after.passage!.passage.claim.withdrawn, 'its claim is marked withdrawn, never by source');
  assert.ok(after.answer!.kind === 'answer' && before.answer!.kind === 'answer');
  assert.deepEqual(after.answer!.answer, before.answer!.answer, 'the answer as kept');
  const now = await passages(k.r, k.r.f.assets.gravity);
  assert.deepEqual([now.passages[0]!.withdrawn, now.passages[0]!.kept], [true, true]);
  assert.equal((await keep(k.r, { ...k.passage })).statusCode, 200, 'the kept one is still answered');
});

test('a newer revision of the Scroll corrects a passage and an answer, and leaves a place alone', async () => {
  const k = await prepared();
  await kept(k.r, k.place); await kept(k.r, k.passage); await kept(k.r, k.answer);
  await pool.query(`UPDATE asset SET revision=2, body='A revised body that says something else entirely.' WHERE id=$1`, [k.r.f.assets.gravity]);
  const states = Object.fromEntries((await relics(k.r)).relics.map(x => [x.kind, x.state]));
  assert.deepEqual(states, { place: 'current', passage: 'corrected', answer: 'corrected' });
  const sameClaim = { kind: 'passage' as const, assetId: k.r.f.assets.gravity, revision: 2, claimKey: k.r.f.claims.gravity };
  assert.equal((await keep(k.r, sameClaim)).statusCode, 409, 'not the revision the reader read');
});

test('the reader\'s doubt: "seems wrong" on a passage and an answer, "Set aside" on a place', async () => {
  const k = await prepared();
  const gravity = await placeOf(k.r, k.r.f.codes.gravity);
  const ids = [await kept(k.r, { kind: 'place', placeId: gravity }), await kept(k.r, k.passage), await kept(k.r, k.answer)].map(x => x.relicId);

  const key = randomUUID();
  const first = await object(k.r, { kind: 'passage', assetId: k.r.f.assets.gravity, claimKey: k.r.f.claims.gravity }, key);
  assert.equal(first.statusCode, 201, first.body);
  const objectionId = objectionResponse.parse(first.json()).objectionId;
  const replay = await object(k.r, { kind: 'passage', assetId: k.r.f.assets.gravity, claimKey: k.r.f.claims.gravity }, key);
  assert.deepEqual([replay.statusCode, replay.json().objectionId], [200, objectionId]);
  const again = await object(k.r, { kind: 'passage', assetId: k.r.f.assets.gravity, claimKey: k.r.f.claims.gravity });
  assert.deepEqual([again.statusCode, again.json().objectionId], [200, objectionId], 'one objection per thing');
  assert.equal((await object(k.r, { kind: 'answer', askId: k.askId }, key)).statusCode, 409, 'a key reused for another thing');
  assert.equal((await object(k.r, { kind: 'answer', askId: k.askId })).statusCode, 201);
  const aside = await app.inject({ method: 'POST', url: `/v1/atlas/places/${gravity}/reject`, headers: headers(k.r), payload: { expectedPrivacyEpoch: k.r.epoch } });
  assert.equal(aside.statusCode, 200, aside.body);

  const list = (await relics(k.r)).relics;
  assert.deepEqual(list.map(x => x.state), ['doubted', 'doubted', 'doubted']);
  assert.deepEqual([(await passages(k.r, k.r.f.assets.gravity)).passages[0]!.seemsWrong, (await answerView(k.r, k.askId)).seemsWrong], [true, true]);
  for (const id of ids) assert.equal((await release(k.r, id)).statusCode, 200);
  for (const target of [{ kind: 'place' as const, placeId: gravity }, k.passage, k.answer]) assert.equal((await keep(k.r, target)).statusCode, 422, `${target.kind}: a doubted thing is not kept anew`);
});

test('let go, Clear and Reset erase every kind and its objections; export carries their provenance first', async () => {
  const k = await prepared();
  const place = await kept(k.r, k.place);
  await kept(k.r, k.passage); await kept(k.r, k.answer);
  assert.equal((await object(k.r, { kind: 'answer', askId: k.askId })).statusCode, 201);

  const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(k.r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(exported.statusCode, 200, exported.body);
  const body = exported.json();
  assert.deepEqual([body.rowCounts.relics, body.rowCounts.objections, body.returns.objections.length], [3, 1, 1]);
  const rows = Object.fromEntries((body.returns.relics as Record<string, unknown>[]).map(row => [row.kind as string, row]));
  assert.equal(rows.place!.place_id, k.place.kind === 'place' && k.place.placeId);
  assert.equal(rows.place!.place_kind, 'sighting');
  assert.match(String(rows.place!.formation_delta_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual([rows.passage!.asset_revision, rows.passage!.cited_claim_keys], [1, [k.r.f.claims.gravity]]);
  assert.match(String(rows.passage!.exposure_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual([rows.answer!.ask_id, rows.answer!.cited_claim_keys], [k.askId, [k.r.f.claims.gravity]]);

  assert.equal((await release(k.r, place.relicId)).statusCode, 200);
  assert.equal((await release(k.r, place.relicId)).statusCode, 200, 'letting go of what is gone answers the same');
  assert.equal((await relics(k.r)).relics.length, 2);

  const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: headers(k.r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  k.r.epoch = 1;
  for (const table of ['relic', 'reader_objection']) assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [k.r.universeId])).rows[0].count), 0, table);
  assert.deepEqual((await relics(k.r)).relics, []);

  const reset = await prepared();
  await kept(reset.r, reset.place); await kept(reset.r, reset.passage); await kept(reset.r, reset.answer);
  assert.equal((await object(reset.r, { kind: 'passage', assetId: reset.r.f.assets.gravity, claimKey: reset.r.f.claims.gravity })).statusCode, 201);
  const done = await app.inject({ method: 'POST', url: '/v1/privacy/reset', headers: headers(reset.r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' } });
  assert.equal(done.statusCode, 200, done.body);
  for (const table of ['relic', 'reader_objection']) assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [reset.r.universeId])).rows[0].count), 0, table);
});

test('SQL guards: a typed Relic keeps only what it names, and an objection is history like a Relic', async () => {
  const k = await prepared();
  const exposure = (await pool.query(`SELECT e.id FROM exposure e WHERE e.universe_id=$1 AND e.asset_id=$2`, [k.r.universeId, k.r.f.assets.gravity])).rows[0].id;
  const claim = (key: string) => pool.query('SELECT id FROM claim WHERE key=$1', [key]).then(res => res.rows[0].id as string);
  const insertPassage = async (claimKey: string, revision = 1) => pool.query(
    `INSERT INTO relic(id, universe_id, privacy_epoch, client_request_id, kind, asset_id, asset_revision, scroll_title, exposure_id, claim_id, cited_claim_keys)
     VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), 'passage', $2, $3, 'A title', $4, $5, $6)`,
    [k.r.universeId, k.r.f.assets.gravity, revision, exposure, await claim(claimKey), JSON.stringify([claimKey])]);
  await assert.rejects(insertPassage(k.r.f.claims.sun), /supported claim/);
  await assert.rejects(insertPassage(k.r.f.claims.gravity, 2), /supported claim/);
  await assert.rejects(pool.query(`INSERT INTO relic(id, universe_id, privacy_epoch, client_request_id, kind, place_id, place_kind, formation_delta_id, cited_claim_keys)
    VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), 'place', $2, 'sighting', gen_random_uuid(), '[]')`, [k.r.universeId, k.place.kind === 'place' && k.place.placeId]), /formation_delta_id|formed it/);
  await assert.rejects(pool.query(`INSERT INTO relic(id, universe_id, privacy_epoch, client_request_id, kind, ask_id, asset_id, asset_revision, scroll_title, cited_claim_keys, place_kind)
    VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), 'answer', $2, $3, 1, 'A title', '[]', 'planet')`, [k.r.universeId, k.askId, k.r.f.assets.gravity]), /relic_kind_shape/);
  await insertPassage(k.r.f.claims.gravity);
  await assert.rejects(pool.query(`UPDATE relic SET kept_at = kept_at WHERE universe_id=$1`, [k.r.universeId]), /immutable/);
  const objection = () => pool.query(`INSERT INTO reader_objection(id, universe_id, privacy_epoch, client_request_id, kind, ask_id) VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), 'answer', $2)`, [k.r.universeId, k.askId]);
  await objection();
  await assert.rejects(pool.query(`UPDATE reader_objection SET objected_at = objected_at WHERE universe_id=$1`, [k.r.universeId]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM reader_objection WHERE universe_id=$1', [k.r.universeId]), /erased only after/);
  await assert.rejects(objection(), /duplicate key/);
});

test('the Relic list pages newest first, so the oldest can be reached and let go (M8)', async () => {
  const r = await reader();
  // 101 places of the reader's own: one more than a page.
  const tag = `m${randomBytes(5).toString('hex')}`;
  const codes = Array.from({ length: 101 }, (_, i) => `${tag}.place_${i}`);
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-09-25.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [{ key: `fam.${tag}`, kind: 'publisher', description: 'Synthetic paging test family' }],
    sources: [{ key: `src.${tag}`, url: `https://example.test/${tag}`, title: 'Paging fixture', publisher: 'Fixture', familyKey: `fam.${tag}`, retrievedAt: '2026-09-25', contentSha256: randomBytes(32).toString('hex') }],
    concepts: [{ code: tag, name: 'Paging fixture root', description: 'Root of a synthetic paging substrate', kind: 'idea', parentCode: null },
      ...codes.map((code, i) => ({ code, name: `Place ${i}`, description: 'A place for the paging test', kind: 'idea' as const, parentCode: tag }))],
    claims: [{ key: `clm.${tag}`, statement: 'A claim the paging fixture needs to load.', truthState: 'documented', concepts: [{ code: tag, role: 'subject' }],
      support: [{ sourceKey: `src.${tag}`, quote: 'A verbatim passage long enough to be a quote.', supportKind: 'supports' }] }],
    relations: [], assets: [], bridgeProposals: [],
  };
  assert.equal((await transaction(client => loadSubstrateSeed(client, JSON.stringify(seed)))).status, 'loaded');
  await formPlaces(r.universeId, codes);
  const places = (await pool.query(`SELECT id FROM atlas_place WHERE universe_id=$1 AND state='live' ORDER BY created_at, id`, [r.universeId])).rows.map(x => x.id as string);
  assert.equal(places.length, 101);
  const keptIds: string[] = [];
  for (const placeId of places) keptIds.push((await kept(r, { kind: 'place', placeId })).relicId);

  const first = await relics(r);
  assert.equal(first.relics.length, 100);
  assert.ok(first.nextPage);
  const second = await relics(r, first.nextPage!);
  assert.deepEqual([second.relics.map(x => x.relicId), second.nextPage], [[keptIds[0]], null], 'the oldest, alone on the next page');
  assert.deepEqual(new Set([...first.relics, ...second.relics].map(x => x.relicId)), new Set(keptIds), 'every Relic exactly once');
  assert.equal((await release(r, keptIds[0]!)).statusCode, 200);
  const after = await relics(r);
  assert.deepEqual([after.relics.length, after.nextPage], [100, null]);
  assert.equal((await app.inject({ url: '/v1/relics?page=not-a-cursor', headers: headers(r) })).statusCode, 400);
});
