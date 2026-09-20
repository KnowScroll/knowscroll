/**
 * ADR-0024 / migration 0014 — SQL guard tests. Exercises the database's own authority directly
 * (raw SQL against freshly-seeded rows), independent of gates.ts/evaluate.ts: eligibility can never
 * be hand-set, a decided gate set is required before any availability decision, the stand-in fence
 * (test_eligible) is refused outside a disposable database and for a non-standin provider mode,
 * fingerprints are written once, gate results and policies are immutable, and a withdrawn/rejected
 * Reel never returns. This file always makes and drops its OWN disposable knowscroll_test_*
 * database (never the lane's configured one), so it is safe standalone or under scripts/test.sh.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { runMigrations } from '../packages/db/src/migrations.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';

// -------------------------------------------------------------------------------------------
// Disposable-database plumbing (same shape as tests/generation-import.test.ts).
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
// Fixture building: a brief, a finished attempt, a media_object and a generated_reel row, direct
// SQL throughout (mirroring tests/generation-contract.test.ts's own style).
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

async function seedAsset(pool: pg.Pool): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Title','Summary','Body text.','Example source','https://example.test/x','documented',
       (SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId],
  );
  return assetId;
}

interface SeedOptions {
  providerMode?: 'standin' | 'live';
  tag?: string;
}
interface SeededReel {
  generatedReelId: string;
  attemptId: string;
  mediaSha256: string;
}

/** Builds a fully legitimate finished-video `generated_reel` row (availability still 'imported')
 * under the given provider mode, going through every one of migration 0013's own admission and
 * lineage guards rather than bypassing them. */
async function seedGeneratedReel(pool: pg.Pool, options: SeedOptions = {}): Promise<SeededReel> {
  const providerMode = options.providerMode ?? 'standin';
  const tag = options.tag ?? randomUUID().slice(0, 8);

  const assetId = await seedAsset(pool);
  const briefJson = generationBrief.parse(brief(assetId, tag));
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
     VALUES($1,$2,$3,'/tmp/publication-guard-fixtures',$4,'test')`,
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
  const enginePath = `/tmp/publication-guard-fixtures/${attemptId}.mp4`;
  // The attempt's own guard only allows prepared -> dispatch_committed -> accepted -> finished;
  // walk it exactly (mirrors tests/generation-import.test.ts's finishAttempt helper).
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

  return { generatedReelId, attemptId, mediaSha256 };
}

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];

async function recordGate(pool: pg.Pool, reelId: string, gate: string, verdict: string, evidence: Record<string, unknown> = {}): Promise<void> {
  const body = verdict === 'unavailable' ? { reason: 'test fixture', ...evidence } : evidence;
  await pool.query(
    `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,$4,$5)`,
    [randomUUID(), reelId, gate, verdict, JSON.stringify(body)],
  );
}
async function recordAllGatesPassingExceptWitness(pool: pg.Pool, reelId: string): Promise<void> {
  for (const gate of REQUIRED_GATES) {
    if (gate === 'witness_alignment') await recordGate(pool, reelId, gate, 'unavailable');
    else await recordGate(pool, reelId, gate, 'pass');
  }
}

// -------------------------------------------------------------------------------------------

test('migration 0014 publication guards', async (t) => {
  await withDisposableDatabase(async (pool) => {
    await t.test('the disposable-test-database pattern matches this database and not the owner one', async () => {
      const current = (await pool.query<{ ok: boolean }>('SELECT knowscroll_disposable_test_database() AS ok')).rows[0];
      assert.equal(current?.ok, true);
      const pattern = (await pool.query<{ in_pattern: boolean; owner_in_pattern: boolean }>(
        `SELECT 'knowscroll_test_abc123' LIKE 'knowscroll\\_test\\_%' AS in_pattern,
                'knowscroll' LIKE 'knowscroll\\_test\\_%' AS owner_in_pattern`,
      )).rows[0]!;
      assert.equal(pattern.in_pattern, true);
      assert.equal(pattern.owner_in_pattern, false);
    });

    await t.test('eligible is refused while witness_alignment is unavailable, even with every other gate passing', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await recordAllGatesPassingExceptWitness(pool, reel.generatedReelId);
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]),
        /eligible only when every required gate passed/,
      );
    });

    await t.test('test_eligible tolerates a blocked witness gate, inside this disposable database, for a standin Reel', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await recordAllGatesPassingExceptWitness(pool, reel.generatedReelId);
      await pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]);
      const row = (await pool.query('SELECT availability FROM generated_reel WHERE id=$1', [reel.generatedReelId])).rows[0];
      assert.equal(row?.availability, 'test_eligible');
    });

    await t.test('test_eligible is refused for a live provider mode, before any gate is even checked', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'live' });
      // Deliberately no gate results at all: the provider-mode check fires first.
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]),
        /stand-in provenance/,
      );
    });

    await t.test('an availability decision is refused without a recorded verdict for every required gate', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await recordGate(pool, reel.generatedReelId, 'lineage_complete', 'pass');
      await recordGate(pool, reel.generatedReelId, 'source_support', 'pass');
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]),
        /recorded verdict/,
      );
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]),
        /recorded verdict/,
      );
    });

    await t.test('an availability decision must name a known publication policy', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='test_eligible', availability_policy_version='no-such-policy', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]),
        /violates foreign key|known publication policy/,
      );
    });

    await t.test('repetition fingerprints are written once', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await pool.query(`UPDATE generated_reel SET template_fingerprint=$2, argument_fingerprint=$3 WHERE id=$1`, [reel.generatedReelId, 'a'.repeat(64), 'b'.repeat(64)]);
      // Re-setting the identical value is not a change, so it must succeed (idempotent evaluation).
      await pool.query(`UPDATE generated_reel SET template_fingerprint=$2 WHERE id=$1`, [reel.generatedReelId, 'a'.repeat(64)]);
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET template_fingerprint=$2 WHERE id=$1`, [reel.generatedReelId, 'c'.repeat(64)]),
        /written once/,
      );
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET argument_fingerprint=$2 WHERE id=$1`, [reel.generatedReelId, 'd'.repeat(64)]),
        /written once/,
      );
    });

    await t.test('gate results and policies are immutable', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await recordGate(pool, reel.generatedReelId, 'truth_label', 'pass', { truthState: 'synthesis' });
      await assert.rejects(
        pool.query(`UPDATE publication_gate_result SET verdict='fail' WHERE generated_reel_id=$1 AND gate='truth_label'`, [reel.generatedReelId]),
        /immutable/,
      );
      await assert.rejects(
        pool.query(`DELETE FROM publication_gate_result WHERE generated_reel_id=$1 AND gate='truth_label'`, [reel.generatedReelId]),
        /immutable/,
      );
      await assert.rejects(pool.query(`UPDATE publication_policy SET required_gates=ARRAY['truth_label'] WHERE version='publication-v1'`), /immutable/);
      await assert.rejects(pool.query(`DELETE FROM publication_policy WHERE version='publication-v1'`), /immutable/);
      const stillThere = (await pool.query(`SELECT required_gates FROM publication_policy WHERE version='publication-v1'`)).rows[0];
      assert.equal(stillThere?.required_gates.length, REQUIRED_GATES.length);
    });

    await t.test('a withdrawn Reel never becomes available again', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await pool.query(`UPDATE generated_reel SET availability='withdrawn', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]);
      await recordAllGatesPassingExceptWitness(pool, reel.generatedReelId);
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='eligible' WHERE id=$1`, [reel.generatedReelId]),
        /does not become available again/,
      );
      await assert.rejects(
        pool.query(`UPDATE generated_reel SET availability='test_eligible' WHERE id=$1`, [reel.generatedReelId]),
        /does not become available again/,
      );
    });

    await t.test('a rejected Reel never becomes available again', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      await pool.query(`UPDATE generated_reel SET availability='rejected', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`, [reel.generatedReelId]);
      await assert.rejects(pool.query(`UPDATE generated_reel SET availability='imported' WHERE id=$1`, [reel.generatedReelId]), /does not become available again/);
    });

    await t.test('identity, lineage and provenance stay immutable, and a generated Reel is never deleted', async () => {
      const reel = await seedGeneratedReel(pool, { providerMode: 'standin' });
      const otherSha = 'f'.repeat(64);
      await pool.query(
        `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,10,'video/mp4','{}',$2)`,
        [otherSha, `sha256/${otherSha.slice(0, 2)}/${otherSha.slice(2, 4)}/${otherSha}.mp4`],
      );
      await assert.rejects(pool.query(`UPDATE generated_reel SET media_sha256=$2 WHERE id=$1`, [reel.generatedReelId, otherSha]), /immutable/);
      await assert.rejects(pool.query(`UPDATE generated_reel SET provider_mode='live' WHERE id=$1`, [reel.generatedReelId]), /immutable/);
      await assert.rejects(pool.query(`DELETE FROM generated_reel WHERE id=$1`, [reel.generatedReelId]), /immutable/);
    });
  });
});
