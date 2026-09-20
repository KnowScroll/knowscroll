/**
 * J008 — ADR-0026's joined proof: request a magic link for the owner address, read it from the
 * development sink, show `GET /v1/auth/confirm` never consumes, `POST /v1/auth/session` consumes
 * exactly once, the minted session authenticates a normal call and can sign itself out, and a
 * replayed or expired token is refused — issue #104 under #2/#4/#12/#72.
 *
 * Against a fresh disposable `knowscroll_test_signin_journey_*` PostgreSQL database and a real,
 * separate KnowScroll API process (`apps/api/src/main.ts`), with its own scratch `KS_DEV_ROOT` so
 * the development sink never touches this machine's real local state:
 *
 *  1. `POST /v1/auth/magic-link` for an unknown address and for the (journey-chosen, single-run)
 *     owner address both answer an identical `202`.
 *  2. Read the confirmation link from the development sink file, never logged.
 *  3. `GET /v1/auth/confirm` reports `valid:true` and is safe to call again — still `true`.
 *  4. `POST /v1/auth/session` consumes it once, mints a session; that session authenticates
 *     `GET /v1/session`.
 *  5. Sign out (`POST /v1/session/revoke`); the same session then fails authentication.
 *  6. The already-consumed token, replayed, is refused with the same generic shape.
 *  7. A separately fabricated, already-expired token is refused with the same generic shape too.
 *
 * Evidence level throughout: A DISPOSABLE DATABASE AND A SCRATCH DEVELOPMENT SINK — NEVER THE
 * OWNER'S UNIVERSE, NEVER A REAL MAIL PROVIDER. No token or address is ever written to the receipt
 * or this script's own console output; only booleans, lengths and shapes are recorded.
 *
 * Usage (source scripts/env.sh first):
 *   pnpm exec tsx scripts/run-signin-journey.ts
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

import { runMigrations } from '../packages/db/src/migrations.ts';

const execFileAsync = promisify(execFile);
const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules/.bin/tsx');
const API_MAIN = join(REPO_ROOT, 'apps/api/src/main.ts');

const KS_DEV_ROOT = process.env.KS_DEV_ROOT;
if (!KS_DEV_ROOT) throw new Error('KS_DEV_ROOT is not set; source scripts/env.sh before running this script');
const DEV_ROOT: string = KS_DEV_ROOT;

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOGS_ROOT = join(DEV_ROOT, 'sign-in', 'logs');
const SCRATCH_ROOT = join(DEV_ROOT, 'sign-in', `journey-${RUN_STAMP}`);
const SCRATCH_DEV_ROOT = join(SCRATCH_ROOT, 'dev-root'); // the child API's OWN KS_DEV_ROOT, never the real one
const SINK_PATH = join(SCRATCH_DEV_ROOT, 'sign-in', 'magic-link.txt');

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
  const name = `knowscroll_test_signin_journey_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
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
// Process management (matches scripts/run-inventory-journey.ts's own pattern).
// -------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const; // deliberately NOT KS_DEV_ROOT: the
  // child gets its own scratch value below, never this process's real one.
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return { ...env, ...extra };
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
  console.log(JSON.stringify({ service: 'signin-journey', event: pass ? 'check_pass' : 'check_fail', name, expected, observed }));
  if (!pass) throw new Error(`J008 check failed: ${name}: expected ${expected}, observed ${observed}`);
}

async function readSinkLink(): Promise<string> {
  return (await readFile(SINK_PATH, 'utf8')).trim();
}
function tokenFromLink(link: string): string {
  const url = new URL(link);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('confirmation link carried no token parameter');
  return token;
}

async function main(): Promise<void> {
  await mkdir(LOGS_ROOT, { recursive: true });
  await mkdir(SCRATCH_DEV_ROOT, { recursive: true });

  const [gitRev, nodeVersion] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).then((r) => r.stdout.trim()),
    Promise.resolve(process.version),
  ]);

  const db = await createDisposableDatabase();
  let apiChild: ChildProcess | undefined;
  try {
    await runMigrations(db.pool, { directory: join(REPO_ROOT, 'packages/db/migrations') });
    await db.pool.query('INSERT INTO universe(id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER_ID]);
    await db.pool.query('INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER_ID]);

    // Chosen fresh for this single run; never written to the receipt or console.
    const ownerEmail = `j008-owner-${randomUUID()}@example.test`;
    const unknownEmail = `j008-unknown-${randomUUID()}@example.test`;

    const devToken = randomBytes(32).toString('hex');
    const apiPort = 20000 + Math.floor(Math.random() * 10000);
    const apiEnv = childEnv({
      DATABASE_URL: db.url, KS_DEV_TOKEN: devToken, PORT: String(apiPort),
      KS_DEV_ROOT: SCRATCH_DEV_ROOT, KS_OWNER_EMAIL: ownerEmail, NODE_ENV: 'test',
    });
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
      if (i > 100) throw new Error('J008: API process never became healthy');
      await sleep(100);
    }
    console.log(JSON.stringify({ service: 'signin-journey', event: 'api_started', port: apiPort }));

    // 1. Unknown and owner addresses answer an identical 202.
    const unknownResponse = await fetch(`${apiBase}/v1/auth/magic-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: unknownEmail }),
    });
    record('unknown address status', '202', String(unknownResponse.status), unknownResponse.status === 202);
    const unknownBody = await unknownResponse.text();

    const ownerResponse = await fetch(`${apiBase}/v1/auth/magic-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ownerEmail }),
    });
    record('owner address status', '202', String(ownerResponse.status), ownerResponse.status === 202);
    const ownerBody = await ownerResponse.text();
    record('unknown and owner response bodies are byte-identical', 'true', String(unknownBody === ownerBody), unknownBody === ownerBody);

    // 2. Read the link from the development sink (never logged).
    const link = await readSinkLink();
    record('development sink produced a link', 'true', String(link.length > 0), link.length > 0);
    record('sink content carries no @ character (no address written)', 'false', String(link.includes('@')), !link.includes('@'));
    const token = tokenFromLink(link);
    record('extracted a token from the confirmation link', 'true', String(token.length > 0), token.length > 0);

    // 3. GET confirm never consumes and is repeatable.
    const confirm1 = await fetch(`${apiBase}/v1/auth/confirm?token=${encodeURIComponent(token)}`);
    const confirm1Json = await confirm1.json() as { valid: boolean };
    record('first confirm status', '200', String(confirm1.status), confirm1.status === 200);
    record('first confirm reports valid:true', 'true', String(confirm1Json.valid), confirm1Json.valid === true);
    const confirm2 = await fetch(`${apiBase}/v1/auth/confirm?token=${encodeURIComponent(token)}`);
    const confirm2Json = await confirm2.json() as { valid: boolean };
    record('repeated confirm still reports valid:true (GET never consumes)', 'true', String(confirm2Json.valid), confirm2Json.valid === true);

    // 4. POST session consumes once and mints a working session.
    const sessionResponse = await fetch(`${apiBase}/v1/auth/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    record('session consumption status', '200', String(sessionResponse.status), sessionResponse.status === 200);
    const session = await sessionResponse.json() as { sessionToken: string; origin: string; accountId: string };
    record('minted session origin', 'magic_link', session.origin, session.origin === 'magic_link');
    record('minted session names an account', 'true', String(typeof session.accountId === 'string' && session.accountId.length > 0), typeof session.accountId === 'string' && session.accountId.length > 0);

    const authedCall = await fetch(`${apiBase}/v1/session`, { headers: { Authorization: `Bearer ${session.sessionToken}` } });
    record('authenticated call using the minted session', '200', String(authedCall.status), authedCall.status === 200);

    // 5. Sign out; the same session then fails.
    const revoke = await fetch(`${apiBase}/v1/session/revoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.sessionToken}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    record('sign-out status', '204', String(revoke.status), revoke.status === 204);
    const afterRevoke = await fetch(`${apiBase}/v1/session`, { headers: { Authorization: `Bearer ${session.sessionToken}` } });
    record('revoked session is refused', '401', String(afterRevoke.status), afterRevoke.status === 401);

    // 6. Replay of the already-consumed token is refused with the generic shape.
    const replay = await fetch(`${apiBase}/v1/auth/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const replayJson = await replay.json();
    record('replayed token status', '401', String(replay.status), replay.status === 401);
    record('replayed token error shape', '{"error":"Unauthorized"}', JSON.stringify(replayJson), JSON.stringify(replayJson) === '{"error":"Unauthorized"}');

    // 7. A separately fabricated, already-expired token is refused the same way. `expires_at` is
    // immutable once inserted (sign_in_token_guard), so this inserts an already-expired row
    // directly rather than aging a real one out from underneath — a valid shape, just entirely in
    // the past, and never derived from any token this journey actually requested.
    const { rows: [{ id: accountId }] } = await db.pool.query('SELECT id FROM account LIMIT 1');
    const expiredRawToken = randomBytes(32).toString('base64url');
    await db.pool.query(
      `INSERT INTO sign_in_token(id,account_id,token_hash,purpose,expires_at,created_at)
       VALUES($1,$2,$3,'sign_in',clock_timestamp() - interval '5 minutes',clock_timestamp() - interval '10 minutes')`,
      [randomUUID(), accountId, createHash('sha256').update(expiredRawToken, 'utf8').digest('hex')],
    );
    const expired = await fetch(`${apiBase}/v1/auth/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: expiredRawToken }),
    });
    const expiredJson = await expired.json();
    record('expired token status', '401', String(expired.status), expired.status === 401);
    record('expired token error shape matches the replay refusal exactly', JSON.stringify(replayJson), JSON.stringify(expiredJson), JSON.stringify(expiredJson) === JSON.stringify(replayJson));

    const receipt = {
      journey: 'J008',
      evidenceLevel: 'disposable database and scratch development sink — never the owner universe, never a real mail provider',
      runStamp: RUN_STAMP,
      knowscrollHead: gitRev,
      node: nodeVersion,
      database: db.name,
      checks,
      result: 'passed',
    };
    const receiptPath = join(LOGS_ROOT, `signin-journey-${RUN_STAMP}.json`);
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ service: 'signin-journey', event: 'passed', receiptPath, checks: checks.length }));
  } finally {
    if (apiChild) await stopProcess(apiChild);
    await dropDisposableDatabase(db);
    await rm(SCRATCH_ROOT, { recursive: true, force: true });
  }
}

await main();
