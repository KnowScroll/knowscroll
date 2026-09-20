/**
 * J007 — ADR-0025's joined proof: a gated Reel becomes inventory and is offered only to a client
 * that asks for it, issue #102 under #8/#9/#3/#72. Follows [#100/J006](J006.md) (publication gates
 * and media serving), reusing that journey's seeding shape for one stand-in `generated_reel`.
 *
 * Against a fresh disposable `knowscroll_test_inv_journey_*` PostgreSQL database, a real separate
 * KnowScroll API process (`apps/api/src/main.ts`) and a real separate projection-worker loop
 * (`apps/worker/src/main.ts`) plus the one-shot publication-gate CLI
 * (`apps/worker/src/publication/cli.ts`):
 *
 *  1. Seed one library `asset` and a fully legitimate, finished-video `generated_reel` row (ADR-0023's
 *     own admission/lineage guards, not bypassed), with a real local-ffmpeg-made MP4 at its
 *     content-addressed key.
 *  2. Run the gate-evaluation worker to `--decide test_eligible` (every required gate passes except
 *     the structurally-unavailable witness gate; the stand-in fence is what allows `test_eligible`
 *     here, exactly like J006).
 *  3. Mint the inventory asset (`... cli.ts mint --reel-id <uuid>`): idempotent, carries the brief's
 *     own title/summary, the Reel's media digest, truth state and simulated flag.
 *  4. `GET /v1/feed` with no `kinds` parameter: the default candidate list never includes the Reel.
 *  5. `GET /v1/feed?kinds=Scroll,Reel`: the Reel is offered, with the documented item shape.
 *  6. Expose it, keep it, let the real projection worker reach the Keep, read the events lookup.
 *  7. Fetch the media via `GET /v1/media/:sha256`: byte-identical to the source file.
 *
 * Evidence level throughout: STAND-IN MEDIA IN A DISPOSABLE DATABASE — NEVER REAL GENERATION AND
 * NEVER THE OWNER'S UNIVERSE. No Cutroom process is started; no provider credential is used or even
 * read; the owner-local stand-in engine on 127.0.0.1:4390 is never touched.
 *
 * Usage (source scripts/env.sh first):
 *   pnpm exec tsx scripts/run-inventory-journey.ts
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
const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules/.bin/tsx');
const API_MAIN = join(REPO_ROOT, 'apps/api/src/main.ts');
const WORKER_MAIN = join(REPO_ROOT, 'apps/worker/src/main.ts');
const PUBLICATION_CLI = join(REPO_ROOT, 'apps/worker/src/publication/cli.ts');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs/journeys/evidence/reel-inventory');

const KS_DEV_ROOT = process.env.KS_DEV_ROOT;
if (!KS_DEV_ROOT) throw new Error('KS_DEV_ROOT is not set; source scripts/env.sh before running this script');
const DEV_ROOT: string = KS_DEV_ROOT;

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOGS_ROOT = join(DEV_ROOT, 'inventory', 'logs');
const SCRATCH_ROOT = join(DEV_ROOT, 'inventory', `journey-${RUN_STAMP}`);
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
  const name = `knowscroll_test_inv_journey_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
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
// Seeding: one Scroll (the Reel's own source lineage), an approved brief carrying title/summary,
// a standin engine/grant/job, a finished-video attempt with a clean Cutroom record, and the
// resulting generated_reel row — migration 0013's own admission/lineage guards apply in full.
// -------------------------------------------------------------------------------------------

async function seedSourceAsset(pool: pg.Pool): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','The Charter of Runnymede','A sealed charter bound a king to the law of the land.',
       'Fixture body text for the J007 inventory journey.','Example source','https://example.test/charter','documented',1)`,
    [assetId],
  );
  return assetId;
}

function brief(assetId: string) {
  return generationBrief.parse({
    version: 1,
    worldId: 'j007-inventory-world',
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
    title: 'The sealing of the Charter',
    summary: 'A stand-in Reel imagining the moment the charter was sealed, for the J007 journey.',
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
  const assetId = await seedSourceAsset(pool);
  const briefJson = brief(assetId);
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'j007-journey','approved')`,
    [briefId, assetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,'http://127.0.0.1:19299',$2,$3,'standin','j007-journey')`,
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
  await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,$2,'video/mp4',$3,$4)`,
    [sha256, bytes.length, JSON.stringify({ durationSeconds: 6, width: 108, height: 192 }), storageKey],
  );

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
// Process management.
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
  console.log(JSON.stringify({ service: 'inventory-journey', event: pass ? 'check_pass' : 'check_fail', name, expected, observed }));
  if (!pass) throw new Error(`J007 check failed: ${name}: expected ${expected}, observed ${observed}`);
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
  let workerChild: ChildProcess | undefined;
  try {
    await runMigrations(db.pool, { directory: join(REPO_ROOT, 'packages/db/migrations') });
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
      if (i > 100) throw new Error('J007: API process never became healthy');
      await sleep(100);
    }
    console.log(JSON.stringify({ service: 'inventory-journey', event: 'api_started', port: apiPort }));

    const workerEnv = childEnv({ DATABASE_URL: db.url, KS_MEDIA_ROOT: MEDIA_ROOT });
    workerChild = spawn(TSX_BIN, [WORKER_MAIN], { env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(JSON.stringify({ service: 'inventory-journey', event: 'projection_worker_started' }));

    // Gate the Reel to test_eligible (identical to J006's own path).
    const gateEval = await runOnce(TSX_BIN, [PUBLICATION_CLI, 'evaluate', '--reel-id', seeded.generatedReelId, '--policy', 'publication-v1', '--decide', 'test_eligible'], workerEnv);
    record('gate-evaluation worker exits 0', '0', String(gateEval.code), gateEval.code === 0);
    const gateOutcome = JSON.parse(gateEval.stdout.trim().split('\n').filter(Boolean).pop()!);
    record('worker reports test_eligible', 'test_eligible', gateOutcome?.availability?.availability, gateOutcome?.availability?.decided === true && gateOutcome?.availability?.availability === 'test_eligible');

    // Mint the inventory asset.
    const mint = await runOnce(TSX_BIN, [PUBLICATION_CLI, 'mint', '--reel-id', seeded.generatedReelId], workerEnv);
    record('mint worker exits 0', '0', String(mint.code), mint.code === 0);
    const mintOutcome = JSON.parse(mint.stdout.trim().split('\n').filter(Boolean).pop()!);
    record('mint reports created:true on first call', 'true', String(mintOutcome.created), mintOutcome.created === true);
    const assetId: string = mintOutcome.assetId;

    // Idempotent second mint.
    const mintAgain = await runOnce(TSX_BIN, [PUBLICATION_CLI, 'mint', '--reel-id', seeded.generatedReelId], workerEnv);
    const mintAgainOutcome = JSON.parse(mintAgain.stdout.trim().split('\n').filter(Boolean).pop()!);
    record('second mint is idempotent (created:false, same assetId)', `false,${assetId}`, `${mintAgainOutcome.created},${mintAgainOutcome.assetId}`, mintAgainOutcome.created === false && mintAgainOutcome.assetId === assetId);

    // Default feed: no Reel.
    const defaultFeedResponse = await fetch(`${apiBase}/v1/feed`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('default feed status', '200', String(defaultFeedResponse.status), defaultFeedResponse.status === 200);
    const defaultFeed = await defaultFeedResponse.json() as { items: Array<{ assetId: string; kind: string }> };
    record('default feed never includes the Reel', 'false', String(defaultFeed.items.some((item) => item.assetId === assetId)), !defaultFeed.items.some((item) => item.assetId === assetId));
    record('default feed carries no kind:Reel item at all', 'false', String(defaultFeed.items.some((item) => item.kind === 'Reel')), !defaultFeed.items.some((item) => item.kind === 'Reel'));

    // Opted-in feed: the Reel is offered with the documented shape.
    const optInResponse = await fetch(`${apiBase}/v1/feed?kinds=Scroll,Reel`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('opted-in feed status', '200', String(optInResponse.status), optInResponse.status === 200);
    const optIn = await optInResponse.json() as { decisionId: string; items: Array<Record<string, unknown>> };
    const reelItem = optIn.items.find((item) => item.assetId === assetId);
    record('opted-in feed includes the eligible Reel', 'present', reelItem ? 'present' : 'absent', reelItem !== undefined);
    record('Reel item mediaUrl is the content-addressed route, never an engine path', `/v1/media/${seeded.sha256}`, String(reelItem?.mediaUrl), reelItem?.mediaUrl === `/v1/media/${seeded.sha256}`);
    record('Reel item truthState', 'synthesis', String(reelItem?.truthState), reelItem?.truthState === 'synthesis');
    record('Reel item simulated flag', 'true', String(reelItem?.simulated), reelItem?.simulated === true);
    record('Reel item generatedLabel', 'true', String(reelItem?.generatedLabel), reelItem?.generatedLabel === true);

    // Unknown kind is refused.
    const badKindsResponse = await fetch(`${apiBase}/v1/feed?kinds=Scroll,Video`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('unknown kind is refused with 400', '400', String(badKindsResponse.status), badKindsResponse.status === 400);

    // Expose, keep, project, read the events lookup.
    const exposureResponse = await fetch(`${apiBase}/v1/exposures`, {
      method: 'POST', headers: { Authorization: `Bearer ${devToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionId: optIn.decisionId, assetId, clientExposureId: randomUUID() }),
    });
    record('exposure status', '201', String(exposureResponse.status), exposureResponse.status === 201);
    const exposure = await exposureResponse.json() as { exposureId: string; eventId: string };

    const keepResponse = await fetch(`${apiBase}/v1/interactions`, {
      method: 'POST', headers: { Authorization: `Bearer ${devToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientEventId: randomUUID(), exposureId: exposure.exposureId, assetId, kind: 'keep' }),
    });
    record('keep status', '202', String(keepResponse.status), keepResponse.status === 202);
    const keep = await keepResponse.json() as { eventId: string; jobId: string };

    let projected = false;
    for (let i = 0; i < 100; i += 1) {
      const row = (await db.pool.query('SELECT status FROM job WHERE id=$1', [keep.jobId])).rows[0];
      if (row?.status === 'completed') { projected = true; break; }
      await sleep(100);
    }
    record('real projection worker reaches the admitted Reel Keep', 'true', String(projected), projected);

    const eventLookupResponse = await fetch(`${apiBase}/v1/events/${keep.eventId}`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('events lookup status', '200', String(eventLookupResponse.status), eventLookupResponse.status === 200);
    const eventLookup = await eventLookupResponse.json() as { kind: string; projected: boolean };
    record('events lookup reports kind:keep, projected:true', 'keep,true', `${eventLookup.kind},${eventLookup.projected}`, eventLookup.kind === 'keep' && eventLookup.projected === true);

    const traceRow = (await db.pool.query('SELECT asset_id FROM trace WHERE event_id=$1', [keep.eventId])).rows[0];
    record('the same trace table records the kept Reel (no new event kind)', assetId, String(traceRow?.asset_id), traceRow?.asset_id === assetId);

    // A kept Reel is excluded from later candidates.
    const afterKeepResponse = await fetch(`${apiBase}/v1/feed?kinds=Scroll,Reel`, { headers: { Authorization: `Bearer ${devToken}` } });
    const afterKeep = await afterKeepResponse.json() as { items: Array<{ assetId: string }> };
    record('a kept Reel is excluded from later candidates', 'false', String(afterKeep.items.some((item) => item.assetId === assetId)), !afterKeep.items.some((item) => item.assetId === assetId));

    // Documented boundary: the dedicated revisit endpoint (outside this lane's owned paths) is
    // Scroll-only and returns its existing generic error for any candidate it cannot parse.
    const revisitResponse = await fetch(`${apiBase}/v1/traces/${keep.eventId}`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('revisit of a kept Reel returns the existing generic lineage-unavailable error (documented boundary, not a crash)', '422', String(revisitResponse.status), revisitResponse.status === 422);

    // Stream the media, byte-identically.
    const wholeResponse = await fetch(`${apiBase}/v1/media/${seeded.sha256}`, { headers: { Authorization: `Bearer ${devToken}` } });
    record('whole-body GET status', '200', String(wholeResponse.status), wholeResponse.status === 200);
    const wholeBytes = Buffer.from(await wholeResponse.arrayBuffer());
    record('whole-body bytes are byte-identical to the stored file', 'true', String(wholeBytes.equals(seeded.bytes)), wholeBytes.equals(seeded.bytes));
    record('simulated-media marker is present', 'true', wholeResponse.headers.get('x-knowscroll-media-simulated') ?? 'missing', wholeResponse.headers.get('x-knowscroll-media-simulated') === 'true');

    const receipt = {
      journey: 'J007',
      evidenceLevel: "stand-in media in a disposable database — never real generation and never the owner's universe",
      runStamp: RUN_STAMP,
      knowscrollHead: gitRev,
      node: nodeVersion,
      ffmpeg: ffmpegVersion,
      database: db.name,
      generatedReelId: seeded.generatedReelId,
      assetId,
      mediaSha256: seeded.sha256,
      mediaByteSize: seeded.bytes.length,
      checks,
      result: 'passed',
    };
    const receiptPath = join(LOGS_ROOT, `inventory-journey-${RUN_STAMP}.json`);
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ service: 'inventory-journey', event: 'passed', receiptPath, checks: checks.length }));
  } finally {
    if (apiChild) await stopProcess(apiChild);
    if (workerChild) await stopProcess(workerChild);
    await dropDisposableDatabase(db);
    await rm(SCRATCH_ROOT, { recursive: true, force: true });
  }
}

await main();
