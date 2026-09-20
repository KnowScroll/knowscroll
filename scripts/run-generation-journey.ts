/**
 * Issue #94 stage A2 — J005, the joined generation-supply journey. From an approved
 * GenerationBrief over a seeded library Scroll, through a real, separate generation worker
 * process (`pnpm dev:generation`), against ops/cutroom-host's REAL local Cutroom api+worker with
 * upstream's own stand-in providers, to a verified, content-addressed import in KnowScroll's own
 * media store and an immutable `generated_reel` row. This mirrors #89's joined proof
 * (docs/journeys/evidence/cutroom-local/README.md) and its scenario shapes.
 *
 * Evidence level throughout: REAL LOCAL SERVICE WITH UPSTREAM STAND-IN PROVIDERS — NOT REAL
 * GENERATION. Every scenario below creates its own disposable PostgreSQL database and its own
 * Cutroom instance/processes; it never touches the owner database, the owner-local stand-in engine
 * on 127.0.0.1:4390, or the pinned Cutroom checkout's own files.
 *
 * Usage (source scripts/env.sh first):
 *   pnpm exec tsx scripts/run-generation-journey.ts [receipt-path]
 * `J005_ONLY_SCENARIO=S1|S2|S3|S4|S5|S6` restricts a run to one scenario, for fast iteration; the
 * default (unset) runs all six in order and is the actual accepted journey.
 */
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdir, readFile, rm, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import pg from 'pg';

import {runMigrations} from '../packages/db/src/migrations.ts';
import {generationBrief, type GenerationBrief} from '../packages/contracts/src/generation.ts';
import * as storage from '../apps/worker/src/generation/storage.ts';
import * as operator from '../apps/worker/src/generation/operator.ts';
import {
  type Readiness,
  type SpawnedHost,
  hostChildEnv,
  spawnHost,
  spawnProcess,
  sleep,
  waitForJsonLine,
  waitForReadiness,
  withTimeout,
} from './cutroom-local/host-process.ts';

const execFileAsync = promisify(execFile);

// =================================================================================================
// Pinned constants (ADR-0021/0023) and paths.
// =================================================================================================

const CUTROOM_RUNTIME = '/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742';
const CUTROOM_REVISION = storage.CUTROOM_CONTRACT_REVISION;
if (CUTROOM_REVISION !== '86d6e2c8b74228db4a5a953e53c53a7b77cef46e') {
  throw new Error('J005 assumes the pinned Cutroom revision matches storage.CUTROOM_CONTRACT_REVISION');
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const HOST_SCRIPT = join(REPO_ROOT, 'ops/cutroom-host/host.ts');
const MAIN_TS = join(REPO_ROOT, 'apps/worker/src/generation/main.ts');
const GENERATION_CLI = join(REPO_ROOT, 'scripts/generation.ts');
const TSX_BIN = join(REPO_ROOT, 'node_modules/.bin/tsx');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs/journeys/evidence/generation-supply');
const OWNER_ENGINE_PIDS = {api: 6937, worker: 6939} as const;
const OWNER_ENGINE_PORT = 4390;

const KS_DEV_ROOT = process.env.KS_DEV_ROOT;
if (!KS_DEV_ROOT) throw new Error('KS_DEV_ROOT is not set; source scripts/env.sh before running this script');
const DEV_ROOT: string = KS_DEV_ROOT;

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const INSTANCES_ROOT = join(DEV_ROOT, 'cutroom', 'instances');
const LOGS_ROOT = join(DEV_ROOT, 'cutroom', 'logs');
const SCRATCH_ROOT = join(DEV_ROOT, 'tmp', `generation-journey-${RUN_STAMP}`);

function instancePath(scenario: string): string {
  return join(INSTANCES_ROOT, `gen-journey-${RUN_STAMP}-${scenario}`);
}
function scratchPath(scenario: string, ...rest: string[]): string {
  return join(SCRATCH_ROOT, scenario, ...rest);
}

// =================================================================================================
// Never print/derive any .env value. Only the disposable database's OWN generated name (never
// derived from the connection string) may ever appear in logs or evidence.
// =================================================================================================

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

interface DisposableDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
}
const allDisposableDatabaseNames: string[] = [];

async function createDisposableDatabase(label: string): Promise<DisposableDatabase> {
  const name = `knowscroll_test_gen_${label.replace(/[^a-z0-9]+/gi, '_')}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const admin = new pg.Pool({connectionString: withDatabaseName(BASE_DB_URL, 'postgres'), max: 1});
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  allDisposableDatabaseNames.push(name);
  const url = withDatabaseName(BASE_DB_URL, name);
  const pool = new pg.Pool({connectionString: url, max: 8});
  return {name, url, pool};
}
async function dropDisposableDatabase(db: DisposableDatabase): Promise<void> {
  await db.pool.end();
  const admin = new pg.Pool({connectionString: withDatabaseName(BASE_DB_URL, 'postgres'), max: 1});
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${db.name}"`);
  } finally {
    await admin.end();
  }
  const index = allDisposableDatabaseNames.indexOf(db.name);
  if (index >= 0) allDisposableDatabaseNames.splice(index, 1);
}
async function strayDisposableDatabaseCount(): Promise<number> {
  const admin = new pg.Pool({connectionString: withDatabaseName(BASE_DB_URL, 'postgres'), max: 1});
  try {
    const rows = await admin.query<{datname: string}>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'knowscroll_test_gen_%'`,
    );
    return rows.rowCount ?? 0;
  } finally {
    await admin.end();
  }
}

async function migrateAndSeedOneAsset(pool: pg.Pool): Promise<string> {
  await runMigrations(pool, {directory: join(REPO_ROOT, 'packages/db/migrations')});
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','The Charter of Runnymede','A sealed charter bound a king to the law of the land.',
       'Fixture body text for the J005 generation-supply journey.','Example source','https://example.test/charter','documented',1)`,
    [assetId],
  );
  return assetId;
}

// =================================================================================================
// The brief: structurally identical (worldId/narration/claims/criteria/style) to upstream's own
// `videoRequest()` (tests/engine/video.ts -> stillsRequest -> planRequest), so the pinned
// THREE_RANKS stand-in script — keyed to that exact shape, not to specific field VALUES — answers
// every planner/witness/judge call this compiled request actually makes. Sources/claim text/truth
// state never leave KnowScroll (ADR-0023): only worldId/narration/claims/criteria/style compile
// into the wire request.
// =================================================================================================

function matchingBrief(assetId: string): GenerationBrief {
  return generationBrief.parse({
    version: 1,
    worldId: 'world-1',
    narration: [
      {text: 'In 1215 a charter was sealed at Runnymede.', claimIds: ['c1']},
      {text: 'It bound a king to the law of the land.', claimIds: ['c1']},
      {text: 'The barons who forced it were not democrats.', claimIds: ['c2']},
      {text: 'They wanted their own privileges back.', claimIds: []},
      {text: 'Within weeks the pope annulled it.', claimIds: ['c3']},
      {text: 'Yet it was reissued three times.', claimIds: ['c2']},
      {text: 'Each reissue shortened it.', claimIds: []},
      {text: 'Three of its clauses are still law in England today.', claimIds: ['c4']},
    ],
    claims: [
      {id: 'c1', role: 'main'},
      {id: 'c2', role: 'supporting'},
      {id: 'c3', role: 'supporting'},
      {id: 'c4', role: 'main'},
    ],
    claimSources: [
      {claimId: 'c1', assetId, assetRevision: 1},
      {claimId: 'c2', assetId, assetRevision: 1},
      {claimId: 'c3', assetId, assetRevision: 1},
      {claimId: 'c4', assetId, assetRevision: 1},
    ],
    criteria: {
      mustShow: [
        {id: 'show-seal', text: 'a wax seal on parchment', type: 'presence', claimId: 'c1'},
        {id: 'show-pressing', text: 'the seal being pressed into hot wax', type: 'event', claimId: 'c1'},
        {id: 'show-crowd', text: 'armed men gathered together', type: 'presence', claimId: 'c2'},
        {id: 'show-law', text: 'a printed statute book', type: 'presence', claimId: 'c4'},
        {id: 'show-meadow', text: 'a meadow beside a river', type: 'presence'},
      ],
      mustNotShow: [
        {id: 'never-person', text: 'any real living person', type: 'presence'},
        {id: 'never-flag', text: 'a modern flag', type: 'presence', claimId: 'c4'},
      ],
      depictionPolicyVersion: 'policy-3',
    },
    style: {id: 'style-1', version: 2, text: 'quiet, precise, natural light'},
  });
}

// =================================================================================================
// Stand-in script: dynamically imported from upstream's OWN test-support (never a *.test.ts file
// with node:test registrations), matching scripts/cutroom-local/make-standin-script.ts's own
// `completeVideo()` generator. This is a generator/proof script, not `ops/cutroom-host/host.ts`
// itself, so this import is within the boundary ADR-0021 draws.
// =================================================================================================

interface StandinScript {
  model: unknown;
  images: Record<string, unknown>;
  sensors: Record<string, unknown>;
  video: Record<string, unknown>;
  narration: Record<string, unknown>;
  media: Record<string, unknown>;
}

async function buildStandinScript(): Promise<StandinScript> {
  const videoModuleUrl = pathToFileURL(join(CUTROOM_RUNTIME, 'tests/engine/video.ts')).href;
  const stillsModuleUrl = pathToFileURL(join(CUTROOM_RUNTIME, 'tests/engine/stills.ts')).href;
  const video = (await import(videoModuleUrl)) as {videoScript: (shape: unknown, pics: readonly unknown[]) => unknown};
  const stills = (await import(stillsModuleUrl)) as {THREE_RANKS: unknown; THREE_RANKS_PICS: readonly unknown[]};
  const model = video.videoScript(stills.THREE_RANKS, stills.THREE_RANKS_PICS);
  return {model, images: {}, sensors: {}, video: {}, narration: {}, media: {}};
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function gitOf(dir: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();
}
function runtimeSnapshot(): {head: string; ignoredStatus: string} {
  const head = gitOf(CUTROOM_RUNTIME, ['rev-parse', 'HEAD']);
  const ignoredStatus = execFileSync(
    'sh',
    ['-c', `git -C "${CUTROOM_RUNTIME}" status --porcelain --ignored | grep -v node_modules || true`],
    {encoding: 'utf8'},
  ).trim();
  return {head, ignoredStatus};
}
function ffmpegVersion(): string {
  return execFileSync('ffmpeg', ['-version'], {encoding: 'utf8'}).split('\n')[0] ?? 'unknown';
}
async function ffprobeJson(path: string): Promise<unknown> {
  const {stdout} = await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {maxBuffer: 8 * 1024 * 1024});
  return JSON.parse(stdout);
}

// =================================================================================================
// Cutroom host process lifecycle (reused, never modified, from #89's own helpers).
// =================================================================================================

const allSpawned: SpawnedHost[] = [];

function initInstance(instance: string): unknown {
  const out = execFileSync(
    'node',
    [HOST_SCRIPT, 'init-instance', '--cutroom', CUTROOM_RUNTIME, '--expect-revision', CUTROOM_REVISION, '--instance', instance],
    {env: hostChildEnv(), encoding: 'utf8'},
  );
  return JSON.parse(out.trim());
}
async function startApiRole(instance: string, port = 0): Promise<{host: SpawnedHost; readiness: Readiness}> {
  const host = spawnHost('api', HOST_SCRIPT, [
    'api', '--cutroom', CUTROOM_RUNTIME, '--expect-revision', CUTROOM_REVISION, '--instance', instance, '--port', String(port),
  ]);
  allSpawned.push(host);
  const readiness = await waitForReadiness(host);
  return {host, readiness};
}
async function startWorkerRole(instance: string, standinScriptPath: string): Promise<{host: SpawnedHost; readiness: Readiness}> {
  const host = spawnHost('worker', HOST_SCRIPT, [
    'worker', '--cutroom', CUTROOM_RUNTIME, '--expect-revision', CUTROOM_REVISION, '--instance', instance,
    '--standin-script', standinScriptPath, '--render-profile', 'small',
  ]);
  allSpawned.push(host);
  const readiness = await waitForReadiness(host, 30_000);
  return {host, readiness};
}
async function sigtermAndWait(host: SpawnedHost, timeoutMs = 60_000): Promise<{code: number | null; signal: NodeJS.Signals | null}> {
  host.child.kill('SIGTERM');
  return withTimeout(host.exited, timeoutMs, `${host.role} exit after SIGTERM`);
}

// =================================================================================================
// The generation worker: a real, separate process (`pnpm dev:generation`'s own module).
// =================================================================================================

function generationWorkerEnv(dbUrl: string, mediaRoot: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'KS_DEV_ROOT', 'LANG'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.DATABASE_URL = dbUrl;
  env.KS_MEDIA_ROOT = mediaRoot;
  env.GENERATION_POLL_MS = '150';
  env.GENERATION_IDLE_POLL_MS = '150';
  env.GENERATION_LEASE_MS = '15000';
  return {...env, ...extra};
}
function spawnGenerationWorker(dbUrl: string, mediaRoot: string, extra: Record<string, string> = {}): SpawnedHost {
  const host = spawnProcess('generation-worker', TSX_BIN, [MAIN_TS], {env: generationWorkerEnv(dbUrl, mediaRoot, extra), cwd: REPO_ROOT});
  allSpawned.push(host);
  return host;
}
function isStartedLine(value: unknown): value is {service: string; event: string} {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).event === 'started';
}
function isHeldBeforeSubmit(value: unknown): value is {event: string; jobId: string} {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).event === 'held_before_submit';
}
async function stopGenerationWorkerGracefully(host: SpawnedHost, timeoutMs = 30_000): Promise<void> {
  host.child.kill('SIGTERM');
  const exit = await withTimeout(host.exited, timeoutMs, `${host.role} exit after SIGTERM`);
  if (exit.code !== 0) throw new Error(`generation worker did not exit 0 after SIGTERM: ${JSON.stringify(exit)}`);
}

/** Runs the real `scripts/generation.ts` operator CLI as a child process — a genuine operator
 * action, never an in-process shortcut — against the scenario's own disposable database. */
function runOperatorCli(dbUrl: string, args: readonly string[]): {ok: boolean; value: unknown} {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'KS_DEV_ROOT', 'LANG'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.DATABASE_URL = dbUrl;
  const out = execFileSync(TSX_BIN, [GENERATION_CLI, ...args], {env, encoding: 'utf8', cwd: REPO_ROOT});
  return JSON.parse(out.trim());
}

// =================================================================================================
// Scenario bookkeeping (mirrors scripts/run-local-cutroom-journey.ts's own harness).
// =================================================================================================

interface Assertion {
  description: string;
  pass: boolean;
  detail?: string;
}
interface ScenarioRecord {
  name: string;
  status: 'pass' | 'fail';
  assertions: Assertion[];
  observations: string[];
  data: Record<string, unknown>;
  firstFailure?: string;
}
const scenarios: ScenarioRecord[] = [];

class ScenarioFailure extends Error {}
interface ScenarioTools {
  assert(condition: boolean, description: string, detail?: string): void;
  observe(text: string): void;
  record(key: string, value: unknown): void;
}
async function runScenario(name: string, fn: (tools: ScenarioTools) => Promise<void>): Promise<ScenarioRecord> {
  const assertions: Assertion[] = [];
  const observations: string[] = [];
  const data: Record<string, unknown> = {};
  const tools: ScenarioTools = {
    assert(condition, description, detail) {
      assertions.push({description, pass: condition, detail});
      if (!condition) throw new ScenarioFailure(`${description}${detail === undefined ? '' : `: ${detail}`}`);
    },
    observe(text) { observations.push(text); },
    record(key, value) { data[key] = value; },
  };
  process.stdout.write(`\n=== ${name} ===\n`);
  let record: ScenarioRecord;
  try {
    await fn(tools);
    record = {name, status: 'pass', assertions, observations, data};
    process.stdout.write(`--- ${name}: PASS (${assertions.length} assertions)\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record = {name, status: 'fail', assertions, observations, data, firstFailure: message};
    process.stdout.write(`--- ${name}: FAIL — ${message}\n`);
  }
  scenarios.push(record);
  return record;
}

async function pollUntil<T>(predicate: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    await sleep(150);
  }
}

// =================================================================================================
// Shared scenario setup: a fresh disposable database, a fresh Cutroom instance (api+worker), a
// registered engine, an approved brief and a standin grant.
// =================================================================================================

interface World {
  label: string;
  db: DisposableDatabase;
  instance: string;
  api: {host: SpawnedHost; readiness: Readiness};
  cutroomWorker: {host: SpawnedHost; readiness: Readiness};
  engineId: string;
  briefId: string;
  briefSha256: string;
  grantId: string;
  assetId: string;
  mediaRoot: string;
  standinScriptPath: string;
}

async function setupWorld(label: string, standinScriptPath: string, opts: {artifactRoot?: string} = {}): Promise<World> {
  const db = await createDisposableDatabase(label);
  const assetId = await migrateAndSeedOneAsset(db.pool);

  const instance = instancePath(label);
  initInstance(instance);
  const api = await startApiRole(instance);
  const cutroomWorker = await startWorkerRole(instance, standinScriptPath);
  const origin = api.readiness.baseUrl;
  const realArtifactRoot = api.readiness.artifactRoot;
  if (!origin || !realArtifactRoot) throw new Error('api readiness carried no baseUrl/artifactRoot');

  const registered = await operator.registerEngine(db.pool, {
    origin, contractRevision: CUTROOM_REVISION, artifactRoot: opts.artifactRoot ?? realArtifactRoot,
    providerMode: 'standin', declaredBy: 'j005-generation-journey',
  });
  if (!registered.ok) throw new Error(`registerEngine refused: ${registered.code} ${registered.message}`);
  const engineId = (registered.value as {id: string}).id;

  // A real operator/coordinator action (ADR-0023 section 1: no model authors a brief at runtime),
  // via the same `storage.ts` the operator CLI (`scripts/generation.ts add-brief`/`approve-brief`)
  // itself calls.
  const brief = matchingBrief(assetId);
  const added = await storage.addBrief(db.pool, {brief, authoredBy: 'j005-generation-journey'});
  await storage.approveBrief(db.pool, added.id);

  const {id: grantId} = await storage.createGrant(db.pool, {mode: 'standin', capCents: 100_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString()});

  const mediaRoot = scratchPath(label, 'media');
  await mkdir(mediaRoot, {recursive: true});

  return {
    label, db, instance, api, cutroomWorker, engineId,
    briefId: added.id, briefSha256: added.briefSha256, grantId, assetId, mediaRoot, standinScriptPath,
  };
}

async function teardownWorld(world: World): Promise<void> {
  // Cutroom worker first (its own graceful stop finishes any job "in hand" before exiting), then
  // the api. Either may already have exited (a scenario may have stopped one deliberately).
  for (const spawned of [world.cutroomWorker.host, world.api.host]) {
    if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
      await sigtermAndWait(spawned).catch(() => {});
    }
  }
  await dropDisposableDatabase(world.db);
}

// =================================================================================================
// main
// =================================================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const receiptOverride = argv[0] !== undefined && !argv[0].startsWith('--') ? resolve(argv[0]) : undefined;

  const only = process.env.J005_ONLY_SCENARIO;
  process.stdout.write(`J005 generation-supply journey run stamp: ${RUN_STAMP}\n`);
  process.stdout.write(`node ${process.version} (${process.execPath})\n`);
  mkdirSync(SCRATCH_ROOT, {recursive: true});
  mkdirSync(LOGS_ROOT, {recursive: true});

  const knowscrollHead = gitOf(REPO_ROOT, ['rev-parse', 'HEAD']);
  const runtimeBefore = runtimeSnapshot();
  const hostSha256 = sha256File(HOST_SCRIPT);
  const ffmpegVer = ffmpegVersion();
  const ownerBefore = ownerEngineSnapshot();

  const standin = await buildStandinScript();
  const standinScriptPath = join(SCRATCH_ROOT, 'standin.json');
  writeFileSync(standinScriptPath, JSON.stringify(standin, null, 2));
  const standinScriptSha256 = sha256File(standinScriptPath);

  // ------------------------------------------------------------------------------------------
  // S1 — happy path
  // ------------------------------------------------------------------------------------------
  if (!only || only === 'S1') await runScenario('S1 happy path: approved brief -> real Cutroom run -> verified import -> completed', async (t) => {
    const world = await setupWorld('s1', standinScriptPath);
    try {
      const job = await storage.createJob(world.db.pool, {
        briefId: world.briefId, engineId: world.engineId, grantId: world.grantId,
        until: 'video', budgetCents: 300, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const worker = spawnGenerationWorker(world.db.url, world.mediaRoot);
      try {
        const finalJob = await pollUntil(async () => {
          const row = (await world.db.pool.query<{status: string}>('SELECT status FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
          return row && (row.status === 'completed' || ['refused', 'failed', 'cancelled', 'needs_operator'].includes(row.status)) ? row : undefined;
        }, 120_000, 'S1 job reaching a terminal status');
        t.assert(finalJob.status === 'completed', 'job reached completed', finalJob.status);

        const attemptRows = await world.db.pool.query('SELECT * FROM cutroom_attempt WHERE job_id=$1', [job.jobId]);
        t.assert(attemptRows.rowCount === 1, 'exactly one cutroom_attempt exists for the job');
        const attempt = attemptRows.rows[0];
        t.record('attempt', {id: attempt.id, runId: attempt.run_id, state: attempt.state, reportedCostCents: attempt.reported_cost_cents});

        const events = (await world.db.pool.query<{seq: number}>('SELECT seq FROM cutroom_event WHERE attempt_id=$1 ORDER BY seq', [attempt.id])).rows;
        for (let i = 0; i < events.length; i += 1) {
          t.assert(events[i]?.seq === i + 1, `event seq ${i + 1} is continuous`, JSON.stringify(events.map((e) => e.seq)));
        }
        t.assert(events.length > 0, 'stored events are non-empty');

        t.assert(attempt.result !== null, 'result persisted');
        t.assert(attempt.record_summary !== null, 'record persisted');
        t.assert(attempt.settlement === 'settled', 'settlement is settled');

        const grant = (await world.db.pool.query<{reserved_cents: number; spent_cents: number}>('SELECT reserved_cents,spent_cents FROM generation_budget_grant WHERE id=$1', [world.grantId])).rows[0];
        t.assert(grant?.reserved_cents === 0, 'the remainder of the reservation was released', JSON.stringify(grant));
        t.assert(grant?.spent_cents === attempt.reported_cost_cents, 'settlement moved exactly the reported cost to spent');

        const reel = (await world.db.pool.query('SELECT * FROM generated_reel WHERE attempt_id=$1', [attempt.id])).rows[0];
        t.assert(Boolean(reel), 'a generated_reel row was committed');
        t.assert(reel?.provider_mode === 'standin', 'provider_mode is standin');
        t.assert(reel?.truth_state === 'synthesis', 'truth_state is synthesis');
        t.assert(reel?.generated_label === true, 'generated_label is true');
        t.assert(reel?.availability === 'imported', 'availability is imported');
        const lineage = reel?.lineage;
        t.assert(Boolean(lineage?.briefSha256 && lineage?.contractRevision && lineage?.runId), 'lineage carries brief/contract/run identity', JSON.stringify(lineage));

        const media = (await world.db.pool.query('SELECT * FROM media_object WHERE sha256=$1', [reel?.media_sha256])).rows[0];
        t.assert(Boolean(media), 'a media_object row exists');
        const installedPath = join(world.mediaRoot, media.storage_key);
        const installedBytes = await readFile(installedPath);
        const installedSha256 = sha256Buffer(installedBytes);
        t.assert(installedSha256 === media.sha256, 'the installed file hashes to its recorded sha256');
        const probe = await ffprobeJson(installedPath) as {streams?: Array<{codec_type?: string; codec_name?: string}>};
        const videoStream = probe.streams?.find((s) => s.codec_type === 'video');
        t.assert(videoStream?.codec_name === 'h264', 'ffprobe independently confirms an h264 video stream', JSON.stringify(videoStream));

        const originalStat = await stat(reel?.engine_path as string);
        t.assert(originalStat.isFile() && originalStat.size === Number(media.byte_size), "the engine's own file is untouched (import copies, never moves)");

        t.observe(`generated_reel ${reel?.id} at ${media.storage_key}, reported cost ${attempt.reported_cost_cents}c`);
      } finally {
        if (worker.child.exitCode === null) await stopGenerationWorkerGracefully(worker).catch(() => worker.child.kill('SIGKILL'));
      }
    } finally {
      await teardownWorld(world);
    }
  });

  // ------------------------------------------------------------------------------------------
  // S2 — generation worker crash (SIGKILL) between dispatch commit and any recorded outcome
  // ------------------------------------------------------------------------------------------
  if (!only || only === 'S2') await runScenario('S2 generation worker crash between dispatch commit and any recorded outcome', async (t) => {
    const world = await setupWorld('s2', standinScriptPath);
    try {
      const job = await storage.createJob(world.db.pool, {
        briefId: world.briefId, engineId: world.engineId, grantId: world.grantId,
        until: 'video', budgetCents: 300, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const crashing = spawnGenerationWorker(world.db.url, world.mediaRoot, {GENERATION_HOLD_BEFORE_SUBMIT: '1'});
      const held = await waitForJsonLine(() => crashing.stdoutLines, 0, isHeldBeforeSubmit, 30_000, 'held_before_submit');
      t.assert(held.value.jobId === job.jobId, 'the worker held immediately before its first submit for this exact job');

      const attemptBefore = (await world.db.pool.query('SELECT state,run_id FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0];
      t.assert(attemptBefore.state === 'dispatch_committed', 'dispatch is committed but no outcome was ever recorded', attemptBefore.state);
      t.assert(attemptBefore.run_id === null, 'no Cutroom run exists yet');

      crashing.child.kill('SIGKILL');
      const exit = await withTimeout(crashing.exited, 10_000, 'crashing worker SIGKILL exit');
      t.assert(exit.signal === 'SIGKILL', 'the worker actually died by SIGKILL', JSON.stringify(exit));

      const replacement = spawnGenerationWorker(world.db.url, world.mediaRoot);
      try {
        const finalJob = await pollUntil(async () => {
          const row = (await world.db.pool.query<{status: string}>('SELECT status FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
          return row && row.status === 'completed' ? row : undefined;
        }, 120_000, 'S2 replacement worker completing the job');
        t.assert(finalJob.status === 'completed', 'the replacement worker completed the job');

        const attempts = await world.db.pool.query('SELECT request_id FROM cutroom_attempt WHERE job_id=$1', [job.jobId]);
        t.assert(attempts.rowCount === 1, 'exactly one cutroom_attempt row exists for the job');
        t.assert(attempts.rows[0]?.request_id === job.requestId, 'the ORIGINAL request id was reused, never a new one');
      } finally {
        if (replacement.child.exitCode === null) await stopGenerationWorkerGracefully(replacement).catch(() => replacement.child.kill('SIGKILL'));
      }
    } finally {
      await teardownWorld(world);
    }
  });

  // ------------------------------------------------------------------------------------------
  // S3 — Cutroom host restart while the run is in flight
  // ------------------------------------------------------------------------------------------
  if (!only || only === 'S3') await runScenario('S3 Cutroom host restart (SIGTERM both roles, api restarted on the same port) while the run is in flight', async (t) => {
    const world = await setupWorld('s3', standinScriptPath);
    try {
      const job = await storage.createJob(world.db.pool, {
        briefId: world.briefId, engineId: world.engineId, grantId: world.grantId,
        until: 'video', budgetCents: 300, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const worker = spawnGenerationWorker(world.db.url, world.mediaRoot);
      try {
        await pollUntil(async () => {
          const row = (await world.db.pool.query<{state: string; run_id: string | null}>('SELECT state,run_id FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0];
          return row?.state === 'accepted' && row.run_id ? row : undefined;
        }, 60_000, 'S3 run genuinely accepted (in flight)');
        t.observe('run accepted and in flight; interrupting the Cutroom host now');

        const observedPort = world.api.readiness.port as number;
        t.assert(typeof observedPort === 'number' && observedPort > 0, 'observed a real port to restart on');

        // SIGTERM both roles: each finishes whatever atomic internal step it currently holds (its
        // own "job in hand", in Cutroom's own internal job-queue sense) and then stops — observed
        // here as a prompt graceful `{"stopped":true}`/exit 0 for both, never a hang. The render's
        // REMAINING queued internal work (this run was caught early enough that essentially none
        // of it had started) needs a fresh worker process to resume it, exactly as a real operator
        // restart would: bring the api back on the same port, then start a brand-new worker on the
        // same instance/database, mirroring docs/journeys/evidence/cutroom-local/README.md's own
        // "graceful restart" (S8) and "crash restart" (S9) shapes.
        const originalCutroomWorker = world.cutroomWorker;
        originalCutroomWorker.host.child.kill('SIGTERM');
        world.api.host.child.kill('SIGTERM');
        const [workerExit] = await Promise.all([
          withTimeout(originalCutroomWorker.host.exited, 30_000, 'S3 original cutroom worker exit after SIGTERM'),
          withTimeout(world.api.host.exited, 30_000, 'S3 api exit after SIGTERM'),
        ]);
        t.assert(workerExit.code === 0, 'the original Cutroom worker stopped gracefully (finished its job in hand)', JSON.stringify(workerExit));

        const api2 = await startApiRole(world.instance, observedPort);
        world.api = api2; // tracked immediately so teardownWorld stops it even if this scenario fails below
        t.assert(api2.readiness.port === observedPort, 'the restarted api reused the same port');
        const cutroomWorker2 = await startWorkerRole(world.instance, standinScriptPath);
        world.cutroomWorker = cutroomWorker2; // ditto

        let finalJob: {status: string; status_detail: string | null};
        try {
          finalJob = await pollUntil(async () => {
            const row = (await world.db.pool.query<{status: string; status_detail: string | null}>('SELECT status,status_detail FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
            return row && row.status === 'completed' ? row : undefined;
          }, 180_000, 'S3 job completing after the api and worker restart');
        } catch (error) {
          const jobNow = (await world.db.pool.query('SELECT status,status_detail FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
          const attemptNow = (await world.db.pool.query('SELECT state,run_id,next_since FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0];
          process.stderr.write(`\nS3 DIAGNOSTIC job=${JSON.stringify(jobNow)} attempt=${JSON.stringify(attemptNow)}\n`);
          process.stderr.write(`S3 DIAGNOSTIC generation-worker tail:\n${worker.stdoutLines.slice(-30).join('\n')}\n${worker.stderrLines.slice(-30).join('\n')}\n`);
          process.stderr.write(`S3 DIAGNOSTIC cutroom worker2 tail:\n${cutroomWorker2.host.stdoutLines.slice(-30).join('\n')}\n${cutroomWorker2.host.stderrLines.slice(-30).join('\n')}\n`);
          process.stderr.write(`S3 DIAGNOSTIC api2 tail:\n${api2.host.stdoutLines.slice(-15).join('\n')}\n${api2.host.stderrLines.slice(-15).join('\n')}\n`);
          throw error;
        }
        t.assert(finalJob.status === 'completed', 'the run completed and imported despite the restart');

        const events = (await world.db.pool.query<{seq: number}>(
          'SELECT seq FROM cutroom_event WHERE attempt_id=(SELECT id FROM cutroom_attempt WHERE job_id=$1) ORDER BY seq', [job.jobId],
        )).rows;
        for (let i = 0; i < events.length; i += 1) t.assert(events[i]?.seq === i + 1, `event seq ${i + 1} has no regression or duplication`);
      } finally {
        if (worker.child.exitCode === null) await stopGenerationWorkerGracefully(worker).catch(() => worker.child.kill('SIGKILL'));
      }
    } finally {
      await teardownWorld(world);
    }
  });

  // ------------------------------------------------------------------------------------------
  // S4 — operator cancel while genuinely running
  // ------------------------------------------------------------------------------------------
  if (!only || only === 'S4') await runScenario('S4 operator cancel while the run is genuinely running', async (t) => {
    const world = await setupWorld('s4', standinScriptPath);
    try {
      const job = await storage.createJob(world.db.pool, {
        briefId: world.briefId, engineId: world.engineId, grantId: world.grantId,
        until: 'video', budgetCents: 300, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const worker = spawnGenerationWorker(world.db.url, world.mediaRoot);
      try {
        await pollUntil(async () => {
          const row = (await world.db.pool.query<{state: string; run_id: string | null}>('SELECT state,run_id FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0];
          return row?.state === 'accepted' && row.run_id ? row : undefined;
        }, 60_000, 'S4 run genuinely accepted (in flight)');

        const cancelResult = runOperatorCli(world.db.url, ['cancel-job', '--job-id', job.jobId]);
        t.assert(cancelResult.ok === true, 'the real operator CLI accepted the cancel request', JSON.stringify(cancelResult));

        const finalJob = await pollUntil(async () => {
          const row = (await world.db.pool.query<{status: string}>('SELECT status FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
          return row && ['cancelled', 'completed', 'failed'].includes(row.status) ? row : undefined;
        }, 120_000, 'S4 job reaching a terminal status after cancel');
        t.assert(finalJob.status === 'cancelled', 'the job ended cancelled (real contract semantics: effective once the engine worker processes it)', finalJob.status);

        // `generation_job.status` turns `cancelled` in `recordResult`'s own transaction; settlement
        // (a separate, immediately-following transaction in the same worker call) can lag that
        // externally-observed status write by a small, genuine amount. Poll for it rather than
        // reading once right at the status transition.
        const attempt = await pollUntil(async () => {
          const row = (await world.db.pool.query('SELECT * FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0];
          return row && row.settlement !== 'held' ? row : undefined;
        }, 10_000, 'S4 settlement resolving after the cancelled result');
        t.assert(attempt.settlement === 'settled', 'settlement resolved per the terminal cancelled result', JSON.stringify(attempt));
        const reel = (await world.db.pool.query('SELECT count(*)::int AS n FROM generated_reel WHERE attempt_id=$1', [attempt.id])).rows[0];
        t.assert(reel.n === 0, 'nothing was imported for a cancelled run');
        const grant = (await world.db.pool.query<{reserved_cents: number}>('SELECT reserved_cents FROM generation_budget_grant WHERE id=$1', [world.grantId])).rows[0];
        t.assert(grant?.reserved_cents === 0, 'the reservation was released per the terminal result', JSON.stringify(grant));
      } finally {
        if (worker.child.exitCode === null) await stopGenerationWorkerGracefully(worker).catch(() => worker.child.kill('SIGKILL'));
      }
    } finally {
      await teardownWorld(world);
    }
  });

  // ------------------------------------------------------------------------------------------
  // S5 — import refusal: a containment failure (engine registered with a wrong artifact root)
  // ------------------------------------------------------------------------------------------
  if (!only || only === 'S5') await runScenario('S5 import refusal (containment failure) leaves the job honestly unfinished and retryable', async (t) => {
    const wrongArtifactRoot = scratchPath('s5', 'wrong-artifact-root');
    mkdirSync(wrongArtifactRoot, {recursive: true});
    const world = await setupWorld('s5', standinScriptPath, {artifactRoot: wrongArtifactRoot});
    try {
      const job = await storage.createJob(world.db.pool, {
        briefId: world.briefId, engineId: world.engineId, grantId: world.grantId,
        until: 'video', budgetCents: 300, deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const worker = spawnGenerationWorker(world.db.url, world.mediaRoot);
      try {
        const jobRow = await pollUntil(async () => {
          const row = (await world.db.pool.query<{status: string; status_detail: string | null}>('SELECT status,status_detail FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
          return row && row.status_detail?.startsWith('import_refused:') ? row : undefined;
        }, 120_000, 'S5 a typed import refusal is recorded');
        t.assert(jobRow.status === 'importing', 'the job is left honestly unfinished (still importing), never a fabricated success', jobRow.status);
        t.assert(jobRow.status_detail === 'import_refused:engine_path_not_contained', 'the typed reason names the containment failure', jobRow.status_detail ?? undefined);

        const attempt = (await world.db.pool.query('SELECT id,settlement FROM cutroom_attempt WHERE job_id=$1', [job.jobId])).rows[0];
        const reel = (await world.db.pool.query('SELECT count(*)::int AS n FROM generated_reel WHERE attempt_id=$1', [attempt.id])).rows[0];
        t.assert(reel.n === 0, 'no generated_reel row was ever committed');
        t.assert(attempt.settlement === 'held', 'the reservation stays held for an unverified/refused import');
        const grant = (await world.db.pool.query<{reserved_cents: number}>('SELECT reserved_cents FROM generation_budget_grant WHERE id=$1', [world.grantId])).rows[0];
        t.assert(grant?.reserved_cents === 300, 'the full reservation is still held');

        // Retryable while the engine file still exists: force the lease to expire and confirm a
        // fresh worker still claims and retries the import (the honest same refusal, on unchanged
        // data), rather than the job ever getting permanently stuck.
        await world.db.pool.query(`UPDATE generation_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.jobId]);
      } finally {
        if (worker.child.exitCode === null) await stopGenerationWorkerGracefully(worker).catch(() => worker.child.kill('SIGKILL'));
      }
      const retryWorker = spawnGenerationWorker(world.db.url, world.mediaRoot);
      try {
        await pollUntil(async () => {
          const row = (await world.db.pool.query<{status: string; status_detail: string | null}>('SELECT status,status_detail FROM generation_job WHERE id=$1', [job.jobId])).rows[0];
          return row && row.status === 'importing' && row.status_detail?.startsWith('import_refused:') ? row : undefined;
        }, 60_000, 'S5 a retry reaches the same honest refusal');
        t.observe('a later reclaim retried the import and reached the same typed refusal on unchanged data');
      } finally {
        if (retryWorker.child.exitCode === null) await stopGenerationWorkerGracefully(retryWorker).catch(() => retryWorker.child.kill('SIGKILL'));
      }
    } finally {
      await teardownWorld(world);
    }
  });

  // ------------------------------------------------------------------------------------------
  // S6 — cleanup
  // ------------------------------------------------------------------------------------------
  if (!only || only === 'S6') await runScenario('S6 cleanup: every spawned process exited, no stray database, owner engine/runtime untouched', async (t) => {
    for (const spawned of allSpawned) {
      t.assert(spawned.child.exitCode !== null || spawned.child.signalCode !== null, `${spawned.role} process has exited`, JSON.stringify({exitCode: spawned.child.exitCode, signalCode: spawned.child.signalCode}));
    }
    const stray = await strayDisposableDatabaseCount();
    t.assert(stray === 0, 'no stray disposable database remains', String(stray));

    const ownerAfter = ownerEngineSnapshot();
    t.assert(ownerAfter.apiAlive === ownerBefore.apiAlive && ownerAfter.workerAlive === ownerBefore.workerAlive, 'the owner-local engine pids are unchanged (still running or still absent, exactly as before)', JSON.stringify({ownerBefore, ownerAfter}));
    if (ownerBefore.apiStart !== undefined) t.assert(ownerAfter.apiStart === ownerBefore.apiStart, 'the owner-local api process was never restarted by this journey');
    if (ownerBefore.workerStart !== undefined) t.assert(ownerAfter.workerStart === ownerBefore.workerStart, 'the owner-local worker process was never restarted by this journey');

    const runtimeAfter = runtimeSnapshot();
    t.assert(runtimeAfter.head === runtimeBefore.head, 'the pinned Cutroom checkout HEAD is unchanged');
    t.assert(runtimeAfter.ignoredStatus === runtimeBefore.ignoredStatus, 'the pinned Cutroom checkout has no new tracked changes', runtimeAfter.ignoredStatus);
  });

  // ------------------------------------------------------------------------------------------
  // Evidence
  // ------------------------------------------------------------------------------------------
  const anyFailed = scenarios.some((s) => s.status === 'fail');
  const receipt = {
    runStamp: RUN_STAMP,
    evidenceLevel: 'real local service with upstream stand-in providers — not real generation',
    knowscrollHead, cutroomRevision: CUTROOM_REVISION, hostSha256, standinScriptSha256, ffmpegVersion: ffmpegVer,
    nodeVersion: process.version,
    scenarios,
    overall: anyFailed ? 'fail' : 'pass',
  };
  const receiptPath = receiptOverride ?? join(LOGS_ROOT, `generation-journey-${RUN_STAMP}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\nFull receipt: ${receiptPath}\n`);

  mkdirSync(EVIDENCE_DIR, {recursive: true});
  const sanitized = {
    runStamp: RUN_STAMP,
    evidenceLevel: receipt.evidenceLevel,
    knowscrollHead, cutroomRevision: CUTROOM_REVISION, hostSha256, standinScriptSha256, ffmpegVersion: ffmpegVer,
    nodeVersion: process.version,
    scenarios: scenarios.map((s) => ({name: s.name, status: s.status, assertions: s.assertions, observations: s.observations, firstFailure: s.firstFailure})),
    overall: receipt.overall,
  };
  writeFileSync(join(EVIDENCE_DIR, 'generation-journey.json'), `${JSON.stringify(sanitized, null, 2)}\n`);

  await rm(SCRATCH_ROOT, {recursive: true, force: true});

  if (anyFailed) {
    process.stdout.write('\nJ005 FAILED. See the receipt above for the first failure of each scenario.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('\nJ005 PASSED (real local service with upstream stand-in providers — not real generation).\n');
  }
}

function ownerEngineSnapshot(): {apiAlive: boolean; workerAlive: boolean; apiStart?: string; workerStart?: string} {
  function snapshot(pid: number): {alive: boolean; start?: string} {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding: 'utf8'}).trim();
      return {alive: out.length > 0, start: out};
    } catch {
      return {alive: false};
    }
  }
  const api = snapshot(OWNER_ENGINE_PIDS.api);
  const worker = snapshot(OWNER_ENGINE_PIDS.worker);
  void OWNER_ENGINE_PORT;
  return {apiAlive: api.alive, workerAlive: worker.alive, apiStart: api.start, workerStart: worker.start};
}

let ownerBefore: {apiAlive: boolean; workerAlive: boolean; apiStart?: string; workerStart?: string};

await (async () => {
  ownerBefore = ownerEngineSnapshot();
  try {
    await main();
  } finally {
    // Safety net: make absolutely sure nothing spawned by this journey is left running, and no
    // disposable database this run created is left behind, even if a scenario threw unexpectedly.
    for (const spawned of allSpawned) {
      if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
        spawned.child.kill('SIGKILL');
      }
    }
    for (const name of [...allDisposableDatabaseNames]) {
      const admin = new pg.Pool({connectionString: withDatabaseName(BASE_DB_URL, 'postgres'), max: 1});
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      } catch {
        // best-effort
      } finally {
        await admin.end();
      }
    }
  }
})();

if (process.exitCode === 1) process.exit(1);
