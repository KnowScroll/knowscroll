/**
 * ADR-0025 — HTTP-level proof for the Reel-inventory slice, against real disposable PostgreSQL and
 * the real Fastify app (same style as tests/api-asks.test.ts / tests/api-trace-revisit.test.ts):
 * the `kinds` feed parameter (default excludes Reel, opt-in includes it, unknown kind is a 400),
 * the Reel item shape, exposure/keep working identically for a Reel (including the events lookup),
 * a kept Reel excluded from later candidates, and that an Ask naming a Reel exposure is refused.
 * Also documents (rather than works around) the one pre-existing boundary this lane does not own:
 * `GET /v1/traces/:eventId` and the Universe trace list use a Scroll-only selection schema that
 * lives outside this lane's paths (packages/db/src/trace-revisit.ts) — see bootstrap-http.md.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';
import { projectOne } from '../apps/worker/src/project.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';
import { mintReelAsset, withdrawGeneratedReel } from '../apps/worker/src/publication/mint.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Inventory HTTP tests require an isolated knowscroll_test_* database');
}

const developmentToken = randomBytes(32).toString('hex');
const app = buildApp(developmentToken);
after(async () => { await app.close(); await pool.end(); });

const headers = (token: string) => ({ authorization: `Bearer ${token}` });

// -------------------------------------------------------------------------------------------
// Seeding one legitimate, minted, test_eligible Reel — going through migration 0013/0014/0015's
// own admission, lineage, gate and provenance guards, not around them.
// -------------------------------------------------------------------------------------------

const claim = (id: string, role: 'main' | 'supporting') => ({ id, role });
const sentence = (text: string, claimIds: string[]) => ({ text, claimIds });

function brief(assetId: string, tag: string) {
  return generationBrief.parse({
    version: 1,
    worldId: `inventory-http-${tag}`,
    narration: [
      sentence(`Sentence one ${tag}.`, ['c1']),
      sentence(`Sentence two ${tag}.`, ['c1']),
      sentence(`Sentence three ${tag}.`, ['c2']),
      sentence(`Sentence four ${tag}.`, ['c2']),
    ],
    claims: [claim('c1', 'main'), claim('c2', 'supporting')],
    claimSources: [{ claimId: 'c1', assetId, assetRevision: 1 }, { claimId: 'c2', assetId, assetRevision: 1 }],
    criteria: { mustShow: [{ id: 'show-1', text: 'Something visible.', type: 'presence' as const, claimId: 'c1' }], mustNotShow: [], depictionPolicyVersion: 'depiction-v1' },
    style: { id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.' },
    title: `Inventory HTTP Reel ${tag}`,
    summary: `A fixture Reel minted for the inventory HTTP tests (${tag}).`,
  });
}

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];

async function seedMintedReel(tag: string): Promise<{ assetId: string; mediaSha256: string; sourceAssetId: string; generatedReelId: string }> {
  const sourceAssetId = randomUUID();
  // ADR-0028: a minted Reel's `source_title`/`source_url` (copied verbatim from this Scroll by
  // `mintReelAsset`) is now also the composer's `sourceKey` for diversity ranking. A literal
  // identical URL across every fixture this file mints would make composer-signals-v1 see them
  // all as "one source" and cap them at max_per_source — tagged uniquely, each fixture is its own
  // source, matching what a real distinct generation would be.
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Library title','Library summary','Library body text.',$2,$3,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [sourceAssetId, `Library source ${tag}`, `https://example.test/library-${tag}`],
  );

  const briefJson = brief(sourceAssetId, tag);
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'test','approved')`,
    [briefId, sourceAssetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  const port = 20000 + Math.floor(Math.random() * 30000);
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,$2,$3,'/tmp/inventory-http-fixtures','standin','test')`,
    [engineId, `http://127.0.0.1:${port}`, REVISION],
  );
  const grantId = randomUUID();
  await pool.query(`INSERT INTO generation_budget_grant(id,mode,cap_cents,expires_at) VALUES($1,'standin',100000,now()+interval '30 days')`, [grantId]);
  await pool.query('UPDATE generation_budget_grant SET reserved_cents=reserved_cents+500 WHERE id=$1', [grantId]);

  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at)
     VALUES($1,$2,$3,$4,'video',500,now()+interval '1 hour')`,
    [jobId, briefId, engineId, grantId],
  );

  const attemptId = randomUUID();
  const requestId = `ks-gen-${attemptId}`;
  const requestBody = '{}';
  await pool.query(
    `INSERT INTO cutroom_attempt(id,job_id,ordinal,request_id,request_body,body_sha256,contract_revision)
     VALUES($1,$2,1,$3,$4,$5,$6)`,
    [attemptId, jobId, requestId, requestBody, createHash('sha256').update(requestBody).digest('hex'), REVISION],
  );
  const runId = `run-${attemptId}`;
  const enginePath = `/tmp/inventory-http-fixtures/${attemptId}.mp4`;
  await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed', dispatch_committed_at=now() WHERE id=$1`, [attemptId]);
  await pool.query(`UPDATE cutroom_attempt SET state='accepted', run_id=$2, accepted_at=now() WHERE id=$1`, [attemptId, runId]);
  await pool.query(
    `UPDATE cutroom_attempt SET state='finished', finished_at=now(), reported_cost_cents=0, settlement='settled',
       result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text)),
       record_summary=jsonb_build_object('contractVersion',1,'runId',$3::text,'pictures','[]'::jsonb,
         'takes',jsonb_build_array(jsonb_build_object('takeId','t1','shotId','s1','number',1,'used',true,'checks','[]'::jsonb)),
         'degradations','[]'::jsonb)
     WHERE id=$1`,
    [attemptId, enginePath, runId],
  );

  const mediaSha256 = createHash('sha256').update(`${attemptId}-media`).digest('hex');
  const storageKey = `sha256/${mediaSha256.slice(0, 2)}/${mediaSha256.slice(2, 4)}/${mediaSha256}.mp4`;
  await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,4096,'video/mp4',$2,$3)`,
    [mediaSha256, JSON.stringify({ durationSeconds: 7.25, width: 1080, height: 1920 }), storageKey],
  );

  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: 1, used: 1 } };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,'standin','synthesis',true,$8)`,
    [generatedReelId, attemptId, briefId, engineId, runId, mediaSha256, enginePath, JSON.stringify(lineage)],
  );

  for (const gate of REQUIRED_GATES) {
    const verdict = gate === 'witness_alignment' ? 'unavailable' : 'pass';
    await pool.query(
      `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,$4,$5)`,
      [randomUUID(), generatedReelId, gate, verdict, JSON.stringify(verdict === 'unavailable' ? { reason: 'test' } : {})],
    );
  }
  await pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [generatedReelId]);

  const minted = await mintReelAsset(pool, generatedReelId);
  return { assetId: minted.assetId, mediaSha256, sourceAssetId, generatedReelId };
}

/**
 * Every test in this file shares one global `asset` table (no universe scoping for inventory
 * rows) and the existing bootstrap policy bounds candidates to 3. Withdrawing each test's own
 * fixture Reel once that test is done keeps later tests' feeds from being crowded out by an
 * earlier, still-eligible-but-unkept Reel this same file minted — the identical isolation problem
 * a real deployment would solve by having many more than one Reel in circulation.
 */
async function withFixtureReel<T>(tag: string, fn: (reel: Awaited<ReturnType<typeof seedMintedReel>>) => Promise<T>): Promise<T> {
  const reel = await seedMintedReel(tag);
  try {
    return await fn(reel);
  } finally {
    await withdrawGeneratedReel(pool, reel.generatedReelId);
  }
}

type FeedItem = { assetId: string; kind: string; reason?: string; [key: string]: unknown };
type Feed = { decisionId: string; items: FeedItem[]; privacyEpoch: number };

async function feed(token: string, kinds?: string): Promise<{ status: number; body: Feed }> {
  const url = kinds === undefined ? '/v1/feed' : `/v1/feed?kinds=${encodeURIComponent(kinds)}`;
  const response = await app.inject({ url, headers: headers(token) });
  return { status: response.statusCode, body: response.statusCode === 200 ? response.json() : response.json() };
}

/**
 * ADR-0028: the real Composer ranks every unread candidate on equal footing and fills the whole
 * bounded slate from whatever is eligible — it does not, unlike the retired bootstrap policy,
 * favor a fixed feed position. A fresh identity's candidate pool is otherwise every Scroll ever
 * inserted by `db:seed` or an earlier test/file in this run (this file's own docstring above
 * already notes the shared `asset` table), so a growing set of same-scored, never-exposed Scrolls
 * can otherwise out-tie-break this file's own fixture Reel by sheer numbers. Marking everything
 * that already exists as kept for the fresh universe excludes it from candidacy outright (the real
 * production mechanism, not a scoring trick), leaving this test's own fixture(s) as the whole pool
 * — restoring the deterministic "the eligible Reel is offered" proof ADR-0025 requires.
 */
async function existingLibraryIds(): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM asset WHERE kind IN ('Scroll','Reel')")).rows.map(r => r.id);
}

/** `excludeIds` must be snapshotted BEFORE this test's own fixture (its library Scroll and/or
 * minted Reel) is created, or the exclusion would swallow the very candidate the test wants to
 * see. */
async function provisionIsolatedIdentity(excludeIds: readonly string[]): ReturnType<typeof provisionIdentity> {
  const identity = await provisionIdentity();
  if (excludeIds.length) await pool.query('UPDATE accounts SET kept_asset_ids=$2::uuid[] WHERE universe_id=$1', [identity.scope.universeId, excludeIds]);
  return identity;
}

test('GET /v1/feed default excludes an eligible Reel; kinds=Scroll,Reel includes it with the documented shape', async () => {
  await app.ready();
  const preexisting = await existingLibraryIds();
  await withFixtureReel('default-vs-optin', async (reel) => {
    const identity = await provisionIsolatedIdentity(preexisting);

    const defaultFeed = await feed(identity.token);
    assert.equal(defaultFeed.status, 200, JSON.stringify(defaultFeed.body));
    assert.ok(!defaultFeed.body.items.some((item) => item.kind === 'Reel'), 'default feed must never include a Reel');
    assert.ok(!defaultFeed.body.items.some((item) => item.assetId === reel.assetId));

    const optIn = await feed(identity.token, 'Scroll,Reel');
    assert.equal(optIn.status, 200, JSON.stringify(optIn.body));
    const reelItem = optIn.body.items.find((item) => item.assetId === reel.assetId);
    assert.ok(reelItem, 'opted-in feed must include the eligible Reel');
    assert.equal(reelItem!.kind, 'Reel');
    assert.equal(reelItem!.truthState, 'synthesis');
    assert.equal(reelItem!.generatedLabel, true);
    assert.equal(reelItem!.simulated, true);
    assert.equal(reelItem!.mediaUrl, `/v1/media/${reel.mediaSha256}`);
    assert.equal(reelItem!.durationSeconds, 7.25);
    assert.equal(reelItem!.aspect, '1080:1920');
    assert.equal(typeof reelItem!.reason, 'string');
    assert.ok((reelItem!.reason as string).length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(reelItem, 'body'), false, 'a Reel item never carries a body field');
    assert.ok(!('sourceUrl' in reelItem! && (reelItem!.sourceUrl as string).includes('engine')), 'never an engine path');

    // Order also matters for /v1/feed?kinds=Reel alone (Scroll excluded entirely).
    const reelOnly = await feed(identity.token, 'Reel');
    assert.equal(reelOnly.status, 200, JSON.stringify(reelOnly.body));
    assert.ok(!reelOnly.body.items.some((item) => item.kind === 'Scroll'));
  });
});

test('unknown or malformed kinds are refused with 400, never silently dropped', async () => {
  const identity = await provisionIdentity();
  for (const kinds of ['Reel,Video', 'Scroll,,Reel', '', 'reel', 'Scroll,Scroll', 'Scroll,Reel,']) {
    const response = await feed(identity.token, kinds);
    assert.equal(response.status, 400, `kinds=${JSON.stringify(kinds)} should be refused, got ${response.status}`);
  }
});

test('exposure, keep and the events lookup work identically for a Reel; a kept Reel is excluded from later candidates', async () => {
  const preexisting = await existingLibraryIds();
  await withFixtureReel('exposure-keep', async (reel) => {
    const identity = await provisionIsolatedIdentity(preexisting);

    const optIn = await feed(identity.token, 'Scroll,Reel');
    const item = optIn.body.items.find((entry) => entry.assetId === reel.assetId)!;
    assert.ok(item, 'fixture Reel must appear in the opted-in feed');

    const exposure = await app.inject({
      method: 'POST', url: '/v1/exposures', headers: headers(identity.token),
      payload: { decisionId: optIn.body.decisionId, assetId: reel.assetId, clientExposureId: randomUUID() },
    });
    assert.equal(exposure.statusCode, 201, exposure.body);

    const keep = await app.inject({
      method: 'POST', url: '/v1/interactions', headers: headers(identity.token),
      payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId: reel.assetId, kind: 'keep' },
    });
    assert.equal(keep.statusCode, 202, keep.body);

    let projected = false;
    for (let i = 0; i < 64; i += 1) {
      const result = await projectOne();
      if (result?.jobId === keep.json().jobId) { projected = true; break; }
      if (!result) break;
    }
    assert.ok(projected, 'the deterministic projection worker must reach an admitted Reel Keep exactly like a Scroll Keep');

    const eventRow = await app.inject({ url: `/v1/events/${keep.json().eventId}`, headers: headers(identity.token) });
    assert.equal(eventRow.statusCode, 200, eventRow.body);
    assert.equal(eventRow.json().kind, 'keep');
    assert.equal(eventRow.json().projected, true);

    const traceRow = (await pool.query('SELECT asset_id FROM trace WHERE event_id=$1', [keep.json().eventId])).rows[0];
    assert.equal(traceRow.asset_id, reel.assetId, 'the same trace table, no new event kind');

    // A kept Reel must never appear as a candidate again — same policy as a kept Scroll.
    const after = await feed(identity.token, 'Scroll,Reel');
    assert.ok(!after.body.items.some((entry) => entry.assetId === reel.assetId), 'a kept Reel must be excluded from later candidates');

    // ADR-0025 documented boundary: the dedicated read endpoint's selection schema is Scroll-only
    // and lives outside this lane (packages/db/src/trace-revisit.ts) — see bootstrap-http.md. The
    // WRITE path above (same ledger kind, same trace row, same projection worker) is what
    // ADR-0025 section 3 actually requires, and is fully proven above.
    const revisit = await app.inject({ url: `/v1/traces/${keep.json().eventId}`, headers: headers(identity.token) });
    assert.equal(revisit.statusCode, 422, revisit.body);
    assert.deepEqual(revisit.json(), { error: 'Saved Scroll lineage is unavailable' });

    const universe = await app.inject({ url: '/v1/universe', headers: headers(identity.token) });
    assert.equal(universe.statusCode, 200, universe.body);
    const traceEntry = universe.json().traces.find((entry: { eventId: string }) => entry.eventId === keep.json().eventId);
    assert.ok(traceEntry, 'the Reel Trace still appears in the Universe trace list');
    assert.equal(traceEntry.title, 'Saved Scroll unavailable', 'neutral fallback title, same as any other unparseable selection history');
  });
});

test('an Ask naming a Reel exposure is refused (migration 0009\'s own lineage guard requires a Scroll candidate)', async () => {
  const preexisting = await existingLibraryIds();
  await withFixtureReel('ask-refusal', async (reel) => {
    const identity = await provisionIsolatedIdentity(preexisting);
    const optIn = await feed(identity.token, 'Scroll,Reel');
    const exposure = await app.inject({
      method: 'POST', url: '/v1/exposures', headers: headers(identity.token),
      payload: { decisionId: optIn.body.decisionId, assetId: reel.assetId, clientExposureId: randomUUID() },
    });
    assert.equal(exposure.statusCode, 201, exposure.body);

    const before = await pool.query(`SELECT (SELECT count(*) FROM ledger WHERE kind='ask') AS asks, (SELECT count(*) FROM explicit_ask) AS explicit_asks`);
    const ask = await app.inject({
      method: 'POST', url: '/v1/asks', headers: headers(identity.token),
      payload: { clientAskId: randomUUID(), exposureId: exposure.json().exposureId, expectedPrivacyEpoch: identity.scope.privacyEpoch, question: 'What is this Reel showing?' },
    });
    assert.equal(ask.statusCode, 422, ask.body);
    const after = await pool.query(`SELECT (SELECT count(*) FROM ledger WHERE kind='ask') AS asks, (SELECT count(*) FROM explicit_ask) AS explicit_asks`);
    assert.deepEqual(after.rows[0], before.rows[0], 'a refused Ask on a Reel writes nothing');
  });
});
