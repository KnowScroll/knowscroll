/**
 * ADR-0037 — foundation Stars over the real database and API. With the reader's places for Gravity,
 * Tides, Orbits and Star formation, Gravity explains all three (sourced claims in the editorial
 * substrate), so it is recognised as a foundation, with what it holds up and the claims that say so.
 * Setting one of those places aside withdraws it at once, as the reader's correction.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { atlasDeltaSchema, atlasResponseSchema } from '../packages/contracts/src/atlas.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { runCartographer } from '../packages/db/src/atlas.ts';
import type { PlaceAccount } from '../packages/core/src/atlas/cartographer.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Foundation tests require a disposable knowscroll_test_* database');
const app = buildApp('foundation-stars-development-token-12345678');
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const anchoredAccount = (concept: string): PlaceAccount => ({ concept, state: 'anchored', episodes: 4, daysActive: 2, voluntary: 2, sourceFamilies: 2, mass: 5, evidence: { episodeIds: ['e1', 'e2', 'e3'], markIds: ['m1', 'm2'] } });

test('Gravity holds up Tides, Orbits and Star formation; setting one aside withdraws it as a correction', async () => {
  const i = await provisionIdentity();
  const h = { authorization: `Bearer ${i.token}` };
  // The Cartographer is driven with anchored accounts for four concepts (the attention arithmetic
  // that produces them is covered by the attention and places tests).
  await transaction(async client => {
    await client.query('SELECT 1 FROM universe WHERE id=$1 FOR UPDATE', [i.scope.universeId]);
    await runCartographer(client, i.scope.universeId, ['physics.gravity', 'earth.tides', 'astro.orbit', 'astro.star.birth'].map(anchoredAccount));
  });
  const atlas = atlasResponseSchema.parse((await app.inject({ url: '/v1/atlas', headers: h })).json());
  const byCode = new Map(atlas.places.map(p => [p.anchor.code, p]));
  const gravity = byCode.get('physics.gravity')!;
  assert.ok(gravity.foundation, 'Gravity is a foundation');
  assert.deepEqual([...gravity.foundation.holdsUp].sort(), ['earth.tides', 'astro.orbit', 'astro.star.birth'].map(c => byCode.get(c)!.placeId).sort());
  assert.ok(gravity.foundation.relations.every(r => r.claim || r.bridge), 'every connection is sourced');
  for (const code of ['earth.tides', 'astro.orbit', 'astro.star.birth']) assert.equal(byCode.get(code)!.foundation, null);
  const recognised = atlas.chronicle.find(c => c.kind === 'foundation_recognised')!;
  assert.match(recognised.line, /^Gravity holds up .+, .+ and .+\.$/);
  assert.equal(recognised.causalClass, 'substrate_neighbourhood');
  const evidence = atlasDeltaSchema.parse((await app.inject({ url: `/v1/atlas/deltas/${recognised.deltaId}`, headers: h })).json());
  assert.equal((evidence.evidence.relations as unknown[]).length, 3);

  const tides = byCode.get('earth.tides')!;
  const set = await app.inject({ method: 'POST', url: `/v1/atlas/places/${tides.placeId}/reject`, headers: h, payload: { expectedPrivacyEpoch: 0 } });
  assert.equal(set.statusCode, 200, set.body);
  const afterReject = atlasResponseSchema.parse(set.json());
  assert.equal(afterReject.places.find(p => p.anchor.code === 'physics.gravity')!.foundation, null, 'two connections left: no longer a foundation');
  const withdrawn = afterReject.chronicle.find(c => c.kind === 'foundation_withdrawn')!;
  assert.equal(withdrawn.causalClass, 'reader_correction');
  assert.equal(withdrawn.line, 'Gravity no longer holds up the places around it.');
});

test('the schema refuses a foundation flag on a sighting and a flag change without a delta', async () => {
  const i = await provisionIdentity();
  await transaction(async client => {
    await client.query('SELECT 1 FROM universe WHERE id=$1 FOR UPDATE', [i.scope.universeId]);
    await runCartographer(client, i.scope.universeId, [anchoredAccount('physics.gravity')]);
  });
  const rows = (await pool.query<{ id: string; kind: string }>('SELECT id, kind FROM atlas_place WHERE universe_id=$1', [i.scope.universeId])).rows;
  const sighting = rows.find(r => r.kind === 'sighting')!, planet = rows.find(r => r.kind === 'planet')!;
  await assert.rejects(pool.query('UPDATE atlas_place SET load_bearing=true WHERE id=$1', [sighting.id]), /atlas_place_foundation_kind/);
  await assert.rejects(pool.query('UPDATE atlas_place SET load_bearing=true WHERE id=$1', [planet.id]), /delta that says why/);
});

const setUp = async () => {
  const i = await provisionIdentity();
  await transaction(async client => {
    await client.query('SELECT 1 FROM universe WHERE id=$1 FOR UPDATE', [i.scope.universeId]);
    await runCartographer(client, i.scope.universeId, ['physics.gravity', 'earth.tides', 'astro.orbit', 'astro.star.birth'].map(anchoredAccount));
  });
  const h = { authorization: `Bearer ${i.token}` };
  const atlas = atlasResponseSchema.parse((await app.inject({ url: '/v1/atlas', headers: h })).json());
  return { i, h, byCode: new Map(atlas.places.map(p => [p.anchor.code, p])) };
};

test('setting a place aside changes only the rejection and foundations, never other places (review I2)', async () => {
  const { i, h, byCode } = await setUp();
  // A stored account the last refresh wrote with no place of its own: the rejection must not act on it.
  await pool.query(
    `INSERT INTO attention_account(universe_id,concept_id,policy_version,mass,mass_at,episodes,voluntary,returns,days_active,span_days,source_families,exposure_share,negatives,state,evidence)
     SELECT $1, id, 'attention-v1', 6, clock_timestamp(), 4, 2, 1, 2, 1, 2, 0.2, 0, 'anchored', '{}'::jsonb FROM concept WHERE code='astro.sun'`, [i.scope.universeId]);
  const before = (await pool.query<{ n: string }>('SELECT count(*) AS n FROM atlas_delta WHERE universe_id=$1', [i.scope.universeId])).rows[0]!.n;
  const set = await app.inject({ method: 'POST', url: `/v1/atlas/places/${byCode.get('earth.tides')!.placeId}/reject`, headers: h, payload: { expectedPrivacyEpoch: 0 } });
  assert.equal(set.statusCode, 200, set.body);
  const kinds = (await pool.query<{ kind: string }>('SELECT kind FROM atlas_delta WHERE universe_id=$1 ORDER BY created_at, id OFFSET $2', [i.scope.universeId, Number(before)])).rows.map(r => r.kind);
  assert.deepEqual(kinds.filter(k => !['place_rejected', 'place_released', 'sighting_retired', 'foundation_withdrawn', 'foundation_recognised'].includes(k)), [], kinds.join(','));
  assert.equal(atlasResponseSchema.parse(set.json()).places.some(p => p.anchor.code === 'astro.sun'), false);
});

test('a foundation set aside is withdrawn first; export carries the flag (review M1, M2)', async () => {
  const { i, h, byCode } = await setUp();
  const gravity = byCode.get('physics.gravity')!;
  assert.ok(gravity.foundation);
  const set = await app.inject({ method: 'POST', url: `/v1/atlas/places/${gravity.placeId}/reject`, headers: h, payload: { expectedPrivacyEpoch: 0 } });
  assert.equal(set.statusCode, 200, set.body);
  const row = (await pool.query<{ state: string; load_bearing: boolean }>('SELECT state, load_bearing FROM atlas_place WHERE id=$1', [gravity.placeId])).rows[0];
  assert.deepEqual(row, { state: 'rejected', load_bearing: false });
  const chronicle = atlasResponseSchema.parse(set.json()).chronicle.filter(c => c.placeId === gravity.placeId).map(c => c.kind);
  assert.deepEqual(chronicle.slice(0, 2), ['place_rejected', 'foundation_withdrawn'], 'newest first: withdrawn, then set aside');
  const exported = (await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: h, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } })).json();
  const places = JSON.stringify(exported);
  assert.match(places, /"load_bearing":false/);
  assert.equal(i.scope.privacyEpoch, 0);
});

test('the foundation shown is its latest recognition, and the schema wants a foundation delta for the flag (review test gap, M3)', async () => {
  const { i, h, byCode } = await setUp();
  const gravity = byCode.get('physics.gravity')!;
  const bridges = (await pool.query<{ id: string; to: string }>(
    `SELECT b.id, t.code AS to FROM bridge b JOIN concept f ON f.id=b.from_concept_id JOIN concept t ON t.id=b.to_concept_id
     WHERE f.code='physics.gravity' AND b.scope_kind='shared' AND b.status='admitted' ORDER BY t.code`)).rows;
  assert.equal(bridges.length, 3);
  const relations = bridges.map(b => ({ from: 'physics.gravity', to: b.to, kind: 'explains', ref: { bridgeId: b.id } }));
  await pool.query(
    `INSERT INTO atlas_delta(id,universe_id,place_id,kind,causal_class,policy_version,evidence,before,after)
     VALUES(gen_random_uuid(),$1,$2,'foundation_recognised','source_correction','cartographer-v2',$3,'{"loadBearing":true}','{"loadBearing":true}')`,
    [i.scope.universeId, gravity.placeId, JSON.stringify({ relations, holdsUp: bridges.map(b => b.to) })]);
  const atlas = atlasResponseSchema.parse((await app.inject({ url: '/v1/atlas', headers: h })).json());
  const shown = atlas.places.find(p => p.placeId === gravity.placeId)!.foundation!;
  assert.ok(shown.relations.every(r => r.bridge && !r.claim), 'the newer recognition, citing the bridges, is what is shown');

  const tides = byCode.get('earth.tides')!;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO atlas_delta(id,universe_id,place_id,kind,causal_class,policy_version,evidence,before,after)
       VALUES(gen_random_uuid(),$1,$2,'place_released','reader_correction','cartographer-v2','{}','{}','{}')`, [i.scope.universeId, tides.placeId]);
    await client.query('UPDATE atlas_place SET load_bearing=true WHERE id=$1', [tides.placeId]);
    await assert.rejects(client.query('COMMIT'), /foundation/);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
