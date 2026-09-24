/**
 * #167 (ADR-0043) — a Reel carries its Scroll's concepts, explains itself and continues like a
 * Scroll, against real PostgreSQL and the real Fastify app. Each Reel is minted over a Scroll of a
 * unique semantic fixture by the supply chain's own guards (scripts/fixtures/gated-reel.ts).
 *
 * Assets are global. Each reader marks every asset that already exists, of either kind, as kept for
 * its own fresh universe (the production gate) BEFORE minting its own substrate and Reel, so those
 * are the whole eligible pool.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import type { EncounterFeedbackReceipt, WhyResponseWire } from '../packages/contracts/src/composer.ts';
import type { BranchOpenResponse, EncounterBranchesResponse } from '../packages/contracts/src/semantic.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { mintReelAsset } from '../apps/worker/src/publication/mint.ts';
import { makeSemanticFixture, type SemanticFixture } from './helpers/semantic-fixture.ts';
import { gateTestReel, mintGatedTestReel, type GatedReel } from '../scripts/fixtures/gated-reel.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Reel semantic tests require an isolated knowscroll_test_* database');
}

const app = buildApp(randomBytes(32).toString('hex'));
after(async () => { await app.close(); await pool.end(); });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

type Feed = { decisionId: string; items: { assetId: string; kind: string; title: string; reason: string }[] };
type Reader = { token: string; universeId: string };

async function reader(): Promise<Reader> {
  const identity = await provisionIdentity();
  const existing = (await pool.query<{ id: string }>('SELECT id FROM asset')).rows.map(r => r.id);
  await pool.query('UPDATE accounts SET kept_asset_ids=$2::uuid[] WHERE universe_id=$1', [identity.scope.universeId, existing]);
  return { token: identity.token, universeId: identity.scope.universeId };
}

async function substrate(): Promise<SemanticFixture> {
  const fixture = await makeSemanticFixture(pool);
  assert.equal((await transaction(client => loadSubstrateSeed(client, fixture.raw))).status, 'loaded');
  return fixture;
}

const reelOver = (sourceAssetId: string, tag: string): Promise<GatedReel> =>
  mintGatedTestReel(pool, sourceAssetId, { tag, title: `Reel ${tag}`, summary: `A test Reel over one fixture Scroll (${tag}).` });

async function feed(r: Reader, kinds: string): Promise<Feed> {
  const response = await app.inject({ url: `/v1/feed?kinds=${kinds}`, headers: headers(r.token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function branchesOf(r: Reader, assetId: string): Promise<EncounterBranchesResponse> {
  const response = await app.inject({ url: `/v1/assets/${assetId}/branches`, headers: headers(r.token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function why(r: Reader, decisionId: string, assetId: string): Promise<WhyResponseWire> {
  const response = await app.inject({ url: `/v1/decisions/${decisionId}/why?assetId=${assetId}`, headers: headers(r.token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function expose(r: Reader, decisionId: string, assetId: string): Promise<{ exposureId: string; eventId: string }> {
  const response = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(r.token), payload: { decisionId, assetId, clientExposureId: randomUUID() } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function keep(r: Reader, exposureId: string, assetId: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/v1/interactions', headers: headers(r.token), payload: { clientEventId: randomUUID(), exposureId, assetId, kind: 'keep' } });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().eventId;
}

/** Expose exactly `assetId` through a recorded single-item decision (no Composer tie-break). */
async function exposeDirect(r: Reader, assetId: string): Promise<{ exposureId: string; eventId: string }> {
  const asset = (await pool.query(`SELECT id AS "assetId", revision, kind, title, summary FROM asset WHERE id=$1`, [assetId])).rows[0];
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'reel-test-fixture',$3::jsonb,0)`,
    [decisionId, r.universeId, JSON.stringify([asset])]);
  return expose(r, decisionId, assetId);
}

const annotations = async (assetId: string) => (await pool.query<{ code: string; role: string }>(
  'SELECT c.code, ac.role FROM asset_concept ac JOIN concept c ON c.id = ac.concept_id WHERE ac.asset_id=$1 ORDER BY c.code', [assetId])).rows;

test('a minted Reel carries its Scroll\'s concepts with the same roles, and none of its claims', async () => {
  const f = await substrate();
  const reel = await reelOver(f.assets.tides, 'concepts');
  assert.deepEqual(await annotations(reel.assetId), await annotations(f.assets.tides));
  assert.deepEqual(await annotations(reel.assetId), [{ code: f.codes.gravity, role: 'mentioned' }, { code: f.codes.tides, role: 'primary' }].sort((a, b) => a.code.localeCompare(b.code)));
  assert.equal(Number((await pool.query('SELECT count(*) FROM asset_claim WHERE asset_id=$1', [reel.assetId])).rows[0].count), 0, 'a Reel does not claim to state its Scroll\'s substrate claims');

  const bare = await reelOver(f.assets.unannotated, 'unannotated');
  assert.deepEqual(await annotations(bare.assetId), [], 'an unannotated Scroll gives an unannotated Reel');
});

/** A later seed version that annotates the fixture's unannotated Scroll. */
const annotatingUnannotated = (f: SemanticFixture): string => JSON.stringify({
  ...f.seed, version: `${f.seed.version}9`, bridgeProposals: [],
  assets: [...f.seed.assets, { assetId: f.assets.unannotated, concepts: [{ code: f.codes.seasons, role: 'primary' }], claims: [] }],
});

test('a Reel minted over a Scroll the seed annotates later carries the concepts the seed gives that Scroll', async () => {
  const f = await substrate();
  const reel = await reelOver(f.assets.unannotated, 'annotated-later');
  assert.deepEqual(await annotations(reel.assetId), []);
  assert.equal((await transaction(client => loadSubstrateSeed(client, annotatingUnannotated(f)))).status, 'loaded');
  assert.deepEqual(await annotations(reel.assetId), [{ code: f.codes.seasons, role: 'primary' }]);
  assert.equal(Number((await pool.query('SELECT count(*) FROM asset_claim WHERE asset_id=$1', [reel.assetId])).rows[0].count), 0);
});

test('minting waits for a seed load holding the substrate, then carries the annotations it committed', async () => {
  const f = await substrate();
  const gated = await gateTestReel(pool, f.assets.unannotated, { tag: 'mint-lock', title: 'Reel mint-lock', summary: 'A test Reel minted while a seed loads.' });
  const seeding = await pool.connect();
  try {
    await seeding.query('BEGIN');
    await loadSubstrateSeed(seeding, annotatingUnannotated(f));
    const minting = mintReelAsset(pool, gated.generatedReelId);
    let waiting = false;
    for (const deadline = Date.now() + 5000; !waiting && Date.now() < deadline; await new Promise(r => setTimeout(r, 20))) {
      waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rows[0].n > 0;
    }
    assert.ok(waiting, 'the mint waits for the seed load to commit');
    await seeding.query('COMMIT');
    assert.deepEqual(await annotations((await minting).assetId), [{ code: f.codes.seasons, role: 'primary' }]);
  } catch (error) {
    await seeding.query('ROLLBACK');
    throw error;
  } finally { seeding.release(); }
});

test('after a source correction a Reel continues exactly as its Scroll does, and is still served (ADR-0043 §4)', async () => {
  const r = await reader();
  const f = await substrate();
  const reel = await reelOver(f.assets.tides, 'corrected');
  assert.deepEqual((await branchesOf(r, reel.assetId)).branches.map(b => b.target.assetId), [f.assets.gravity]);

  await transaction(client => correctSourceSnapshot(client, { sourceKey: f.sources.physics, action: 'revoked', reason: 'Fixture: the publisher withdrew this page' }, 'editorial'));
  const fromReel = await branchesOf(r, reel.assetId);
  const fromScroll = await branchesOf(r, f.assets.tides);
  assert.deepEqual([fromReel.branches, fromReel.emptyReason], [[], 'no_admitted_bridge'], 'the continuation resting on the revoked source is gone');
  assert.deepEqual([fromReel.branches, fromReel.emptyReason], [fromScroll.branches, fromScroll.emptyReason], 'the Reel continues as its Scroll does');
  assert.deepEqual((await feed(r, 'Reel')).items.map(i => i.assetId), [reel.assetId], 'nothing withdraws the Reel itself (ADR-0024 §5)');
});

test('a Reel encounter\'s why names its concept and the recorded path that led to it; "less like this" suppresses its route', async () => {
  const r = await reader();
  const f = await substrate();
  const reel = await reelOver(f.assets.tides, 'why');
  const exposure = await exposeDirect(r, f.assets.gravity);
  const keepEventId = await keep(r, exposure.exposureId, f.assets.gravity);

  const served = await feed(r, 'Reel');
  assert.deepEqual(served.items.map(i => [i.assetId, i.kind]), [[reel.assetId, 'Reel']]);
  const explained = await why(r, served.decisionId, reel.assetId);
  assert.equal(explained.family, 'bridge', 'the Reel is reached through the admitted connection from what was kept');
  assert.match(explained.reason, /: Gravity explains Tides\.$/);
  assert.equal(explained.reason, served.items[0]!.reason, 'the explanation is the one that was served');
  const mark = explained.evidence.find(s => s.kind === 'mark');
  assert.ok(mark && mark.kind === 'mark' && mark.eventId === keepEventId && mark.assetId === f.assets.gravity, 'the path names the recorded keep');
  assert.ok(explained.evidence.some(s => s.kind === 'bridge' && s.sentence === 'Gravity explains Tides'));
  assert.deepEqual(explained.corrections, ['less_like_this', 'wrong_connection']);
  const recorded = (await pool.query<{ code: string; bridge_id: string }>(
    'SELECT c.code, dc.bridge_id FROM decision_candidate dc JOIN concept c ON c.id = dc.concept_id WHERE dc.decision_id=$1 AND dc.asset_id=$2 AND dc.rank IS NOT NULL',
    [served.decisionId, reel.assetId])).rows[0]!;
  assert.equal(recorded.code, f.codes.tides, 'the served route is the Reel\'s own primary concept');

  const correction = await app.inject({ method: 'POST', url: '/v1/encounters/feedback', headers: headers(r.token),
    payload: { clientFeedbackId: randomUUID(), decisionId: served.decisionId, assetId: reel.assetId, kind: 'less_like_this', expectedPrivacyEpoch: 0 } });
  assert.equal(correction.statusCode, 201, correction.body);
  const { suppressed } = correction.json() as EncounterFeedbackReceipt;
  assert.deepEqual([suppressed.family, suppressed.concept, suppressed.bridgeId], ['bridge', f.codes.tides, recorded.bridge_id]);
  const after = await feed(r, 'Reel');
  const routes = (await pool.query('SELECT bridge_id FROM decision_candidate WHERE decision_id=$1 AND asset_id=$2', [after.decisionId, reel.assetId])).rows;
  assert.ok(routes.length > 0 && !routes.some(c => c.bridge_id === recorded.bridge_id), 'the Reel is no longer reached along the corrected route');
});

test('a kept Reel grounds what comes next, from its primary concept, and its own connections can be followed', async () => {
  const r = await reader();
  const f = await substrate();
  const reel = await reelOver(f.assets.tides, 'continue');
  const exposure = await exposeDirect(r, reel.assetId);
  const keepEventId = await keep(r, exposure.exposureId, reel.assetId);

  const next = await feed(r, 'Scroll');
  const grounded = (await pool.query<{ asset_id: string; family: string; evidence: { kind: string; assetId?: string; eventId?: string }[] }>(
    'SELECT asset_id, family, evidence FROM decision_candidate WHERE decision_id=$1 AND gate IS NULL', [next.decisionId])).rows
    .filter(c => c.evidence.some(e => e.kind === 'mark' && e.assetId === reel.assetId && e.eventId === keepEventId));
  assert.ok(grounded.some(c => c.family === 'continue' && c.asset_id === f.assets.tides), 'continues the Reel\'s primary idea');
  assert.ok(grounded.some(c => c.family === 'bridge' && c.asset_id === f.assets.gravity), 'crosses the admitted connection from it');
  const head = await why(r, next.decisionId, next.items[0]!.assetId);
  assert.ok(head.evidence.some(e => e.kind === 'mark' && e.assetId === reel.assetId && e.eventId === keepEventId), 'the head cites the kept Reel');

  const listed = await branchesOf(r, reel.assetId);
  assert.equal(listed.emptyReason, null);
  const branch = listed.branches.find(b => b.target.assetId === f.assets.gravity);
  assert.ok(branch, JSON.stringify(listed));
  assert.equal(branch.relationPhrase, 'is explained by');

  const opened = await app.inject({ method: 'POST', url: '/v1/branches', headers: headers(r.token),
    payload: { clientBranchId: randomUUID(), fromExposureId: exposure.exposureId, bridgeId: branch.bridgeId, targetAssetId: f.assets.gravity, expectedPrivacyEpoch: 0 } });
  assert.equal(opened.statusCode, 201, opened.body);
  const body = opened.json() as BranchOpenResponse;
  assert.equal(body.branch.recorded, true);
  assert.deepEqual((body.items as { assetId: string }[]).map(i => i.assetId), [f.assets.gravity]);
  const ledger = (await pool.query(`SELECT l.causation_id FROM ledger l WHERE l.universe_id=$1 AND l.kind='branch'`, [r.universeId])).rows;
  assert.deepEqual(ledger.map(x => x.causation_id), [exposure.eventId], 'the branch is caused by the Reel\'s exposure');
});

test('composer-semantic-v4 (ADR-0043 §7) is a configured alternative: it records its own version and explains like v3', async () => {
  const v4 = buildApp(randomBytes(32).toString('hex'), { composerPolicy: 'composer-semantic-v4' });
  try {
    const r = await reader();
    const f = await substrate();
    const reel = await reelOver(f.assets.tides, 'v4');
    await keep(r, (await exposeDirect(r, f.assets.gravity)).exposureId, f.assets.gravity);
    const response = await v4.inject({ url: '/v1/feed?kinds=Reel', headers: headers(r.token) });
    assert.equal(response.statusCode, 200, response.body);
    const served = response.json() as Feed;
    assert.deepEqual(served.items.map(i => i.assetId), [reel.assetId]);
    const recorded = (await pool.query('SELECT d.ranking_version, c.policy_version FROM decision d JOIN decision_context c ON c.decision_id=d.id WHERE d.id=$1', [served.decisionId])).rows[0];
    assert.deepEqual([recorded.ranking_version, recorded.policy_version], ['composer-semantic-v4', 'composer-semantic-v4']);
    const explained = await why(r, served.decisionId, reel.assetId);
    assert.deepEqual([explained.policyVersion, explained.family, explained.reason], ['composer-semantic-v4', 'bridge', served.items[0]!.reason]);
  } finally { await v4.close(); }
});
