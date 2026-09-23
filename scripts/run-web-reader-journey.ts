/**
 * Orchestrates the #92 web-reader Playwright evidence run against a fully
 * disposable stack: PostgreSQL database `knowscroll_test_*` (created and
 * dropped here, never the owner `knowscroll` database), a real API process,
 * a real worker process, a real fault-injecting HTTP proxy
 * (apps/web/e2e/support/fault-proxy.ts, run out-of-process via its CLI
 * wrapper so this NodeNext-resolved root script never statically imports a
 * Vite/bundler-resolved apps/web source file), and a real Vite dev server
 * (apps/web) proxying through it. Never touches the owner database, an
 * emulator, or a Cutroom process. Modeled on scripts/run-isolated-journey.ts.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
/** Every process started via `start()` (api/worker/fault-proxy/web-dev), so a fatal abort can kill
 * all of them even outside `cleanup()` -- `activeCommands` alone (populated only by `run()`) never
 * tracked these long-lived children. */
const managedProcesses: ManagedProcess[] = [];

const RECENT_OUTPUT_LINES = 40;
/** Keeps roughly the last `RECENT_OUTPUT_LINES` lines of a child's combined stdout/stderr so an
 * unexpected-exit error can show what it was doing, without holding its entire run in memory. */
function appendRecentOutput(recentOutput: string[], text: string): void {
  recentOutput.push(...text.split('\n'));
  const excess = recentOutput.length - RECENT_OUTPUT_LINES;
  if (excess > 0) recentOutput.splice(0, excess);
}

/** quiet=true buffers output only for the eventual error message (migrate/seed noise); quiet=false also streams it live (Playwright's own progress) -- piped either way so both modes can report progress to the watchdog and, on an abnormal exit, their own last output. */
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
      // A kill we ourselves issued (fatal abort or SIGINT/SIGTERM) already has a clearer, more
      // specific error in flight (triggerFatal's, or the interruption itself); don't bury it
      // under this child's own "exited 143(SIGTERM)" noise.
      if (fatalTriggered) return reject(fatalError ?? new Error(`${command} ${args.join(' ')} exited ${code} during an aborted run`));
      if (interrupted) return reject(new Error(`${command} ${args.join(' ')} exited ${code}: web-reader journey runner interrupted`));
      reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
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
  // A managed child (api/worker/fault-proxy/web-dev) is expected to keep running for the whole
  // journey. If it exits on its own -- not because `stop()`/a fatal abort marked it `stopping`
  // first -- that is itself the failure: name which child, how it ended, and what it last said.
  child.once('exit', (code, signal) => {
    if (managed.stopping) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    const tail = managed.recentOutput.join('\n').trim();
    triggerFatal(
      new Error(
        [
          `web-reader journey: managed child "${label}" exited unexpectedly during phase "${currentPhase}" (${reason}).`,
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
  // Mark it first: this is an expected, self-initiated stop, not the unexpected exit `start()`'s
  // own exit handler watches for.
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

/**
 * #115: a run that makes no progress (nothing spawned or observed has produced output, and no
 * phase transition has happened) for this long aborts loudly instead of hanging until something
 * external kills it -- exactly what happened twice running this journey by hand against a healthy
 * commit. `noteActivity()` is called on every managed/`run()` child's stdout/stderr chunk and on
 * every phase transition, so a hang anywhere (Playwright itself included, now that its process is
 * piped rather than merely inherited) is caught, not just a hang before the first process starts.
 */
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
/** Records which part of the journey is running, for both the watchdog's timeout message and any
 * managed child's unexpected-exit message. */
function notePhase(phase: string): void {
  currentPhase = phase;
  noteActivity();
}

let fatalTriggered = false;
let fatalError: Error | undefined;
let rejectFatal!: (error: Error) => void;
/** Never resolves; rejects exactly once, the first time something fatal (an unexpected managed
 * child death or the watchdog) happens. Main-flow awaits race against this so the descriptive
 * fatal error wins over whatever generic rejection a now-killed child's own promise produces. */
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
/** Races `promise` against the fatal signal so a hang or an unexpected managed-child death aborts
 * whatever the main flow is currently awaiting, instead of leaving it to hang until that awaited
 * promise itself eventually settles (which, for a genuine hang, it never does). */
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
        `web-reader journey watchdog: no progress for ${Math.round(idleMs / 1000)}s during phase "${currentPhase}" ` +
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
let api: ManagedProcess | undefined;
let worker: ManagedProcess | undefined;
let faultProxy: ManagedProcess | undefined;
let webDev: ManagedProcess | undefined;
let databaseCreated = false;
let interrupted = false;
let cleanupPromise: Promise<void> | undefined;

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
    for (const managed of [webDev, faultProxy, worker, api]) {
      try {
        await stop(managed);
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
    if (errors.length) throw new AggregateError(errors, 'web-reader journey cleanup failed');
  })();
  await cleanupPromise;
  return { databaseDropped };
}

function throwIfInterrupted(): void {
  if (interrupted) throw new Error('web-reader journey runner interrupted');
}

const receipt: Record<string, unknown> = { journey: 'web-reader-92', startedAt: new Date().toISOString() };
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
  await guarded(admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`));
  databaseCreated = true;
  throwIfInterrupted();

  const disposableUrl = databaseUrl(sourceUrl, databaseName);
  const apiPort = await freePort();
  const token = randomBytes(32).toString('hex');
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
  };

  notePhase('running database migrations');
  await guarded(run('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], backendEnvironment));
  throwIfInterrupted();
  notePhase('seeding the disposable database');
  await guarded(run('pnpm', ['exec', 'tsx', 'scripts/seed.ts'], backendEnvironment));
  throwIfInterrupted();

  notePhase('starting the API and worker');
  api = start('pnpm', ['exec', 'tsx', 'apps/api/src/main.ts'], backendEnvironment, 'api');
  worker = start('pnpm', ['exec', 'tsx', 'apps/worker/src/main.ts'], backendEnvironment, 'worker');
  const apiBase = `http://127.0.0.1:${apiPort}`;
  notePhase('waiting for the disposable API/worker to become healthy');
  await guarded(waitForHealth(`${apiBase}/health`, { authorization: `Bearer ${token}` }, [api, worker], 'disposable API/worker'));
  throwIfInterrupted();

  // Fault-injecting proxy sits between the Vite dev-auth proxy and the real API.
  notePhase('starting the fault-injecting proxy');
  const faultProxyLog = { port: 0 };
  faultProxy = start('pnpm', ['exec', 'tsx', 'apps/web/e2e/support/fault-proxy-cli.ts', apiBase], backendEnvironment, 'fault-proxy');
  const faultProxyPort = await guarded(
    new Promise<number>((resolvePort, reject) => {
      const onData = (chunk: Buffer) => {
        const match = /PORT=(\d+)/.exec(chunk.toString());
        if (match) {
          faultProxy!.child.stdout?.off('data', onData);
          resolvePort(Number(match[1]));
        }
      };
      faultProxy!.child.stdout?.on('data', onData);
      faultProxy!.child.once('exit', code => reject(new Error(`fault-proxy exited before reporting its port: ${code}`)));
      setTimeout(() => reject(new Error('fault-proxy never reported its port')), 10000).unref();
    }),
  );
  faultProxyLog.port = faultProxyPort;
  throwIfInterrupted();

  const webPort = await freePort();
  const webEnvironment = {
    ...runtimeEnvironment,
    PORT: String(webPort),
    KS_WEB_API_URL: `http://127.0.0.1:${faultProxyPort}`,
    KS_DEV_TOKEN: token,
    NODE_ENV: 'development',
  };
  notePhase('starting the Vite dev server');
  webDev = start('pnpm', ['exec', 'vite', '--config', 'vite.config.ts'], webEnvironment, 'web-dev', resolve(root, 'apps/web'));
  const webBase = `http://127.0.0.1:${webPort}`;
  notePhase('waiting for the Vite dev server to become healthy');
  await guarded(waitForHealth(webBase, {}, [webDev, api, worker, faultProxy], 'Vite dev server'));
  throwIfInterrupted();

  // Smoke-check the dev-auth proxy end to end before handing off to Playwright:
  // an unauthenticated curl-style request to the proxied path must succeed
  // because Vite injects the bearer token server-side.
  notePhase('running the dev-auth proxy smoke check');
  const proxyCheck = await guarded(fetch(`${webBase}/v1/session`, { signal: AbortSignal.timeout(3000) }));
  if (proxyCheck.status !== 200) throw new Error(`Dev-auth proxy smoke check failed: HTTP ${proxyCheck.status}`);
  const proxyCheckBody = (await proxyCheck.json()) as { sessionId?: string };
  if (!proxyCheckBody.sessionId) throw new Error('Dev-auth proxy smoke check: unexpected /v1/session shape');

  const playwrightEnvironment = {
    ...runtimeEnvironment,
    PW_BASE_URL: webBase,
    KS_FAULT_PROXY_URL: `http://127.0.0.1:${faultProxyPort}`,
    KS_TEST_API_BASE: apiBase,
    KS_TEST_API_TOKEN: token,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(runtimeEnvironment.KS_DEV_ROOT ?? '', 'playwright-browsers'),
    // The cached browser *binary* is required to live on the SSD (ADR-0022/#92
    // brief); the ephemeral per-launch --user-data-dir profile does not. Measured
    // on this SSD, launching Chromium with its scratch profile under
    // $KS_DEV_ROOT/tmp (an external-volume mount) is unreliable -- some launches
    // took 15+ minutes or exceeded Playwright's 180s launch timeout outright.
    // Using the boot volume's fast local /tmp for that scratch profile only
    // resolved it; no product code, evidence, or persistent state is affected.
    TMPDIR: '/tmp',
  };

  mkdirSync(resolve(root, 'apps/web/artifacts'), { recursive: true });
  notePhase('running the Playwright web-reader journey');
  let playwrightError: unknown;
  try {
    await guarded(run('pnpm', ['exec', 'playwright', 'test'], playwrightEnvironment, resolve(root, 'apps/web'), false));
  } catch (error) {
    playwrightError = error;
  }

  receipt.database = databaseName;
  receipt.apiPort = apiPort;
  receipt.faultProxyPort = faultProxyPort;
  receipt.webPort = webPort;
  receipt.devAuthProxySmokeCheck = 'passed (unauthenticated /v1/session via proxy returned 200)';
  receipt.playwright = playwrightError ? { result: 'failed', message: String(playwrightError) } : { result: 'passed' };
  receipt.finishedAt = new Date().toISOString();

  if (playwrightError) throw playwrightError;
  console.log(JSON.stringify({ journey: 'web-reader-92', result: 'passed', ...receipt }));
} catch (error) {
  primaryError = error;
  receipt.error = String(error);
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
    if (primaryError) console.error('web-reader journey cleanup failed after primary error', error);
    else throw error;
  }
  receipt.databaseDropped = cleanupResult?.databaseDropped ?? databaseCreated === false;
  try {
    mkdirSync(resolve(root, 'docs/journeys/evidence/web-reader'), { recursive: true });
    writeFileSync(resolve(root, 'docs/journeys/evidence/web-reader/last-run-receipt.json'), JSON.stringify(receipt, null, 2));
  } catch {
    // Evidence write is best-effort; it must never mask the primary result.
  }
}
