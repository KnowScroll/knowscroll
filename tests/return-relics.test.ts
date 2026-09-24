/**
 * #134 — the return and Relics (ADR-0039) against real PostgreSQL, the real Fastify app and the
 * inquiry worker over the fixture transport: what changed while the reader was away (only what they
 * did not cause), the marker they move, a connection kept as a Relic whose state shows a later
 * source correction or their own doubt, release, pause, Clear and export, and the SQL guards.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { awayResponse, awayAcknowledgeResponse } from '../packages/contracts/src/away.ts';
import { relicKeepResponse, relicsResponse } from '../packages/contracts/src/relics.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerFairnessPolicy } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { inquiryAuthority, installBackgroundInquiryRoute } from '../packages/db/src/reasoning-inquiries.ts';
import { settleInquiries } from '../packages/db/src/reasoning-inquiry-execution.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { runInquiryPass } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport, type InquiryFixtureMode } from '../apps/worker/src/providers/inquiry-fixture.ts';
import { formPlaces, loadInquiryFixture, type InquiryFixture } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Return tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'return-relics-test-v1';
let mode: InquiryFixtureMode = 'proposal';
const fixture = createFixtureInquiryTransport(() => mode, { count: 0 });

before(async () => {
  await createReasoningFairness(pool, inquiryAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(client => installBackgroundInquiryRoute(client, { policyVersion: POLICY, routeId: `fixture-${POLICY}`, routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 200, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, coalescingDelaySeconds: 0, jobTtlSeconds: 600, remoteSlots: 16 }));
  await pool.query('UPDATE background_inquiry_route SET enabled=false WHERE enabled');
  await pool.query('UPDATE background_inquiry_route SET enabled=true WHERE policy_version=$1', [POLICY]);
});
after(async () => { await app.close(); await pool.end(); });

type Reader = { token: string; universeId: string; epoch: number; places: string[]; f: InquiryFixture };
const headers = (r: Reader) => ({ authorization: `Bearer ${r.token}` });
const pass = () => runInquiryPass({ pool, owner: 'return-test-worker', leaseMs: 60_000, transports: { fixture }, signal: new AbortController().signal });

/** A reader with their own substrate (a source correction here must not reach another test). */
async function reader(): Promise<Reader> {
  const identity = await provisionIdentity();
  return { token: identity.token, universeId: identity.scope.universeId, epoch: 0, places: [], f: await loadInquiryFixture(pool) };
}
async function consentOn(r: Reader) {
  const response = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(r),
    payload: { enabled: true, clientRequestId: randomUUID(), expectedPrivacyEpoch: r.epoch } });
  assert.equal(response.statusCode, 200, response.body);
}
async function form(r: Reader, ...names: (keyof InquiryFixture['codes'])[]) {
  const codes = names.map(n => r.f.codes[n]);
  await formPlaces(r.universeId, codes, r.places);
  r.places.push(...codes);
}
/** Runs the worker until this reader has no open inquiry (another file's queued work may come first). */
async function drain(r: Reader) {
  for (let i = 0; i < 20; i += 1) {
    if (!(await pool.query(`SELECT 1 FROM background_inquiry WHERE universe_id=$1 AND status IN ('pending','queued')`, [r.universeId])).rowCount) return;
    await pass();
    await settleInquiries(pool, { owner: 'return-test-worker' });
  }
  throw new Error('inquiry never closed');
}
async function away(r: Reader) {
  const response = await app.inject({ url: '/v1/away', headers: headers(r) });
  assert.equal(response.statusCode, 200, response.body);
  return awayResponse.parse(response.json());
}
const acknowledge = (r: Reader, through: string, clientRequestId: string = randomUUID(), expectedPrivacyEpoch = r.epoch) =>
  app.inject({ method: 'POST', url: '/v1/away/acknowledge', headers: headers(r), payload: { clientRequestId, expectedPrivacyEpoch, through } });
const keep = (r: Reader, bridgeId: string, clientRequestId: string = randomUUID(), expectedPrivacyEpoch = r.epoch) =>
  app.inject({ method: 'POST', url: '/v1/relics', headers: headers(r), payload: { clientRequestId, expectedPrivacyEpoch, kind: 'connection', bridgeId } });
async function relics(r: Reader) {
  const response = await app.inject({ url: '/v1/relics', headers: headers(r) });
  assert.equal(response.statusCode, 200, response.body);
  return relicsResponse.parse(response.json()).relics;
}
const release = (r: Reader, relicId: string) =>
  app.inject({ method: 'POST', url: `/v1/relics/${relicId}/release`, headers: headers(r), payload: { expectedPrivacyEpoch: r.epoch } });
const privacy = (r: Reader, action: 'pause' | 'resume') =>
  app.inject({ method: 'POST', url: `/v1/privacy/${action}`, headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: r.epoch } });
const seemsWrong = (r: Reader, bridgeId: string) =>
  app.inject({ method: 'POST', url: '/v1/connections/feedback', headers: headers(r), payload: { clientFeedbackId: randomUUID(), bridgeId, expectedPrivacyEpoch: r.epoch, objection: 'seems_wrong' } });

/** Consent, places, and a found connection: the background work of ADR-0038, done while away. */
async function foundWhileAway(r: Reader) {
  await consentOn(r);
  await form(r, 'gravity', 'sun');
  await drain(r);
  const items = (await away(r)).items;
  const found = items.find(i => i.kind === 'connection_found');
  assert.ok(found && found.kind === 'connection_found', JSON.stringify(items.map(i => i.kind)));
  return found;
}

test('a fresh reader has nothing waiting and no marker', async () => {
  const r = await reader();
  assert.deepEqual(await away(r), { privacyEpoch: 0, since: null, items: [], more: 0, recordingPaused: false });
  assert.equal((await app.inject({ url: '/v1/away' })).statusCode, 401);
});

test('return after real background work: found, inspected, kept, acknowledged; a source correction then reaches the Relic', async () => {
  mode = 'proposal';
  const r = await reader();
  const found = await foundWhileAway(r);
  const listed = await away(r);
  // Only what the reader did not cause: the places they formed by reading are not "away" news.
  assert.deepEqual(listed.items.map(i => i.kind), ['connection_found']);
  assert.equal(found.found.bridgeStatus, 'admitted');
  assert.ok(found.found.evidence.length >= 3, 'the evidence it was admitted on');
  const inquiryId = (await pool.query('SELECT id FROM background_inquiry WHERE universe_id=$1', [r.universeId])).rows[0].id;
  assert.equal(found.inquiryId, inquiryId);

  const kept = await keep(r, found.found.bridgeId);
  assert.equal(kept.statusCode, 201, kept.body);
  const relic = relicKeepResponse.parse(kept.json()).relic;
  assert.deepEqual([relic.state, relic.kind, relic.provenance.inquiryId, relic.provenance.validatorVersion], ['current', 'connection', inquiryId, 'bridge-validator-v1']);
  assert.deepEqual([...relic.provenance.citedClaimKeys].sort(), [r.f.claims.both, r.f.claims.gravity, r.f.claims.sun].sort());

  // Another reader sees none of it (review I3).
  const stranger = await reader();
  assert.deepEqual([(await away(stranger)).items, await relics(stranger)], [[], []]);

  const acked = await acknowledge(r, found.at);
  assert.equal(acked.statusCode, 200, acked.body);
  assert.equal(awayAcknowledgeResponse.parse(acked.json()).since, found.at);
  assert.deepEqual((await away(r)).items, [], 'seen once, not shown again');

  // Tides is a sighting near Gravity through a relation the physics source supports.
  const sighting = (await pool.query(`SELECT p.id FROM atlas_place p JOIN concept c ON c.id=p.anchor_concept_id
    WHERE p.universe_id=$1 AND p.kind='sighting' AND p.state='live' AND c.code=$2`, [r.universeId, r.f.codes.tides])).rows[0];
  assert.ok(sighting, 'fixture: Tides is on the horizon before the correction');
  // While the reader is away the publisher withdraws the physics page: the found connection cites it.
  await transaction(client => correctSourceSnapshot(client, { sourceKey: r.f.sources.physics, action: 'revoked', reason: 'Fixture: the publisher withdrew this page' }, 'editorial'));
  await formPlaces(r.universeId, [], r.places); // the Cartographer's next refresh

  const later = await away(r);
  assert.equal(later.since, found.at);
  const kinds = later.items.map(i => i.kind).sort();
  assert.deepEqual(kinds, ['connection_corrected', 'place_changed']);
  const corrected = later.items.find(i => i.kind === 'connection_corrected')!;
  assert.ok(corrected.kind === 'connection_corrected' && corrected.bridgeId === found.found.bridgeId && corrected.status === 'revoked');
  const place = later.items.find(i => i.kind === 'place_changed')!;
  assert.ok(place.kind === 'place_changed' && place.change === 'sighting_retired' && place.placeId === sighting.id);
  assert.equal(place.line, 'Tides left the horizon: the source behind it changed.');

  const [after] = await relics(r);
  assert.deepEqual([after!.relicId, after!.state, after!.connection.bridgeStatus], [relic.relicId, 'corrected', 'revoked']);
  assert.equal(after!.connection.sentence, relic.connection.sentence, 'the kept form stays readable');

  assert.equal((await release(r, relic.relicId)).statusCode, 200);
  assert.deepEqual(await relics(r), []);
  assert.equal((await release(r, relic.relicId)).statusCode, 200, 'releasing what is gone is the same outcome');
});

test('nothing found and did not hold up are away news too, with their pairs and the validator\'s reasons', async () => {
  for (const [fixtureMode, kind] of [['none', 'nothing_found'], ['invalid_bridge', 'connection_did_not_hold_up']] as const) {
    mode = fixtureMode;
    const r = await reader();
    await consentOn(r);
    await form(r, 'gravity', 'sun');
    await drain(r);
    mode = 'proposal';
    const [item] = (await away(r)).items;
    assert.equal(item?.kind, kind);
    if (item?.kind === 'connection_did_not_hold_up') assert.ok(item.reasons.includes('analogy_limit_missing'), JSON.stringify(item.reasons));
    if (item?.kind === 'nothing_found' || item?.kind === 'connection_did_not_hold_up') assert.deepEqual(item.pairs[0]!.a.name === 'Gravity' || item.pairs[0]!.b.name === 'Gravity', true);
  }
});

test('the marker: forward only, replay-safe, never in the future, never while paused, and per epoch', async () => {
  mode = 'proposal';
  const r = await reader();
  const found = await foundWhileAway(r);
  assert.equal((await acknowledge(r, found.at, undefined, 1)).statusCode, 409, 'stale epoch');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/away/acknowledge', headers: headers(r), payload: { through: found.at } })).statusCode, 400);
  assert.equal((await acknowledge(r, new Date(Date.now() + 60_000).toISOString())).statusCode, 422, 'never in the future');

  assert.equal((await privacy(r, 'pause')).statusCode, 200);
  const paused = await away(r);
  assert.equal(paused.recordingPaused, true);
  const refused = await acknowledge(r, found.at);
  assert.deepEqual([refused.statusCode, refused.json().error ?? refused.json().message], [409, 'Recording is paused']);
  assert.equal((await privacy(r, 'resume')).statusCode, 200);

  const key = randomUUID();
  assert.equal((await acknowledge(r, found.at, key)).statusCode, 200);
  assert.equal((await acknowledge(r, found.at, key)).statusCode, 200, 'a replay is the same answer');
  assert.equal((await acknowledge(r, new Date(Date.parse(found.at) - 1000).toISOString(), key)).statusCode, 409, 'a key reused for another time');
  const behind = await acknowledge(r, new Date(Date.parse(found.at) - 1000).toISOString());
  assert.equal(awayAcknowledgeResponse.parse(behind.json()).since, found.at, 'behind the marker changes nothing');
  assert.equal(Number((await pool.query('SELECT count(*) FROM away_acknowledgement WHERE universe_id=$1', [r.universeId])).rows[0].count), 1);
});

test('keeping a Relic: idempotent, one per connection, refused while paused, for doubted or unknown connections', async () => {
  mode = 'proposal';
  const r = await reader();
  const found = await foundWhileAway(r);
  const bridgeId = found.found.bridgeId;
  assert.equal((await keep(r, randomUUID())).statusCode, 422, 'an unknown connection');
  assert.equal((await keep(r, bridgeId, undefined, 1)).statusCode, 409, 'stale epoch');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/relics', headers: headers(r), payload: { kind: 'place', bridgeId } })).statusCode, 400);

  assert.equal((await privacy(r, 'pause')).statusCode, 200);
  assert.equal((await keep(r, bridgeId)).statusCode, 409, 'nothing is kept while paused');
  assert.equal((await privacy(r, 'resume')).statusCode, 200);

  const key = randomUUID();
  const first = await keep(r, bridgeId, key);
  assert.equal(first.statusCode, 201);
  const relicId = first.json().relic.relicId;
  const replay = await keep(r, bridgeId, key);
  assert.deepEqual([replay.statusCode, replay.json().relic.relicId], [200, relicId]);
  const again = await keep(r, bridgeId);
  assert.deepEqual([again.statusCode, again.json().relic.relicId], [200, relicId], 'one Relic per connection');
  const other = await reader();
  assert.equal((await keep(other, bridgeId)).statusCode, 422, 'a personal connection stays in its universe');

  // Doubting it afterwards is shown on the Relic, not hidden; a doubted connection is not kept anew.
  assert.equal((await seemsWrong(r, bridgeId)).statusCode, 201);
  assert.equal((await relics(r))[0]!.state, 'doubted');
  assert.equal((await release(r, relicId)).statusCode, 200);
  assert.equal((await keep(r, bridgeId)).statusCode, 422, 'a connection marked "seems wrong" is not kept');
});

test('Clear erases Relics and markers; export carried them first', async () => {
  mode = 'proposal';
  const r = await reader();
  const found = await foundWhileAway(r);
  assert.equal((await keep(r, found.found.bridgeId)).statusCode, 201);
  assert.equal((await acknowledge(r, found.at)).statusCode, 200);
  const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(exported.statusCode, 200, exported.body);
  const body = exported.json();
  assert.deepEqual([body.rowCounts.relics, body.rowCounts.awayAcknowledgements, body.returns.relics.length, body.returns.acknowledgements.length], [1, 1, 1, 1]);
  assert.equal(body.returns.relics[0].bridge_id, found.found.bridgeId);

  const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  r.epoch = 1;
  for (const table of ['relic', 'away_acknowledgement']) {
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [r.universeId])).rows[0].count), 0, table);
  }
  assert.deepEqual(await away(r), { privacyEpoch: 1, since: null, items: [], more: 0, recordingPaused: false });
});

test('SQL guards: rows are immutable, bound to the current epoch, never written while paused, and a marker never moves back', async () => {
  mode = 'proposal';
  const r = await reader();
  const found = await foundWhileAway(r);
  const bridgeId = found.found.bridgeId;
  const insertRelic = (epoch: number, bridge = bridgeId) => pool.query(
    `INSERT INTO relic(id, universe_id, privacy_epoch, client_request_id, kind, bridge_id, validator_version, cited_claim_keys)
     VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'connection', $3, 'bridge-validator-v1', '["k"]')`, [r.universeId, epoch, bridge]);
  await assert.rejects(insertRelic(1), /current privacy epoch/);
  await insertRelic(0);
  await assert.rejects(pool.query(`UPDATE relic SET kept_at = kept_at WHERE universe_id=$1`, [r.universeId]), /immutable/);
  await assert.rejects(pool.query(`INSERT INTO away_acknowledgement(id, universe_id, privacy_epoch, client_request_id, through)
    VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), clock_timestamp() + interval '1 hour')`, [r.universeId]), /future|through/);
  await pool.query(`INSERT INTO away_acknowledgement(id, universe_id, privacy_epoch, client_request_id, through) VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), $2)`, [r.universeId, found.at]);
  await assert.rejects(pool.query(`INSERT INTO away_acknowledgement(id, universe_id, privacy_epoch, client_request_id, through)
    VALUES (gen_random_uuid(), $1, 0, gen_random_uuid(), $2::timestamptz - interval '1 second')`, [r.universeId, found.at]), /only moves forward/);
  await assert.rejects(pool.query('DELETE FROM away_acknowledgement WHERE universe_id=$1', [r.universeId]), /erased only after/);
  assert.equal((await privacy(r, 'pause')).statusCode, 200);
  await pool.query('DELETE FROM relic WHERE universe_id=$1', [r.universeId]); // release is allowed while paused
  await assert.rejects(insertRelic(0), /Recording is paused/);
  assert.equal((await privacy(r, 'resume')).statusCode, 200);
  // A connection that is no longer admitted cannot be kept, even by SQL.
  await transaction(client => correctSourceSnapshot(client, { sourceKey: r.f.sources.bridge, action: 'revoked', reason: 'Fixture: withdrawn' }, 'editorial'));
  await assert.rejects(insertRelic(0), /admitted connection/);
});

test('the marker covers an item at its millisecond, so the count of the rest is exact on a full list (review I3)', async () => {
  const r = await reader();
  await form(r, 'gravity');
  const place = (await pool.query(`SELECT p.id FROM atlas_place p JOIN concept c ON c.id=p.anchor_concept_id WHERE p.universe_id=$1 AND c.code=$2`,
    [r.universeId, r.f.codes.gravity])).rows[0].id;
  // Twelve source corrections a second apart, each with microseconds the wire does not carry.
  for (let i = 12; i >= 1; i -= 1) {
    await pool.query(`INSERT INTO atlas_delta(id,universe_id,place_id,kind,causal_class,policy_version,evidence,before,after,created_at)
      VALUES(gen_random_uuid(),$1,$2,'place_released','source_correction','cartographer-v2','{}','{}','{}',
             date_trunc('milliseconds', clock_timestamp()) - make_interval(secs => $3) + interval '456 microseconds')`, [r.universeId, place, i]);
  }
  const first = await away(r);
  assert.deepEqual([first.items.length, first.more], [10, 2]);
  const oldest = (await pool.query(`SELECT date_trunc('milliseconds', min(created_at)) AS at FROM atlas_delta WHERE universe_id=$1 AND causal_class='source_correction'`,
    [r.universeId])).rows[0].at as Date;
  assert.equal((await acknowledge(r, oldest.toISOString())).statusCode, 200);
  const after = await away(r);
  assert.deepEqual([after.items.length, after.more], [10, 1], 'the oldest is covered by a marker at its millisecond');
});

test('Reset erases Relics and markers too (review I3; account deletion: tests/account-deletion.test.ts)', async () => {
  mode = 'proposal';
  const r = await reader();
  const found = await foundWhileAway(r);
  assert.equal((await keep(r, found.found.bridgeId)).statusCode, 201);
  assert.equal((await acknowledge(r, found.at)).statusCode, 200);
  const done = await app.inject({ method: 'POST', url: '/v1/privacy/reset', headers: headers(r),
    payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'reset-personal-universe' } });
  assert.equal(done.statusCode, 200, done.body);
  for (const table of ['relic', 'away_acknowledgement', 'background_inquiry']) {
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [r.universeId])).rows[0].count), 0, table);
  }
});
