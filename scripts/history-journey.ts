/** J003: clear private bootstrap history through the real HTTP boundary. */
import {type ChildProcess, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

import {type AuthScope, provisionIdentity} from '../packages/db/src/identity.ts';
import {pool} from '../packages/db/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.DATABASE_URL, journeyUrl = process.env.JOURNEY_DATABASE_URL,
      base = process.env.JOURNEY_API_BASE;
if (!databaseUrl || !journeyUrl || databaseUrl !== journeyUrl)
  throw new Error('J003 requires identical DATABASE_URL and JOURNEY_DATABASE_URL');
const database = new URL(journeyUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(database.hostname) ||
    !/^\/knowscroll_j003_[0-9a-f]+$/.test(database.pathname))
  throw new Error('J003 only permits a loopback knowscroll_j003_<hex> database');
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('J003 requires loopback JOURNEY_API_BASE');
const receiptPath = resolve(root, process.env.JOURNEY_RECEIPT_PATH ?? '');
if (!process.env.JOURNEY_RECEIPT_PATH || relative(resolve(root, 'artifacts'), receiptPath).startsWith('..'))
  throw new Error('J003 requires JOURNEY_RECEIPT_PATH under artifacts');
type Feed = {
  decisionId: string; privacyEpoch: number; items: Array<{assetId: string}>
};
type Exposure = {
  exposureId: string; eventId: string
};
type Keep = {
  eventId: string; jobId: string
};
type Clear = {
  receiptId: string; privacyEpoch: number; clearedAt: string
};
type Universe = {
  privacyEpoch: number; traces: Array<{eventId: string}>
};
function assert(v: unknown, m: string): asserts v {
  if (!v) throw new Error(`J003 assertion failed: ${m}`)
}
async function api<T>(token: string, path: string, init: RequestInit = {}, expected = 200): Promise<T> {
  const r = await fetch(
      `${base}${path}`,
      {...init, headers: {authorization: `Bearer ${token}`, ...init.headers}, signal: AbortSignal.timeout(5000)});
  if (r.status !== expected) throw new Error(`J003 ${path} expected ${expected}, got ${r.status}: ${await r.text()}`);
  return r.status === 204 ? undefined as T : await r.json() as T
}
async function status(token: string, path: string, want: number, init: RequestInit = {}) {
  const r = await fetch(`${base}${path}`, {...init, headers: {authorization: `Bearer ${token}`, ...init.headers}});
  assert(r.status === want, `${path} expected ${want}, got ${r.status}`)
}
async function admit(token: string): Promise<{feed: Feed; exposure: Exposure; keep: Keep}> {
  const feed = await api<Feed>(token, '/v1/feed');
  const item = feed.items[0];
  assert(item, 'seed library has Scroll');
  const exposure = await api<Exposure>(
      token, '/v1/exposures', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({clientExposureId: randomUUID(), decisionId: feed.decisionId, assetId: item.assetId})
      },
      201);
  const keep = await api<Keep>(
      token, '/v1/interactions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(
            {clientEventId: randomUUID(), exposureId: exposure.exposureId, assetId: item.assetId, kind: 'keep'})
      },
      202);
  return {
    feed, exposure, keep
  }
}
function startWorker() {
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/worker/src/main.ts'], {
    cwd: root,
    env: {...process.env, DATABASE_URL: journeyUrl, NODE_ENV: 'test'},
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  child.stdout?.on('data', c => process.stdout.write(`[J003 worker] ${c}`));
  child.stderr?.on('data', c => process.stderr.write(`[J003 worker] ${c}`));
  return child
}
async function stop(child: ChildProcess|undefined) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([new Promise<void>(done => child.once('exit', () => done())), setTimeout(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL')
}
async function waitJob(client: pg.Client, id: string, status: string) {
  for (let i = 0; i < 80; i++) {
    const row = (await client.query('SELECT status FROM job WHERE id=$1', [id])).rows[0];
    if (row?.status === status) return;
    await setTimeout(100)
  }
  throw new Error(`job ${id} did not reach ${status}`)
}
async function counts(client: pg.Client, universeId: string) {
  return (await client.query(
              `SELECT (SELECT count(*)::integer FROM decision WHERE universe_id=$1) AS decisions,(SELECT count(*)::integer FROM exposure WHERE universe_id=$1) AS exposures,(SELECT count(*)::integer FROM ledger WHERE universe_id=$1) AS ledger,(SELECT count(*)::integer FROM job WHERE universe_id=$1) AS jobs,(SELECT count(*)::integer FROM trace WHERE universe_id=$1) AS traces,(SELECT revision FROM accounts WHERE universe_id=$1) AS "accountsRevision"`,
              [universeId]))
      .rows[0]
}
let worker: ChildProcess|undefined, client: pg.Client|undefined, interrupted = false;
const onSignal = () => {
  interrupted = true;
  void stop(worker)
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
let primary: unknown;
try {
  const a = await provisionIdentity(), aOther = await provisionIdentity({universeId: a.scope.universeId}),
        b = await provisionIdentity();
  client = new pg.Client({connectionString: journeyUrl});
  await client.connect();
  const aFirst = await admit(a.token), bFirst = await admit(b.token);
  worker = startWorker();
  await waitJob(client, aFirst.keep.jobId, 'completed');
  await waitJob(client, bFirst.keep.jobId, 'completed');
  await stop(worker);
  worker = undefined;
  const aPending = await admit(a.token);
  const beforeA = await counts(client, a.scope.universeId), beforeB = await counts(client, b.scope.universeId);
  assert(
      beforeA.traces > 0 && beforeA.jobs > 0 && beforeB.traces > 0,
      'A and B have nonempty independent history and A has pending work');
  const clearBody = {
    requestId: randomUUID(),
    expectedPrivacyEpoch: aFirst.feed.privacyEpoch,
    confirmation: 'clear-scroll-history'
  };
  const withheld = await fetch(`${base}/v1/history/clear`, {
    method: 'POST',
    headers: {authorization: `Bearer ${a.token}`, 'content-type': 'application/json'},
    body: JSON.stringify(clearBody)
  });
  assert(withheld.status === 200, 'withheld clear response commits');
  const withheldReceipt = await withheld.json() as Clear;
  const retry = await api<Clear>(
      a.token, '/v1/history/clear',
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(clearBody)});
  assert(JSON.stringify(retry) === JSON.stringify(withheldReceipt), 'exact retry replays the withheld receipt');
  assert(retry.privacyEpoch === clearBody.expectedPrivacyEpoch + 1, 'caller rolls forward one epoch');
  await status(aOther.token, '/v1/session', 401);
  const afterClear = await counts(client, a.scope.universeId), bAfterClear = await counts(client, b.scope.universeId);
  assert(
      afterClear.decisions === 0 && afterClear.exposures === 0 && afterClear.ledger === 0 && afterClear.jobs === 0 &&
          afterClear.traces === 0,
      'clear deletes only A private history');
  assert(JSON.stringify(beforeB) === JSON.stringify(bAfterClear), 'B history is unchanged');
  assert(
      (await client.query('SELECT count(*)::integer AS count FROM asset')).rows[0].count > 0, 'shared assets survive');
  const fresh = await admit(a.token);
  await api<Clear>(
      a.token, '/v1/history/clear',
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(clearBody)});
  assert(
      (await client.query('SELECT count(*)::integer AS count FROM ledger WHERE id=$1', [fresh.keep.eventId]))
              .rows[0]
              .count === 1,
      'exact retry does not erase new activity');
  await status(a.token, '/v1/history/clear', 409, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({...clearBody, requestId: randomUUID(), expectedPrivacyEpoch: clearBody.expectedPrivacyEpoch})
  });
  worker = startWorker();
  await waitJob(client, fresh.keep.jobId, 'completed');
  const aUniverse = await api<Universe>(a.token, '/v1/universe'),
        bUniverse = await api<Universe>(b.token, '/v1/universe');
  assert(
      aUniverse.traces.some(t => t.eventId === fresh.keep.eventId) &&
          bUniverse.traces.some(t => t.eventId === bFirst.keep.eventId),
      'new A epoch and untouched B project independently');
  assert(!aUniverse.traces.some(t => t.eventId === aPending.keep.eventId), 'cleared old Trace cannot return');
  assert(!interrupted, 'journey interrupted');
  const hashes = Object.fromEntries(await Promise.all([
    'apps/api/src/app.ts', 'apps/worker/src/project.ts', 'packages/db/src/privacy.ts',
    'packages/db/migrations/0003_history_clear.sql'
  ].map(async p => [p, createHash('sha256').update(await readFile(resolve(root, p))).digest('hex')])));
  await mkdir(dirname(receiptPath), {recursive: true});
  await writeFile(
      receiptPath,
      JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            journey: 'J003',
            result: 'passed',
            database: {name: database.pathname.slice(1)},
            causal: {oldA: aPending.keep, newA: fresh.keep, b: bFirst.keep, clear: retry},
            beforeA,
            afterClear,
            beforeB,
            bAfterClear,
            sourceHashes: hashes
          },
          null, 2) +
          '\n');
  console.log(JSON.stringify({journey: 'J003', result: 'passed', receiptPath: relative(root, receiptPath)}))
} catch (e) {
  primary = e;
  throw e
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  try {
    await stop(worker);
    await client?.end();
    await pool.end()
  } catch (e) {
    if (primary)
      console.error('J003 cleanup failed', e);
    else
      throw e
  }
}
