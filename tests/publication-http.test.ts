/**
 * ADR-0024 section 4 — `GET|HEAD /v1/media/:sha256` over the real Fastify app: full body, Range
 * (206, reassembly, 416), HEAD, 404 for unknown/ineligible/missing-on-disk, 401 without a session,
 * the `test_eligible` simulated marker, and that no database transaction survives into the
 * streaming phase. Runs against the outer test.sh-managed disposable database via the shared
 * `pool`/`provisionIdentity` (the same convention every other tests/api-*.test.ts file uses); this
 * file never creates its own nested database.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';
import { CUTROOM_CONTRACT_REVISION as REVISION } from '../apps/worker/src/generation/storage.ts';
import { insertFakeEngine } from './helpers/generation-fixture.ts';
import { computeStorageKey } from '../apps/worker/src/generation/media-store.ts';
import { generationBrief } from '../packages/contracts/src/generation.ts';
import { MEDIA_SIMULATED_HEADER } from '../apps/api/src/media.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('publication HTTP tests require an isolated knowscroll_test_* database');
}

const developmentToken = randomBytes(32).toString('hex');
const scratch = await mktempDir();
const mediaRoot = join(scratch, 'media');
await mkdir(mediaRoot, { recursive: true });
const app = buildApp(developmentToken, { mediaRoot });

after(async () => {
  await app.close();
  await pool.end();
  await rm(scratch, { recursive: true, force: true });
});

async function mktempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ks-publication-http-'));
}

function headers(token: string) {
  return { authorization: `Bearer ${token}` };
}

// -------------------------------------------------------------------------------------------
// Fixture: a fully legitimate finished-video generated_reel row, taken to a chosen availability.
// `eligible`/`test_eligible` are reached here by directly recording a 'pass' verdict for EVERY
// required gate (including witness_alignment) — an HTTP-layer test fixture only. The real gate
// evaluator (apps/worker/src/publication/gates.ts, exercised in tests/publication-gates.test.ts)
// never assigns witness_alignment anything but 'unavailable'; this bypass exists purely to give the
// serving route something to authorize, and must never be read as proof that real eligibility is
// reachable in the live product.
// -------------------------------------------------------------------------------------------

const REQUIRED_GATES = ['lineage_complete', 'source_support', 'engine_record', 'media_conformance', 'truth_label', 'repetition', 'witness_alignment'];

async function seedAsset(): Promise<string> {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll','Title','Summary','Body text.','Example source','https://example.test/x','documented',
       (SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [assetId],
  );
  return assetId;
}

function brief(assetId: string, tag: string) {
  return generationBrief.parse({
    version: 1,
    worldId: `http-tests-${tag}`,
    narration: [
      { text: `S1 ${tag}.`, claimIds: ['c1'] },
      { text: `S2 ${tag}.`, claimIds: ['c1'] },
      { text: `S3 ${tag}.`, claimIds: ['c2'] },
      { text: `S4 ${tag}.`, claimIds: ['c2'] },
    ],
    claims: [{ id: 'c1', role: 'main' }, { id: 'c2', role: 'supporting' }],
    claimSources: [{ claimId: 'c1', assetId, assetRevision: 1 }, { claimId: 'c2', assetId, assetRevision: 1 }],
    criteria: { mustShow: [{ id: 'show-1', text: 'Something visible.', type: 'presence' as const, claimId: 'c1' }], mustNotShow: [], depictionPolicyVersion: 'depiction-v1' },
    style: { id: 'library', version: 1, text: 'Quiet, documentary.' },
  });
}

interface MediaFixtureOptions {
  availability: 'imported' | 'eligible' | 'test_eligible';
  providerMode?: 'standin' | 'live';
  fileBytes?: Buffer;
}
interface MediaFixture { sha256: string; storageKey: string; generatedReelId: string; }

async function seedMediaFixture(options: MediaFixtureOptions): Promise<MediaFixture> {
  const tag = randomUUID().slice(0, 8);
  const providerMode = options.providerMode ?? 'standin';
  const assetId = await seedAsset();
  const briefJson = brief(assetId, tag);
  const briefSha256 = createHash('sha256').update(JSON.stringify(briefJson)).digest('hex');
  const briefId = randomUUID();
  await pool.query(
    `INSERT INTO generation_brief(id,source_asset_id,source_asset_revision,truth_state,brief,brief_sha256,authored_by,review_state)
     VALUES($1,$2,1,'synthesis',$3,$4,'test','approved')`,
    [briefId, assetId, JSON.stringify(briefJson), briefSha256],
  );

  const engineId = randomUUID();
  const budgetCents = providerMode === 'live' ? 100 : 500;
  await insertFakeEngine(pool, { id: engineId, artifactRoot: '/tmp/publication-http-fixtures', providerMode });
  const grantId = randomUUID();
  if (providerMode === 'live') {
    await pool.query(`INSERT INTO generation_budget_grant(id,mode,cap_cents,authorization_ref,expires_at) VALUES($1,'live',200,'test fixture',now()+interval '1 day')`, [grantId]);
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
  const enginePath = `/tmp/publication-http-fixtures/${attemptId}.mp4`;
  await pool.query(`UPDATE cutroom_attempt SET state='dispatch_committed', dispatch_committed_at=now() WHERE id=$1`, [attemptId]);
  await pool.query(`UPDATE cutroom_attempt SET state='accepted', run_id=$2, accepted_at=now() WHERE id=$1`, [attemptId, runId]);
  await pool.query(
    `UPDATE cutroom_attempt SET state='finished', finished_at=now(), reported_cost_cents=0, settlement='settled',
       result=jsonb_build_object('status','completed','until','video','video',jsonb_build_object('path',$2::text))
     WHERE id=$1`,
    [attemptId, enginePath],
  );

  const fileBytes = options.fileBytes;
  const sha256 = fileBytes ? createHash('sha256').update(fileBytes).digest('hex') : createHash('sha256').update(`${attemptId}-missing`).digest('hex');
  const storageKey = computeStorageKey(sha256);
  const byteSize = fileBytes ? fileBytes.length : 4096;
  await pool.query(
    `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key) VALUES($1,$2,'video/mp4','{}',$3) ON CONFLICT (sha256) DO NOTHING`,
    [sha256, byteSize, storageKey],
  );
  if (fileBytes) {
    await mkdir(join(mediaRoot, storageKey.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(mediaRoot, storageKey), fileBytes);
  }

  const generatedReelId = randomUUID();
  const lineage = { briefSha256, contractRevision: REVISION, runId, recordSummary: { takes: [] } };
  await pool.query(
    `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthesis',true,$9)`,
    [generatedReelId, attemptId, briefId, engineId, runId, sha256, enginePath, providerMode, JSON.stringify(lineage)],
  );

  if (options.availability !== 'imported') {
    for (const gate of REQUIRED_GATES) {
      await pool.query(
        `INSERT INTO publication_gate_result(id,generated_reel_id,policy_version,gate,verdict,evidence) VALUES($1,$2,'publication-v1',$3,'pass','{}')`,
        [randomUUID(), generatedReelId, gate],
      );
    }
    await pool.query(
      `UPDATE generated_reel SET availability=$2, availability_policy_version='publication-v1', availability_decided_at=now() WHERE id=$1`,
      [generatedReelId, options.availability],
    );
  }

  return { sha256, storageKey, generatedReelId };
}

// -------------------------------------------------------------------------------------------

test('a fixture engine never takes an origin an engine registered earlier still holds', async (t) => {
  // #169: engines registered earlier stay active, and an origin belongs to at most one active engine.
  // A random fixture port that landed on one of them failed this file on CI.
  const held = 'http://127.0.0.1:20000';
  await pool.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     VALUES($1,$2,$3,'/tmp/publication-http-fixtures','standin','test') ON CONFLICT (origin) WHERE retired_at IS NULL DO NOTHING`,
    [randomUUID(), held, REVISION],
  );
  t.mock.method(Math, 'random', () => 0); // where a random pick would land: on the held origin
  const fixture = await seedMediaFixture({ availability: 'eligible' });
  const engine = await pool.query(
    'SELECT e.origin FROM generated_reel r JOIN cutroom_engine e ON e.id=r.engine_id WHERE r.id=$1', [fixture.generatedReelId],
  );
  assert.notEqual(engine.rows[0]?.origin, held);
});

test('GET|HEAD /v1/media/:sha256', async (t) => {
  await t.test('401 without a session', async () => {
    const fixture = await seedMediaFixture({ availability: 'eligible', fileBytes: Buffer.from('hello world') });
    const response = await app.inject({ url: `/v1/media/${fixture.sha256}` });
    assert.equal(response.statusCode, 401);
  });

  await t.test('400 for a malformed media identifier, before any authorization is attempted', async () => {
    const { token } = await provisionIdentity();
    const response = await app.inject({ url: '/v1/media/not-a-sha256', headers: headers(token) });
    assert.equal(response.statusCode, 400);
  });

  await t.test('404 for an unknown sha256', async () => {
    const { token } = await provisionIdentity();
    const response = await app.inject({ url: `/v1/media/${'0'.repeat(64)}`, headers: headers(token) });
    assert.equal(response.statusCode, 404);
  });

  await t.test('404 for a Reel that exists but is not eligible', async () => {
    const { token } = await provisionIdentity();
    const fixture = await seedMediaFixture({ availability: 'imported', fileBytes: Buffer.from('never served') });
    const response = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: headers(token) });
    assert.equal(response.statusCode, 404);
  });

  await t.test('404 for an eligible Reel whose file is missing on disk', async () => {
    const { token } = await provisionIdentity();
    const fixture = await seedMediaFixture({ availability: 'eligible' }); // no fileBytes: nothing written
    const response = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: headers(token) });
    assert.equal(response.statusCode, 404);
  });

  await t.test('full body: real eligible media serves whole, byte-identical content with no simulated marker', async () => {
    const { token } = await provisionIdentity();
    const bytes = randomBytes(65536 + 37);
    const fixture = await seedMediaFixture({ availability: 'eligible', fileBytes: bytes });
    const response = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: headers(token) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'video/mp4');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(response.headers[MEDIA_SIMULATED_HEADER], undefined);
    assert.ok((response.rawPayload as Buffer).equals(bytes));
  });

  await t.test('the simulated marker is present for test_eligible media and absent for eligible media', async () => {
    const { token } = await provisionIdentity();
    const simulated = await seedMediaFixture({ availability: 'test_eligible', fileBytes: randomBytes(4096) });
    const real = await seedMediaFixture({ availability: 'eligible', fileBytes: randomBytes(4096) });
    const simulatedResponse = await app.inject({ url: `/v1/media/${simulated.sha256}`, headers: headers(token) });
    const realResponse = await app.inject({ url: `/v1/media/${real.sha256}`, headers: headers(token) });
    assert.equal(simulatedResponse.headers[MEDIA_SIMULATED_HEADER], 'true');
    assert.equal(realResponse.headers[MEDIA_SIMULATED_HEADER], undefined);
  });

  await t.test('an eligible reference to shared content is never mislabelled simulated, even if the same bytes are also test_eligible elsewhere', async () => {
    const { token } = await provisionIdentity();
    const bytes = randomBytes(4096);
    await seedMediaFixture({ availability: 'test_eligible', fileBytes: bytes });
    const real = await seedMediaFixture({ availability: 'eligible', fileBytes: bytes }); // same bytes, same sha256
    const response = await app.inject({ url: `/v1/media/${real.sha256}`, headers: headers(token) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers[MEDIA_SIMULATED_HEADER], undefined);
  });

  await t.test('HEAD returns the same headers with no body', async () => {
    const { token } = await provisionIdentity();
    const bytes = randomBytes(9000);
    const fixture = await seedMediaFixture({ availability: 'eligible', fileBytes: bytes });
    const response = await app.inject({ method: 'HEAD', url: `/v1/media/${fixture.sha256}`, headers: headers(token) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['content-type'], 'video/mp4');
    assert.equal((response.rawPayload as Buffer).length, 0);
  });

  await t.test('Range requests: 206 slices reassemble byte-identically to the whole file, and an unsatisfiable range is 416', async () => {
    const { token } = await provisionIdentity();
    const bytes = randomBytes(100_003);
    const fixture = await seedMediaFixture({ availability: 'eligible', fileBytes: bytes });

    const first = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: { ...headers(token), range: 'bytes=0-9999' } });
    assert.equal(first.statusCode, 206);
    assert.equal(first.headers['content-range'], `bytes 0-9999/${bytes.length}`);
    assert.equal(first.headers['content-length'], '10000');
    assert.ok((first.rawPayload as Buffer).equals(bytes.subarray(0, 10000)));

    const middle = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: { ...headers(token), range: 'bytes=10000-99999' } });
    assert.equal(middle.statusCode, 206);
    assert.ok((middle.rawPayload as Buffer).equals(bytes.subarray(10000, 100000)));

    const openEnded = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: { ...headers(token), range: `bytes=100000-` } });
    assert.equal(openEnded.statusCode, 206);
    assert.equal(openEnded.headers['content-range'], `bytes 100000-${bytes.length - 1}/${bytes.length}`);
    assert.ok((openEnded.rawPayload as Buffer).equals(bytes.subarray(100000)));

    const suffix = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: { ...headers(token), range: 'bytes=-3' } });
    assert.equal(suffix.statusCode, 206);
    assert.ok((suffix.rawPayload as Buffer).equals(bytes.subarray(bytes.length - 3)));

    // Reassembly: first + middle + openEnded cover the whole file, in order, byte-identically.
    const reassembled = Buffer.concat([first.rawPayload as Buffer, middle.rawPayload as Buffer, openEnded.rawPayload as Buffer]);
    assert.ok(reassembled.equals(bytes));

    const unsatisfiable = await app.inject({ url: `/v1/media/${fixture.sha256}`, headers: { ...headers(token), range: `bytes=${bytes.length + 10}-${bytes.length + 20}` } });
    assert.equal(unsatisfiable.statusCode, 416);
    assert.equal(unsatisfiable.headers['content-range'], `bytes */${bytes.length}`);
  });

  await t.test('no transaction is held while streaming: a slow client read does not block a concurrent write to the same session row', async () => {
    const identity = await provisionIdentity();
    const bytes = randomBytes(24 * 1024 * 1024); // large enough to force real TCP backpressure
    const fixture = await seedMediaFixture({ availability: 'eligible', fileBytes: bytes });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const conn = await pausedGet(port, `/v1/media/${fixture.sha256}`, identity.token);
    try {
      assert.equal(conn.statusCode, 200);
      // The socket is paused right after the response headers: the server is very likely still
      // trying to write the body (Node/TCP backpressure) because nothing is reading it.
      await sleep(300);
      const start = Date.now();
      await pool.query('UPDATE device_session SET expires_at=expires_at WHERE id=$1', [identity.scope.sessionId]);
      const elapsedMs = Date.now() - start;
      assert.ok(elapsedMs < 2000, `a concurrent write to the authorizing session row took ${elapsedMs}ms; a held transaction/lock would block it far longer`);

      const body = await drain(conn.socket, conn.initialBody);
      assert.ok(body.equals(bytes));
    } finally {
      conn.socket.destroy();
    }
  });
});

// -------------------------------------------------------------------------------------------
// Raw-socket helpers for the concurrency proof: fastify's `.inject()` buffers the whole response
// in memory and never exposes real backpressure, so this proof needs an actual TCP socket we can
// pause mid-stream.
// -------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

interface PausedResponse {
  socket: net.Socket;
  statusCode: number;
  responseHeaders: Record<string, string>;
  initialBody: Buffer;
}

/** Sends a raw HTTP/1.1 GET, reads only up to the end of the response headers, then PAUSES the
 * socket immediately — halting further reads and letting real TCP flow control push back on the
 * server's still-in-progress write. */
function pausedGet(port: number, path: string, token: string): Promise<PausedResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      socket.pause();
      const headerText = buffer.subarray(0, idx).toString('utf8');
      const initialBody = Buffer.from(buffer.subarray(idx + 4));
      const [statusLine, ...headerLines] = headerText.split('\r\n');
      const statusCode = Number(statusLine!.split(' ')[1]);
      const responseHeaders: Record<string, string> = {};
      for (const line of headerLines) {
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        responseHeaders[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
      }
      resolvePromise({ socket, statusCode, responseHeaders, initialBody });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/** Resumes a paused socket and reads it to completion (the server closes the connection once the
 * response finishes, because the request above sent `Connection: close`). */
function drain(socket: net.Socket, initialBody: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [initialBody];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolvePromise(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.resume();
  });
}
