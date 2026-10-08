/** #199: one Cutroom pool shared by two worlds. Proves, against a local HTTP fixture that speaks
 * the pinned Cutroom wire and two real databases plus the pool's own database:
 *
 * - the pool's spend record: one open order per script, takes, the shared cap, settle once;
 * - a Reel ordered once by one world is received by the other at 0¢, from the same file;
 * - a world that tries to order an already-ordered script orders nothing;
 * - Cutroom's own re-run of a failed run is followed, and both runs' spend is summed;
 * - a receive refuses a pool order whose request bytes differ from its own script.
 *
 * Fixture proof only: no real Cutroom, provider or money is involved. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import {
  type GenerationBrief,
  generationBrief,
} from '@knowscroll/contracts/generation';
import {
  poolRequestId,
  scriptDigest,
} from '@knowscroll/core/cutroom/pool-identity';
import {
  createPoolLedger,
  type PoolLedger,
  runPoolMigrations,
} from '@knowscroll/db/pool/ledger';
import { feedCandidates } from '@knowscroll/db/feed';
import { createLocalImportPort } from '../apps/worker/src/generation/import-port.ts';
import * as operator from '../apps/worker/src/generation/operator.ts';
import * as storage from '../apps/worker/src/generation/storage.ts';
import {
  type GenerationWorkerOptions,
  processClaimedJob,
  publishImportedReels,
  syncSharedPool,
} from '../apps/worker/src/generation/worker.ts';
import { drainStrayJobs } from './helpers/generation-fixture.ts';

const execFileAsync = promisify(execFile);

const databaseUrl =
  process.env.DATABASE_URL ??
  (() => {
    throw new Error('DATABASE_URL required');
  })();
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith('knowscroll_test_'))
  throw new Error(`requires a knowscroll_test_* database, got ${databaseName}`);
const urlFor = (name: string) => {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};
const devName = `${databaseName}_dev`;
const poolName = `${databaseName}_pool`;

const stageDb = new pg.Pool({ connectionString: databaseUrl, max: 6 });
let devDb: pg.Pool;
let poolDb: pg.Pool;
let ledger: PoolLedger;

async function createDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}
async function dropDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
async function migrateAndSeed(name: string): Promise<void> {
  const tsx = resolve('node_modules/.bin/tsx');
  const env = { ...process.env, DATABASE_URL: urlFor(name) };
  await execFileAsync(tsx, ['scripts/migrate.ts'], { env });
  await execFileAsync(tsx, ['scripts/seed.ts'], { env });
}

// --- Scripts: the same approved brief in both worlds -------------------------------------------

let assetId: string;
function makeBrief(tag: string): GenerationBrief {
  const ids = ['claim-a', 'claim-b'];
  return generationBrief.parse({
    version: 1,
    worldId: 'knowscroll-shared-pool-test',
    narration: [
      { text: `The ${tag} rises over the plain.`, claimIds: ['claim-a'] },
      { text: 'Rain gathers in the valley below.', claimIds: ['claim-b'] },
      { text: 'Rivers carry the water to the sea.', claimIds: ['claim-a'] },
      { text: 'The sea returns it to the sky.', claimIds: ['claim-b'] },
    ],
    claims: [
      { id: 'claim-a', role: 'main' },
      { id: 'claim-b', role: 'supporting' },
    ],
    claimSources: ids.map((claimId) => ({
      claimId,
      assetId,
      assetRevision: 1,
    })),
    criteria: {
      mustShow: [
        {
          id: 'show-river',
          text: 'A river.',
          type: 'presence',
          claimId: 'claim-a',
        },
      ],
      mustNotShow: [
        { id: 'never-text', text: 'Written words.', type: 'presence' },
      ],
      depictionPolicyVersion: 'depiction-v1',
    },
    style: { id: 'calm', version: 1, text: 'Calm and documentary.' },
    title: `The ${tag}`,
    summary: `A short Reel about the ${tag}.`,
  });
}
async function approve(db: pg.Pool, brief: GenerationBrief): Promise<string> {
  const { id } = await storage.addBrief(db, {
    brief,
    authoredBy: 'shared-pool-test',
  });
  await storage.approveBrief(db, id);
  return id;
}
async function liveGrant(db: pg.Pool): Promise<string> {
  const { id } = await storage.createGrant(db, {
    mode: 'live',
    capCents: 200,
    authorizationRef: 'shared-pool-test: owner $5 for dev and stage',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return id;
}
async function grantRow(db: pg.Pool, id: string) {
  return (
    await db.query(
      'SELECT reserved_cents,spent_cents,overage_cents FROM generation_budget_grant WHERE id=$1',
      [id],
    )
  ).rows[0];
}

// --- A local fixture of the pinned Cutroom wire, with Cutroom's own re-run --------------------

type Run = {
  runId: string;
  requestId: string;
  body: string;
  state: 'running' | 'finished';
  events: Record<string, unknown>[];
  result?: unknown;
  record?: unknown;
  resumes?: string;
  resumedBy?: string;
};
function createPoolCutroom() {
  const runs = new Map<string, Run>();
  const newest = new Map<string, string>();
  let posts = 0;
  const reply = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      connection: 'close',
    });
    res.end(JSON.stringify(value));
  };
  const status = (run: Run) => ({
    contractVersion: 1,
    runId: run.runId,
    requestId: run.requestId,
    state: run.state,
    lastSeq: run.events.length,
    ...(run.resumes ? { resumes: run.resumes } : {}),
    ...(run.resumedBy ? { resumedBy: run.resumedBy } : {}),
  });
  const event = (run: Run, type: string, extra = {}) =>
    run.events.push({
      contractVersion: 1,
      runId: run.runId,
      seq: run.events.length + 1,
      at: new Date().toISOString(),
      type,
      ...extra,
    });
  const notFound = { contractVersion: 1, error: 'not-found', detail: 'none' };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        posts += 1;
        const { requestId } = JSON.parse(body) as { requestId: string };
        const existing = newest.get(requestId);
        if (existing) {
          const run = runs.get(existing) as Run;
          if (run.body !== body)
            return reply(res, 409, {
              contractVersion: 1,
              outcome: 'refused',
              requestId,
              reason: 'conflict',
              detail: 'different body',
            });
          return reply(res, 202, {
            contractVersion: 1,
            outcome: 'accepted',
            requestId,
            runId: run.runId,
            replayed: true,
          });
        }
        const run: Run = {
          runId: randomUUID(),
          requestId,
          body,
          state: 'running',
          events: [],
        };
        runs.set(run.runId, run);
        newest.set(requestId, run.runId);
        event(run, 'run.accepted');
        return reply(res, 202, {
          contractVersion: 1,
          outcome: 'accepted',
          requestId,
          runId: run.runId,
          replayed: false,
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/runs') {
        const runId = newest.get(url.searchParams.get('requestId') ?? '');
        const run = runId ? runs.get(runId) : undefined;
        return run ? reply(res, 200, status(run)) : reply(res, 404, notFound);
      }
      const match = /^\/v1\/runs\/([^/]+)(?:\/(events|result|record))?$/.exec(
        url.pathname,
      );
      const run = match ? runs.get(decodeURIComponent(match[1] ?? '')) : null;
      if (!match || !run) return reply(res, 404, notFound);
      if (!match[2]) return reply(res, 200, status(run));
      if (match[2] === 'events') {
        const since = Number(url.searchParams.get('since') ?? '0');
        const events = run.events.filter((e) => (e.seq as number) > since);
        return reply(res, 200, {
          contractVersion: 1,
          runId: run.runId,
          events,
          nextSince: events.length
            ? (events[events.length - 1]?.seq as number)
            : since,
        });
      }
      if (run.state !== 'finished') return reply(res, 409, status(run));
      return reply(res, 200, match[2] === 'result' ? run.result : run.record);
    });
  });
  function finish(
    run: Run,
    result: Record<string, unknown> & { status: string; costCents: number },
  ) {
    event(run, 'run.finished', { status: result.status });
    run.state = 'finished';
    run.result = {
      contractVersion: 1,
      runId: run.runId,
      requestId: run.requestId,
      ...result,
    };
    // What Cutroom's own checks record for a Reel it made: Gate 1 on the chosen picture, Gates
    // 2-5 on the used take.
    const accept = (gate: string) => ({ gate, outcome: 'accept' });
    run.record = {
      contractVersion: 1,
      runId: run.runId,
      pictures:
        result.status === 'completed'
          ? [
              {
                pictureId: 'p1',
                shotId: 's1',
                chosen: true,
                observationId: 'o-p1',
                checks: [accept('1')],
              },
            ]
          : [],
      takes:
        result.status === 'completed'
          ? [
              {
                takeId: 't1',
                shotId: 's1',
                number: 1,
                used: true,
                observationId: 'o-t1',
                checks: ['2', '3', '4', '5'].map(accept),
              },
            ]
          : [],
      degradations: [],
    };
  }
  return {
    get posts() {
      return posts;
    },
    async listen(): Promise<string> {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      assert(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}`;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
    newestRun(requestId: string): Run | undefined {
      const runId = newest.get(requestId);
      return runId ? runs.get(runId) : undefined;
    },
    completeVideo(run: Run, costCents: number, path: string) {
      finish(run, {
        status: 'completed',
        until: 'video',
        costCents,
        estimateCents: 60,
        stills: [],
        video: { path },
        degradations: [],
      });
    },
    /** Cutroom's own rule: a provider-failed run is re-run once, under the same request id. */
    failAndResume(run: Run, costCents: number): Run {
      finish(run, { status: 'failed', costCents, detail: 'provider failed' });
      const resume: Run = {
        runId: randomUUID(),
        requestId: run.requestId,
        body: run.body,
        state: 'running',
        events: [],
        resumes: run.runId,
      };
      run.resumedBy = resume.runId;
      runs.set(resume.runId, resume);
      newest.set(run.requestId, resume.runId);
      event(resume, 'run.accepted');
      return resume;
    },
  };
}

async function makeVideo(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=size=108x192:duration=6:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-y',
    path,
  ]);
}
async function pollUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('pollUntil timed out');
}

test('#199 shared Reel pool across two worlds', async (t) => {
  await createDatabase(devName);
  await createDatabase(poolName);
  await migrateAndSeed(devName);
  devDb = new pg.Pool({ connectionString: urlFor(devName), max: 6 });
  poolDb = new pg.Pool({ connectionString: urlFor(poolName), max: 4 });
  await runPoolMigrations(poolDb);
  ledger = createPoolLedger(poolDb);
  assetId = (
    await stageDb.query<{ id: string }>(
      'SELECT id FROM asset ORDER BY editorial_order LIMIT 1',
    )
  ).rows[0]?.id as string;
  assert.ok(assetId);
  const sameAsset = await devDb.query('SELECT 1 FROM asset WHERE id=$1', [
    assetId,
  ]);
  assert.equal(sameAsset.rowCount, 1, 'editorial Scrolls share ids');
  await drainStrayJobs(stageDb, 'shared-pool-sweep');

  const cutroom = createPoolCutroom();
  const origin = await cutroom.listen();
  const base = await mkdtemp(join(tmpdir(), 'ks-shared-pool-'));
  const artifactRoot = join(base, 'cutroom-artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const worlds = {
    stage: { db: stageDb, media: join(base, 'stage-media') },
    dev: { db: devDb, media: join(base, 'dev-media') },
  };
  const engines: Record<string, string> = {};
  for (const [name, world] of Object.entries(worlds)) {
    await mkdir(world.media, { recursive: true });
    engines[name] = (
      await storage.registerEngine(world.db, {
        origin,
        contractRevision: storage.CUTROOM_CONTRACT_REVISION,
        artifactRoot,
        providerMode: 'live',
        declaredBy: 'shared-pool-test',
      })
    ).id;
  }
  const options = (name: 'stage' | 'dev'): GenerationWorkerOptions => ({
    db: worlds[name].db,
    owner: `shared-pool-${name}`,
    pollMs: 10,
    maxFollowIterations: 2_000,
    importPort: createLocalImportPort(worlds[name].media),
    pool: { ledger, world: name },
    log: () => {},
  });
  const claim = async (db: pg.Pool) => {
    const claimed = await storage.claimJob(db, {
      owner: db === stageDb ? 'shared-pool-stage' : 'shared-pool-dev',
      leaseMs: 60_000,
    });
    assert.ok(claimed, 'a job is ready');
    return claimed;
  };

  try {
    await t.test(
      'the pool record: one open order per script, takes, the cap, settle once',
      async () => {
        const digest = createHash('sha256').update('ledger-only').digest('hex');
        const order = (take: number, ceilingCents: number) =>
          ledger.claim({
            requestId: poolRequestId(digest, take),
            scriptDigest: digest,
            take,
            until: 'video',
            bodySha256: 'a'.repeat(64),
            world: 'stage',
            ceilingCents,
            approvalRef: 'test',
          });
        assert.equal(await ledger.nextTake(digest), 1);
        assert.deepEqual(await order(1, 100), {
          status: 'claimed',
          requestId: poolRequestId(digest, 1),
        });
        const again = await order(2, 100);
        assert.equal(again.status, 'already_ordered', 'one open order only');
        await assert.rejects(
          ledger.settle({
            requestId: poolRequestId(digest, 1),
            world: 'dev',
            outcome: 'failed',
            spentCents: 40,
            finalRunId: null,
          }),
          /pool_order_not_yours/,
        );
        assert.equal(
          await ledger.settle({
            requestId: poolRequestId(digest, 1),
            world: 'stage',
            outcome: 'failed',
            spentCents: 40,
            finalRunId: null,
          }),
          'settled',
        );
        assert.equal(
          await ledger.settle({
            requestId: poolRequestId(digest, 1),
            world: 'stage',
            outcome: 'failed',
            spentCents: 40,
            finalRunId: null,
          }),
          'already_settled',
          'settling again with the same figures is a no-op',
        );
        assert.equal((await order(1, 10)).status, 'take_taken');
        assert.equal(await ledger.nextTake(digest), 2);
        assert.equal(
          (await order(2, 461)).status,
          'cap_exceeded',
          '40 spent + 461 would pass the shared 500',
        );
        assert.equal((await order(2, 460)).status, 'claimed');
        assert.deepEqual(await ledger.budget(), {
          capCents: 500,
          committedCents: 500,
          leftCents: 0,
        });
        assert.equal(
          await ledger.release(poolRequestId(digest, 2), 'stage'),
          'released',
        );
        assert.equal((await ledger.budget()).leftCents, 460);
        await assert.rejects(
          poolDb.query('DELETE FROM pool_order'),
          /never deleted/,
        );
      },
    );

    await t.test(
      'stage orders a script once; dev cannot order it again and receives the same Reel at 0 cents',
      async () => {
        const brief = makeBrief('mountain');
        const stageBrief = await approve(stageDb, brief);
        const devBrief = await approve(devDb, brief);
        const stageGrant = await liveGrant(stageDb);
        const devGrant = await liveGrant(devDb);
        const postsBefore = cutroom.posts;

        const ordered = await operator.orderShared(stageDb, ledger, {
          world: 'stage',
          briefId: stageBrief,
          grantId: stageGrant,
          until: 'video',
          ceilingCents: 75,
          approvalRef: 'PR #test (owner approved the script)',
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        assert.ok(ordered.ok, JSON.stringify(ordered));
        const { jobId, requestId } = ordered.value as {
          jobId: string;
          requestId: string;
        };
        assert.equal(
          requestId,
          poolRequestId(scriptDigest(brief, 'video'), 1),
          'the request id comes from the script itself',
        );

        const second = await operator.orderShared(devDb, ledger, {
          world: 'dev',
          briefId: devBrief,
          grantId: devGrant,
          until: 'video',
          ceilingCents: 75,
          approvalRef: 'PR #test',
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        assert.ok(second.ok);
        assert.deepEqual(second.value, {
          ordered: false,
          alreadyOrdered: true,
          requestId,
          orderedBy: 'stage',
        });
        assert.equal(
          (await devDb.query('SELECT count(*)::int AS n FROM generation_job'))
            .rows[0].n,
          0,
          'dev created no job and reserved nothing',
        );

        const video = join(artifactRoot, 'mountain', 'render.mp4');
        await makeVideo(video);
        const processing = processClaimedJob(
          options('stage'),
          await claim(stageDb),
        );
        await pollUntil(async () => Boolean(cutroom.newestRun(requestId)));
        cutroom.completeVideo(cutroom.newestRun(requestId) as Run, 55, video);
        assert.equal((await processing).outcome, 'completed');
        assert.deepEqual(await grantRow(stageDb, stageGrant), {
          reserved_cents: 0,
          spent_cents: 55,
          overage_cents: 0,
        });

        // The pool learns what it cost, once; then dev receives it.
        assert.deepEqual(await syncSharedPool(options('stage')), {
          settled: 1,
          received: 0,
        });
        const pooled = (await ledger.orders()).find(
          (o) => o.requestId === requestId,
        );
        assert.equal(pooled?.state, 'settled');
        assert.equal(pooled?.outcome, 'completed');
        assert.equal(pooled?.spentCents, 55);

        assert.deepEqual(await syncSharedPool(options('dev')), {
          settled: 0,
          received: 1,
        });
        const received = await claim(devDb);
        assert.equal(received.kind, 'receive');
        assert.equal(received.grantId, null);
        assert.equal(
          (await processClaimedJob(options('dev'), received)).outcome,
          'completed',
        );
        assert.equal(cutroom.posts - postsBefore, 1, 'Cutroom was asked once');

        const reelOf = async (db: pg.Pool) =>
          (
            await db.query(
              `SELECT r.media_sha256, r.provider_mode, a.role, a.settlement
               FROM generated_reel r JOIN cutroom_attempt a ON a.id = r.attempt_id
               WHERE a.request_id = $1`,
              [requestId],
            )
          ).rows[0];
        const stageReel = await reelOf(stageDb);
        const devReel = await reelOf(devDb);
        assert.equal(
          devReel.media_sha256,
          stageReel.media_sha256,
          'the same file',
        );
        assert.equal(devReel.provider_mode, 'live');
        assert.equal(devReel.role, 'receive');
        assert.equal(devReel.settlement, 'released', 'dev paid nothing');
        assert.deepEqual(await grantRow(devDb, devGrant), {
          reserved_cents: 0,
          spent_cents: 0,
          overage_cents: 0,
        });
        assert.deepEqual(await syncSharedPool(options('dev')), {
          settled: 0,
          received: 0,
        });
        assert.ok(jobId);

        // On dev the worker publishes the received Reel by itself: publication-v2, then the feed.
        const devReelId = (
          await devDb.query(
            `SELECT r.id FROM generated_reel r JOIN cutroom_attempt a ON a.id = r.attempt_id
             WHERE a.request_id = $1`,
            [requestId],
          )
        ).rows[0].id as string;
        const publishing = {
          ...options('dev'),
          publish: {
            policyVersion: 'publication-v2',
            mediaRoot: worlds.dev.media,
          },
        };
        assert.deepEqual(await publishImportedReels(publishing), {
          published: 1,
          refused: 0,
        });
        assert.deepEqual(
          await publishImportedReels(publishing),
          { published: 0, refused: 0 },
          'a published Reel is not offered again',
        );
        const availability = (
          await devDb.query(
            'SELECT availability FROM generated_reel WHERE id=$1',
            [devReelId],
          )
        ).rows[0].availability;
        assert.equal(availability, 'eligible');
        const minted = (
          await devDb.query(
            'SELECT id AS "assetId" FROM asset WHERE generated_reel_id=$1',
            [devReelId],
          )
        ).rows[0] as { assetId: string };
        const client = await devDb.connect();
        try {
          const shown = (await feedCandidates(client, ['Reel'])).find(
            (candidate) => candidate.assetId === minted.assetId,
          );
          assert.ok(shown && shown.kind === 'Reel');
          assert.equal(shown.simulated, false);
          assert.deepEqual(shown.check, {
            by: 'engine',
            policyVersion: 'publication-v2',
            shotsChecked: 2,
          });
        } finally {
          client.release();
        }
      },
    );

    await t.test(
      "Cutroom's own re-run is followed and both runs' spend is summed",
      async () => {
        const brief = makeBrief('volcano');
        const briefId = await approve(stageDb, brief);
        // A world's own live cap is 200 cents until an operator raises it, and never above 500.
        await assert.rejects(liveGrant(stageDb), /owner cap of 200 cents/);
        const refused = await operator.setLiveCap(stageDb, {
          capCents: 501,
          setBy: 'shared-pool-test',
        });
        assert.equal(refused.ok, false);
        assert.ok(
          (
            await operator.setLiveCap(stageDb, {
              capCents: 500,
              setBy: 'owner decision 2026-10-07: $5 for dev and stage',
            })
          ).ok,
        );
        const grantId = await liveGrant(stageDb);
        const ordered = await operator.orderShared(stageDb, ledger, {
          world: 'stage',
          briefId,
          grantId,
          until: 'video',
          ceilingCents: 75,
          approvalRef: 'PR #test',
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        assert.ok(ordered.ok, JSON.stringify(ordered));
        const { jobId, requestId } = ordered.value as {
          jobId: string;
          requestId: string;
        };
        const video = join(artifactRoot, 'volcano', 'render.mp4');
        await makeVideo(video);
        const processing = processClaimedJob(
          options('stage'),
          await claim(stageDb),
        );
        await pollUntil(async () => Boolean(cutroom.newestRun(requestId)));
        const first = cutroom.newestRun(requestId) as Run;
        const resume = cutroom.failAndResume(first, 20);
        await pollUntil(
          async () =>
            (
              await stageDb.query(
                'SELECT 1 FROM cutroom_attempt WHERE job_id=$1 AND ordinal=2',
                [jobId],
              )
            ).rowCount === 1,
        );
        cutroom.completeVideo(resume, 30, video);
        assert.equal((await processing).outcome, 'completed');

        const attempts = (
          await stageDb.query(
            `SELECT ordinal, role, run_id, state, settlement, reported_cost_cents
             FROM cutroom_attempt WHERE job_id=$1 ORDER BY ordinal`,
            [jobId],
          )
        ).rows;
        assert.deepEqual(
          attempts.map((a) => [
            a.ordinal,
            a.role,
            a.run_id,
            a.settlement,
            a.reported_cost_cents,
          ]),
          [
            [1, 'order', first.runId, 'settled', 20],
            [2, 'resume', resume.runId, 'settled', 30],
          ],
        );
        assert.equal((await grantRow(stageDb, grantId)).spent_cents, 50);
        await syncSharedPool(options('stage'));
        const pooled = (await ledger.orders()).find(
          (o) => o.requestId === requestId,
        );
        assert.equal(pooled?.spentCents, 50, 'the pool counts both runs');
        assert.equal(pooled?.finalRunId, resume.runId);
      },
    );

    await t.test(
      'the schema keeps receives free and re-runs honest',
      async () => {
        const briefId = await approve(devDb, makeBrief('schema'));
        const grantId = await liveGrant(stageDb).catch(() => null);
        assert.equal(grantId, null, 'stage is at its own cap already');
        const job = (kind: string, grant: string | null, budget: number) =>
          devDb.query(
            `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at,kind,shared_pool)
             VALUES($1,$2,$3,$4,'video',$5,now()+interval '1 day',$6,true)`,
            [randomUUID(), briefId, engines.dev, grant, budget, kind],
          );
        await assert.rejects(job('receive', null, 5), /violates/);
        await assert.rejects(
          job('order', null, 5),
          /violates|needs an approved brief/,
        );
        const receiveJob = randomUUID();
        await devDb.query(
          `INSERT INTO generation_job(id,brief_id,engine_id,grant_id,until,budget_cents,deadline_at,kind,shared_pool)
           VALUES($1,$2,$3,NULL,'video',0,now()+interval '1 day','receive',true)`,
          [receiveJob, briefId, engines.dev],
        );
        const attempt = (
          role: string,
          ordinal: number,
          resumes: string | null,
        ) =>
          devDb.query(
            `INSERT INTO cutroom_attempt(id,job_id,ordinal,role,resumes_attempt_id,request_id,request_body,body_sha256,contract_revision)
             VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8)`,
            [
              randomUUID(),
              receiveJob,
              ordinal,
              role,
              resumes,
              `ks-reel-${'c'.repeat(32)}-1`,
              'd'.repeat(64),
              storage.CUTROOM_CONTRACT_REVISION,
            ],
          );
        await assert.rejects(attempt('order', 1, null), /never sends/);
        await assert.rejects(
          attempt('resume', 2, randomUUID()),
          /violates|resume/,
        );
      },
    );

    await t.test(
      'a receive refuses a pool order whose request bytes differ from its own script',
      async () => {
        const brief = makeBrief('glacier');
        await approve(devDb, brief);
        const digest = scriptDigest(brief, 'video');
        const requestId = poolRequestId(digest, 1);
        assert.equal(
          (
            await ledger.claim({
              requestId,
              scriptDigest: digest,
              take: 1,
              until: 'video',
              bodySha256: 'b'.repeat(64),
              world: 'stage',
              ceilingCents: 10,
              approvalRef: 'test',
            })
          ).status,
          'claimed',
        );
        await ledger.settle({
          requestId,
          world: 'stage',
          outcome: 'completed',
          spentCents: 10,
          finalRunId: 'run-glacier',
        });
        assert.deepEqual(await syncSharedPool(options('dev')), {
          settled: 0,
          received: 0,
        });
        assert.equal(await storage.hasRequest(devDb, requestId), false);
      },
    );
  } finally {
    await cutroom.close();
    await rm(base, { recursive: true, force: true });
    await devDb?.end();
    await poolDb?.end();
    await stageDb.end();
    await dropDatabase(devName);
    await dropDatabase(poolName);
  }
});

// A sanity check that the fixture video really is what import accepts (fails fast if ffmpeg is gone).
test('the fixture video exists after ffmpeg', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ks-shared-pool-ffmpeg-'));
  try {
    const path = join(base, 'v.mp4');
    await makeVideo(path);
    assert.ok((await readFile(path)).byteLength > 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
