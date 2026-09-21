/**
 * ADR-0028 — proof for evidence-backed semantic worlds: the deterministic derivation
 * (`packages/db/src/worlds.ts`), the `GET /v1/worlds` API, and the projection wired into
 * `POST /v1/exposures`. Uses the same real disposable-PostgreSQL, real-Fastify style as
 * `tests/inventory-http.test.ts` / `tests/api-asks.test.ts`, plus direct-transaction tests
 * against the derivation functions and migration 0017's own guard triggers.
 *
 * #113: earlier versions of this file found a source's asset by reading `GET /v1/feed` and
 * matching a seeded editorial `sourceUrl`. That coupled a derivation test to whichever ranking
 * policy `/v1/feed` happens to run — real ranking (composer-signals-v2, #114/ADR-0029) does not
 * guarantee any specific source appears in a bounded slate when the `asset` table is shared with
 * every other test file in the run (ADR-0029's own coverage guarantee is about a source
 * eventually being reached across many decisions, not about any one decision). This file has
 * nothing to do with ranking, so it no longer goes through the feed at all: every test below seeds
 * its own, uniquely-URLed source directly into `asset`, then constructs the `decision` row itself
 * (the same pattern `tests/composer.test.ts`'s SQL-oracle test and `tests/identity.test.ts` already
 * use) so `POST /v1/exposures` has a real decision to check the exposed asset against. What is
 * proved is derivation and the exposure→projection wiring, nothing about what a ranking policy
 * would have offered.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import type { ScrollAsset } from '../packages/contracts/src/index.ts';
import {
  SHARED_SOURCE_V1,
  deriveWorlds,
  deriveWorldSystemForUniverse,
  readWorldSystem,
} from '../packages/db/src/worlds.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Worlds tests require an isolated knowscroll_test_* database');
}

const developmentToken = randomBytes(32).toString('hex');
const app = buildApp(developmentToken);
after(async () => { await app.close(); await pool.end(); });

const headers = (token: string) => ({ authorization: `Bearer ${token}` });

async function expose(token: string, decisionId: string, assetId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST', url: '/v1/exposures', headers: headers(token),
    payload: { decisionId, assetId, clientExposureId: randomUUID() },
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function worlds(token: string) {
  const response = await app.inject({ url: '/v1/worlds', headers: headers(token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { derivationMethod: string; system: { systemId: string; worlds: Array<{ worldId: string; sourceTitle: string; sourceUrl: string; scrollCount: number; seenCount: number }> } | null };
}

/** Seeds one Scroll directly into the shared `asset` table (the same construction
 * `tests/composer.test.ts`'s `insertScrollAsset` uses) and returns it in exactly the wire shape
 * `decision.candidates` records, so it can be handed straight to `directDecision` below. */
async function insertScrollAsset(tag: string, sourceTitle: string, sourceUrl: string): Promise<ScrollAsset> {
  const assetId = randomUUID();
  const title = `Worlds fixture ${tag}`;
  const summary = `Summary ${tag}`;
  const body = 'Body text.';
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId, title, summary, body, sourceTitle, sourceUrl],
  );
  return { assetId, revision: 1, kind: 'Scroll', title, summary, body, sourceTitle, sourceUrl, truthState: 'documented' };
}

/** Constructs a `decision` row directly — never through `/v1/feed` — naming exactly the given
 * candidates, so `POST /v1/exposures`'s own candidate-membership check has a real row to check
 * against. Mirrors `tests/composer.test.ts`'s SQL-oracle fixture and `tests/identity.test.ts`'s
 * direct decision inserts; `policy_version` names no real policy since nothing here was ranked. */
async function directDecision(universeId: string, privacyEpoch: number, candidates: readonly ScrollAsset[]): Promise<string> {
  const decisionId = randomUUID();
  await pool.query(
    `INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'worlds-test-fixture',$3::jsonb,$4)`,
    [decisionId, universeId, JSON.stringify(candidates), privacyEpoch],
  );
  return decisionId;
}

// -----------------------------------------------------------------------------------------------
// A universe with nothing derives nothing.
// -----------------------------------------------------------------------------------------------

test('a universe with no exposures derives no system, and the API never invents an empty one', async () => {
  await app.ready();
  const identity = await provisionIdentity();
  const response = await worlds(identity.token);
  assert.equal(response.derivationMethod, SHARED_SOURCE_V1);
  assert.equal(response.system, null, 'a universe with nothing must derive nothing, not an empty system object');
});

// -----------------------------------------------------------------------------------------------
// One source -> one world; two sources -> two worlds in one system. Counts proven against direct
// SQL over asset/exposure, not just re-reading what the API itself computed.
// -----------------------------------------------------------------------------------------------

test('exposure to Scrolls from one source derives exactly one world, with database-verified counts', async () => {
  const identity = await provisionIdentity();
  const sourceUrl = 'https://example.test/worlds-one-source';
  const a1 = await insertScrollAsset('one-source-a', 'One Source', sourceUrl);
  const a2 = await insertScrollAsset('one-source-b', 'One Source', sourceUrl);
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [a1, a2]);

  await expose(identity.token, decisionId, a1.assetId);

  const response = await worlds(identity.token);
  assert.ok(response.system, 'one exposure must produce a system');
  assert.equal(response.system!.worlds.length, 1, 'exactly one world for one encountered source');
  const world = response.system!.worlds[0]!;
  assert.equal(world.sourceUrl, sourceUrl);
  assert.equal(world.seenCount, 1);

  const directScrollCount = (await pool.query(
    `SELECT count(*)::int AS n FROM asset WHERE kind='Scroll' AND source_url=$1`, [sourceUrl],
  )).rows[0].n;
  const directSeenCount = (await pool.query(
    `SELECT count(DISTINCT a.id)::int AS n FROM exposure e JOIN asset a ON a.id=e.asset_id
     WHERE e.universe_id=$1 AND a.kind='Scroll' AND a.source_url=$2`,
    [identity.scope.universeId, sourceUrl],
  )).rows[0].n;
  assert.equal(world.scrollCount, directScrollCount, 'scrollCount must match a direct SQL count over asset');
  assert.equal(world.seenCount, directSeenCount, 'seenCount must match a direct SQL count over exposure/asset');
  assert.equal(directScrollCount, 2, 'this fixture source carries two Scrolls');
});

test('exposure to Scrolls from two sources derives two worlds inside one system ("two planets, one solar system")', async () => {
  const identity = await provisionIdentity();
  const sourceAUrl = 'https://example.test/worlds-two-source-a';
  const sourceBUrl = 'https://example.test/worlds-two-source-b';
  const a1 = await insertScrollAsset('two-source-a-1', 'Two Source A', sourceAUrl);
  const a2 = await insertScrollAsset('two-source-a-2', 'Two Source A', sourceAUrl);
  const b1 = await insertScrollAsset('two-source-b-1', 'Two Source B', sourceBUrl);
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [a1, a2, b1]);

  await expose(identity.token, decisionId, a1.assetId);
  await expose(identity.token, decisionId, b1.assetId);

  const response = await worlds(identity.token);
  assert.ok(response.system, 'two exposures across two sources must produce one system');
  assert.equal(response.system!.worlds.length, 2, 'exactly two worlds -- one solar system, two planets');
  const bySource = new Map(response.system!.worlds.map(w => [w.sourceUrl, w]));
  assert.equal(bySource.get(sourceAUrl)?.seenCount, 1);
  assert.equal(bySource.get(sourceBUrl)?.seenCount, 1);
  assert.equal(bySource.get(sourceAUrl)?.scrollCount, 2);
  assert.equal(bySource.get(sourceBUrl)?.scrollCount, 1);
  // Every universe shares the same underlying catalog world for a given source (ADR-0028 section 4:
  // worlds are universe-independent) -- the ids must be stable across universes, not re-minted.
  const other = await provisionIdentity();
  const otherDecisionId = await directDecision(other.scope.universeId, other.scope.privacyEpoch, [a1]);
  await expose(other.token, otherDecisionId, a1.assetId);
  const otherResponse = await worlds(other.token);
  assert.equal(otherResponse.system!.worlds[0]!.worldId, bySource.get(sourceAUrl)!.worldId, 'the shared-source world is the same catalog row for every universe');
});

// -----------------------------------------------------------------------------------------------
// Re-running the derivation is idempotent: no new rows, identical output, from the recorded
// evidence alone.
// -----------------------------------------------------------------------------------------------

test('re-running the derivation changes nothing: same ids, same counts, no new rows', async () => {
  const identity = await provisionIdentity();
  const sourceAUrl = 'https://example.test/worlds-rerun-a';
  const sourceBUrl = 'https://example.test/worlds-rerun-b';
  const a1 = await insertScrollAsset('rerun-a', 'Rerun Source A', sourceAUrl);
  const b1 = await insertScrollAsset('rerun-b', 'Rerun Source B', sourceBUrl);
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [a1, b1]);
  await expose(identity.token, decisionId, a1.assetId);
  await expose(identity.token, decisionId, b1.assetId);

  const before = await worlds(identity.token);
  const rowCountsBefore = (await pool.query(
    `SELECT (SELECT count(*) FROM world) AS worlds, (SELECT count(*) FROM world_member) AS members,
            (SELECT count(*) FROM world_system) AS systems, (SELECT count(*) FROM world_system_member) AS system_members`,
  )).rows[0];

  // Call the derivation functions directly, twice more, outside any exposure event -- proving the
  // recompute itself is idempotent, not merely that the route happens not to call it twice.
  for (let i = 0; i < 2; i += 1) {
    await transaction(async client => {
      await deriveWorlds(client);
      await deriveWorldSystemForUniverse(client, identity.scope.universeId);
    });
  }

  const after = await worlds(identity.token);
  const rowCountsAfter = (await pool.query(
    `SELECT (SELECT count(*) FROM world) AS worlds, (SELECT count(*) FROM world_member) AS members,
            (SELECT count(*) FROM world_system) AS systems, (SELECT count(*) FROM world_system_member) AS system_members`,
  )).rows[0];

  assert.deepEqual(rowCountsAfter, rowCountsBefore, 'recomputing twice more must insert no additional rows anywhere');
  assert.deepEqual(
    new Set(after.system!.worlds.map(w => w.worldId)),
    new Set(before.system!.worlds.map(w => w.worldId)),
    'world identities must be stable across recomputation',
  );
  for (const world of before.system!.worlds) {
    const rerun = after.system!.worlds.find(w => w.worldId === world.worldId)!;
    assert.equal(rerun.scrollCount, world.scrollCount);
    assert.equal(rerun.seenCount, world.seenCount);
  }
});

// -----------------------------------------------------------------------------------------------
// A world (or system) can never exist without the evidence rows that justify it -- the database
// itself refuses it, at commit, not merely this module's own convention.
// -----------------------------------------------------------------------------------------------

test('the database refuses a world with no world_member evidence', async () => {
  await assert.rejects(
    transaction(async client => {
      await client.query(
        `INSERT INTO world(id,derivation_method,source_title,source_url) VALUES($1,$2,'Evidence-less','https://example.test/no-evidence')`,
        [randomUUID(), SHARED_SOURCE_V1],
      );
    }),
    /must name at least one asset as its evidence/,
  );
});

test('deleting a world\'s last member is refused, not silently allowed to strand it', async () => {
  const identity = await provisionIdentity();
  const sourceUrl = 'https://example.test/worlds-delete-last-member';
  const a1 = await insertScrollAsset('delete-last-member', 'Delete Last Member Source', sourceUrl);
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [a1]);
  await expose(identity.token, decisionId, a1.assetId);

  const world = (await pool.query(
    `SELECT id FROM world WHERE derivation_method=$1 AND source_url=$2`, [SHARED_SOURCE_V1, sourceUrl],
  )).rows[0];
  assert.ok(world, 'the fixture world must already exist from the exposure above');

  await assert.rejects(
    transaction(async client => {
      await client.query('DELETE FROM world_member WHERE world_id=$1', [world.id]);
    }),
    /must name at least one asset as its evidence/,
  );
  // Unaffected: the world's real member is still the one fixture Scroll.
  const remaining = (await pool.query('SELECT count(*)::int AS n FROM world_member WHERE world_id=$1', [world.id])).rows[0].n;
  assert.equal(remaining, 1);
});

test('the database refuses a world_system with no encountered world', async () => {
  const identity = await provisionIdentity();
  await assert.rejects(
    transaction(async client => {
      await client.query(
        `INSERT INTO world_system(id,universe_id,derivation_method) VALUES($1,$2,$3)`,
        [randomUUID(), identity.scope.universeId, SHARED_SOURCE_V1],
      );
    }),
    /must group at least one encountered world/,
  );
});

test('a title variant on one source URL does not break the derivation', async () => {
  // A real library will spell the same source differently -- a curly apostrophe where an earlier
  // row had a straight one. Keying a world on the title as well as the URL made the whole
  // encounter path throw, so every exposure returned 500 until the data was hand-corrected.
  const identity = await provisionIdentity();
  const sourceUrl = 'https://example.test/worlds-title-variant';
  const original = await insertScrollAsset('title-variant-original', 'NASA · Title Variant', sourceUrl);
  const variantAssetId = randomUUID();
  const variantTitle = 'Variant spelling';
  const variantSourceTitle = 'NASA · Title Variant (variant)';
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,'s','b',$3,$4,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [variantAssetId, variantTitle, variantSourceTitle, sourceUrl],
  );
  const variant: ScrollAsset = { assetId: variantAssetId, revision: 1, kind: 'Scroll', title: variantTitle, summary: 's', body: 'b', sourceTitle: variantSourceTitle, sourceUrl, truthState: 'documented' };
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [original, variant]);
  // Expose the variant-titled asset specifically -- this is the one that previously threw.
  await expose(identity.token, decisionId, variant.assetId);

  const worldsCount = (await pool.query(
    `SELECT count(*)::int AS n FROM world WHERE derivation_method=$1 AND source_url=$2`,
    [SHARED_SOURCE_V1, sourceUrl],
  )).rows[0];
  assert.equal(worldsCount.n, 1, 'one source URL yields exactly one world whatever its title variants');
});

test('a world_member cannot claim a source its own asset does not carry', async () => {
  const identity = await provisionIdentity();
  const sourceAUrl = 'https://example.test/worlds-cross-source-a';
  const sourceBUrl = 'https://example.test/worlds-cross-source-b';
  const a1 = await insertScrollAsset('cross-source-a', 'Cross Source A', sourceAUrl);
  const b1 = await insertScrollAsset('cross-source-b', 'Cross Source B', sourceBUrl);
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [a1, b1]);
  await expose(identity.token, decisionId, a1.assetId);

  const worldA = (await pool.query(
    `SELECT id FROM world WHERE derivation_method=$1 AND source_url=$2`, [SHARED_SOURCE_V1, sourceAUrl],
  )).rows[0];
  assert.ok(worldA, 'world A must already exist from the exposure above');

  await assert.rejects(
    transaction(async client => {
      await client.query('INSERT INTO world_member(world_id,asset_id) VALUES($1,$2)', [worldA.id, b1.assetId]);
    }),
    /must carry the same source URL as its world/,
  );
});

// -----------------------------------------------------------------------------------------------
// readWorldSystem is a pure read: it never mutates state, unlike the derivation functions.
// -----------------------------------------------------------------------------------------------

test('readWorldSystem performs no writes', async () => {
  const identity = await provisionIdentity();
  const sourceUrl = 'https://example.test/worlds-read-only';
  const a1 = await insertScrollAsset('read-only', 'Read Only Source', sourceUrl);
  const decisionId = await directDecision(identity.scope.universeId, identity.scope.privacyEpoch, [a1]);
  await expose(identity.token, decisionId, a1.assetId);

  const before = (await pool.query(
    `SELECT (SELECT count(*) FROM world) AS worlds, (SELECT count(*) FROM world_member) AS members,
            (SELECT count(*) FROM world_system) AS systems, (SELECT count(*) FROM world_system_member) AS system_members`,
  )).rows[0];
  for (let i = 0; i < 5; i += 1) {
    await transaction(client => readWorldSystem(client, identity.scope.universeId));
  }
  const after = (await pool.query(
    `SELECT (SELECT count(*) FROM world) AS worlds, (SELECT count(*) FROM world_member) AS members,
            (SELECT count(*) FROM world_system) AS systems, (SELECT count(*) FROM world_system_member) AS system_members`,
  )).rows[0];
  assert.deepEqual(after, before, 'a pure read must never insert or update anything');
});
