/** ADR-0023 section 4: the verified media import module (#94 "import" lane). Exercises
 * `importFinishedVideo` against real files (ffmpeg-made fixtures) and `recordImportedReel`
 * against a real disposable PostgreSQL database that this file creates and drops itself. This is
 * a unit/integration proof of the import module in isolation; it never dispatches to Cutroom, runs
 * a job loop, or proves the joined product journey (a later stage wires that together). */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { runMigrations } from '../packages/db/src/migrations.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import {
  importFinishedVideo,
  recordImportedReel,
  type ImportOutcome,
} from '../apps/worker/src/generation/import.ts';
import { computeStorageKey } from '../apps/worker/src/generation/media-store.ts';

const execFileAsync = promisify(execFile);

// Reused from ADR-0021/0023 fixtures (tests/generation-contract.test.ts uses the same constant).
const REVISION = '86d6e2c8b74228db4a5a953e53c53a7b77cef46e';

// -------------------------------------------------------------------------------------------
// Disposable-database plumbing. This file always makes and drops its OWN knowscroll_test_*
// database (never the lane's configured one), per this lane's brief: safe to run directly, and
// safe to run as one of many files under scripts/test.sh.
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
// Real-file fixtures. ffmpeg/ffprobe are required on PATH by this lane's brief.
// -------------------------------------------------------------------------------------------

interface VideoFixtureOptions {
  durationSeconds: number;
  faststart?: boolean;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

async function makeVideoFixture(path: string, options: VideoFixtureOptions): Promise<void> {
  const width = options.width ?? 108;
  const height = options.height ?? 192;
  const withAudio = options.withAudio ?? true;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=size=${width}x${height}:duration=${options.durationSeconds}:rate=24`,
  ];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${options.durationSeconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac');
  if (options.faststart !== false) args.push('-movflags', '+faststart');
  args.push('-y', path);
  await execFileAsync('ffmpeg', args);
}

/** Writes a genuine PNG file at a `.mp4` path (not an MP4 with PNG-looking content): ffmpeg
 * chooses its output muxer from the destination extension, so encoding straight to a `.mp4` path
 * would actually produce a tiny real MP4. Instead this renders a real `.png` file, then copies
 * those exact bytes to `path` unchanged. */
async function makePngFixture(path: string): Promise<void> {
  const realPngPath = `${path}.real.png`;
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=16x16', '-frames:v', '1', '-y', realPngPath]);
  await writeFile(path, await readFile(realPngPath));
  await rm(realPngPath, { force: true });
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

interface TempWorld {
  base: string;
  engineArtifactRoot: string;
  mediaRoot: string;
}

async function makeWorld(): Promise<TempWorld> {
  const base = await mkdtemp(join(tmpdir(), 'ks-generation-import-'));
  const engineArtifactRoot = join(base, 'artifacts');
  const mediaRoot = join(base, 'media');
  await mkdir(engineArtifactRoot, { recursive: true });
  await mkdir(mediaRoot, { recursive: true });
  return { base, engineArtifactRoot, mediaRoot };
}

async function cleanupWorld(world: TempWorld): Promise<void> {
  await rm(world.base, { recursive: true, force: true });
}

function assertSuccess(outcome: ImportOutcome): asserts outcome is Extract<ImportOutcome, { ok: true }> {
  assert.equal(outcome.ok, true, outcome.ok === false ? `unexpected refusal: ${outcome.reason}` : undefined);
}

function assertRefusal(outcome: ImportOutcome, reason: string): void {
  assert.equal(outcome.ok, false, 'expected a refusal');
  if (!outcome.ok) assert.equal(outcome.reason, reason);
}

// =============================================================================================
// importFinishedVideo — filesystem-only behavior
// =============================================================================================

test('importFinishedVideo verifies and content-addresses a real MP4', async (t) => {
  await t.test('a genuine contained MP4 imports, hashes, probes and lands at the computed key', async () => {
    const world = await makeWorld();
    try {
      const enginePath = join(world.engineArtifactRoot, 'run-a', 'a1-render.mp4');
      await mkdir(dirname(enginePath), { recursive: true });
      await makeVideoFixture(enginePath, { durationSeconds: 6 });
      const expectedSha256 = await sha256OfFile(enginePath);

      const outcome = await importFinishedVideo({
        attemptId: randomUUID(),
        runId: randomUUID(),
        enginePath,
        engineArtifactRoot: world.engineArtifactRoot,
        mediaRoot: world.mediaRoot,
      });
      assertSuccess(outcome);
      assert.equal(outcome.sha256, expectedSha256);
      assert.equal(outcome.storageKey, computeStorageKey(expectedSha256));
      assert.equal(outcome.probe.videoCodec, 'h264');
      assert.equal(outcome.probe.audioCodec, 'aac');
      assert.equal(outcome.probe.progressive, true);
      assert.equal(outcome.probe.width, 108);
      assert.equal(outcome.probe.height, 192);
      assert.ok(Math.abs(outcome.probe.durationSeconds - 6) < 0.5);

      const installedPath = join(world.mediaRoot, outcome.storageKey);
      const installedStat = await stat(installedPath);
      assert.equal(installedStat.size, outcome.byteSize);
      // The original engine file is untouched: import copies, never moves.
      const sourceStat = await stat(enginePath);
      assert.equal(sourceStat.size, outcome.byteSize);
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('importing the same bytes twice is idempotent: same key, no duplicate, no partial file', async () => {
    const world = await makeWorld();
    try {
      const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
      await makeVideoFixture(enginePath, { durationSeconds: 6 });
      const input = { attemptId: randomUUID(), runId: randomUUID(), enginePath, engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot };

      const first = await importFinishedVideo(input);
      assertSuccess(first);
      const second = await importFinishedVideo({ ...input, attemptId: randomUUID() });
      assertSuccess(second);
      assert.equal(second.sha256, first.sha256);
      assert.equal(second.storageKey, first.storageKey);

      const directory = dirname(join(world.mediaRoot, first.storageKey));
      const entries = await readdir(directory);
      assert.deepEqual(entries, [`${first.sha256}.mp4`]);

      const tmpDirectory = join(world.mediaRoot, 'tmp');
      const tmpEntries = await readdir(tmpDirectory).catch(() => []);
      assert.deepEqual(tmpEntries, []);
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('a real stand-in output file (if present locally) imports identically to the ffmpeg fixture', async () => {
    // Realistic-fixture bonus check (this lane's brief: "you may READ existing stand-in output
    // files ... as realistic fixtures"). Not required in CI, which has no local Cutroom instance
    // history; skipped harmlessly when none is found.
    const devRoot = process.env.KS_DEV_ROOT;
    if (!devRoot) return;
    let candidate: string | undefined;
    try {
      const instancesDir = join(devRoot, 'cutroom', 'instances');
      for (const instance of await readdir(instancesDir).catch(() => [] as string[])) {
        const artifactsDir = join(instancesDir, instance, 'artifacts');
        for (const runDir of await readdir(artifactsDir).catch(() => [] as string[])) {
          const guess = join(artifactsDir, runDir, 'a1-render.mp4');
          if (await stat(guess).then(() => true).catch(() => false)) { candidate = guess; break; }
        }
        if (candidate) break;
      }
    } catch { /* best-effort discovery only */ }
    if (!candidate) return;

    const world = await makeWorld();
    try {
      const copyPath = join(world.engineArtifactRoot, 'copied-standin.mp4');
      await writeFile(copyPath, await readFile(candidate));
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: copyPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertSuccess(outcome);
      assert.equal(outcome.probe.videoCodec, 'h264');
      assert.equal(outcome.probe.progressive, true);
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a relative engine path', async () => {
    const world = await makeWorld();
    try {
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: 'relative/run/a1-render.mp4',
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_not_absolute');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a ".." escape from the artifact root', async () => {
    const world = await makeWorld();
    try {
      const escapePath = join(world.engineArtifactRoot, '..', 'evil.mp4');
      await writeFile(escapePath, 'not a real video');
      try {
        const outcome = await importFinishedVideo({
          attemptId: randomUUID(), runId: randomUUID(), enginePath: escapePath,
          engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        });
        assertRefusal(outcome, 'engine_path_not_contained');
      } finally {
        await rm(escapePath, { force: true });
      }
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a path entirely outside the artifact root', async () => {
    const world = await makeWorld();
    const otherRoot = await mkdtemp(join(tmpdir(), 'ks-generation-import-other-'));
    try {
      const outsidePath = join(otherRoot, 'a1-render.mp4');
      await makeVideoFixture(outsidePath, { durationSeconds: 6 });
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: outsidePath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_not_contained');
    } finally {
      await cleanupWorld(world);
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  await t.test('refuses a root-equal path (the root itself is a directory, never a file)', async () => {
    const world = await makeWorld();
    try {
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: world.engineArtifactRoot,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_not_contained');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a symlink whose target is genuinely inside the root', async () => {
    const world = await makeWorld();
    try {
      const realPath = join(world.engineArtifactRoot, 'real.mp4');
      await makeVideoFixture(realPath, { durationSeconds: 6 });
      const linkPath = join(world.engineArtifactRoot, 'link-inside.mp4');
      await symlink(realPath, linkPath);
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: linkPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_is_symlink');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a symlink whose target resolves outside the root', async () => {
    const world = await makeWorld();
    const otherRoot = await mkdtemp(join(tmpdir(), 'ks-generation-import-other-'));
    try {
      const outsidePath = join(otherRoot, 'real.mp4');
      await makeVideoFixture(outsidePath, { durationSeconds: 6 });
      const linkPath = join(world.engineArtifactRoot, 'link-outside.mp4');
      await symlink(outsidePath, linkPath);
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: linkPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_not_contained');
    } finally {
      await cleanupWorld(world);
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  await t.test('refuses a directory', async () => {
    const world = await makeWorld();
    try {
      const directoryPath = join(world.engineArtifactRoot, 'a-directory.mp4');
      await mkdir(directoryPath);
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: directoryPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_is_directory');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a missing file', async () => {
    const world = await makeWorld();
    try {
      const missingPath = join(world.engineArtifactRoot, 'nope.mp4');
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: missingPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_path_missing');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses an empty file', async () => {
    const world = await makeWorld();
    try {
      const emptyPath = join(world.engineArtifactRoot, 'empty.mp4');
      await writeFile(emptyPath, Buffer.alloc(0));
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: emptyPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'engine_file_empty');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses an oversized file, simulated with a lowered ceiling rather than a 512 MiB fixture', async () => {
    const world = await makeWorld();
    try {
      const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
      await makeVideoFixture(enginePath, { durationSeconds: 6 });
      const realSize = (await stat(enginePath)).size;
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        maxBytes: realSize - 1,
      });
      assertRefusal(outcome, 'engine_file_too_large');
      const tmpEntries = await readdir(join(world.mediaRoot, 'tmp')).catch(() => []);
      assert.deepEqual(tmpEntries, []);
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('a caller-supplied maxBytes can never raise the real 512 MiB ceiling', async () => {
    const world = await makeWorld();
    try {
      const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
      await makeVideoFixture(enginePath, { durationSeconds: 6 });
      // A tiny real file, but an absurdly large requested ceiling: the file still imports (it is
      // well under 512 MiB), proving the override only ever narrows the limit downward.
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        maxBytes: 10 * 1024 * 1024 * 1024,
      });
      assertSuccess(outcome);
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a non-MP4 file (a PNG renamed .mp4)', async () => {
    const world = await makeWorld();
    try {
      const fakePath = join(world.engineArtifactRoot, 'fake.mp4');
      await makePngFixture(fakePath);
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: fakePath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'probe_not_mp4');
      const tmpEntries = await readdir(join(world.mediaRoot, 'tmp')).catch(() => []);
      assert.deepEqual(tmpEntries, []);
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a video whose duration is below the 5-second minimum', async () => {
    const world = await makeWorld();
    try {
      const shortPath = join(world.engineArtifactRoot, 'short.mp4');
      await makeVideoFixture(shortPath, { durationSeconds: 2 });
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: shortPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'probe_duration_out_of_range');
    } finally {
      await cleanupWorld(world);
    }
  });

  await t.test('refuses a faststart-less (mdat before moov) file, and leaves no stray temp file', async () => {
    const world = await makeWorld();
    try {
      const noFaststartPath = join(world.engineArtifactRoot, 'no-faststart.mp4');
      await makeVideoFixture(noFaststartPath, { durationSeconds: 6, faststart: false });
      const outcome = await importFinishedVideo({
        attemptId: randomUUID(), runId: randomUUID(), enginePath: noFaststartPath,
        engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
      });
      assertRefusal(outcome, 'probe_not_progressive');
      const tmpEntries = await readdir(join(world.mediaRoot, 'tmp')).catch(() => []);
      assert.deepEqual(tmpEntries, [], 'no stray temp file after a probe refusal');
      const storeEntries = await readdir(world.mediaRoot).catch(() => []);
      assert.deepEqual(storeEntries, ['tmp'], 'no content-addressed file was ever created for a refused import');
    } finally {
      await cleanupWorld(world);
    }
  });
});

// =============================================================================================
// recordImportedReel — one transaction, migration 0013's own guards enforced
// =============================================================================================

const claim = (id: string, role: 'main' | 'supporting') => ({ id, role });
const sentence = (text: string, claimIds: string[]) => ({ text, claimIds });

function brief(assetId: string) {
  return {
    version: 1 as const,
    worldId: 'library-world',
    narration: [
      sentence('A wax seal closes the charter.', ['claim-seal']),
      sentence('The barons gather in the stone hall.', ['claim-hall']),
      sentence('A king sets his hand to the page.', ['claim-king']),
      sentence('The copy leaves for the shires.', ['claim-seal']),
    ],
    claims: [claim('claim-seal', 'main'), claim('claim-hall', 'supporting'), claim('claim-king', 'supporting')],
    claimSources: [
      { claimId: 'claim-seal', assetId, assetRevision: 1 },
      { claimId: 'claim-hall', assetId, assetRevision: 1 },
      { claimId: 'claim-king', assetId, assetRevision: 1 },
    ],
    criteria: {
      mustShow: [{ id: 'show-seal', text: 'A wax seal.', type: 'presence' as const, claimId: 'claim-seal' }],
      mustNotShow: [{ id: 'never-flag', text: 'A modern flag.', type: 'presence' as const }],
      depictionPolicyVersion: 'depiction-v1',
    },
    style: { id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.' },
  };
}

interface AttemptFixture {
  pool: pg.Pool;
  assetId: string;
  briefId: string;
  briefSha256: string;
  engineId: string;
  jobId: string;
  attemptId: string;
  requestId: string;
}

/** Builds an approved brief, a standin engine, an unexpired grant, a job and a `prepared`
 * attempt — mirroring tests/generation-contract.test.ts's own fixture for the same tables. */
async function seedAttempt(pool: pg.Pool, engineArtifactRoot: string): Promise<AttemptFixture> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','The charter','A sealed charter','Body text.','Example source','https://example.test/charter','documented',
       (SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId],
  );
  const briefJson = generationBrief.parse(brief(assetId));
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'test','approved')`,
    [briefId, assetId, JSON.stringify(briefJson), briefSha256],
  );
  const engineId = randomUUID();
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,'http://127.0.0.1:19191',$2,$3,'standin','test')`,
    [engineId, REVISION, engineArtifactRoot],
  );
  const grantId = randomUUID();
  await pool.query(`INSERT INTO generation_budget_grant(id,mode,cap_cents,expires_at) VALUES($1,'standin',100000,now()+interval '30 days')`, [grantId]);
  // Admission requires this job's budget to be reserved already (migration 0013), exactly as the
  // real caller does inside one transaction before inserting the job.
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
  return { pool, assetId, briefId, briefSha256, engineId, jobId, attemptId, requestId };
}

async function finishAttempt(pool: pg.Pool, attemptId: string, runId: string, videoPath: string): Promise<void> {
  await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed',dispatch_committed_at=now() WHERE id=$1`, [attemptId]);
  await pool.query(`UPDATE cutroom_attempt SET state='accepted',run_id=$2,accepted_at=now() WHERE id=$1`, [attemptId, runId]);
  await pool.query(
    `UPDATE cutroom_attempt SET state='finished',finished_at=now(),reported_cost_cents=0,settlement='settled',
       result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text)) WHERE id=$1`,
    [attemptId, videoPath],
  );
}

test('recordImportedReel commits media_object and generated_reel together, atomically', async (t) => {
  await t.test('a real import followed by a matching record succeeds and is safe to repeat', async () => {
    await withDisposableDatabase(async (pool) => {
      const world = await makeWorld();
      try {
        const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
        await makeVideoFixture(enginePath, { durationSeconds: 6 });
        const fixture = await seedAttempt(pool, world.engineArtifactRoot);
        const runId = `run-${fixture.attemptId}`;

        const imported = await importFinishedVideo({
          attemptId: fixture.attemptId, runId, enginePath,
          engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        });
        assertSuccess(imported);
        await finishAttempt(pool, fixture.attemptId, runId, enginePath);

        const recordInput = {
          attemptId: fixture.attemptId,
          briefId: fixture.briefId,
          engineId: fixture.engineId,
          cutroomRunId: runId,
          providerMode: 'standin' as const,
          enginePath,
          media: { sha256: imported.sha256, byteSize: imported.byteSize, probe: imported.probe, storageKey: imported.storageKey },
          lineage: { briefSha256: fixture.briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: 6, used: 6 } },
        };

        const client = await pool.connect();
        try {
          const first = await recordImportedReel(client, recordInput);
          assert.equal(first.ok, true);
          if (!first.ok) return;
          assert.equal(first.created, true);

          const mediaRow = await pool.query('SELECT byte_size, storage_key FROM media_object WHERE sha256=$1', [imported.sha256]);
          assert.equal(mediaRow.rowCount, 1);
          assert.equal(mediaRow.rows[0]?.storage_key, imported.storageKey);
          const reelRow = await pool.query('SELECT availability, truth_state, generated_label, provider_mode FROM generated_reel WHERE id=$1', [first.generatedReelId]);
          assert.equal(reelRow.rowCount, 1);
          assert.equal(reelRow.rows[0]?.availability, 'imported');
          assert.equal(reelRow.rows[0]?.truth_state, 'synthesis');
          assert.equal(reelRow.rows[0]?.generated_label, true);
          assert.equal(reelRow.rows[0]?.provider_mode, 'standin');

          // Safe to call twice: the unique attempt_id is the fence, no duplicate row, no error.
          const second = await recordImportedReel(client, recordInput);
          assert.equal(second.ok, true);
          if (!second.ok) return;
          assert.equal(second.created, false);
          assert.equal(second.generatedReelId, first.generatedReelId);
          const count = await pool.query('SELECT count(*)::int AS n FROM generated_reel WHERE attempt_id=$1', [fixture.attemptId]);
          assert.equal(count.rows[0]?.n, 1);
        } finally {
          client.release();
        }
      } finally {
        await cleanupWorld(world);
      }
    });
  });

  await t.test('refuses a lineage mismatch (attempt not finished yet) and fails closed', async () => {
    await withDisposableDatabase(async (pool) => {
      const world = await makeWorld();
      try {
        const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
        await makeVideoFixture(enginePath, { durationSeconds: 6 });
        const fixture = await seedAttempt(pool, world.engineArtifactRoot);
        const imported = await importFinishedVideo({
          attemptId: fixture.attemptId, runId: 'unused', enginePath,
          engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        });
        assertSuccess(imported);
        // Deliberately do NOT finish the attempt: it is still 'prepared'.
        const client = await pool.connect();
        try {
          const outcome = await recordImportedReel(client, {
            attemptId: fixture.attemptId, briefId: fixture.briefId, engineId: fixture.engineId,
            cutroomRunId: `run-${fixture.attemptId}`, providerMode: 'standin', enginePath,
            media: { sha256: imported.sha256, byteSize: imported.byteSize, probe: imported.probe, storageKey: imported.storageKey },
            lineage: { briefSha256: fixture.briefSha256, contractRevision: REVISION, runId: `run-${fixture.attemptId}`, recordSummary: {} },
          });
          assert.equal(outcome.ok, false);
          if (outcome.ok) return;
          assert.equal(outcome.reason, 'lineage_mismatch');
          // Atomicity: the media_object insert in the SAME transaction was rolled back too.
          const mediaRow = await pool.query('SELECT 1 FROM media_object WHERE sha256=$1', [imported.sha256]);
          assert.equal(mediaRow.rowCount, 0);
        } finally {
          client.release();
        }
      } finally {
        await cleanupWorld(world);
      }
    });
  });

  await t.test('refuses a lineage mismatch when the provider mode does not match the engine', async () => {
    await withDisposableDatabase(async (pool) => {
      const world = await makeWorld();
      try {
        const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
        await makeVideoFixture(enginePath, { durationSeconds: 6 });
        const fixture = await seedAttempt(pool, world.engineArtifactRoot);
        const runId = `run-${fixture.attemptId}`;
        const imported = await importFinishedVideo({
          attemptId: fixture.attemptId, runId, enginePath,
          engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        });
        assertSuccess(imported);
        await finishAttempt(pool, fixture.attemptId, runId, enginePath);
        const client = await pool.connect();
        try {
          const outcome = await recordImportedReel(client, {
            attemptId: fixture.attemptId, briefId: fixture.briefId, engineId: fixture.engineId,
            cutroomRunId: runId, providerMode: 'live', enginePath, // engine declared 'standin'
            media: { sha256: imported.sha256, byteSize: imported.byteSize, probe: imported.probe, storageKey: imported.storageKey },
            lineage: { briefSha256: fixture.briefSha256, contractRevision: REVISION, runId, recordSummary: {} },
          });
          assert.equal(outcome.ok, false);
          if (outcome.ok) return;
          assert.equal(outcome.reason, 'lineage_mismatch');
        } finally {
          client.release();
        }
      } finally {
        await cleanupWorld(world);
      }
    });
  });

  await t.test('refuses a lineage mismatch when the engine path does not match the finished result', async () => {
    await withDisposableDatabase(async (pool) => {
      const world = await makeWorld();
      try {
        const enginePath = join(world.engineArtifactRoot, 'a1-render.mp4');
        await makeVideoFixture(enginePath, { durationSeconds: 6 });
        const fixture = await seedAttempt(pool, world.engineArtifactRoot);
        const runId = `run-${fixture.attemptId}`;
        const imported = await importFinishedVideo({
          attemptId: fixture.attemptId, runId, enginePath,
          engineArtifactRoot: world.engineArtifactRoot, mediaRoot: world.mediaRoot,
        });
        assertSuccess(imported);
        await finishAttempt(pool, fixture.attemptId, runId, enginePath);
        const client = await pool.connect();
        try {
          const outcome = await recordImportedReel(client, {
            attemptId: fixture.attemptId, briefId: fixture.briefId, engineId: fixture.engineId,
            cutroomRunId: runId, providerMode: 'standin', enginePath: enginePath + '.different',
            media: { sha256: imported.sha256, byteSize: imported.byteSize, probe: imported.probe, storageKey: imported.storageKey },
            lineage: { briefSha256: fixture.briefSha256, contractRevision: REVISION, runId, recordSummary: {} },
          });
          assert.equal(outcome.ok, false);
          if (outcome.ok) return;
          assert.equal(outcome.reason, 'lineage_mismatch');
        } finally {
          client.release();
        }
      } finally {
        await cleanupWorld(world);
      }
    });
  });
});
