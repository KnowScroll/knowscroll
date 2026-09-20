/**
 * ADR-0028 — proof for evidence-backed semantic worlds: the deterministic derivation
 * (`packages/db/src/worlds.ts`), the `GET /v1/worlds` API, and the projection wired into
 * `POST /v1/exposures`. Uses the same real disposable-PostgreSQL, real-Fastify style as
 * `tests/inventory-http.test.ts` / `tests/api-asks.test.ts`, plus direct-transaction tests
 * against the derivation functions and migration 0017's own guard triggers.
 *
 * The seeded editorial library (`content/editorial-scrolls.json`, installed by `pnpm db:seed`
 * before this file runs) is exactly three Scrolls across two sources: two share the
 * "Orbits and Kepler's Laws" URL, one is the separate "Stars" URL — this is what lets these
 * tests assert "one source" / "two sources" against real seeded content, not fixtures this file
 * invents.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
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

const ORBITS_URL = 'https://science.nasa.gov/solar-system/orbits-and-keplers-laws/';
const STARS_URL = 'https://science.nasa.gov/universe/stars/';

type FeedItem = { assetId: string; sourceUrl: string };
type Feed = { decisionId: string; items: FeedItem[] };

async function feed(token: string): Promise<Feed> {
  const response = await app.inject({ url: '/v1/feed', headers: headers(token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

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
  const decision = await feed(identity.token);
  const orbitsItem = decision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  assert.ok(orbitsItem, 'seeded library must contain an orbits Scroll');

  await expose(identity.token, decision.decisionId, orbitsItem.assetId);

  const response = await worlds(identity.token);
  assert.ok(response.system, 'one exposure must produce a system');
  assert.equal(response.system!.worlds.length, 1, 'exactly one world for one encountered source');
  const world = response.system!.worlds[0]!;
  assert.equal(world.sourceUrl, ORBITS_URL);
  assert.equal(world.seenCount, 1);

  const directScrollCount = (await pool.query(
    `SELECT count(*)::int AS n FROM asset WHERE kind='Scroll' AND source_url=$1`, [ORBITS_URL],
  )).rows[0].n;
  const directSeenCount = (await pool.query(
    `SELECT count(DISTINCT a.id)::int AS n FROM exposure e JOIN asset a ON a.id=e.asset_id
     WHERE e.universe_id=$1 AND a.kind='Scroll' AND a.source_url=$2`,
    [identity.scope.universeId, ORBITS_URL],
  )).rows[0].n;
  assert.equal(world.scrollCount, directScrollCount, 'scrollCount must match a direct SQL count over asset');
  assert.equal(world.seenCount, directSeenCount, 'seenCount must match a direct SQL count over exposure/asset');
  assert.equal(directScrollCount, 2, 'the seeded orbits source carries two Scrolls');
});

test('exposure to Scrolls from two sources derives two worlds inside one system ("two planets, one solar system")', async () => {
  const identity = await provisionIdentity();
  const decision = await feed(identity.token);
  const orbitsItem = decision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  const starsItem = decision.items.find(item => item.sourceUrl === STARS_URL)!;
  assert.ok(orbitsItem && starsItem, 'seeded library must contain both sources');

  await expose(identity.token, decision.decisionId, orbitsItem.assetId);
  await expose(identity.token, decision.decisionId, starsItem.assetId);

  const response = await worlds(identity.token);
  assert.ok(response.system, 'two exposures across two sources must produce one system');
  assert.equal(response.system!.worlds.length, 2, 'exactly two worlds -- one solar system, two planets');
  const bySource = new Map(response.system!.worlds.map(w => [w.sourceUrl, w]));
  assert.equal(bySource.get(ORBITS_URL)?.seenCount, 1);
  assert.equal(bySource.get(STARS_URL)?.seenCount, 1);
  assert.equal(bySource.get(ORBITS_URL)?.scrollCount, 2);
  assert.equal(bySource.get(STARS_URL)?.scrollCount, 1);
  // Every universe shares the same underlying catalog world for a given source (ADR-0028 section 4:
  // worlds are universe-independent) -- the ids must be stable across universes, not re-minted.
  const other = await provisionIdentity();
  const otherDecision = await feed(other.token);
  const otherOrbits = otherDecision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  await expose(other.token, otherDecision.decisionId, otherOrbits.assetId);
  const otherResponse = await worlds(other.token);
  assert.equal(otherResponse.system!.worlds[0]!.worldId, bySource.get(ORBITS_URL)!.worldId, 'the orbits world is the same catalog row for every universe');
});

// -----------------------------------------------------------------------------------------------
// Re-running the derivation is idempotent: no new rows, identical output, from the recorded
// evidence alone.
// -----------------------------------------------------------------------------------------------

test('re-running the derivation changes nothing: same ids, same counts, no new rows', async () => {
  const identity = await provisionIdentity();
  const decision = await feed(identity.token);
  const orbitsItem = decision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  const starsItem = decision.items.find(item => item.sourceUrl === STARS_URL)!;
  await expose(identity.token, decision.decisionId, orbitsItem.assetId);
  await expose(identity.token, decision.decisionId, starsItem.assetId);

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
  const decision = await feed(identity.token);
  const orbitsItem = decision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  await expose(identity.token, decision.decisionId, orbitsItem.assetId);

  const world = (await pool.query(
    `SELECT id FROM world WHERE derivation_method=$1 AND source_url=$2`, [SHARED_SOURCE_V1, ORBITS_URL],
  )).rows[0];
  assert.ok(world, 'the orbits world must already exist from the exposure above');

  await assert.rejects(
    transaction(async client => {
      await client.query('DELETE FROM world_member WHERE world_id=$1', [world.id]);
    }),
    /must name at least one asset as its evidence/,
  );
  // Unaffected: the world's real members are still exactly the two orbits Scrolls.
  const remaining = (await pool.query('SELECT count(*)::int AS n FROM world_member WHERE world_id=$1', [world.id])).rows[0].n;
  assert.equal(remaining, 2);
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
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Variant spelling','s','b',$2,$3,'documented',900)`,
    [randomUUID(), 'NASA \u00b7 Orbits and Kepler\u2019s Laws (variant)', ORBITS_URL],
  );
  const decision = await feed(identity.token);
  const item = decision.items[0]!;
  await expose(identity.token, decision.decisionId, item.assetId);

  const worlds = (await pool.query(
    `SELECT count(*)::int AS n FROM world WHERE derivation_method=$1 AND source_url=$2`,
    [SHARED_SOURCE_V1, ORBITS_URL],
  )).rows[0];
  assert.equal(worlds.n, 1, 'one source URL yields exactly one world whatever its title variants');
});

test('a world_member cannot claim a source its own asset does not carry', async () => {
  const identity = await provisionIdentity();
  const decision = await feed(identity.token);
  const orbitsItem = decision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  await expose(identity.token, decision.decisionId, orbitsItem.assetId);
  const orbitsWorld = (await pool.query(
    `SELECT id FROM world WHERE derivation_method=$1 AND source_url=$2`, [SHARED_SOURCE_V1, ORBITS_URL],
  )).rows[0];
  const starsAsset = (await pool.query(`SELECT id FROM asset WHERE source_url=$1 LIMIT 1`, [STARS_URL])).rows[0];

  await assert.rejects(
    transaction(async client => {
      await client.query('INSERT INTO world_member(world_id,asset_id) VALUES($1,$2)', [orbitsWorld.id, starsAsset.id]);
    }),
    /must carry the same source URL as its world/,
  );
});

// -----------------------------------------------------------------------------------------------
// readWorldSystem is a pure read: it never mutates state, unlike the derivation functions.
// -----------------------------------------------------------------------------------------------

test('readWorldSystem performs no writes', async () => {
  const identity = await provisionIdentity();
  const decision = await feed(identity.token);
  const orbitsItem = decision.items.find(item => item.sourceUrl === ORBITS_URL)!;
  await expose(identity.token, decision.decisionId, orbitsItem.assetId);

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
