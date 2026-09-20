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
const app = buildApp(developmentToken);
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
  assert.equal(ranking.rows[0]?.ranking_version, 'composer-signals-v1', 'the exhausted decision is still ranked, just empty');
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
     FROM composer_policy WHERE version='composer-signals-v1'`,
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
