/**
 * ADR-0036 — the reader's places over the real Fastify app and database. A reader who keeps two
 * gravity Scrolls on two different days and keeps one from a second source family anchors it:
 * a planet forms with its account as evidence, its unshown typed neighbours appear as sightings
 * with their claims, and each change is a chronicle line with inspectable evidence. The reader can
 * set the planet aside for good; a source correction retires a sighting; pause, Clear and export
 * behave as for the rest of private history; and the schema refuses a place change without a delta.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';
import { atlasDeltaSchema, atlasResponseSchema } from '../packages/contracts/src/atlas.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { refreshPersonalModel } from '../packages/db/src/semantic/personal-model.ts';
import { mintGatedTestReel } from '../scripts/fixtures/gated-reel.ts';
import { EDITORIAL, anchorGravity as anchorGravityIn, readFirstOffered, readScroll, type Identity } from './helpers/reading.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Atlas tests require a disposable knowscroll_test_* database');
const app = buildApp('atlas-places-development-token-1234567890');
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const { oneForce: ONE_FORCE, unseenPull: UNSEEN_PULL, oceanRhythm: OCEAN_RHYTHM, starBorn: STAR_BORN } = EDITORIAL;
const h = (i: Identity) => ({ authorization: `Bearer ${i.token}` });
const epoch = async (i: Identity) => (await app.inject({ url: '/v1/universe', headers: h(i) })).json().privacyEpoch as number;

const read = (i: Identity, assetId: string, keep: boolean) => readScroll(app, h(i), assetId, keep);
const readAnything = (i: Identity) => readFirstOffered(app, h(i));

const anchorGravity = () => anchorGravityIn(app);

const atlasOf = async (i: Identity) => {
  const r = await app.inject({ url: '/v1/atlas', headers: h(i) });
  assert.equal(r.statusCode, 200, r.body);
  // Every served atlas satisfies the strict wire contract the clients parse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return atlasResponseSchema.parse(r.json()) as any;
};

test('reading gravity on two days across two source families forms a planet with sightings, each with its evidence', async () => {
  const i = await anchorGravity();
  const atlas = await atlasOf(i);
  const planet = atlas.places.find((p: { anchor: { code: string } }) => p.anchor.code === 'physics.gravity');
  assert.ok(planet, JSON.stringify(atlas.places.map((p: { anchor: { code: string }; kind: string }) => [p.anchor.code, p.kind])));
  assert.equal(planet.kind, 'planet');
  assert.equal(planet.attention.state, 'anchored');
  assert.deepEqual([planet.attention.daysActive >= 2, planet.attention.sourceFamilies >= 2], [true, true]);
  assert.ok(planet.scrolls.total >= 2 && planet.scrolls.seen >= 2, JSON.stringify(planet.scrolls));

  const sightings = atlas.places.filter((p: { kind: string; parentPlaceId: string }) => p.kind === 'sighting' && p.parentPlaceId === planet.placeId);
  assert.ok(sightings.length >= 1 && sightings.length <= 5);
  for (const s of sightings) {
    assert.ok(s.basis && (s.basis.claim?.text || s.basis.bridge?.mechanism), 'a sighting shows what connects it');
    assert.equal(s.attention, null, 'a sighting is something the reader has not been shown');
  }
  const formed = atlas.chronicle.find((c: { kind: string; placeId: string }) => c.kind === 'place_formed' && c.placeId === planet.placeId);
  assert.equal(formed.line, 'A place formed around Gravity.');
  assert.ok(atlas.chronicle.some((c: { kind: string; line: string }) => c.kind === 'sighting_appeared' && / appeared near Gravity: Gravity explains /.test(c.line)));

  const evidence = atlasDeltaSchema.parse((await app.inject({ url: `/v1/atlas/deltas/${formed.deltaId}`, headers: h(i) })).json()) as any;
  assert.equal(evidence.causalClass, 'personal_exploration');
  assert.ok(evidence.evidence.account.episodes >= 3 && evidence.evidence.account.episodeIds.length >= 3 && evidence.evidence.account.markIds.length >= 2);
  const sightingDelta = atlas.chronicle.find((c: { kind: string }) => c.kind === 'sighting_appeared');
  const sightingEvidence = (await app.inject({ url: `/v1/atlas/deltas/${sightingDelta.deltaId}`, headers: h(i) })).json();
  assert.equal(sightingEvidence.causalClass, 'substrate_neighbourhood');
  assert.ok(sightingEvidence.evidence.relation && sightingEvidence.evidence.relationSupport);

  // Another universe cannot read it; a second refresh changes nothing.
  const other = await provisionIdentity();
  assert.equal((await app.inject({ url: `/v1/atlas/deltas/${formed.deltaId}`, headers: h(other) })).statusCode, 404);
  assert.deepEqual((await atlasOf(other)).places, []);
  const count = (await pool.query('SELECT count(*)::int n FROM atlas_delta WHERE universe_id=$1', [i.scope.universeId])).rows[0].n;
  await readAnything(i);
  assert.equal((await pool.query('SELECT count(*)::int n FROM atlas_delta WHERE universe_id=$1', [i.scope.universeId])).rows[0].n, count);
});

test('the reader sets a planet aside: its sightings leave, it never forms again, and paused changes are refused', async () => {
  const i = await anchorGravity();
  const planet = (await atlasOf(i)).places.find((p: { anchor: { code: string } }) => p.anchor.code === 'physics.gravity');
  const reject = (e: number) => app.inject({ method: 'POST', url: `/v1/atlas/places/${planet.placeId}/reject`, headers: h(i), payload: { expectedPrivacyEpoch: e } });
  assert.equal((await reject((await epoch(i)) + 1)).statusCode, 409, 'stale epoch');

  const e = await epoch(i);
  await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: h(i), payload: { requestId: randomUUID(), expectedPrivacyEpoch: e } });
  assert.equal((await reject(e)).statusCode, 409, 'nothing personal is recorded while paused');
  await app.inject({ method: 'POST', url: '/v1/privacy/resume', headers: h(i), payload: { requestId: randomUUID(), expectedPrivacyEpoch: e } });

  const after = await reject(e);
  assert.equal(after.statusCode, 200, after.body);
  const atlas = after.json();
  assert.equal(atlas.places.length, 0, 'the planet and its sightings are gone');
  assert.equal(atlas.chronicle[0].line.startsWith('You set Gravity aside.') || atlas.chronicle.some((c: { line: string }) => c.line === 'You set Gravity aside.'), true);
  assert.equal((await reject(e)).statusCode, 200, 'setting aside twice is the same answer');

  await readAnything(i);
  assert.equal((await pool.query('SELECT state FROM attention_account a JOIN concept c ON c.id=a.concept_id WHERE a.universe_id=$1 AND c.code=$2', [i.scope.universeId, 'physics.gravity'])).rows[0].state, 'anchored', 'still anchored');
  assert.equal((await atlasOf(i)).places.some((p: { anchor: { code: string } }) => p.anchor.code === 'physics.gravity'), false, 'a rejected anchor never forms again');
});

test('a source correction retires the sighting it supported, as a correction with its cause', async () => {
  const i = await anchorGravity();
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // rolled back: the shared editorial substrate is left as it was for other tests
    const sighting = (await client.query<{ id: string; basis: { ref: { claimId?: string; bridgeId?: string } } }>(
      `SELECT id, basis FROM atlas_place WHERE universe_id=$1 AND kind='sighting' AND state='live' ORDER BY created_at LIMIT 1`, [i.scope.universeId])).rows[0]!;
    const claims = sighting.basis.ref.claimId ? [sighting.basis.ref.claimId]
      : (await client.query<{ claim_id: string }>('SELECT claim_id FROM bridge_evidence WHERE bridge_id=$1', [sighting.basis.ref.bridgeId])).rows.map(r => r.claim_id);
    const sources = (await client.query<{ key: string }>(
      `SELECT DISTINCT s.key FROM claim_support cs JOIN source_snapshot ss ON ss.id=cs.snapshot_id AND ss.status='current' JOIN semantic_source s ON s.id=ss.source_id
       WHERE cs.claim_id = ANY($1::uuid[])`, [claims])).rows.map(r => r.key);
    for (const key of sources) await correctSourceSnapshot(client, { sourceKey: key, action: 'revoked', reason: 'Test: the publisher withdrew this page' }, 'operator');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [i.scope.universeId]);
    await refreshPersonalModel(client, i.scope.universeId);
    const retired = (await client.query<{ state: string; causal_class: string }>(
      `SELECT p.state, d.causal_class FROM atlas_place p JOIN atlas_delta d ON d.place_id=p.id AND d.kind='sighting_retired' WHERE p.id=$1`, [sighting.id])).rows[0];
    assert.deepEqual(retired, { state: 'retired', causal_class: 'source_correction' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('Clear erases places and deltas; export carries them first', async () => {
  const i = await anchorGravity();
  const e = await epoch(i);
  const exported = (await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: h(i), payload: { requestId: randomUUID(), expectedPrivacyEpoch: e } })).json();
  assert.ok(exported.personalModel.atlasPlaces.length >= 1 && exported.personalModel.atlasDeltas.length >= exported.personalModel.atlasPlaces.length);
  const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: h(i), payload: { requestId: randomUUID(), expectedPrivacyEpoch: e, confirmation: 'clear-scroll-history' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM atlas_place WHERE universe_id=$1) p, (SELECT count(*)::int FROM atlas_delta WHERE universe_id=$1) d`, [i.scope.universeId])).rows[0];
  assert.deepEqual(counts, { p: 0, d: 0 });
});

test('the schema refuses a place without a delta, an edited delta, and a change to a settled place', async () => {
  const i = await anchorGravity();
  const concept = (await pool.query<{ id: string }>("SELECT id FROM concept WHERE code='astro.sun'")).rows[0]!.id;
  const refuse = async (sql: string, params: unknown[], pattern: RegExp) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, params);
      await assert.rejects(client.query('COMMIT'), pattern);
    } catch (error) {
      if (!pattern.test(String(error))) throw error;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  };
  await refuse(`INSERT INTO atlas_place(id,universe_id,anchor_concept_id,kind,policy_version) VALUES($1,$2,$3,'planet','cartographer-v1')`, [randomUUID(), i.scope.universeId, concept], /delta that says why/);
  await refuse(`UPDATE atlas_delta SET causal_class='reader_correction' WHERE universe_id=$1`, [i.scope.universeId], /immutable/);
  const planet = (await pool.query<{ id: string }>(`SELECT p.id FROM atlas_place p JOIN concept c ON c.id=p.anchor_concept_id WHERE p.universe_id=$1 AND c.code='physics.gravity'`, [i.scope.universeId])).rows[0]!.id;
  await refuse(`UPDATE atlas_place SET kind='region' WHERE id=$1`, [planet], /Only a region|delta that says why/);
});

test('review B1/I2/M3: reading a sighting\'s subject retires it as the reader\'s own exploration, and the atlas stays valid', async () => {
  const i = await anchorGravity();
  const before = await atlasOf(i);
  const planet = before.places.find((p: { anchor: { code: string } }) => p.anchor.code === 'physics.gravity');
  const sighting = before.places.find((p: { kind: string; anchor: { code: string } }) => p.kind === 'sighting' && p.anchor.code === 'astro.star.birth');
  assert.ok(sighting, 'Star formation is on Gravity\'s horizon before it is read');
  for (const p of before.places) if (p.kind === 'sighting') assert.equal(p.attention, null);
  const appeared = before.chronicle.find((c: { kind: string; placeId: string }) => c.kind === 'sighting_appeared' && c.placeId === sighting.placeId);
  assert.equal(appeared.parentPlaceId, planet.placeId, 'a sighting\'s line names the place it belongs to');

  await read(i, STAR_BORN, false);
  const after = await atlasOf(i); // parses under the strict contract
  assert.ok(!after.places.some((p: { anchor: { code: string } }) => p.anchor.code === 'astro.star.birth'), 'no longer a sighting once met');
  const reached = after.chronicle.find((c: { kind: string; placeId: string }) => c.kind === 'sighting_retired' && c.placeId === sighting.placeId);
  assert.equal(reached.causalClass, 'personal_exploration');
  assert.equal(reached.line, 'You came across Star formation.');
  assert.equal(reached.parentPlaceId, planet.placeId);
  const evidence = atlasDeltaSchema.parse((await app.inject({ url: `/v1/atlas/deltas/${reached.deltaId}`, headers: h(i) })).json()) as any;
  assert.equal(evidence.evidence.met.state, 'seen');
});

test('#167: a Reel carries its Scroll\'s concepts but is never counted among a place\'s Scrolls', async () => {
  const i = await anchorGravity();
  const gravity = async () => (await atlasOf(i)).places.find((p: { anchor: { code: string } }) => p.anchor.code === 'physics.gravity').scrolls;
  const before = await gravity();
  await mintGatedTestReel(pool, ONE_FORCE, { tag: 'atlas-count', title: 'Reel atlas-count', summary: 'A test Reel over a gravity Scroll.' });
  assert.deepEqual(await gravity(), before);
});
