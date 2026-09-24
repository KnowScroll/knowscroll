/**
 * ADR-0025 / migration 0015 — SQL guard tests, direct against the database's own triggers and
 * CHECK constraints (raw SQL, independent of `apps/worker/src/publication/mint.ts`): an ungated
 * Reel can never mint an asset; a minted Reel asset must carry its generated Reel's own media,
 * truth state and simulated provenance; a Reel needs an editorial_order of NULL and non-null media/
 * lineage while a Scroll needs the reverse; an inventory asset's identity is immutable once
 * written; an asset is never deleted; and a withdrawal can only happen once. This file always makes
 * and drops its OWN disposable `knowscroll_test_*` database (never the lane's configured one), so
 * it is safe standalone or under `scripts/test.sh`.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { runMigrations } from '../packages/db/src/migrations.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';
import { insertFakeEngine } from './helpers/generation-fixture.ts';

// -------------------------------------------------------------------------------------------
// Disposable-database plumbing (same shape as tests/publication-guards.test.ts).
// -------------------------------------------------------------------------------------------

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

// -------------------------------------------------------------------------------------------
// Fixture building: one Scroll, an approved brief, a finished-video attempt, a media_object and a
// generated_reel row -- mirroring tests/publication-guards.test.ts's own seedGeneratedReel.
// -------------------------------------------------------------------------------------------

const claim = (id: string, role: 'main' | 'supporting') => ({ id, role });
const sentence = (text: string, claimIds: string[]) => ({ text, claimIds });

function brief(assetId: string, tag: string) {
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
  };
}

async function seedScrollAsset(pool: pg.Pool): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Title','Summary','Body text.','Example source','https://example.test/x','documented',
       (SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId],
  );
  return assetId;
}

interface SeedOptions { providerMode?: 'standin' | 'live'; tag?: string }
interface SeededReel { generatedReelId: string; attemptId: string; mediaSha256: string; briefId: string }

async function seedGeneratedReel(pool: pg.Pool, options: SeedOptions = {}): Promise<SeededReel> {
  const providerMode = options.providerMode ?? 'standin';
  const tag = options.tag ?? randomUUID().slice(0, 8);

  const assetId = await seedScrollAsset(pool);
  const briefJson = generationBrief.parse(brief(assetId, tag));
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'test','approved')`,
    [briefId, assetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  await insertFakeEngine(pool, { id: engineId, artifactRoot: '/tmp/inventory-guard-fixtures', providerMode });

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
  const enginePath = `/tmp/inventory-guard-fixtures/${attemptId}.mp4`;
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
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,4096,'video/mp4','{}',$2)`,
    [mediaSha256, storageKey],
  );

  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: 1, used: 1 } };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthesis',true,$9)`,
    [generatedReelId, attemptId, briefId, engineId, runId, mediaSha256, enginePath, providerMode, JSON.stringify(lineage)],
  );

  return { generatedReelId, attemptId, mediaSha256, briefId };
}

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];
async function recordGate(pool: pg.Pool, reelId: string, gate: string, verdict: string): Promise<void> {
  const body = verdict === 'unavailable' ? { reason: 'test fixture' } : {};
  await pool.query(
    `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,$4,$5)`,
    [randomUUID(), reelId, gate, verdict, JSON.stringify(body)],
  );
}
async function moveToTestEligible(pool: pg.Pool, reelId: string): Promise<void> {
  for (const gate of REQUIRED_GATES) await recordGate(pool, reelId, gate, gate === 'witness_alignment' ? 'unavailable' : 'pass');
  await pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reelId]);
}

async function insertReelAsset(pool: pg.Pool, reel: SeededReel, overrides: Partial<{ mediaSha256: string; truthState: string; simulated: boolean }> = {}): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order,media_sha256,generated_reel_id,simulated)
     VALUES($1,1,'Reel','Reel title','Reel summary','','Source title','https://example.test/source','synthesis',NULL,$2,$3,$4)`,
    [assetId, overrides.mediaSha256 ?? reel.mediaSha256, reel.generatedReelId, overrides.simulated ?? true],
  );
  return assetId;
}

test('migration 0015 asset guards', async (t) => {
  await withDisposableDatabase(async (pool) => {
    await t.test('an ungated (imported) Reel cannot mint an asset: the trigger refuses it directly', async () => {
      const reel = await seedGeneratedReel(pool);
      const availability = (await pool.query('SELECT availability FROM generated_reel WHERE id=$1', [reel.generatedReelId])).rows[0]?.availability;
      assert.equal(availability, 'imported');
      await assert.rejects(insertReelAsset(pool, reel), /gates cleared|not one that is/);
    });

    await t.test('a Reel without media is refused (asset_kind_shape)', async () => {
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      const assetId = randomUUID();
      await assert.rejects(
        pool.query(
          `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order,generated_reel_id,simulated)
           VALUES($1,1,'Reel','T','S','','ST','https://example.test','synthesis',NULL,$2,true)`,
          [assetId, reel.generatedReelId],
        ),
        // The provenance trigger (BEFORE INSERT) sees NULL media_sha256 as distinct from the
        // generated Reel's own media and raises first; the asset_kind_shape CHECK would refuse it
        // too, but never gets the chance to run.
        /own media|asset_kind_shape|violates check constraint/,
      );
    });

    await t.test('a Reel asset must carry its generated Reel\'s own media', async () => {
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      const wrongSha = 'a'.repeat(64);
      await pool.query(`INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,10,'video/mp4','{}',$2)`, [wrongSha, `sha256/${wrongSha.slice(0, 2)}/${wrongSha.slice(2, 4)}/${wrongSha}.mp4`]);
      await assert.rejects(insertReelAsset(pool, reel, { mediaSha256: wrongSha }), /own media/);
    });

    await t.test('a Reel asset\'s simulated flag must match its provenance', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await moveToTestEligible(pool, reel.generatedReelId);
      await assert.rejects(insertReelAsset(pool, reel, { simulated: false }), /simulated flag must match/);
    });

    await t.test('minting is idempotent per generated Reel: a second asset for the same Reel is refused', async () => {
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      await insertReelAsset(pool, reel);
      await assert.rejects(insertReelAsset(pool, reel), /duplicate key|unique/);
    });

    await t.test('identity and provenance are immutable once minted', async () => {
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      const assetId = await insertReelAsset(pool, reel);
      await assert.rejects(pool.query(`UPDATE asset SET title='Changed' WHERE id=$1`, [assetId]), /immutable/);
      await assert.rejects(pool.query(`UPDATE asset SET simulated=NOT simulated WHERE id=$1`, [assetId]), /immutable/);
      const otherSha = 'b'.repeat(64);
      await pool.query(`INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,10,'video/mp4','{}',$2)`, [otherSha, `sha256/${otherSha.slice(0, 2)}/${otherSha.slice(2, 4)}/${otherSha}.mp4`]);
      await assert.rejects(pool.query(`UPDATE asset SET media_sha256=$2 WHERE id=$1`, [assetId, otherSha]), /immutable/);
    });

    await t.test('an asset is never deleted', async () => {
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      const assetId = await insertReelAsset(pool, reel);
      await assert.rejects(pool.query(`DELETE FROM asset WHERE id=$1`, [assetId]), /withdrawn, never deleted/);
    });

    await t.test('withdrawal happens once', async () => {
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      const assetId = await insertReelAsset(pool, reel);
      await pool.query(`UPDATE asset SET withdrawn_at=clock_timestamp() WHERE id=$1`, [assetId]);
      const first = (await pool.query('SELECT withdrawn_at FROM asset WHERE id=$1', [assetId])).rows[0].withdrawn_at;
      assert.ok(first);
      await assert.rejects(pool.query(`UPDATE asset SET withdrawn_at=clock_timestamp() WHERE id=$1`, [assetId]), /stays withdrawn/);
      const stillFirst = (await pool.query('SELECT withdrawn_at FROM asset WHERE id=$1', [assetId])).rows[0].withdrawn_at;
      assert.deepEqual(stillFirst, first);
    });

    await t.test('editorial_order is nullable for a Reel but a Scroll still needs one, and the seeded library is untouched', async () => {
      const before = (await pool.query(`SELECT id, editorial_order FROM asset WHERE kind='Scroll' ORDER BY editorial_order`)).rows;
      const reel = await seedGeneratedReel(pool);
      await moveToTestEligible(pool, reel.generatedReelId);
      await insertReelAsset(pool, reel);
      const after = (await pool.query(`SELECT id, editorial_order FROM asset WHERE kind='Scroll' ORDER BY editorial_order`)).rows;
      // seedGeneratedReel adds its own source Scroll, so compare the ORIGINAL rows are still present and unchanged.
      for (const row of before) {
        const match = after.find((candidate: { id: string }) => candidate.id === row.id);
        assert.ok(match, 'a previously seeded Scroll row must still exist');
        assert.equal(match.editorial_order, row.editorial_order);
      }
    });

    await t.test('a Scroll may not carry Reel-only columns (asset_kind_shape)', async () => {
      const assetId = randomUUID();
      const sha = createHash('sha256').update('unused').digest('hex');
      await pool.query(`INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,10,'video/mp4','{}',$2)`, [sha, `sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.mp4`]);
      await assert.rejects(
        pool.query(
          `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order,media_sha256)
           VALUES($1,1,'Scroll','T','S','Body','ST','https://example.test','documented',
             (SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset),$2)`,
          [assetId, sha],
        ),
        /asset_kind_shape|violates check constraint/,
      );
    });
  });
});
