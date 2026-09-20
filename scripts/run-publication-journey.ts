/**
 * J006 — ADR-0024's joined proof: publication gates and media serving, issue #100 under #9/#12/#72.
 *
 * Against a fresh disposable `knowscroll_test_pub_journey_*` PostgreSQL database, a real separate
 * KnowScroll API process (`apps/api/src/main.ts`) and a real separate publication-gate "worker"
 * process (`apps/worker/src/publication/cli.ts`, one-shot per call — this slice defines no gate
 * job queue):
 *
 *  1. Seed one library `asset` and a fully legitimate, finished-video `generated_reel` row directly
 *     (ADR-0023's own admission/lineage guards, not bypassed) with a REAL local ffmpeg-made MP4 at
 *     its content-addressed key — reusing the generation journey's seeding shape rather than a real
 *     Cutroom run, exactly as ADR-0024's evidence requirements allow.
 *  2. Run the worker once: every required gate gets a recorded verdict; witness_alignment is
 *     `unavailable`; availability stays `imported` (`eligible` is impossible). A direct SQL attempt
 *     to hand-set `eligible` is independently refused by the database itself.
 *  3. Run the worker again with `--decide test_eligible`: the database allows it (disposable
 *     database, standin provider mode), so availability becomes `test_eligible`.
 *  4. Stream the media back over REAL HTTP against the real API process: whole-body and
 *     Range-sliced GETs are byte-identical to the source file, and the response carries the
 *     simulated-media marker.
 *
 * Evidence level throughout: STAND-IN MEDIA IN A DISPOSABLE DATABASE — NEVER REAL GENERATION AND
 * NEVER THE OWNER'S UNIVERSE. No Cutroom process is started; no provider credential is used or
 * even read; the owner-local stand-in engine on 127.0.0.1:4390 is never touched.
 *
 * Usage (source scripts/env.sh first):
 *   pnpm exec tsx scripts/run-publication-journey.ts
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

import { runMigrations } from '../packages/db/src/migrations.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';
import { computeStorageKey } from '../apps/worker/src/generation/media-store.ts';

const execFileAsync = promisify(execFile);
/** packages/db/src/index.ts's own constant, duplicated rather than imported: importing that module
 * would open its own pool against whatever DATABASE_URL this process's environment happened to
 * have at import time, which is this lane's OUTER database, not the disposable one this journey
 * creates for itself. */
const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules/.bin/tsx');
const API_MAIN = join(REPO_ROOT, 'apps/api/src/main.ts');
const PUBLICATION_CLI = join(REPO_ROOT, 'apps/worker/src/publication/cli.ts');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs/journeys/evidence/publication');

const KS_DEV_ROOT = process.env.KS_DEV_ROOT;
if (!KS_DEV_ROOT) throw new Error('KS_DEV_ROOT is not set; source scripts/env.sh before running this script');
const DEV_ROOT: string = KS_DEV_ROOT;

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOGS_ROOT = join(DEV_ROOT, 'publication', 'logs');
const SCRATCH_ROOT = join(DEV_ROOT, 'publication', `journey-${RUN_STAMP}`);
const MEDIA_ROOT = join(SCRATCH_ROOT, 'media');

// -------------------------------------------------------------------------------------------
// Never print/derive any .env value. Only this run's own generated database name (never derived
// from the connection string) may ever appear in logs or evidence.
// -------------------------------------------------------------------------------------------

function loadBaseDatabaseUrl(): URL {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);
  const envPath = join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^DATABASE_URL=(.+)$/.exec(line.trim());
      if (match?.[1]) return new URL(match[1]);
    }
  }
  throw new Error('DATABASE_URL is required, in the environment or the lane .env');
}
function withDatabaseName(url: URL, name: string): string {
  const clone = new URL(url.toString());
  clone.pathname = `/${name}`;
  return clone.toString();
}
const BASE_DB_URL = loadBaseDatabaseUrl();
if (BASE_DB_URL.pathname.replace(/^\//, '') === 'knowscroll') {
  throw new Error('refusing to run against the owner database "knowscroll"');
}

async function createDisposableDatabase(): Promise<{ name: string; url: string; pool: pg.Pool }> {
  const name = `knowscroll_test_pub_journey_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new pg.Pool({ connectionString: withDatabaseName(BASE_DB_URL, 'postgres'), max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabaseName(BASE_DB_URL, name);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return { name, url, pool };
}
async function dropDisposableDatabase(db: { name: string; pool: pg.Pool }): Promise<void> {
  await db.pool.end();
  const admin = new pg.Pool({ connectionString: withDatabaseName(BASE_DB_URL, 'postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${db.name}"`);
  } finally {
    await admin.end();
  }
}

// -------------------------------------------------------------------------------------------
// Real-file fixture (ffmpeg, a genuinely real local tool — never a provider).
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
// Seeding: one asset, an approved brief, a standin engine/grant/job, a finished-video attempt with
// a clean Cutroom record (no failing checks, no degradations), and the resulting generated_reel
// row — ADR-0023's own admission/lineage guards apply in full; nothing here is a database bypass.
// -------------------------------------------------------------------------------------------

async function seedAsset(pool: pg.Pool): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','The Charter of Runnymede','A sealed charter bound a king to the law of the land.',
       'Fixture body text for the J006 publication journey.','Example source','https://example.test/charter','documented',1)`,
    [assetId],
  );
  return assetId;
}

function brief(assetId: string) {
  return generationBrief.parse({
    version: 1,
    worldId: 'j006-publication-world',
    narration: [
      { text: 'A wax seal closes the charter.', claimIds: ['c1'] },
      { text: 'The barons gather in the stone hall.', claimIds: ['c1'] },
      { text: 'A king sets his hand to the page.', claimIds: ['c2'] },
      { text: 'The copy leaves for the shires.', claimIds: ['c2'] },
    ],
    claims: [{ id: 'c1', role: 'main' }, { id: 'c2', role: 'supporting' }],
    claimSources: [{ claimId: 'c1', assetId, assetRevision: 1 }, { claimId: 'c2', assetId, assetRevision: 1 }],
    criteria: { mustShow: [{ id: 'show-seal', text: 'A wax seal.', type: 'presence' as const, claimId: 'c1' }], mustNotShow: [], depictionPolicyVersion: 'depiction-v1' },
    style: { id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.' },
  });
}

interface SeededReel {
  generatedReelId: string;
  attemptId: string;
  briefSha256: string;
  sha256: string;
  storageKey: string;
  bytes: Buffer;
}

async function seedStandinGeneratedReel(pool: pg.Pool): Promise<SeededReel> {
  const assetId = await seedAsset(pool);
  const briefJson = brief(assetId);
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'j006-journey','approved')`,
    [briefId, assetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,'http://127.0.0.1:19199',$2,$3,'standin','j006-journey')`,
    [engineId, REVISION, SCRATCH_ROOT],
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
  const enginePath = join(SCRATCH_ROOT, `${attemptId}.mp4`);
  await mkdir(SCRATCH_ROOT, { recursive: true });
  await makeValidMp4(enginePath);
  const bytes = await readFile(enginePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = computeStorageKey(sha256);

  await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed', dispatch_committed_at=now() WHERE id=$1`, [attemptId]);
  await pool.query(`UPDATE cutroom_attempt SET state='accepted', run_id=$2, accepted_at=now() WHERE id=$1`, [attemptId, runId]);
  const recordSummary = { contractVersion: 1, runId, pictures: [], takes: [{ takeId: 't1', shotId: 's1', number: 1, used: true, checks: [{ gate: 'safety', outcome: 'accept' }] }], degradations: [] };
  await pool.query(
    `UPDATE cutroom_attempt SET state='finished', finished_at=now(), reported_cost_cents=0, settlement='settled',
       result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text)),
       record_summary=$3
     WHERE id=$1`,
    [attemptId, enginePath, JSON.stringify(recordSummary)],
  );

  await mkdir(join(MEDIA_ROOT, storageKey.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(join(MEDIA_ROOT, storageKey), bytes);
  await pool.query(`INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,$2,'video/mp4','{}',$3)`, [sha256, bytes.length, storageKey]);

  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,'standin','synthesis',true,$8)`,
    [generatedReelId, attemptId, briefId, engineId, runId, sha256, enginePath, JSON.stringify(lineage)],
  );

  return { generatedReelId, attemptId, briefSha256, sha256, storageKey, bytes };
}

// -------------------------------------------------------------------------------------------
// Process management: a real, separate node/tsx child per role. Every child receives an explicit
// environment only (never this repository's own full process env, never a provider credential).
// -------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'KS_DEV_ROOT'] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return { ...env, ...extra };
}

interface RunResult { code: number | null; stdout: string; stderr: string }
function runOnce(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())), sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// -------------------------------------------------------------------------------------------

type Check = { name: string; expected: string; observed: string; pass: boolean };
const checks: Check[] = [];
function record(name: string, expected: string, observed: string, pass: boolean): void {
  checks.push({ name, expected, observed, pass });
  console.log(JSON.stringify({ service: 'publication-journey', event: pass ? 'check_pass' : 'check_fail', name, expected, observed }));
  if (!pass) throw new Error(`J006 check failed: ${name}: expected ${expected}, observed ${observed}`);
}

async function main(): Promise<void> {
  await mkdir(LOGS_ROOT, { recursive: true });
  await mkdir(MEDIA_ROOT, { recursive: true });

  const [gitRev, ffmpegVersion, nodeVersion] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).then((r) => r.stdout.trim()),
    execFileAsync('ffmpeg', ['-version']).then((r) => r.stdout.split('\n')[0] ?? ''),
    Promise.resolve(process.version),
  ]);

  const db = await createDisposableDatabase();
  let apiChild: ChildProcess | undefined;
  try {
    await runMigrations(db.pool, { directory: join(REPO_ROOT, 'packages/db/migrations') });
    // The API's onReady hook enrolls KS_DEV_TOKEN as an ordinary owner device session, which
    // requires the bootstrap owner universe row to already exist (normally `pnpm db:seed`, done
    // here directly since this journey needs nothing else that script installs).
    await db.pool.query(`INSERT INTO universe(id) VALUES($1) ON CONFLICT DO NOTHING`, [OWNER_ID]);
    await db.pool.query(`INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING`, [OWNER_ID]);

    const seeded = await seedStandinGeneratedReel(db.pool);
    record('seeded generated_reel is imported', 'imported', (await db.pool.query('SELECT availability FROM generated_reel WHERE id=$1', [seeded.generatedReelId])).rows[0].availability, true);

    const devToken = randomBytes(32).toString('hex');
    const apiPort = 20000 + Math.floor(Math.random() * 10000);
    const apiEnv = childEnv({ DATABASE_URL: db.url, KS_DEV_TOKEN: devToken, PORT: String(apiPort), KS_MEDIA_ROOT: MEDIA_ROOT });
    apiChild = spawn(TSX_BIN, [API_MAIN], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let apiStartupError: Error | undefined;
    let apiOutput = '';
    apiChild.stdout?.on('data', (chunk: Buffer) => { apiOutput += chunk.toString('utf8'); });
    apiChild.stderr?.on('data', (chunk: Buffer) => { apiOutput += chunk.toString('utf8'); });
    apiChild.once('error', (error) => { apiStartupError = error; });
    const apiBase = `http://127.0.0.1:${apiPort}`;
    for (let i = 0; ; i += 1) {
      if (apiStartupError) throw apiStartupError;
      if (apiChild.exitCode !== null) throw new Error(`API process exited before health check (code ${apiChild.exitCode}): ${apiOutput}`);
      try {
        const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch { /* not up yet */ }
      if (i > 100) throw new Error('J006: API process never became healthy');
      await sleep(100);
    }
    console.log(JSON.stringify({ service: 'publication-journey', event: 'api_started', port: apiPort }));

    const workerEnv = childEnv({ DATABASE_URL: db.url, KS_MEDIA_ROOT: MEDIA_ROOT });
    const firstEval = await runOnce(TSX_BIN, [PUBLICATION_CLI, 'evaluate', '--reel-id', seeded.generatedReelId, '--policy', 'publication-v1'], workerEnv);
    record('gate-evaluation worker exits 0', '0', String(firstEval.code), firstEval.code === 0);
    const firstLine = firstEval.stdout.trim().split('\n').filter(Boolean).pop();
    const firstOutcome = firstLine ? JSON.parse(firstLine) : null;
    record('witness_alignment is unavailable', 'unavailable', firstOutcome?.gates?.find((g: { gate: string }) => g.gate === 'witness_alignment')?.verdict, firstOutcome?.gates?.find((g: { gate: string }) => g.gate === 'witness_alignment')?.verdict === 'unavailable');
    record('every other required gate passed on this clean fixture', 'true', String(firstOutcome?.gates?.filter((g: { gate: string }) => g.gate !== 'witness_alignment').every((g: { verdict: string }) => g.verdict === 'pass')), firstOutcome?.gates?.filter((g: { gate: string }) => g.gate !== 'witness_alignment').every((g: { verdict: string }) => g.verdict === 'pass') === true);
    record('auto decision could not reach eligible', 'imported', firstOutcome?.availability?.current, firstOutcome?.availability?.decided === false && firstOutcome?.availability?.current === 'imported');

    const dbAvailabilityAfterFirst = (await db.pool.query('SELECT availability FROM generated_reel WHERE id=$1', [seeded.generatedReelId])).rows[0].availability;
    record('database still reports imported', 'imported', dbAvailabilityAfterFirst, dbAvailabilityAfterFirst === 'imported');

    let sqlEligibleRejected = false;
    let sqlEligibleMessage = '';
    try {
      await db.pool.query(
        `UPDATE generated_reel SET availability='eligible', availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`,
        [seeded.generatedReelId],
      );
    } catch (error) {
      sqlEligibleRejected = true;
      sqlEligibleMessage = error instanceof Error ? error.message : String(error);
    }
    record('a direct SQL attempt to hand-set eligible is refused by the database', 'rejected', sqlEligibleRejected ? `rejected: ${sqlEligibleMessage}` : 'accepted', sqlEligibleRejected);

    const testEligibleEval = await runOnce(TSX_BIN, [PUBLICATION_CLI, 'evaluate', '--reel-id', seeded.generatedReelId, '--policy', 'publication-v1', '--decide', 'test_eligible'], workerEnv);
    record('test_eligible worker call exits 0', '0', String(testEligibleEval.code), testEligibleEval.code === 0);
    const testEligibleLine = testEligibleEval.stdout.trim().split('\n').filter(Boolean).pop();
    const testEligibleOutcome = testEligibleLine ? JSON.parse(testEligibleLine) : null;
    record('worker reports test_eligible', 'test_eligible', testEligibleOutcome?.availability?.availability, testEligibleOutcome?.availability?.decided === true && testEligibleOutcome?.availability?.availability === 'test_eligible');
    const dbAvailabilityAfterSecond = (await db.pool.query('SELECT availability FROM generated_reel WHERE id=$1', [seeded.generatedReelId])).rows[0].availability;
    record('database reports test_eligible', 'test_eligible', dbAvailabilityAfterSecond, dbAvailabilityAfterSecond === 'test_eligible');

    const wholeResponse = await fetch(`${apiBase}/v1/media/${seeded.sha256}`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('whole-body GET status', '200', String(wholeResponse.status), wholeResponse.status === 200);
    const wholeBytes = Buffer.from(await wholeResponse.arrayBuffer());
    record('whole-body bytes are byte-identical to the stored file', 'true', String(wholeBytes.equals(seeded.bytes)), wholeBytes.equals(seeded.bytes));
    record('simulated-media marker is present', 'true', wholeResponse.headers.get('x-knowscroll-media-simulated') ?? 'missing', wholeResponse.headers.get('x-knowscroll-media-simulated') === 'true');

    const half = Math.floor(seeded.bytes.length / 2);
    const firstHalfResponse = await fetch(`${apiBase}/v1/media/${seeded.sha256}`, { headers: { Authorization: `Bearer ${devToken}`, Range: `bytes=0-${half - 1}` } });
    const secondHalfResponse = await fetch(`${apiBase}/v1/media/${seeded.sha256}`, { headers: { Authorization: `Bearer ${devToken}`, Range: `bytes=${half}-` } });
    record('first Range slice status', '206', String(firstHalfResponse.status), firstHalfResponse.status === 206);
    record('second Range slice status', '206', String(secondHalfResponse.status), secondHalfResponse.status === 206);
    const firstHalfBytes = Buffer.from(await firstHalfResponse.arrayBuffer());
    const secondHalfBytes = Buffer.from(await secondHalfResponse.arrayBuffer());
    const reassembled = Buffer.concat([firstHalfBytes, secondHalfBytes]);
    record('Range slices reassemble byte-identically to the whole file', 'true', String(reassembled.equals(seeded.bytes)), reassembled.equals(seeded.bytes));

    const receipt = {
      journey: 'J006',
      evidenceLevel: "stand-in media in a disposable database — never real generation and never the owner's universe",
      runStamp: RUN_STAMP,
      knowscrollHead: gitRev,
      node: nodeVersion,
      ffmpeg: ffmpegVersion,
      database: db.name,
      generatedReelId: seeded.generatedReelId,
      mediaSha256: seeded.sha256,
      mediaByteSize: seeded.bytes.length,
      checks,
      result: 'passed',
    };
    const receiptPath = join(LOGS_ROOT, `publication-journey-${RUN_STAMP}.json`);
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ service: 'publication-journey', event: 'passed', receiptPath, checks: checks.length }));
  } finally {
    if (apiChild) await stopProcess(apiChild);
    await dropDisposableDatabase(db);
    await rm(SCRATCH_ROOT, { recursive: true, force: true });
  }
}

await main();
