/**
 * #135 -- the owner identity/privacy web journey: magic-link sign-in, the desktop cookie session
 * with CSRF (ADR-0034), reading a real Scroll, and account deletion (ADR-0035). Modelled directly
 * on scripts/run-web-reader-journey.ts -- same disposable-database, watchdog and cleanup
 * machinery -- but a simpler process topology (no worker, no fault-injecting proxy: this journey
 * never exercises Keep's async projection or transport faults) and a fundamentally different
 * client configuration: the Vite dev server runs in cookie mode (KS_WEB_AUTH=cookie) rather than
 * the bearer/dev-proxy default, so the API needs KS_WEB_ORIGIN/KS_CSRF_SECRET/KS_OWNER_EMAIL and a
 * dedicated KS_DEV_ROOT (the magic-link dev sink) that no other concurrent run shares.
 *
 * Never touches the owner `knowscroll` database, an emulator, or a Cutroom process.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function localConfig(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split('\n').flatMap(line => {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
}
function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type ManagedProcess = { child: ChildProcess; startupError?: Error; label: string; stopping: boolean; recentOutput: string[] };
const activeCommands = new Set<ChildProcess>();
const managedProcesses: ManagedProcess[] = [];

const RECENT_OUTPUT_LINES = 40;
function appendRecentOutput(recentOutput: string[], text: string): void {
  recentOutput.push(...text.split('\n'));
  const excess = recentOutput.length - RECENT_OUTPUT_LINES;
  if (excess > 0) recentOutput.splice(0, excess);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = root, quiet = true): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    activeCommands.add(child);
    let stdout = '',
      stderr = '';
    const onChunk = (isStderr: boolean) => (chunk: Buffer) => {
      const text = chunk.toString();
      if (isStderr) stderr += text;
      else stdout += text;
      noteActivity();
      if (!quiet) (isStderr ? process.stderr : process.stdout).write(text);
    };
    child.stdout?.on('data', onChunk(false));
    child.stderr?.on('data', onChunk(true));
    child.once('error', error => {
      activeCommands.delete(child);
      reject(error);
    });
    child.once('exit', code => {
      activeCommands.delete(child);
      if (code === 0) return resolveRun({ stdout, stderr });
      if (fatalTriggered) return reject(fatalError ?? new Error(`${command} ${args.join(' ')} exited ${code} during an aborted run`));
      if (interrupted) return reject(new Error(`${command} ${args.join(' ')} exited ${code}: web-owner journey runner interrupted`));
      reject(new Error(quiet ? `${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}` : `${command} ${args.join(' ')} exited ${code} (output above)`));
    });
  });
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv, label: string, cwd = root): ManagedProcess {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const managed: ManagedProcess = { child, label, stopping: false, recentOutput: [] };
  managedProcesses.push(managed);
  child.once('error', error => {
    managed.startupError = error;
  });
  child.stdout?.on('data', chunk => {
    const text = String(chunk);
    process.stdout.write(`[${label}] ${text}`);
    noteActivity();
    appendRecentOutput(managed.recentOutput, text);
  });
  child.stderr?.on('data', chunk => {
    const text = String(chunk);
    process.stderr.write(`[${label}] ${text}`);
    noteActivity();
    appendRecentOutput(managed.recentOutput, text);
  });
  child.once('exit', (code, signal) => {
    if (managed.stopping) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    const tail = managed.recentOutput.join('\n').trim();
    triggerFatal(
      new Error(
        [
          `web-owner journey: managed child "${label}" exited unexpectedly during phase "${currentPhase}" (${reason}).`,
          tail ? `Last output from "${label}" (up to ${RECENT_OUTPUT_LINES} lines):\n${tail}` : `"${label}" produced no output before exiting.`,
        ].join('\n'),
      ),
    );
  });
  return managed;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No TCP port assigned'));
      const port = address.port;
      server.close(error => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForHealth(url: string, headers: Record<string, string>, processes: ManagedProcess[], label: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const proc of processes) {
      if (proc.startupError) throw proc.startupError;
      if (proc.child.exitCode !== null) throw new Error(`${proc.label} exited before ${label} became ready: ${proc.child.exitCode}`);
    }
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      last = await response.text();
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`${label} never became healthy: ${String(last)}`);
}

async function stop(managed: ManagedProcess | undefined): Promise<void> {
  const child = managed?.child;
  if (!child || child.exitCode !== null || !child.pid) return;
  if (managed) managed.stopping = true;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([new Promise<void>(resolveExit => child.once('exit', () => resolveExit())), sleep(5000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

const WATCHDOG_MS = (() => {
  const raw = process.env.KS_WEB_JOURNEY_WATCHDOG_MS;
  if (raw === undefined || raw === '') return 10 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`KS_WEB_JOURNEY_WATCHDOG_MS must be a positive number of milliseconds; got ${JSON.stringify(raw)}`);
  return parsed;
})();
const WATCHDOG_POLL_MS = 15_000;

let currentPhase = 'starting up';
let lastActivityAt = Date.now();
function noteActivity(): void {
  lastActivityAt = Date.now();
}
function notePhase(phase: string): void {
  currentPhase = phase;
  noteActivity();
}

let fatalTriggered = false;
let fatalError: Error | undefined;
let rejectFatal!: (error: Error) => void;
const fatalPromise = new Promise<never>((_resolve, reject) => {
  rejectFatal = reject;
});
function killAllChildren(): void {
  for (const child of activeCommands) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  for (const managed of managedProcesses) {
    const child = managed.child;
    if (managed.stopping || child.exitCode !== null || !child.pid) continue;
    managed.stopping = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}
function triggerFatal(error: Error): void {
  if (fatalTriggered) return;
  fatalTriggered = true;
  fatalError = error;
  interrupted = true;
  killAllChildren();
  rejectFatal(error);
}
function guarded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, fatalPromise]);
}

let watchdogTimer: NodeJS.Timeout | undefined;
function startWatchdog(): void {
  watchdogTimer = setInterval(() => {
    if (fatalTriggered || interrupted) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs < WATCHDOG_MS) return;
    triggerFatal(
      new Error(
        `web-owner journey watchdog: no progress for ${Math.round(idleMs / 1000)}s during phase "${currentPhase}" ` +
          `(limit ${Math.round(WATCHDOG_MS / 1000)}s; override with KS_WEB_JOURNEY_WATCHDOG_MS).`,
      ),
    );
  }, WATCHDOG_POLL_MS);
  watchdogTimer.unref();
}
function stopWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
}

const suffix = randomBytes(8).toString('hex');
const databaseName = `knowscroll_test_${suffix}`;
let admin: pg.Client | undefined;
let disposable: pg.Client | undefined;
let api: ManagedProcess | undefined;
let webDev: ManagedProcess | undefined;
let databaseCreated = false;
let interrupted = false;
let cleanupPromise: Promise<void> | undefined;
let scratch: string | undefined;

function onSignal(): void {
  interrupted = true;
  killAllChildren();
}
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

async function cleanup(): Promise<{ databaseDropped: boolean }> {
  if (cleanupPromise) return cleanupPromise.then(() => ({ databaseDropped: true }));
  let databaseDropped = false;
  cleanupPromise = (async () => {
    const errors: unknown[] = [];
    for (const managed of [webDev, api]) {
      try {
        await stop(managed);
      } catch (error) {
        errors.push(error);
      }
    }
    if (disposable) {
      try {
        await disposable.end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (admin) {
      if (databaseCreated) {
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
          databaseDropped = true;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await admin.end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (scratch) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'web-owner journey cleanup failed');
  })();
  await cleanupPromise;
  return { databaseDropped };
}

function throwIfInterrupted(): void {
  if (interrupted) throw fatalError ?? new Error('web-owner journey runner interrupted');
}

const receipt: Record<string, unknown> = { journey: 'web-owner-135', startedAt: new Date().toISOString() };
function forReceipt(error: unknown): string {
  return String(error).replaceAll(root, '<repo>').replaceAll(process.env.HOME ?? '\u0000', '<home>').slice(0, 2000);
}
let primaryError: unknown;

try {
  let config: Record<string, string> = {};
  try {
    config = localConfig(await readFile(resolve(root, '.env'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const sourceUrl = process.env.DATABASE_URL ?? config.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL is required in the environment or the lane .env');
  const source = new URL(sourceUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(source.hostname)) {
    throw new Error('This runner only permits a loopback PostgreSQL server');
  }
  if (source.pathname.replace(/^\//, '') === 'knowscroll') {
    throw new Error('Refusing to use the owner database name "knowscroll" as the admin connection target');
  }

  startWatchdog();
  admin = new pg.Client({ connectionString: databaseUrl(sourceUrl, 'postgres'), connectionTimeoutMillis: 5000 });
  notePhase('connecting to the admin PostgreSQL database');
  await guarded(admin.connect());
  throwIfInterrupted();
  notePhase('creating the disposable database');
  databaseCreated = true;
  await guarded(admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`));
  throwIfInterrupted();

  const disposableUrl = databaseUrl(sourceUrl, databaseName);

  // A dedicated scratch KS_DEV_ROOT for the magic-link dev sink (DevelopmentMagicLinkSink writes
  // one fixed file under it) -- never the real shared KS_DEV_ROOT, so a concurrent session's own
  // sign-in link can never collide with (or be clobbered by) this run's.
  scratch = await mkdtemp(join(tmpdir(), 'ks-web-owner-journey-'));

  const apiPort = await freePort();
  const webPort = await freePort();
  const token = randomBytes(32).toString('hex');
  const csrfSecret = randomBytes(32).toString('hex'); // 64 ASCII chars = 64 bytes, well over the 32-byte minimum
  const ownerEmail = `owner-${suffix}@knowscroll.test`;
  // The exact Vite origin (ADR-0034's own same-origin CSRF check compares this literally against
  // the browser's real Origin header) -- vite.config.ts hardcodes host 127.0.0.1 for both dev and
  // preview, so this is also exactly what Playwright's own baseURL below must be.
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const runtimeEnvironment = Object.fromEntries(
    ['PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR'].flatMap(name => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const backendEnvironment = {
    ...runtimeEnvironment,
    ...Object.fromEntries(Object.keys(config).map(key => [key, ''])), // never inherit the lane .env's own values into child processes
    DATABASE_URL: disposableUrl,
    KS_DEV_TOKEN: token,
    PORT: String(apiPort),
    NODE_ENV: 'test',
    KS_WEB_ORIGIN: webOrigin,
    KS_CSRF_SECRET: csrfSecret,
    KS_OWNER_EMAIL: ownerEmail,
    KS_DEV_ROOT: scratch, // overrides the inherited real one -- see the doc comment above
  };

  notePhase('running database migrations');
  await guarded(run('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], backendEnvironment));
  throwIfInterrupted();
  notePhase('seeding the disposable database');
  // The same finite three-Scroll editorial fixture the reader journey uses (apps/web/e2e/fixtures)
  // -- this journey proves owner-identity mechanics, not the size of the product library.
  await guarded(run('pnpm', ['exec', 'tsx', 'scripts/seed.ts'],
    { ...backendEnvironment, KS_SEED_SCROLLS: 'apps/web/e2e/fixtures/reader-library.json', KS_SEED_SUBSTRATE: 'none' }));
  throwIfInterrupted();

  notePhase('starting the API (no worker: this journey never exercises Keep\'s async projection)');
  api = start('pnpm', ['exec', 'tsx', 'apps/api/src/main.ts'], backendEnvironment, 'api');
  const apiBase = `http://127.0.0.1:${apiPort}`;
  notePhase('waiting for the disposable API to become healthy');
  // /health is unauthenticated (apps/api/src/app.ts) -- no credential of any kind is needed here.
  await guarded(waitForHealth(`${apiBase}/health`, {}, [api], 'disposable API'));
  throwIfInterrupted();

  const webEnvironment = {
    ...runtimeEnvironment,
    PORT: String(webPort),
    KS_WEB_API_URL: apiBase,
    KS_WEB_AUTH: 'cookie', // #135, ADR-0034: forward the browser's own cookie; never inject Authorization
    NODE_ENV: 'development',
  };
  notePhase('starting the Vite dev server (cookie mode)');
  webDev = start('pnpm', ['exec', 'vite', '--config', 'vite.config.ts'], webEnvironment, 'web-dev', resolve(root, 'apps/web'));
  const webBase = webOrigin;
  notePhase('waiting for the Vite dev server to become healthy');
  await guarded(waitForHealth(webBase, {}, [webDev, api], 'Vite dev server'));
  throwIfInterrupted();

  // Smoke-check the cookie-mode proxy: an unauthenticated request to a cookie-gated route must
  // fail exactly like a direct request would (the proxy injects nothing of its own).
  notePhase('running the cookie-mode proxy smoke check');
  const proxyCheck = await guarded(fetch(`${webBase}/v1/session`, { signal: AbortSignal.timeout(3000) }));
  if (proxyCheck.status !== 401) throw new Error(`Cookie-mode proxy smoke check failed: expected 401 with no cookie, got HTTP ${proxyCheck.status}`);

  const playwrightEnvironment = {
    ...runtimeEnvironment,
    PW_BASE_URL: webBase,
    KS_DEV_ROOT: scratch, // the Playwright spec reads the same magic-link sink file directly
    KS_OWNER_EMAIL: ownerEmail,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(runtimeEnvironment.KS_DEV_ROOT ?? '', 'playwright-browsers'),
    // See run-web-reader-journey.ts's own comment: the boot volume's local /tmp is required for a
    // reliable Chromium launch profile on this SSD; no product code or evidence is affected.
    TMPDIR: '/tmp',
  };

  mkdirSync(resolve(root, 'apps/web/artifacts'), { recursive: true });
  notePhase('running the Playwright web-owner journey');
  let playwrightError: unknown;
  try {
    await guarded(run('pnpm', ['exec', 'playwright', 'test', '--config=playwright.owner.config.ts'], playwrightEnvironment, resolve(root, 'apps/web'), false));
  } catch (error) {
    playwrightError = error;
  }

  receipt.database = databaseName;
  receipt.apiPort = apiPort;
  receipt.webPort = webPort;
  receipt.cookieModeSmokeCheck = 'passed (unauthenticated /v1/session via the cookie-mode proxy returned 401)';
  receipt.playwright = playwrightError ? { result: 'failed', message: forReceipt(playwrightError) } : { result: 'passed' };

  if (!playwrightError) {
    notePhase('verifying the account deletion footprint directly against the disposable database');
    disposable = new pg.Client({ connectionString: disposableUrl, connectionTimeoutMillis: 5000 });
    await guarded(disposable.connect());
    const footprint = (
      await guarded(
        disposable.query(
          `SELECT (SELECT count(*)::int FROM account) accounts,
                  (SELECT count(*)::int FROM account_deletion_receipt) receipts,
                  (SELECT count(*)::int FROM device_session) sessions`,
        ),
      )
    ).rows[0] as { accounts: number; receipts: number; sessions: number };
    receipt.databaseFootprintAfterDeletion = footprint;
    const expected = { accounts: 0, receipts: 1, sessions: 0 };
    if (footprint.accounts !== expected.accounts || footprint.receipts !== expected.receipts || footprint.sessions !== expected.sessions) {
      playwrightError = new Error(
        `Post-deletion database footprint did not match: expected ${JSON.stringify(expected)}, got ${JSON.stringify(footprint)}`,
      );
      receipt.playwright = { result: 'failed', message: forReceipt(playwrightError) };
    }
  }

  receipt.finishedAt = new Date().toISOString();

  if (playwrightError) throw playwrightError;
  console.log(JSON.stringify({ journey: 'web-owner-135', result: 'passed', ...receipt }));
} catch (error) {
  primaryError = error;
  receipt.error = forReceipt(error);
  if (fatalTriggered) receipt.fatal = { phase: currentPhase, watchdogMs: WATCHDOG_MS };
  throw error;
} finally {
  stopWatchdog();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  let cleanupResult: { databaseDropped: boolean } | undefined;
  try {
    cleanupResult = await cleanup();
  } catch (error) {
    if (primaryError) console.error('web-owner journey cleanup failed after primary error', error);
    else throw error;
  }
  receipt.databaseDropped = cleanupResult?.databaseDropped ?? databaseCreated === false;
  try {
    mkdirSync(resolve(root, 'docs/journeys/evidence/web-owner'), { recursive: true });
    writeFileSync(resolve(root, 'docs/journeys/evidence/web-owner/last-run-receipt.json'), JSON.stringify(receipt, null, 2));
  } catch {
    // Evidence write is best-effort; it must never mask the primary result.
  }
}
