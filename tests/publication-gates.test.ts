/**
 * ADR-0024 section 2 — each publication gate's pass/fail/label outcomes, evaluated by
 * `evaluatePublicationGates` against real rows in a real disposable PostgreSQL database. This file
 * always makes and drops its OWN `knowscroll_test_*` database, so it is safe standalone or under
 * scripts/test.sh. ffmpeg/ffprobe are required on PATH (same as tests/generation-import.test.ts).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { runMigrations } from '../packages/db/src/migrations.ts';
import { generationBrief, type GenerationBrief } from '../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';
import { insertFakeEngine } from './helpers/generation-fixture.ts';
import { computeStorageKey } from '../apps/worker/src/generation/media-store.ts';
import { evaluatePublicationGates } from '../apps/worker/src/publication/evaluate.ts';

const execFileAsync = promisify(execFile);

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
// Real-file fixtures (ffmpeg), same technique as tests/generation-import.test.ts.
// -------------------------------------------------------------------------------------------

async function makeValidMp4(path: string, durationSeconds = 6): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=size=108x192:duration=${durationSeconds}:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', path,
  ]);
}

// -------------------------------------------------------------------------------------------
// Brief building.
// -------------------------------------------------------------------------------------------

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

interface BriefSpec {
  assetId: string;
  assetRevision?: number;
  worldId?: string;
  narration?: { text: string; claimIds: string[] }[];
  extraMustNotShow?: boolean;
  styleVersion?: number;
}
function makeBrief(spec: BriefSpec): GenerationBrief {
  const assetRevision = spec.assetRevision ?? 1;
  const narration = spec.narration ?? [
    { text: 'Sentence one.', claimIds: ['c1'] },
    { text: 'Sentence two.', claimIds: ['c1'] },
    { text: 'Sentence three.', claimIds: ['c2'] },
    { text: 'Sentence four.', claimIds: ['c2'] },
  ];
  const mustNotShow = spec.extraMustNotShow ? [{ id: 'never-1', text: 'Nothing modern.', type: 'presence' as const }] : [];
  return generationBrief.parse({
    version: 1,
    worldId: spec.worldId ?? 'gate-tests-world',
    narration,
    claims: [{ id: 'c1', role: 'main' }, { id: 'c2', role: 'supporting' }],
    claimSources: [{ claimId: 'c1', assetId: spec.assetId, assetRevision }, { claimId: 'c2', assetId: spec.assetId, assetRevision }],
    criteria: { mustShow: [{ id: 'show-1', text: 'Something visible.', type: 'presence' as const, claimId: 'c1' }], mustNotShow, depictionPolicyVersion: 'depiction-v1' },
    style: { id: 'library', version: spec.styleVersion ?? 1, text: 'Quiet, documentary, no captions burned in.' },
  });
}

// -------------------------------------------------------------------------------------------
// Fixture: a fully legitimate finished-video generated_reel row (availability 'imported'),
// going through every one of migration 0013's own admission/lineage guards.
// -------------------------------------------------------------------------------------------

interface DefaultLineageParts {
  briefSha256: string;
  contractRevision: string;
  runId: string;
  recordSummary: unknown;
}
interface FixtureOptions {
  brief: GenerationBrief;
  /** Cutroom's own record, as `cutroom_attempt.record_summary` would actually hold it. `null`
   * leaves the column NULL (the record fetch never succeeded). Defaults to one clean, used,
   * no-degradation take. */
  attemptRecordSummary?: unknown | null;
  /** Overrides the `generated_reel.lineage` object actually written at insert time (this column is
   * immutable afterward — see tests/publication-guards.test.ts), so a mismatch must be built in. */
  lineageOverride?: (defaults: DefaultLineageParts) => Record<string, unknown>;
  /** A real file already written under `mediaRoot` at the correct content-addressed key. Omitted
   * means a fabricated sha/storageKey with no file on disk (media_conformance fails closed). */
  media?: { sha256: string; byteSize: number; storageKey: string };
}
interface SeededFixture {
  generatedReelId: string;
  briefId: string;
  briefSha256: string;
  attemptId: string;
  runId: string;
  mediaSha256: string;
  assetId: string;
}

async function seedFixture(pool: pg.Pool, options: FixtureOptions): Promise<SeededFixture> {
  const briefJson = options.brief;
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const source = briefJson.claimSources[0]!;
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,$3,'synthesis',$4,$5,'test','approved')`,
    [briefId, source.assetId, source.assetRevision, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  await insertFakeEngine(pool, { id: engineId, artifactRoot: '/tmp/publication-gate-fixtures', providerMode: 'standin' });

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
  const enginePath = `/tmp/publication-gate-fixtures/${attemptId}.mp4`;
  await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed', dispatch_committed_at=now() WHERE id=$1`, [attemptId]);
  await pool.query(`UPDATE cutroom_attempt SET state='accepted', run_id=$2, accepted_at=now() WHERE id=$1`, [attemptId, runId]);

  const defaultRecord = { contractVersion: 1, runId, pictures: [], takes: [{ takeId: 't1', shotId: 's1', number: 1, used: true, checks: [] }], degradations: [] };
  const attemptRecordSummary = options.attemptRecordSummary === undefined ? defaultRecord : options.attemptRecordSummary;
  await pool.query(
    `UPDATE cutroom_attempt SET state='finished', finished_at=now(), reported_cost_cents=0, settlement='settled',
       result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text)),
       record_summary=$3
     WHERE id=$1`,
    [attemptId, enginePath, attemptRecordSummary === null ? null : JSON.stringify(attemptRecordSummary)],
  );

  const media = options.media ?? (() => {
    const sha256 = createHash('sha256').update(`${attemptId}-dummy`).digest('hex');
    return { sha256, byteSize: 4096, storageKey: computeStorageKey(sha256) };
  })();
  await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,$2,'video/mp4','{}',$3)`,
    [media.sha256, media.byteSize, media.storageKey],
  );

  const defaults: DefaultLineageParts = { briefSha256, contractRevision: REVISION, runId, recordSummary: defaultRecord };
  const lineage = options.lineageOverride ? options.lineageOverride(defaults) : defaults;

  const generatedReelId = randomUUID();
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,'standin','synthesis',true,$8)`,
    [generatedReelId, attemptId, briefId, engineId, runId, media.sha256, enginePath, JSON.stringify(lineage)],
  );

  return { generatedReelId, briefId, briefSha256, attemptId, runId, mediaSha256: media.sha256, assetId: source.assetId };
}

function gateVerdict(outcome: Awaited<ReturnType<typeof evaluatePublicationGates>>, gate: string): { verdict: string; evidence: Record<string, unknown> } {
  const row = outcome.gates.find((entry) => entry.gate === gate);
  assert.ok(row, `expected a "${gate}" gate result`);
  return { verdict: row.verdict, evidence: row.evidence as Record<string, unknown> };
}

// -------------------------------------------------------------------------------------------

test('ADR-0024 publication gates, evaluated against real rows', async (t) => {
  await withDisposableDatabase(async (pool) => {
    const scratch = await mkdtemp(join(tmpdir(), 'ks-publication-gates-'));
    const mediaRoot = join(scratch, 'media');
    await mkdir(mediaRoot, { recursive: true });
    try {
      await t.test('a fully consistent Reel passes every computable gate; only witness_alignment blocks eligibility', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId });
        const validPath = join(scratch, `${randomUUID()}.mp4`);
        await makeValidMp4(validPath);
        const bytes = await readFile(validPath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const storageKey = computeStorageKey(sha256);
        await mkdir(join(mediaRoot, storageKey.split('/').slice(0, -1).join('/')), { recursive: true });
        await writeFile(join(mediaRoot, storageKey), bytes);

        const fixture = await seedFixture(pool, { brief, media: { sha256, byteSize: bytes.length, storageKey } });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });

        assert.equal(gateVerdict(outcome, 'lineage_complete').verdict, 'pass');
        assert.equal(gateVerdict(outcome, 'source_support').verdict, 'pass');
        assert.equal(gateVerdict(outcome, 'engine_record').verdict, 'pass');
        assert.equal(gateVerdict(outcome, 'media_conformance').verdict, 'pass');
        assert.equal(gateVerdict(outcome, 'truth_label').verdict, 'pass');
        assert.equal(gateVerdict(outcome, 'repetition').verdict, 'pass');
        const witness = gateVerdict(outcome, 'witness_alignment');
        assert.equal(witness.verdict, 'unavailable');
        assert.equal(typeof witness.evidence.reason, 'string');
        assert.deepEqual(outcome.availability, { decided: false, current: 'imported' });

        const testEligible = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot, decide: 'test_eligible' });
        assert.deepEqual(testEligible.availability, { decided: true, availability: 'test_eligible' });
        assert.ok(testEligible.gates.every((row) => row.newlyRecorded === false), 'gate verdicts are idempotent across the two calls');

        // A third call is a pure idempotent no-op: no duplicate gate rows, availability already decided.
        const again = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        assert.deepEqual(again.availability, { decided: false, current: 'test_eligible' });
        const count = (await pool.query('SELECT count(*)::int AS n FROM publication_gate_result WHERE generated_reel_id=$1', [fixture.generatedReelId])).rows[0]!.n;
        assert.equal(count, 7);
      });

      await t.test('lineage_complete fails on a brief-digest mismatch', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'lineage-sha-mismatch' });
        const fixture = await seedFixture(pool, { brief, lineageOverride: (d) => ({ ...d, briefSha256: 'f'.repeat(64) }) });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'lineage_complete');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.briefShaMatches, false);
      });

      await t.test('lineage_complete fails on a contract-revision mismatch', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'lineage-contract-mismatch' });
        const fixture = await seedFixture(pool, { brief, lineageOverride: (d) => ({ ...d, contractRevision: '0'.repeat(40) }) });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'lineage_complete');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.contractRevisionMatches, false);
      });

      await t.test('lineage_complete fails on a run-id mismatch', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'lineage-run-mismatch' });
        const fixture = await seedFixture(pool, { brief, lineageOverride: (d) => ({ ...d, runId: 'run-not-this-one' }) });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'lineage_complete');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.runIdMatches, false);
      });

      await t.test('lineage_complete fails when the record summary is missing from lineage', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'lineage-no-record' });
        const fixture = await seedFixture(pool, {
          brief,
          lineageOverride: (d) => ({ briefSha256: d.briefSha256, contractRevision: d.contractRevision, runId: d.runId }),
        });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'lineage_complete');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.recordSummaryPresent, false);
      });

      await t.test('source_support fails when a narration sentence carries no claim', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({
          assetId, worldId: 'source-support-unsourced-sentence',
          narration: [
            { text: 'Sentence one.', claimIds: ['c1'] },
            { text: 'Sentence two, unsupported.', claimIds: [] },
            { text: 'Sentence three.', claimIds: ['c2'] },
            { text: 'Sentence four.', claimIds: ['c2'] },
          ],
        });
        const fixture = await seedFixture(pool, { brief });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'source_support');
        assert.equal(result.verdict, 'fail');
        assert.deepEqual(result.evidence.sentencesWithoutClaim, [1]);
      });

      await t.test('source_support fails closed when the source asset revision has changed since the brief was authored', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'source-support-changed-revision' });
        const fixture = await seedFixture(pool, { brief });
        await pool.query('UPDATE asset SET revision=2 WHERE id=$1', [assetId]);
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'source_support');
        assert.equal(result.verdict, 'fail');
        const checks = result.evidence.sourceChecks as Array<{ unchanged: boolean; currentRevision: number }>;
        assert.equal(checks[0]!.unchanged, false);
        assert.equal(checks[0]!.currentRevision, 2);
      });

      await t.test('engine_record fails when a used take carries a fail check', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'engine-record-failing-take' });
        const fixture = await seedFixture(pool, {
          brief,
          attemptRecordSummary: { contractVersion: 1, runId: 'ignored', pictures: [], degradations: [], takes: [
            { takeId: 't1', shotId: 's1', number: 1, used: true, checks: [{ gate: 'safety', outcome: 'fail' }] },
            { takeId: 't0', shotId: 's1', number: 0, used: false, checks: [{ gate: 'safety', outcome: 'fail' }] },
          ] },
        });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'engine_record');
        assert.equal(result.verdict, 'fail');
        assert.equal((result.evidence.failingUsedTakes as unknown[]).length, 1);
      });

      await t.test('engine_record is pass_with_label when there is a degradation but no failing used take', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'engine-record-degraded' });
        const fixture = await seedFixture(pool, {
          brief,
          attemptRecordSummary: { contractVersion: 1, runId: 'ignored', pictures: [],
            takes: [{ takeId: 't1', shotId: 's1', number: 1, used: true, checks: [{ gate: 'safety', outcome: 'accept' }] }],
            degradations: [{ shotId: 's1', reason: 'fell back to a simpler shot' }] },
        });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'engine_record');
        assert.equal(result.verdict, 'pass_with_label');
        assert.equal(result.evidence.degradationCount, 1);
      });

      await t.test('engine_record fails closed when the record was never fetched', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'engine-record-missing' });
        const fixture = await seedFixture(pool, { brief, attemptRecordSummary: null, lineageOverride: (d) => ({ ...d, recordSummary: undefined }) });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'engine_record');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.recordSummaryPresent, false);
      });

      await t.test('media_conformance fails when the file is missing on disk', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'media-missing' });
        const fixture = await seedFixture(pool, { brief }); // default media: fabricated sha, no file written
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'media_conformance');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.fileExists, false);
      });

      await t.test('media_conformance fails when the file on disk does not hash to the recorded sha256', async () => {
        const assetId = await seedAsset(pool);
        const brief = makeBrief({ assetId, worldId: 'media-corrupted' });
        const validPath = join(scratch, `${randomUUID()}.mp4`);
        await makeValidMp4(validPath);
        const bytes = await readFile(validPath);
        const claimedSha256 = 'c'.repeat(64); // deliberately NOT the real hash of `bytes`
        const storageKey = computeStorageKey(claimedSha256);
        await mkdir(join(mediaRoot, storageKey.split('/').slice(0, -1).join('/')), { recursive: true });
        await writeFile(join(mediaRoot, storageKey), bytes);
        const fixture = await seedFixture(pool, { brief, media: { sha256: claimedSha256, byteSize: bytes.length, storageKey } });
        const outcome = await evaluatePublicationGates(pool, { generatedReelId: fixture.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
        const result = gateVerdict(outcome, 'media_conformance');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.evidence.hashMatches, false);
      });

      await t.test('repetition: an empty corpus passes, a matching argument in a different template fails, a matching template with a different argument fails, and a genuinely different Reel passes', async () => {
        // A fresh, separate disposable database: every earlier subtest above shares `pool`, and
        // several of them use the same default brief shape as reel A below, which would otherwise
        // make its corpus non-empty by construction rather than by anything this test controls.
        await withDisposableDatabase(async (repetitionPool) => {
          const assetA = await seedAsset(repetitionPool);
          const assetC = await seedAsset(repetitionPool);
          const assetD = await seedAsset(repetitionPool);

          const briefA = makeBrief({ assetId: assetA, worldId: 'repetition-shared-argument' });
          const reelA = await seedFixture(repetitionPool, { brief: briefA });
          const outcomeA = await evaluatePublicationGates(repetitionPool, { generatedReelId: reelA.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
          assert.equal(gateVerdict(outcomeA, 'repetition').verdict, 'pass', 'first Reel: corpus is empty');

          // Same worldId/asset/narration as A (same argument), different template shape.
          const briefB = makeBrief({ assetId: assetA, worldId: 'repetition-shared-argument', extraMustNotShow: true });
          const reelB = await seedFixture(repetitionPool, { brief: briefB });
          const outcomeB = await evaluatePublicationGates(repetitionPool, { generatedReelId: reelB.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
          const resultB = gateVerdict(outcomeB, 'repetition');
          assert.equal(resultB.verdict, 'fail');
          assert.equal((resultB.evidence.argumentMatches as string[]).includes(reelA.generatedReelId), true);
          assert.equal((resultB.evidence.templateMatches as string[]).length, 0);

          // Different topic/asset/narration than A or B, but the SAME template shape as A.
          const briefC = makeBrief({ assetId: assetC, worldId: 'repetition-different-topic-c' });
          const reelC = await seedFixture(repetitionPool, { brief: briefC });
          const outcomeC = await evaluatePublicationGates(repetitionPool, { generatedReelId: reelC.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
          const resultC = gateVerdict(outcomeC, 'repetition');
          assert.equal(resultC.verdict, 'fail');
          assert.equal((resultC.evidence.templateMatches as string[]).includes(reelA.generatedReelId), true);
          assert.equal((resultC.evidence.argumentMatches as string[]).length, 0);

          // Different topic AND different template from every prior Reel: genuinely new.
          const briefD = makeBrief({ assetId: assetD, worldId: 'repetition-different-topic-d', extraMustNotShow: true, styleVersion: 2 });
          const reelD = await seedFixture(repetitionPool, { brief: briefD });
          const outcomeD = await evaluatePublicationGates(repetitionPool, { generatedReelId: reelD.generatedReelId, policyVersion: 'publication-v1', mediaRoot });
          const resultD = gateVerdict(outcomeD, 'repetition');
          assert.equal(resultD.verdict, 'pass');
          assert.equal((resultD.evidence.templateMatches as string[]).length, 0);
          assert.equal((resultD.evidence.argumentMatches as string[]).length, 0);
        });
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
