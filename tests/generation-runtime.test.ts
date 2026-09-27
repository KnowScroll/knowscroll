/** ADR-0023, issue #94 stage A1 ("runtime" lane): proves the generation worker loop
 * (apps/worker/src/generation/worker.ts) end to end against a local HTTP fixture that speaks the
 * pinned Cutroom wire contract, the way `tests/cutroom-http.test.ts` does — never the real running
 * stand-in engine on 127.0.0.1:4390. This is fixture/source proof only: it never claims real
 * generation, a product journey or owner acceptance. Storage-level admission/lease/event/
 * settlement behaviour is proved without HTTP in `tests/generation-admission.test.ts`. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import pg from 'pg';
import {generationBrief, type GenerationBrief} from '../packages/contracts/src/generation.ts';
import * as storage from '../apps/worker/src/generation/storage.ts';
import {createLocalImportPort} from '../apps/worker/src/generation/import-port.ts';
import {processClaimedJob} from '../apps/worker/src/generation/worker.ts';
import {drainStrayJobs} from './helpers/generation-fixture.ts';

const execFileAsync = promisify(execFile);

const databaseUrl = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith('knowscroll_test_')) {
  throw new Error(`Generation runtime tests require a disposable knowscroll_test_* database, received ${databaseName}`);
}

const pool = new pg.Pool({connectionString: databaseUrl, max: 12});

// --- Fixtures: brief/engine/brief/grant/job helpers, mirroring generation-admission.test.ts -----

const claimRef = (id: string, role: 'main' | 'supporting') => ({id, role});
const sentence = (text: string, claimIds: string[]) => ({text, claimIds});
function makeBrief(assetId: string): GenerationBrief {
  return generationBrief.parse({
    version: 1, worldId: `library-world-${randomUUID()}`,
    narration: [
      sentence('A wax seal closes the charter.', ['claim-seal']),
      sentence('The barons gather in the stone hall.', ['claim-hall']),
      sentence('A king sets his hand to the page.', ['claim-king']),
      sentence('The copy leaves for the shires.', ['claim-seal']),
    ],
    claims: [claimRef('claim-seal', 'main'), claimRef('claim-hall', 'supporting'), claimRef('claim-king', 'supporting')],
    claimSources: [
      {claimId: 'claim-seal', assetId, assetRevision: 1},
      {claimId: 'claim-hall', assetId, assetRevision: 1},
      {claimId: 'claim-king', assetId, assetRevision: 1},
    ],
    criteria: {
      mustShow: [{id: 'show-seal', text: 'A wax seal.', type: 'presence', claimId: 'claim-seal'}],
      mustNotShow: [{id: 'never-flag', text: 'A modern flag.', type: 'presence'}],
      depictionPolicyVersion: 'depiction-v1',
    },
    style: {id: 'library', version: 1, text: 'Quiet, documentary, no captions burned in.'},
  });
}
function future(ms = 3_600_000): string { return new Date(Date.now() + ms).toISOString(); }
let assetId: string;

async function approvedBrief() {
  const {id} = await storage.addBrief(pool, {brief: makeBrief(assetId), authoredBy: 'generation-runtime-test'});
  await storage.approveBrief(pool, id);
  return id;
}
async function freshGrant(capCents = 10_000) {
  const {id} = await storage.createGrant(pool, {mode: 'standin', capCents, expiresAt: future()});
  return id;
}

// --- A minimal, fully local, in-process fake of the pinned Cutroom wire contract -----------------
// Real HTTP, real sockets, on 127.0.0.1 — but a hand-built fixture server, never the real stand-in
// engine (which this lane must not stop, restart or submit real runs to). Test code drives its
// state machine explicitly (`finish()`), matching how `ops/cutroom-host/README.md` and
// `docs/journeys/evidence/cutroom-local/README.md` describe a real engine behaving: a run stays
// `running` until something actually processes it.

type FakeRun = {
  runId: string; requestId: string; bodyJson: string; until: 'plan' | 'stills' | 'video';
  state: 'running' | 'finished'; cancelRequested: boolean;
  events: Array<Record<string, unknown>>;
  result?: unknown; record?: unknown;
};
type Fault = {mode: 'before' | 'after'; remaining: number};

function createFakeCutroomServer() {
  const runs = new Map<string, FakeRun>();
  const byRequestId = new Map<string, string>();
  const forcedRefusals = new Map<string, {status: 409 | 422; reason: string; detail: string}>();
  const faults = new Map<string, Fault>();

  function json(res: ServerResponse, code: number, value: unknown) {
    // Never pool/keep-alive: each fixture server binds a fresh ephemeral OS port per subtest, and
    // an OS-recycled port number could otherwise let the client's connection pool confuse a new
    // fixture server with an old, already-closed one immediately after a socket-destroy fault.
    res.writeHead(code, {'content-type': 'application/json', connection: 'close'});
    res.end(JSON.stringify(value));
  }
  function addEvent(run: FakeRun, type: string, extra: Record<string, unknown> = {}) {
    run.events.push({contractVersion: 1, runId: run.runId, seq: run.events.length + 1, at: new Date().toISOString(), type, ...extra});
  }
  function statusOf(run: FakeRun) {
    return {contractVersion: 1, runId: run.runId, requestId: run.requestId, state: run.state, lastSeq: run.events.length};
  }

  function handleSubmit(req: IncomingMessage, res: ServerResponse, body: string) {
    const parsed = JSON.parse(body) as {requestId: string; options: {until: 'plan' | 'stills' | 'video'}};
    const requestId = parsed.requestId;
    const forced = forcedRefusals.get(requestId);
    if (forced) { json(res, forced.status, {contractVersion: 1, outcome: 'refused', requestId, reason: forced.reason, detail: forced.detail}); return; }

    const existingRunId = byRequestId.get(requestId);
    const fault = faults.get(requestId);
    if (!existingRunId && fault && fault.mode === 'before' && fault.remaining > 0) {
      fault.remaining -= 1;
      req.socket.destroy(); // Never processed at all: a genuine non-delivery.
      return;
    }
    let run = existingRunId ? runs.get(existingRunId) : undefined;
    let replayed = true;
    if (!run) {
      run = {runId: randomUUID(), requestId, bodyJson: body, until: parsed.options.until, state: 'running', cancelRequested: false, events: []};
      runs.set(run.runId, run);
      byRequestId.set(requestId, run.runId);
      addEvent(run, 'run.accepted');
      replayed = false;
    } else if (run.bodyJson !== body) {
      json(res, 409, {contractVersion: 1, outcome: 'refused', requestId, reason: 'conflict', detail: 'A run already exists for this requestId with a different body.'});
      return;
    }
    if (fault && fault.mode === 'after' && fault.remaining > 0) {
      fault.remaining -= 1;
      req.socket.destroy(); // Processed and a run exists, but the acknowledgement is lost.
      return;
    }
    json(res, 202, {contractVersion: 1, outcome: 'accepted', requestId, runId: run.runId, replayed});
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        if (req.method === 'POST' && url.pathname === '/v1/runs') { handleSubmit(req, res, body); return; }
        if (req.method === 'GET' && url.pathname === '/v1/runs') {
          const requestId = url.searchParams.get('requestId');
          const runId = requestId ? byRequestId.get(requestId) : undefined;
          const run = runId ? runs.get(runId) : undefined;
          if (!run) { json(res, 404, {contractVersion: 1, error: 'not-found', detail: 'no run for that requestId'}); return; }
          json(res, 200, statusOf(run));
          return;
        }
        const match = /^\/v1\/runs\/([^/]+)(?:\/(cancel|events|result|record))?$/.exec(url.pathname);
        if (match) {
          const runId = decodeURIComponent(match[1] as string);
          const run = runs.get(runId);
          if (!run) { json(res, 404, {contractVersion: 1, error: 'not-found', detail: 'unknown run'}); return; }
          const sub = match[2];
          if (!sub && req.method === 'GET') { json(res, 200, statusOf(run)); return; }
          if (sub === 'cancel' && req.method === 'POST') { run.cancelRequested = true; json(res, 200, statusOf(run)); return; }
          if (sub === 'events' && req.method === 'GET') {
            const since = Number(url.searchParams.get('since') ?? '0');
            const events = run.events.filter((event) => (event.seq as number) > since);
            const nextSince = events.length > 0 ? (events[events.length - 1] as {seq: number}).seq : since;
            json(res, 200, {contractVersion: 1, runId: run.runId, events, nextSince});
            return;
          }
          if (sub === 'result' && req.method === 'GET') {
            if (run.state !== 'finished') { json(res, 409, statusOf(run)); return; }
            json(res, 200, run.result); return;
          }
          if (sub === 'record' && req.method === 'GET') {
            if (run.state !== 'finished') { json(res, 409, statusOf(run)); return; }
            json(res, 200, run.record); return;
          }
        }
        json(res, 404, {contractVersion: 1, error: 'not-found', detail: 'no route'});
      } catch (error) {
        json(res, 500, {contractVersion: 1, error: 'internal', detail: error instanceof Error ? error.message : String(error)});
      }
    });
  });

  return {
    server,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}`;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    forceRefuse(requestId: string, status: 409 | 422, reason: string, detail: string) { forcedRefusals.set(requestId, {status, reason, detail}); },
    dropOnce(requestId: string, mode: 'before' | 'after', times: number) { faults.set(requestId, {mode, remaining: times}); },
    wasCancelled(runId: string) { return runs.get(runId)?.cancelRequested ?? false; },
    runByRequestId(requestId: string) { const runId = byRequestId.get(requestId); return runId ? runs.get(runId) : undefined; },
    hasAnyRunFor(requestId: string) { return byRequestId.has(requestId); },
    finish(runId: string, outcome: {status: 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled'; costCents: number; extra?: Record<string, unknown>}) {
      const run = runs.get(runId);
      assert(run, `finish() called for an unknown run ${runId}`);
      const stages: Array<'plan' | 'stills' | 'video'> = run.until === 'plan' ? ['plan'] : run.until === 'stills' ? ['plan', 'stills'] : ['plan', 'stills', 'video'];
      for (const stage of stages) { addEvent(run, 'stage.started', {stage}); addEvent(run, 'stage.finished', {stage}); }
      addEvent(run, 'run.finished', {status: outcome.status});
      run.state = 'finished';
      run.result = {contractVersion: 1, runId: run.runId, requestId: run.requestId, status: outcome.status, costCents: outcome.costCents, ...(outcome.extra ?? {})};
      run.record = {contractVersion: 1, runId: run.runId, pictures: [], takes: [], degradations: []};
    },
  };
}
type FakeCutroomServer = ReturnType<typeof createFakeCutroomServer>;

const DEFAULT_FAKE_ARTIFACT_ROOT = '/Volumes/Mrigesh SSD/knowscroll-dev/cutroom/instances/generation-runtime-test/artifacts';
async function registeredEngine(origin: string, artifactRoot: string) {
  const {id} = await storage.registerEngine(pool, {
    origin, contractRevision: storage.CUTROOM_CONTRACT_REVISION,
    artifactRoot, providerMode: 'standin', declaredBy: 'generation-runtime-test',
  });
  return id;
}
async function withFakeEngine(
  body: (engine: FakeCutroomServer, engineId: string) => Promise<void>,
  artifactRoot: string = DEFAULT_FAKE_ARTIFACT_ROOT,
): Promise<void> {
  const engine = createFakeCutroomServer();
  const origin = await engine.listen();
  try {
    const engineId = await registeredEngine(origin, artifactRoot);
    await body(engine, engineId);
  } finally {
    await engine.close();
  }
}
function attemptRow(jobId: string) {
  return pool.query('SELECT * FROM cutroom_attempt WHERE job_id=$1 AND ordinal=1', [jobId]).then((r) => r.rows[0]);
}
function jobRow(jobId: string) {
  return pool.query('SELECT * FROM generation_job WHERE id=$1', [jobId]).then((r) => r.rows[0]);
}
function grantRow(grantId: string) {
  return pool.query('SELECT reserved_cents,spent_cents,overage_cents,admission_paused_at FROM generation_budget_grant WHERE id=$1', [grantId]).then((r) => r.rows[0]);
}
async function pollUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('pollUntil timed out');
}

// --- Real-file import fixtures (issue #94 stage A2): a genuine ffmpeg-made MP4 and a scratch ----
// engine-artifact-root/media-root pair per subtest, never the real stand-in engine on :4390. -----

interface ImportWorld { base: string; engineArtifactRoot: string; mediaRoot: string }

async function makeImportWorld(): Promise<ImportWorld> {
  const base = await mkdtemp(join(tmpdir(), 'ks-generation-runtime-import-'));
  const engineArtifactRoot = join(base, 'artifacts');
  const mediaRoot = join(base, 'media');
  await mkdir(engineArtifactRoot, {recursive: true});
  await mkdir(mediaRoot, {recursive: true});
  return {base, engineArtifactRoot, mediaRoot};
}
async function cleanupImportWorld(world: ImportWorld): Promise<void> {
  await rm(world.base, {recursive: true, force: true});
}
async function makeVideoFixture(path: string, durationSeconds: number): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=size=108x192:duration=${durationSeconds}:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', path,
  ]);
}
async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

test('ADR-0023 generation worker: real local HTTP fixture, full lifecycle', async (t) => {
  assetId = (await pool.query<{id: string}>('SELECT id FROM asset ORDER BY editorial_order LIMIT 1')).rows[0]?.id as string;
  assert.ok(assetId, 'the seeded library has at least one asset');
  await drainStrayJobs(pool, 'generation-runtime-test-sweep');
  try {

  await t.test('a job still held under a live lease is drained too, so that lease cannot run out into a later claim', async () => {
    await withFakeEngine(async (_engine, engineId) => {
      const job = await storage.createJob(pool, {briefId: await approvedBrief(), engineId, grantId: await freshGrant(), until: 'plan', budgetCents: 10, deadlineAt: future()});
      const leased = await storage.claimJob(pool, {owner: 'an-earlier-worker', leaseMs: 1_000});
      assert.equal(leased?.jobId, job.jobId);
      await drainStrayJobs(pool, 'generation-runtime-test-sweep');
      await pollUntil(async () => (await pool.query<{passed: boolean}>('SELECT clock_timestamp()>$1 AS passed', [leased!.leaseExpiresAt])).rows[0]!.passed);
      assert.equal(await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000}), null, 'the other worker\'s lease has run out, and its job is still not claimable here');
    });
  });

  await t.test('dispatches once, follows a real HTTP run to completion, and leaves an unwired import port honestly unfinished (reservation stays held)', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 300, deadlineAt: future()});
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      assert.equal(claim?.jobId, job.jobId);

      const logs: Record<string, unknown>[] = [];
      const importCalls: Array<{attemptId: string; runId: string; enginePath: string; engineArtifactRoot: string}> = [];
      const spyImportPort = {
        async importFinishedVideo(input: {attemptId: string; runId: string; enginePath: string; engineArtifactRoot: string}) {
          importCalls.push(input);
          throw new Error('import_port_not_implemented: the media import lane is not wired into this stage');
        },
      };
      const processing = processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500, log: (line) => logs.push(line), importPort: spyImportPort}, claim!);
      await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
      const run = engine.runByRequestId(job.requestId);
      assert.ok(run, 'the fixture actually received the real submit');
      assert.equal((await attemptRow(job.jobId)).replayed, false);
      engine.finish(run!.runId, {status: 'completed', costCents: 210, extra: {until: 'video', estimateCents: 210, stills: [], video: {path: '/artifacts/run/fixture.mp4'}, degradations: []}});
      const outcome = await processing;

      // A wiring defect (no real port configured) never fabricates completion OR a typed refusal:
      // the job stays honestly `importing`, and — per ADR-0023 ("a missing or unverifiable result
      // keeps the whole reservation held") — settlement is deferred until a real import succeeds.
      assert.equal(outcome.outcome, 'importing');
      assert.equal((await jobRow(job.jobId)).status, 'importing');
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'finished');
      assert.equal(attempt.settlement, 'held', 'settlement is deferred to a successful import, not the raw terminal result');
      assert.equal(attempt.reported_cost_cents, 210);
      assert.ok(attempt.record_summary, 'the record summary was fetched and stored');
      const grant = await grantRow(grantId);
      assert.equal(grant.reserved_cents, 300, 'the whole reservation stays held while the result is unverified');
      assert.equal(grant.spent_cents, 0);
      assert.ok(logs.some((line) => line.event === 'import_not_available'), 'the worker logs honestly instead of fabricating an import');
      assert.equal(importCalls.length, 1);
      assert.equal(importCalls[0]?.attemptId, attempt.id);
      assert.equal(importCalls[0]?.runId, run!.runId);
      assert.equal(importCalls[0]?.enginePath, '/artifacts/run/fixture.mp4', 'the untrusted engine path from the result is handed to the import port unchanged');
      assert.equal(importCalls[0]?.engineArtifactRoot, '/Volumes/Mrigesh SSD/knowscroll-dev/cutroom/instances/generation-runtime-test/artifacts');
    });
  });

  await t.test('a reported cost above the job ceiling is recorded as overage, pauses the grant and parks the job', async () => {
    // ADR-0012/ADR-0023: real spend is never clamped to a reservation. The asset stays imported,
    // the excess is recorded, the grant stops admitting work and an operator is told — the job must
    // not quietly complete, and it must not retry the same failing settlement forever.
    const world = await makeImportWorld();
    try {
      await withFakeEngine(async (engine, engineId) => {
        const briefId = await approvedBrief();
        const grantId = await freshGrant();
        const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 200, deadlineAt: future()});
        const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
        const enginePath = join(world.engineArtifactRoot, 'over', 'a1-render.mp4');
        await mkdir(dirname(enginePath), {recursive: true});
        await makeVideoFixture(enginePath, 6);

        const processing = processClaimedJob(
          {db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500, importPort: createLocalImportPort(world.mediaRoot)},
          claim!,
        );
        await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
        const run = engine.runByRequestId(job.requestId)!;
        // 260c against a 200c ceiling: 60c of genuine overage.
        engine.finish(run.runId, {status: 'completed', costCents: 260, extra: {until: 'video', estimateCents: 200, stills: [], video: {path: enginePath}, degradations: []}});
        const outcome = await processing;

        assert.equal(outcome.outcome, 'needs_operator');
        const parked = await jobRow(job.jobId);
        assert.equal(parked.status, 'needs_operator');
        assert.match(String(parked.status_detail), /settled_over_budget:60c/);
        const attempt = await attemptRow(job.jobId);
        assert.equal(attempt.settlement, 'settled', 'the money was spent, so it is settled, not left held');
        assert.equal(attempt.reported_cost_cents, 260);

        const grant = await grantRow(grantId);
        assert.equal(grant.reserved_cents, 0);
        assert.equal(grant.spent_cents, 260, 'actual usage is recorded, never clamped to the reservation');
        assert.equal(grant.overage_cents, 60);
        assert.ok(grant.admission_paused_at, 'the grant stops admitting new work');

        const reel = (await pool.query('SELECT * FROM generated_reel WHERE attempt_id=$1', [attempt.id])).rows[0];
        assert.ok(reel, 'the asset that was actually paid for stays durably recorded');

        // A paused grant admits nothing further, so the overage cannot be spent past again.
        await assert.rejects(
          storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 1, deadlineAt: future()}),
        );
      }, world.engineArtifactRoot);
    } finally {
      await cleanupImportWorld(world);
    }
  });

  await t.test('a real local import port completes the job, commits the generated Reel, and settles only then', async () => {
    const world = await makeImportWorld();
    try {
      await withFakeEngine(async (engine, engineId) => {
        const briefId = await approvedBrief();
        const grantId = await freshGrant();
        const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 300, deadlineAt: future()});
        const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
        const enginePath = join(world.engineArtifactRoot, 'run', 'a1-render.mp4');
        await mkdir(dirname(enginePath), {recursive: true});
        await makeVideoFixture(enginePath, 6);
        const expectedSha256 = await sha256OfFile(enginePath);

        const processing = processClaimedJob(
          {db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500, importPort: createLocalImportPort(world.mediaRoot)},
          claim!,
        );
        await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
        const run = engine.runByRequestId(job.requestId)!;
        engine.finish(run.runId, {status: 'completed', costCents: 210, extra: {until: 'video', estimateCents: 210, stills: [], video: {path: enginePath}, degradations: []}});
        const outcome = await processing;

        assert.equal(outcome.outcome, 'completed');
        assert.equal((await jobRow(job.jobId)).status, 'completed');
        const attempt = await attemptRow(job.jobId);
        assert.equal(attempt.settlement, 'settled');
        assert.equal(attempt.reported_cost_cents, 210);
        const grant = await grantRow(grantId);
        assert.equal(grant.reserved_cents, 0);
        assert.equal(grant.spent_cents, 210);

        const reel = (await pool.query(
          'SELECT * FROM generated_reel WHERE attempt_id=$1', [attempt.id],
        )).rows[0];
        assert.ok(reel, 'a generated_reel row was committed');
        assert.equal(reel.provider_mode, 'standin');
        assert.equal(reel.truth_state, 'synthesis');
        assert.equal(reel.generated_label, true);
        assert.equal(reel.availability, 'imported');
        assert.equal(reel.media_sha256, expectedSha256);
        assert.equal(reel.engine_path, enginePath);

        const media = (await pool.query('SELECT * FROM media_object WHERE sha256=$1', [expectedSha256])).rows[0];
        assert.ok(media, 'a media_object row was committed');
        const installedBytes = await readFile(join(world.mediaRoot, media.storage_key));
        assert.equal(createHash('sha256').update(installedBytes).digest('hex'), expectedSha256, 'a real MP4 exists at its content-addressed key');

        // The engine's own file is untouched: import copies, never moves.
        const originalStat = await stat(enginePath);
        assert.ok(originalStat.isFile());
      }, world.engineArtifactRoot);
    } finally {
      await cleanupImportWorld(world);
    }
  });

  await t.test('a typed import refusal (containment failure) leaves the job honestly importing, with no media object or generated Reel, and the reservation still held', async () => {
    const world = await makeImportWorld();
    try {
      await withFakeEngine(async (engine, engineId) => {
        const briefId = await approvedBrief();
        const grantId = await freshGrant();
        const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 300, deadlineAt: future()});
        const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
        // Outside world.engineArtifactRoot entirely: a genuine containment failure. A distinct
        // duration (7s, vs. 6s elsewhere in this file) keeps ffmpeg's fully deterministic output
        // from accidentally colliding, by content hash, with another subtest's already-imported file.
        const outsidePath = join(world.base, 'outside', 'a1-render.mp4');
        await mkdir(dirname(outsidePath), {recursive: true});
        await makeVideoFixture(outsidePath, 7);
        const wouldBeSha256 = await sha256OfFile(outsidePath);

        const processing = processClaimedJob(
          {db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500, importPort: createLocalImportPort(world.mediaRoot)},
          claim!,
        );
        await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
        const run = engine.runByRequestId(job.requestId)!;
        engine.finish(run.runId, {status: 'completed', costCents: 210, extra: {until: 'video', estimateCents: 210, stills: [], video: {path: outsidePath}, degradations: []}});
        const outcome = await processing;

        assert.equal(outcome.outcome, 'import_refused');
        assert.equal(outcome.detail, 'engine_path_not_contained');
        const jobAfter = await jobRow(job.jobId);
        assert.equal(jobAfter.status, 'importing', 'left honestly unfinished, never fabricated success or a terminal failure');
        assert.equal(jobAfter.status_detail, 'import_refused:engine_path_not_contained');
        const attempt = await attemptRow(job.jobId);
        assert.equal(attempt.settlement, 'held', 'the reservation stays held for an unverified/refused import');
        const grant = await grantRow(grantId);
        assert.equal(grant.reserved_cents, 300);
        assert.equal(grant.spent_cents, 0);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM generated_reel WHERE attempt_id=$1', [attempt.id])).rows[0]?.n, 0);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM media_object WHERE sha256=$1', [wouldBeSha256])).rows[0]?.n, 0, 'a refused import never writes a media_object row for the refused bytes');

        // Retryable while the engine file still exists: a fresh claim (lease expired) picks the
        // job back up and attempts import again. The finished attempt's own recorded result still
        // names the same (outside) path, so the retry reaches the same honest refusal on unchanged
        // data — never a fabricated success, and the job is never permanently stuck either.
        await pool.query(`UPDATE generation_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.jobId]);
        const reclaim = await storage.claimJob(pool, {owner: 'runtime-test-2', leaseMs: 30_000});
        assert.equal(reclaim?.jobId, job.jobId);
        const retried = await processClaimedJob(
          {db: pool, owner: 'runtime-test-2', pollMs: 10, importPort: createLocalImportPort(world.mediaRoot)},
          reclaim!,
        );
        assert.equal(retried.outcome, 'import_refused');
        assert.equal(retried.detail, 'engine_path_not_contained', 'a retry against unchanged data reaches the same honest refusal, never a fabricated success');
      }, world.engineArtifactRoot);
    } finally {
      await cleanupImportWorld(world);
    }
  });

  await t.test('a plan-only completed result needs no import and reaches "completed" directly', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 50, deadlineAt: future()});
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      const processing = processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500}, claim!);
      await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
      const run = engine.runByRequestId(job.requestId)!;
      engine.finish(run.runId, {status: 'completed', costCents: 5, extra: {until: 'plan', estimateCents: 5}});
      assert.equal((await processing).outcome, 'completed');
      assert.equal((await jobRow(job.jobId)).status, 'completed');
    });
  });

  await t.test('a 422 refusal is recorded without ever sending a second request, and releases the reservation', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'video', budgetCents: 80, deadlineAt: future()});
      engine.forceRefuse(job.requestId, 422, 'unsupported', 'Fixture-forced refusal.');
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      const outcome = await processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10}, claim!);
      assert.equal(outcome.outcome, 'refused');
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'refused');
      assert.equal(attempt.run_id, null);
      assert.equal((await jobRow(job.jobId)).status, 'refused');
      assert.equal((await grantRow(grantId)).reserved_cents, 0);
      assert.equal(engine.hasAnyRunFor(job.requestId), false, 'a refused submit never creates a run');
    });
  });

  await t.test('a lost acknowledgement is reconciled by a lookup on the original request id, never a second submit', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 20, deadlineAt: future()});
      engine.dropOnce(job.requestId, 'after', 1); // processed server-side, response lost
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      const processing = processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500}, claim!);
      await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'accepted', 'resolved via lookup, not a resend');
      assert.equal(attempt.replayed, null, 'a lookup-resolved outcome carries no submit-time replay flag');
      assert.equal(attempt.resend_count, 0, 'no resend was needed: the run already existed');
      const run = engine.runByRequestId(job.requestId)!;
      engine.finish(run.runId, {status: 'completed', costCents: 3, extra: {until: 'plan', estimateCents: 3}});
      assert.equal((await processing).outcome, 'completed');
    });
  });

  await t.test('true non-delivery is reconciled by a bounded identical-bytes resend, which then reaches the server', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 20, deadlineAt: future()});
      engine.dropOnce(job.requestId, 'before', 1); // never reaches the server at all, once
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      const processing = processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 500}, claim!);
      await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'accepted');
      assert.equal(attempt.resend_count, 1, 'exactly one bounded resend was needed');
      assert.equal(attempt.request_id, job.requestId, 'the resend reused the original identity, never a new one');
      const run = engine.runByRequestId(job.requestId)!;
      engine.finish(run.runId, {status: 'completed', costCents: 1, extra: {until: 'plan', estimateCents: 1}});
      assert.equal((await processing).outcome, 'completed');
    });
  });

  await t.test('exhausting the bounded resend parks the job needs_operator, and no run is ever created', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 20, deadlineAt: future()});
      engine.dropOnce(job.requestId, 'before', 10); // every attempt is lost, well past the bound
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      const outcome = await processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 5, maxFollowIterations: 500}, claim!);
      assert.equal(outcome.outcome, 'needs_operator');
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'unknown');
      assert.equal(attempt.resend_count, 3);
      assert.equal(attempt.run_id, null);
      assert.equal((await jobRow(job.jobId)).status, 'needs_operator');
      assert.equal((await grantRow(grantId)).reserved_cents, 20, 'the reservation stays held while unresolved');
      assert.equal(engine.hasAnyRunFor(job.requestId), false, 'true non-delivery never fabricates a run');
    });
  });

  await t.test('a worker resuming a dispatch-committed attempt after a crash reconciles through lookup/resend using the original identity', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 15, deadlineAt: future()});
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      // Simulate a worker that committed dispatch and then crashed before ever calling submit().
      await storage.authorizeDispatch(pool, {jobId: claim!.jobId, owner: 'runtime-test', leaseFence: claim!.fence});
      assert.equal((await attemptRow(job.jobId)).state, 'dispatch_committed');
      assert.equal(engine.hasAnyRunFor(job.requestId), false, 'nothing was actually sent yet');

      // A small bounded iteration count is enough: this call is only proving that resumption
      // reconciles and starts following, not exercising the full follow loop (covered elsewhere).
      const outcome = await processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 20}, claim!);
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'accepted');
      assert.equal(attempt.request_id, job.requestId, 'resumption never invents a new request id');
      assert.equal(outcome.outcome, 'following_paused', 'this call stops once the run is accepted and following begins');
      const run = engine.runByRequestId(job.requestId)!;
      assert.equal(run.requestId, job.requestId);
    });
  });

  await t.test('cancellation follows the real contract semantics: it takes effect only once something processes the run, which then finishes cancelled', async () => {
    await withFakeEngine(async (engine, engineId) => {
      const briefId = await approvedBrief();
      const grantId = await freshGrant();
      const job = await storage.createJob(pool, {briefId, engineId, grantId, until: 'plan', budgetCents: 40, deadlineAt: future()});
      const claim = await storage.claimJob(pool, {owner: 'runtime-test', leaseMs: 30_000});
      const processing = processClaimedJob({db: pool, owner: 'runtime-test', pollMs: 10, maxFollowIterations: 2_000}, claim!);

      await pollUntil(async () => Boolean((await attemptRow(job.jobId)).run_id));
      const run = engine.runByRequestId(job.requestId)!;
      await storage.requestCancel(pool, job.jobId); // an operator cancels while the run is in flight
      await pollUntil(async () => engine.wasCancelled(run.runId));

      // No engine worker has processed the cancellation yet: the run genuinely stays running.
      assert.equal(engine.runByRequestId(job.requestId)?.state, 'running');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(engine.runByRequestId(job.requestId)?.state, 'running', 'still running until something finishes it');

      engine.finish(run.runId, {status: 'cancelled', costCents: 0});
      const outcome = await processing;
      assert.equal(outcome.outcome, 'cancelled');
      const attempt = await attemptRow(job.jobId);
      assert.equal(attempt.state, 'finished');
      assert.equal(attempt.reported_cost_cents, 0);
      assert.equal(attempt.settlement, 'settled');
      assert.equal((await jobRow(job.jobId)).status, 'cancelled');
      assert.equal((await grantRow(grantId)).reserved_cents, 0, 'the whole reservation releases on a zero-cost cancellation');
    });
  });

  } finally {
    await pool.end();
  }
});
