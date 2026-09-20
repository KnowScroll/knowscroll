/**
 * ADR-0025 section 1 — `apps/worker/src/publication/mint.ts` against real disposable PostgreSQL:
 * mint is idempotent, refuses an ungated Reel with a typed error (in front of, never instead of,
 * migration 0015's own trigger), refuses a brief with no title/summary, and withdrawal both moves
 * the generated Reel to `withdrawn` and stamps its asset's `withdrawn_at` exactly once. Always
 * makes and drops its own disposable `knowscroll_test_*` database.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { runMigrations } from '../packages/db/src/migrations.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';
import { mintReelAsset, withdrawGeneratedReel, MintError } from '../apps/worker/src/publication/mint.ts';

function requiredDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
  return new URL(raw);
}
function withDatabaseName(url: URL, name: string): string {
  const clone = new URL(url.toString());
  clone.pathname = `/${name}`;
  return clone.toString();
}
async function withDisposableDatabase<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const base = requiredDatabaseUrl();
  const name = `knowscroll_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: withDatabaseName(base, 'postgres'), max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: withDatabaseName(base, name), max: 4 });
  try {
    await runMigrations(pool, { directory: 'packages/db/migrations' });
    return await fn(pool);
  } finally {
    await pool.end();
    const dropAdmin = new pg.Pool({ connectionString: withDatabaseName(base, 'postgres'), max: 1 });
    try {
      await dropAdmin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await dropAdmin.end();
    }
  }
}

const claim = (id: string, role: 'main' | 'supporting') => ({ id, role });
const sentence = (text: string, claimIds: string[]) => ({ text, claimIds });

function brief(assetId: string, tag: string, withDisplayText: boolean) {
  return {
    version: 1 as const,
    worldId: `world-${tag}`,
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
    ...(withDisplayText ? { title: `Reel title ${tag}`, summary: `Reel summary ${tag}.` } : {}),
  };
}

async function seedScrollAsset(pool: pg.Pool, sourceTitle = 'Example source', sourceUrl = 'https://example.test/x'): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Title','Summary','Body text.',$2,$3,'documented',
       (SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId, sourceTitle, sourceUrl],
  );
  return assetId;
}

interface SeedOptions { providerMode?: 'standin' | 'live'; tag?: string; withDisplayText?: boolean; sourceTitle?: string; sourceUrl?: string }
interface SeededReel { generatedReelId: string; mediaSha256: string; sourceTitle: string; sourceUrl: string }

async function seedGeneratedReel(pool: pg.Pool, options: SeedOptions = {}): Promise<SeededReel> {
  const providerMode = options.providerMode ?? 'standin';
  const tag = options.tag ?? randomUUID().slice(0, 8);
  const withDisplayText = options.withDisplayText ?? true;
  const sourceTitle = options.sourceTitle ?? 'Example source';
  const sourceUrl = options.sourceUrl ?? 'https://example.test/x';

  const assetId = await seedScrollAsset(pool, sourceTitle, sourceUrl);
  const briefJson = generationBrief.parse(brief(assetId, tag, withDisplayText));
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'test','approved')`,
    [briefId, assetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  const port = 20000 + Math.floor(Math.random() * 30000);
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,$2,$3,'/tmp/inventory-mint-fixtures',$4,'test')`,
    [engineId, `http://127.0.0.1:${port}`, REVISION, providerMode],
  );

  const grantId = randomUUID();
  const budgetCents = providerMode === 'live' ? 100 : 500;
  if (providerMode === 'live') {
    await pool.query(
      `INSERT INTO generation_budget_grant(id,mode,cap_cents,authorization_ref,expires_at)
       VALUES($1,'live',200,'test fixture authorization',now()+interval '1 day')`,
      [grantId],
    );
  } else {
    await pool.query(`INSERT INTO generation_budget_grant(id,mode,cap_cents,expires_at) VALUES($1,'standin',100000,now()+interval '30 days')`, [grantId]);
  }
  await pool.query('UPDATE generation_budget_grant SET reserved_cents=reserved_cents+$2 WHERE id=$1', [grantId, budgetCents]);

  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at)
     VALUES($1,$2,$3,$4,'video',$5,now()+interval '1 hour')`,
    [jobId, briefId, engineId, grantId, budgetCents],
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
  const enginePath = `/tmp/inventory-mint-fixtures/${attemptId}.mp4`;
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
    [mediaSha256, JSON.stringify({ durationSeconds: 6.5, width: 1080, height: 1920 }), storageKey],
  );

  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: 1, used: 1 } };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthesis',true,$9)`,
    [generatedReelId, attemptId, briefId, engineId, runId, mediaSha256, enginePath, providerMode, JSON.stringify(lineage)],
  );

  return { generatedReelId, mediaSha256, sourceTitle, sourceUrl };
}

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];
async function moveToTestEligible(pool: pg.Pool, reelId: string): Promise<void> {
  for (const gate of REQUIRED_GATES) {
    const verdict = gate === 'witness_alignment' ? 'unavailable' : 'pass';
    await pool.query(
      `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,$4,$5)`,
      [randomUUID(), reelId, gate, verdict, JSON.stringify(verdict === 'unavailable' ? { reason: 'test' } : {})],
    );
  }
  await pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reelId]);
}

test('mintReelAsset', async (t) => {
  await withDisposableDatabase(async (pool) => {
    await t.test('refuses an ungated Reel with a typed error', async () => {
      const reel = await seedGeneratedReel(pool);
      await assert.rejects(mintReelAsset(pool, reel.generatedReelId), (error: unknown) => error instanceof MintError && error.code === 'not_gated');
    });

    await t.test('refuses an unknown generated Reel id', async () => {
      await assert.rejects(mintReelAsset(pool, randomUUID()), (error: unknown) => error instanceof MintError && error.code === 'unknown_reel');
    });

    await t.test('refuses a brief with no title/summary to mint from', async () => {
      const reel = await seedGeneratedReel(pool, { withDisplayText: false });
      await moveToTestEligible(pool, reel.generatedReelId);
      await assert.rejects(mintReelAsset(pool, reel.generatedReelId), (error: unknown) => error instanceof MintError && error.code === 'brief_missing_display_text');
    });

    await t.test('mints an asset carrying media/truth-state/simulated from provenance and title/summary from the brief', async () => {
      const scrollCountBefore = Number((await pool.query(`SELECT count(*) AS n FROM asset WHERE kind='Scroll'`)).rows[0].n);
      const reel = await seedGeneratedReel(pool, { tag: 'display', sourceTitle: 'The lineage source', sourceUrl: 'https://example.test/lineage' });
      await moveToTestEligible(pool, reel.generatedReelId);
      const outcome = await mintReelAsset(pool, reel.generatedReelId);
      assert.equal(outcome.created, true);
      const row = (await pool.query(
        `SELECT kind, title, summary, truth_state, simulated, media_sha256, source_title, source_url, editorial_order, generated_reel_id
         FROM asset WHERE id=$1`, [outcome.assetId],
      )).rows[0];
      assert.equal(row.kind, 'Reel');
      assert.equal(row.title, 'Reel title display');
      assert.equal(row.summary, 'Reel summary display.');
      assert.equal(row.truth_state, 'synthesis');
      assert.equal(row.simulated, true);
      assert.equal(row.media_sha256, reel.mediaSha256);
      assert.equal(row.source_title, 'The lineage source');
      assert.equal(row.source_url, 'https://example.test/lineage');
      assert.equal(row.editorial_order, null);
      assert.equal(row.generated_reel_id, reel.generatedReelId);
      // Minting a Reel never touches the Scroll library.
      const scrollCountAfter = Number((await pool.query(`SELECT count(*) AS n FROM asset WHERE kind='Scroll'`)).rows[0].n);
      assert.equal(scrollCountAfter, scrollCountBefore + 1, 'only the one library Scroll this fixture itself seeded was added');
    });

    await t.test('a live-provider Reel can never even reach test_eligible here, so mint has nothing to mint from', async () => {
      // Documents the structural fence this lane relies on rather than works around: `standin` is
      // the only provider mode `test_eligible` accepts (migration 0014), and `eligible` is blocked
      // for everyone by the unavailable witness gate — so `simulated:false` is unreachable in any
      // disposable test database, exactly as ADR-0024/0025 intend.
      const reel = await seedGeneratedReel(pool, { providerMode: 'live', tag: 'live-mint' });
      for (const gate of REQUIRED_GATES) {
        if (gate === 'witness_alignment') continue;
        await pool.query(
          `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,'pass','{}'::jsonb)`,
          [randomUUID(), reel.generatedReelId, gate],
        );
      }
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]),
        /stand-in provenance/,
      );
      await assert.rejects(mintReelAsset(pool, reel.generatedReelId), (error: unknown) => error instanceof MintError && error.code === 'not_gated');
    });

    await t.test('mint is idempotent: a second call returns the same asset and inserts nothing new', async () => {
      const reel = await seedGeneratedReel(pool, { tag: 'idempotent' });
      await moveToTestEligible(pool, reel.generatedReelId);
      const first = await mintReelAsset(pool, reel.generatedReelId);
      const second = await mintReelAsset(pool, reel.generatedReelId);
      assert.equal(second.created, false);
      assert.equal(second.assetId, first.assetId);
      const count = Number((await pool.query('SELECT count(*) AS n FROM asset WHERE generated_reel_id=$1', [reel.generatedReelId])).rows[0].n);
      assert.equal(count, 1);
    });
  });
});

test('withdrawGeneratedReel', async (t) => {
  await withDisposableDatabase(async (pool) => {
    await t.test('withdraws both the generated Reel and its minted asset, once', async () => {
      const reel = await seedGeneratedReel(pool, { tag: 'withdraw' });
      await moveToTestEligible(pool, reel.generatedReelId);
      const minted = await mintReelAsset(pool, reel.generatedReelId);
      const first = await withdrawGeneratedReel(pool, reel.generatedReelId);
      assert.equal(first.withdrawn, true);
      const availability = (await pool.query('SELECT availability FROM generated_reel WHERE id=$1', [reel.generatedReelId])).rows[0].availability;
      assert.equal(availability, 'withdrawn');
      const withdrawnAt = (await pool.query('SELECT withdrawn_at FROM asset WHERE id=$1', [minted.assetId])).rows[0].withdrawn_at;
      assert.ok(withdrawnAt);
      const second = await withdrawGeneratedReel(pool, reel.generatedReelId);
      assert.equal(second.withdrawn, false, 'a Reel that is already withdrawn is left alone, not re-stamped');
      const stillSame = (await pool.query('SELECT withdrawn_at FROM asset WHERE id=$1', [minted.assetId])).rows[0].withdrawn_at;
      assert.deepEqual(stillSame, withdrawnAt);
    });

    await t.test('withdrawing a Reel that was never minted just moves availability, without error', async () => {
      const reel = await seedGeneratedReel(pool, { tag: 'withdraw-unminted' });
      await moveToTestEligible(pool, reel.generatedReelId);
      const result = await withdrawGeneratedReel(pool, reel.generatedReelId);
      assert.equal(result.withdrawn, true);
      const availability = (await pool.query('SELECT availability FROM generated_reel WHERE id=$1', [reel.generatedReelId])).rows[0].availability;
      assert.equal(availability, 'withdrawn');
    });

    await t.test('withdrawing an imported (never gated) Reel is a no-op', async () => {
      const reel = await seedGeneratedReel(pool, { tag: 'withdraw-imported' });
      const result = await withdrawGeneratedReel(pool, reel.generatedReelId);
      assert.equal(result.withdrawn, false);
      const availability = (await pool.query('SELECT availability FROM generated_reel WHERE id=$1', [reel.generatedReelId])).rows[0].availability;
      assert.equal(availability, 'imported');
    });
  });
});
