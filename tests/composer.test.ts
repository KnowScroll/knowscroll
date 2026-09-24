/**
 * ADR-0028 (#114/#5) — HTTP-level proof for the real Composer: determinism, diversity, a derived
 * explanation that changes with the recorded signals, an honest exhausted state once every
 * eligible candidate is kept, and that the ranking inputs `decision_signal` recorded are both
 * present and recoverable. The final test proves the recorded ordering against an independent
 * SQL recomputation of the same (published) policy weights over the raw `exposure`/`ledger`
 * facts — never by re-invoking `rankSignalCandidates` and asserting it agrees with itself.
 *
 * `asset` (kind='Scroll') is a single global table shared with every other test file in this run
 * (same convention `tests/inventory-http.test.ts` documents), and the bounded slate always fills
 * up to `slate_size` from whatever is eligible and unkept — ranking never drops a low-scoring
 * candidate just because a better one exists elsewhere. So rather than trying to out-score
 * whatever another file already left in the shared library (which a tie could still let back in),
 * every test below marks every pre-existing Scroll as already kept for its own fresh universe
 * before inserting its own fixtures: the real, production `kept_asset_ids` exclusion
 * (`rankSignalCandidates` filters on it before any scoring) removes the existing library from
 * candidacy entirely, so a test's own fixtures are provably the whole pool, not merely the
 * highest-scoring slice of it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';
import { renderExplanation, type ComposerSignalInputs } from '../packages/core/src/composer.ts';
import { projectOne } from '../apps/worker/src/project.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Composer tests require an isolated knowscroll_test_* database');
}

const developmentToken = randomBytes(32).toString('hex');
// These tests pin composer-signals-v2 (ADR-0028/0029), which stays a selectable, immutable policy.
const app = buildApp(developmentToken, { composerPolicy: 'composer-signals-v2' });
after(async () => { await app.close(); await pool.end(); });

const headers = (token: string) => ({ authorization: `Bearer ${token}` });

type FeedItem = { assetId: string; sourceUrl: string; reason: string; [key: string]: unknown };
type Feed = { decisionId: string; items: FeedItem[] };

async function feed(token: string): Promise<Feed> {
  const response = await app.inject({ url: '/v1/feed', headers: headers(token) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function insertScrollAsset(tag: string, sourceTitle: string, sourceUrl: string): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,'Body text.',$4,$5,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId, `Composer fixture ${tag}`, `Summary ${tag}`, sourceTitle, sourceUrl],
  );
  return assetId;
}

/** Marks every Scroll that already exists (from `db:seed` or an earlier test file/test in this
 * run) as already kept for a brand-new universe, so it is excluded from candidacy outright — the
 * exact production mechanism, not a score heuristic — leaving only what a test inserts afterward
 * as the eligible pool. */
async function excludeExistingLibrary(universeId: string): Promise<void> {
  const existing = (await pool.query<{ id: string }>("SELECT id FROM asset WHERE kind='Scroll'")).rows.map(r => r.id);
  if (existing.length === 0) return;
  await pool.query('UPDATE accounts SET kept_asset_ids=$2::uuid[] WHERE universe_id=$1', [universeId, existing]);
}

async function freshUniverse(): Promise<{ token: string; universeId: string; privacyEpoch: number }> {
  const identity = await provisionIdentity();
  await excludeExistingLibrary(identity.scope.universeId);
  return { token: identity.token, universeId: identity.scope.universeId, privacyEpoch: identity.scope.privacyEpoch };
}

// -------------------------------------------------------------------------------------------

test('same universe state produces the same ranking twice (determinism)', async () => {
  const universe = await freshUniverse();
  for (let i = 0; i < 4; i += 1) await insertScrollAsset(`determinism-${i}`, `Source ${i}`, `https://example.test/determinism-${i}`);

  const first = await feed(universe.token);
  const second = await feed(universe.token);
  assert.ok(first.items.length > 0, 'fixture candidates must appear');
  assert.deepEqual(second.items, first.items, 'unchanged universe state must rank identically');
  assert.deepEqual(second.items.map(i => i.assetId), first.items.map(i => i.assetId));
});

test('one source cannot take every slot when another source has an eligible candidate (diversity)', async () => {
  const universe = await freshUniverse();
  const sourceXUrl = 'https://example.test/diversity-source-x';
  const sourceYUrl = 'https://example.test/diversity-source-y';
  for (let i = 0; i < 3; i += 1) await insertScrollAsset(`diversity-x-${i}`, 'Source X', sourceXUrl);
  await insertScrollAsset('diversity-y', 'Source Y', sourceYUrl);

  const result = await feed(universe.token);
  assert.equal(result.items.length, 3, 'the bounded slate size is unchanged');
  const fromX = result.items.filter(i => i.sourceUrl === sourceXUrl).length;
  const fromY = result.items.filter(i => i.sourceUrl === sourceYUrl).length;
  assert.ok(fromX <= 2, `Source X must not exceed the policy's max_per_source; got ${fromX}`);
  assert.equal(fromY, 1, 'Source Y has an eligible candidate and must not be crowded out entirely');
});

test('the explanation is derived from recorded signals and changes when they change', async () => {
  const universe = await freshUniverse();
  const sourceTitle = 'Explanation Source';
  const assetId = await insertScrollAsset('explanation', sourceTitle, 'https://example.test/explanation');

  const unreadFeed = await feed(universe.token);
  const unreadItem = unreadFeed.items.find(i => i.assetId === assetId);
  assert.ok(unreadItem, 'the only candidate must appear');
  assert.ok(unreadItem!.reason.includes(sourceTitle), 'the reason must cite the recorded source');
  assert.ok(unreadItem!.reason.includes('No prior exposure'), 'an unread candidate must say so');

  const exposure = await app.inject({
    method: 'POST', url: '/v1/exposures', headers: headers(universe.token),
    payload: { decisionId: unreadFeed.decisionId, assetId, clientExposureId: randomUUID() },
  });
  assert.equal(exposure.statusCode, 201, exposure.body);

  const resurfacedFeed = await feed(universe.token);
  const resurfacedItem = resurfacedFeed.items.find(i => i.assetId === assetId);
  assert.ok(resurfacedItem, 'the same candidate must still appear (it was exposed, never kept)');
  assert.notEqual(resurfacedItem!.reason, unreadItem!.reason, 'the reason must change once the signal changed');
  assert.ok(resurfacedItem!.reason.includes('shown 1 time(s)'), 'the rendered reason must cite the new exposure count');
  assert.ok(resurfacedItem!.reason.includes('0 day(s) ago'), 'the rendered reason must cite the recorded recency');
});

test('a reader who has kept the only eligible candidate gets an honest exhausted state', async () => {
  const universe = await freshUniverse();
  const assetId = await insertScrollAsset('exhausted', 'Exhausted Source', 'https://example.test/exhausted');

  const before = await feed(universe.token);
  assert.equal(before.items.length, 1);
  assert.equal(before.items[0]!.assetId, assetId);

  const exposure = await app.inject({
    method: 'POST', url: '/v1/exposures', headers: headers(universe.token),
    payload: { decisionId: before.decisionId, assetId, clientExposureId: randomUUID() },
  });
  assert.equal(exposure.statusCode, 201, exposure.body);
  const keep = await app.inject({
    method: 'POST', url: '/v1/interactions', headers: headers(universe.token),
    payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId, kind: 'keep' },
  });
  assert.equal(keep.statusCode, 202, keep.body);
  let projected = false;
  for (let i = 0; i < 64; i += 1) {
    const result = await projectOne();
    if (result?.jobId === keep.json().jobId) { projected = true; break; }
    if (!result) break;
  }
  assert.ok(projected, 'the keep must be projected before the account reflects it');

  const exhausted = await feed(universe.token);
  assert.deepEqual(exhausted.items, [], 'nothing eligible remains; the state must be an honest empty slate, not a fallback item');

  const ranking = await pool.query<{ ranking_version: string | null }>('SELECT ranking_version FROM decision WHERE id=$1', [exhausted.decisionId]);
  assert.equal(ranking.rows[0]?.ranking_version, 'composer-signals-v2', 'the exhausted decision is still ranked, just empty');
  const signals = await pool.query('SELECT id FROM decision_signal WHERE decision_id=$1', [exhausted.decisionId]);
  assert.equal(signals.rowCount, 0, 'no candidate was returned, so no signal row is recorded for it');
});

test('ranking inputs are recorded per candidate and the explanation is recoverable from them alone', async () => {
  const universe = await freshUniverse();
  const ids = [
    await insertScrollAsset('recover-0', 'Recover Source', 'https://example.test/recover'),
    await insertScrollAsset('recover-1', 'Recover Source', 'https://example.test/recover'),
  ];

  const result = await feed(universe.token);
  assert.equal(result.items.length, 2);

  const signalRows = (await pool.query<{ asset_id: string; rank: number; retrieval_score: string; inputs: ComposerSignalInputs; explanation_key: string }>(
    'SELECT asset_id, rank, retrieval_score, inputs, explanation_key FROM decision_signal WHERE decision_id=$1 ORDER BY rank',
    [result.decisionId],
  )).rows;
  assert.equal(signalRows.length, 2, 'exactly one recorded signal row per returned candidate');
  assert.deepEqual(signalRows.map(r => r.asset_id).sort(), [...ids].sort());
  assert.deepEqual(signalRows.map(r => r.rank), [1, 2]);

  const templateRows = (await pool.query<{ explanation_key: string; template: string }>('SELECT explanation_key, template FROM composer_explanation_template')).rows;
  const templates = Object.fromEntries(templateRows.map(r => [r.explanation_key, r.template]));

  for (const row of signalRows) {
    const item = result.items.find(i => i.assetId === row.asset_id);
    assert.ok(item, 'every recorded signal row must correspond to a returned item');
    assert.equal(row.inputs.sourceKey, 'https://example.test/recover');
    assert.equal(row.inputs.unread, true);
    assert.equal(row.inputs.lastExposedAt, null);
    assert.equal(row.inputs.exposureCount, 0);
    const recovered = renderExplanation(templates[row.explanation_key]!, row.inputs);
    assert.equal(recovered, item!.reason, 'the reason must be reproducible from only the recorded template + inputs');
  }
});

test('the recorded ordering matches an independent SQL recomputation of the published policy, not just the implementation', async () => {
  const universe = await freshUniverse();
  // Three distinct sources: this test proves pure ranking order, so no candidate may be excluded
  // by the diversity cap (a separate, already-proven property above).
  const unreadId = await insertScrollAsset('sql-unread', 'SQL Proof Source A', 'https://example.test/sql-proof-a');
  const exposedOnceId = await insertScrollAsset('sql-exposed-once', 'SQL Proof Source B', 'https://example.test/sql-proof-b');
  const exposedTwiceId = await insertScrollAsset('sql-exposed-twice', 'SQL Proof Source C', 'https://example.test/sql-proof-c');

  // Direct, same-transaction-free SQL exposure fixtures with controlled ages — independent of any
  // application code path, so the later SQL recomputation below is a real cross-check.
  async function fixtureExposure(assetId: string, ageDays: number): Promise<void> {
    const decisionId = randomUUID();
    await pool.query(
      `INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'editorial-unkept-v1','[]'::jsonb,$3)`,
      [decisionId, universe.universeId, universe.privacyEpoch],
    );
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch,created_at) VALUES($1,$2,'exposure',$3,$4,$5,clock_timestamp() - ($6::text || ' days')::interval)`,
      [eventId, universe.universeId, randomUUID(), JSON.stringify({ decisionId, assetId }), universe.privacyEpoch, ageDays],
    );
    await pool.query(
      `INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), universe.universeId, decisionId, assetId, eventId, randomUUID()],
    );
  }
  // exposedOnce: 1 exposure, 50 days ago -> score = -exposurePenalty*1 + recencyBonus*50 (positive, big gap).
  await fixtureExposure(exposedOnceId, 50);
  // exposedTwice: 2 exposures, most recent 10 days ago -> score = -exposurePenalty*2 + recencyBonus*10 (small, recent, repeated).
  await fixtureExposure(exposedTwiceId, 20);
  await fixtureExposure(exposedTwiceId, 10);

  const result = await feed(universe.token);
  assert.equal(result.items.length, 3, 'all three fixture candidates fit in one slate');

  // The independent oracle: recompute exposure count/recency straight from exposure+ledger, and
  // the score from composer_policy's own stored weights — never from packages/core.
  const policy = (await pool.query<{ unread_bonus: string; exposure_penalty: string; recency_bonus: string }>(
    `SELECT (weights->>'unreadBonus') AS unread_bonus, (weights->>'exposurePenalty') AS exposure_penalty, (weights->>'recencyBonus') AS recency_bonus
     FROM composer_policy WHERE version='composer-signals-v2'`,
  )).rows[0]!;
  const oracle = (await pool.query<{ asset_id: string; expected_score: string }>(
    `WITH signal AS (
       SELECT a.id AS asset_id, COALESCE(e.cnt,0)::numeric AS exposure_count,
         CASE WHEN e.cnt IS NULL OR e.cnt = 0 THEN NULL
              ELSE floor(extract(epoch FROM (clock_timestamp() - e.last_exposed_at)) / 86400) END AS recency_days
       FROM asset a
       LEFT JOIN (
         SELECT ex.asset_id, count(*) AS cnt, max(l.created_at) AS last_exposed_at
         FROM exposure ex JOIN ledger l ON l.id = ex.event_id
         WHERE ex.universe_id = $4
         GROUP BY ex.asset_id
       ) e ON e.asset_id = a.id
       WHERE a.id = ANY($1::uuid[])
     )
     SELECT asset_id,
       (CASE WHEN exposure_count = 0 THEN $2::numeric ELSE 0 END)
         - $3::numeric * exposure_count + $5::numeric * COALESCE(recency_days, 0) AS expected_score
     FROM signal ORDER BY expected_score DESC, asset_id ASC`,
    [[unreadId, exposedOnceId, exposedTwiceId], policy.unread_bonus, policy.exposure_penalty, universe.universeId, policy.recency_bonus],
  )).rows;

  const expectedOrder = oracle.map(r => r.asset_id);
  assert.equal(expectedOrder[0], unreadId, 'independent SQL must also rank the never-exposed candidate first');

  const recorded = (await pool.query<{ asset_id: string; retrieval_score: string }>(
    'SELECT asset_id, retrieval_score FROM decision_signal WHERE decision_id=$1 ORDER BY rank',
    [result.decisionId],
  )).rows;
  assert.deepEqual(recorded.map(r => r.asset_id), expectedOrder, 'recorded rank order must match the independent SQL oracle, not merely restate the TypeScript implementation');
  recorded.forEach((row, index) => {
    assert.equal(Number(row.retrieval_score), Number(oracle[index]!.expected_score), `recorded retrieval_score for rank ${index + 1} must equal the independently computed score`);
  });
});

// -------------------------------------------------------------------------------------------
// #113/ADR-0029 amendment: the coverage guarantee -- every source in the library is eventually
// offered. Built as a deliberately adversarial library: two "abundant" sources (30 assets each)
// whose asset ids are precomputed, offline, against the exact FNV-1a hash `rankSignalCandidates`
// uses to break ties, so every abundant id hashes strictly below every id belonging to six "minor"
// (one-asset) sources. Under composer-signals-v1's hash-only tie-break this starves the minor
// sources indefinitely: with slate_size 3 and max_per_source 2, every round's three slots are
// filled entirely from the abundant sources' still-unread reserve (which -- at 60 combined assets,
// consumed 3/round -- does not run low within this test's round budget), so no minor source is
// ever offered at all, matching #113's own observation of many consecutive decisions offering
// nothing from a specific source. Under composer-signals-v2's coverage tie-break, once a round's
// offered items are exposed, their sources' recorded exposure counts rise above the untouched
// minor sources' zero, so an entirely-untouched minor source outranks an already-exposed abundant
// one on the very next decision -- regardless of hash -- and all six are reached within a handful
// of decisions.
// -------------------------------------------------------------------------------------------

function tiebreakKeyForTest(assetId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < assetId.length; i += 1) {
    hash ^= assetId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const ABUNDANT_A_IDS = ["c52977ab-9c36-4961-8367-c40e04875373","b30e4ce1-8861-4c89-955d-bc7c4f87b677","ccca6452-fed6-4ba4-8b3f-18705148a780","e2e7d721-4715-4ff9-bce0-30f410008eb9","fd6b6139-bcd8-4a48-a453-7ec234adc513","464591c4-5add-4aab-a153-b84f116fe5dd","88ca803b-8cfd-48e6-bfc7-2d8d2a847ac9","a6c55aaa-ea33-4e69-84b6-180118825a27","5713ff4e-2d91-43e6-84fe-de6ccd373a59","e08d2b32-f187-4767-b114-405f56400d64","54600844-496c-4938-9a2d-b58091a324ec","db6bca9d-091b-47fc-978c-f9521633aef0","fc6bc2fe-f09e-4106-a236-d57f898bfb7c","982c0218-8cf6-4d18-8540-2cf4565f210a","964dc529-c6e7-43e8-83ed-07fe2aabcedf","ecedeeb7-34e5-487d-a2d6-5d2a06158c4f","8659d1ec-5b19-46db-97c8-db14c1bf222a","219b452e-f18c-4831-9dd8-eff338126ee4","6c686ca2-f06d-4feb-bd8e-b383f4de9520","127db50e-4170-4c59-bd76-4cc59f9c14db","dc3c7607-a8c9-4eaf-9c5b-79a2a089d37e","179e1b4c-5dbf-482d-97ae-7c3fc2fed483","10de561f-c50c-4c11-b848-905d20971dd7","92c6404f-bef5-4e4b-879c-0eff72792dcf","28b94423-d29f-4703-8985-ab51cb82fb9d","49fca7f7-ee10-46e7-a102-e5b99a54a15b","cd9156e0-5faa-44bb-a94c-833e298d7bd1","021369a6-c764-4f90-8ac5-bf237226b93c","a9ff5cf7-8184-4c33-a4b2-2d5de210002b","e42c84ae-8f0d-4c86-a556-d2498e8ad386"];
const ABUNDANT_B_IDS = ["28579f35-b09c-42b1-954f-8fbcf1c0f5a9","e6cb1867-5d14-4cca-8b3b-3376c8017526","8569fa6f-f986-40e8-acbf-ddf713ec3dda","c31ff0d9-c130-481c-9b8b-401c28b8d0d5","6675878b-7d47-4e58-9ddd-d520e169dc58","b4c5d030-3534-457f-85f9-221c7e0cf631","b92b19f0-2a74-4808-a6ab-321e84a51ac9","95757d48-e1ad-40dd-8e2e-ac9b90c39f8c","8e09db06-302b-4810-801c-c9b5870be391","89955683-8b7f-41b4-94e8-002288ceaeb3","30ffcf75-51ab-4b0b-a6b3-6997b2269484","6063ac5c-de11-424e-a051-ad990ae39bae","eca82a8b-d893-4ac6-bc99-d371f13b1e28","cd6eee87-ba42-46fe-9c4c-dbaf2ed10b65","a8de1a3b-e74f-4c73-87f4-0ee1dd5a3c28","aa0130cb-7ae5-4229-8b77-1b32dff11652","fd259102-271e-48ed-8b5a-cc0e38a50354","f7512ad9-5895-4525-ac07-7df28a1b31db","e12ab20f-2d70-4740-927b-27ece45101d4","d03bc7fd-24fa-4142-9774-d89cdf7c127f","826653dd-15d1-434e-9482-a7eb7ae2dc26","4af00534-45bd-482c-8875-2babeb952050","5d6884be-7f5f-41bf-ad09-b51ab258e02b","5fbadacd-26a9-41b5-90c5-b7d277b21337","9ff2eee0-1f9d-476f-ab4f-d90b25665414","b993be17-5ce3-4163-9727-c9bb17cb27ea","7e865f6f-8f3d-4453-89a6-c4d24e27ac60","8ab73978-37ee-4802-ae43-7567c126744b","e490929a-2a37-47ab-9cca-1397be28c76c","f8506c1c-02a2-499c-a409-6af698677446"];
const MINOR_IDS = ["13723d15-229c-42d2-82bb-3579fe942cbe","aceb8e91-d20e-4107-9d24-29ec85958147","7d94e084-5e17-4275-8f93-fd67214bf407","bf154eb1-c868-4927-b54e-9a7c8849ea80","29cde711-ede2-4d7e-83cd-7c2958842679","fb639f2c-0b8e-4f98-aced-55178e7f3c8f"];

test('the precomputed coverage-test fixture ids really do separate under the ranking\'s own hash (self-check)', () => {
  const maxAbundantHash = Math.max(...[...ABUNDANT_A_IDS, ...ABUNDANT_B_IDS].map(tiebreakKeyForTest));
  const minMinorHash = Math.min(...MINOR_IDS.map(tiebreakKeyForTest));
  assert.ok(maxAbundantHash < minMinorHash, 'every precomputed abundant id must hash below every precomputed minor id, or the scenario below proves nothing');
});

async function insertScrollAssetWithId(assetId: string, tag: string, sourceTitle: string, sourceUrl: string): Promise<void> {
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,'Body text.',$4,$5,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId, `Coverage fixture ${tag}`, `Summary ${tag}`, sourceTitle, sourceUrl],
  );
}

test('every source in the library is eventually offered, within a bounded number of decisions, even against an abundant hash-favored rival (#113 coverage guarantee)', async () => {
  const universe = await freshUniverse();
  const abundantAUrl = 'https://example.test/coverage-abundant-a';
  const abundantBUrl = 'https://example.test/coverage-abundant-b';
  const minorUrls = MINOR_IDS.map((_, i) => `https://example.test/coverage-minor-${i}`);

  for (const [i, id] of ABUNDANT_A_IDS.entries()) await insertScrollAssetWithId(id, `abundant-a-${i}`, 'Abundant Source A', abundantAUrl);
  for (const [i, id] of ABUNDANT_B_IDS.entries()) await insertScrollAssetWithId(id, `abundant-b-${i}`, 'Abundant Source B', abundantBUrl);
  for (const [i, id] of MINOR_IDS.entries()) await insertScrollAssetWithId(id, `minor-${i}`, `Minor Source ${i}`, minorUrls[i]!);

  const allSourceUrls = new Set([abundantAUrl, abundantBUrl, ...minorUrls]);
  const offeredSourceUrls = new Set<string>();
  const ROUNDS = 15;
  const COVERAGE_BOUND = 6;
  let firstFullCoverageRound: number | null = null;

  for (let round = 1; round <= ROUNDS; round += 1) {
    const decision = await feed(universe.token);
    for (const item of decision.items) {
      offeredSourceUrls.add(item.sourceUrl);
      const exposure = await app.inject({
        method: 'POST', url: '/v1/exposures', headers: headers(universe.token),
        payload: { decisionId: decision.decisionId, assetId: item.assetId, clientExposureId: randomUUID() },
      });
      assert.equal(exposure.statusCode, 201, exposure.body);
    }
    if (firstFullCoverageRound === null && [...allSourceUrls].every(u => offeredSourceUrls.has(u))) {
      firstFullCoverageRound = round;
    }
  }

  const missing = [...allSourceUrls].filter(u => !offeredSourceUrls.has(u));
  assert.deepEqual(missing, [], `every source must be offered at least once within ${ROUNDS} decisions; still missing: ${missing.join(', ')}`);
  assert.ok(
    firstFullCoverageRound !== null && firstFullCoverageRound <= COVERAGE_BOUND,
    `coverage guarantee must be bounded: expected every source offered within ${COVERAGE_BOUND} decisions, first achieved at decision ${String(firstFullCoverageRound)}`,
  );
});
