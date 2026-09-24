/**
 * ADR-0037 — foundation Stars over the real database and API. With the reader's places for Gravity,
 * Tides, Orbits and Star formation, Gravity explains all three (sourced claims in the editorial
 * substrate), so it is recognised as a foundation, with what it holds up and the claims that say so.
 * Setting one of those places aside withdraws it at once, as the reader's correction.
 */
import assert from 'node:assert/strict';
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
