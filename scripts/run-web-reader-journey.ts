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

type ManagedProcess = { child: ChildProcess; startupError?: Error; label: string };
const activeCommands = new Set<ChildProcess>();

/** quiet=true buffers output only for the eventual error message (migrate/seed noise); quiet=false streams live (Playwright's own progress). */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = root, quiet = true): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', detached: process.platform !== 'win32' });
    activeCommands.add(child);
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', chunk => (stdout += chunk));
    child.stderr?.on('data', chunk => (stderr += chunk));
    child.once('error', error => {
      activeCommands.delete(child);
      reject(error);
    });
    child.once('exit', code => {
      activeCommands.delete(child);
      code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv, label: string, cwd = root): ManagedProcess {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const managed: ManagedProcess = { child, label };
  child.once('error', error => {
    managed.startupError = error;
  });
  child.stdout?.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`));
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
  for (const child of activeCommands) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
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

  admin = new pg.Client({ connectionString: databaseUrl(sourceUrl, 'postgres'), connectionTimeoutMillis: 5000 });
  await admin.connect();
  throwIfInterrupted();
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
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

  await run('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], backendEnvironment);
  throwIfInterrupted();
  await run('pnpm', ['exec', 'tsx', 'scripts/seed.ts'], backendEnvironment);
  throwIfInterrupted();

  api = start('pnpm', ['exec', 'tsx', 'apps/api/src/main.ts'], backendEnvironment, 'api');
  worker = start('pnpm', ['exec', 'tsx', 'apps/worker/src/main.ts'], backendEnvironment, 'worker');
  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(`${apiBase}/health`, { authorization: `Bearer ${token}` }, [api, worker], 'disposable API/worker');
  throwIfInterrupted();

  // Fault-injecting proxy sits between the Vite dev-auth proxy and the real API.
  const faultProxyLog = { port: 0 };
  faultProxy = start('pnpm', ['exec', 'tsx', 'apps/web/e2e/support/fault-proxy-cli.ts', apiBase], backendEnvironment, 'fault-proxy');
  const faultProxyPort = await new Promise<number>((resolvePort, reject) => {
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
  });
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
  webDev = start('pnpm', ['exec', 'vite', '--config', 'vite.config.ts'], webEnvironment, 'web-dev', resolve(root, 'apps/web'));
  const webBase = `http://127.0.0.1:${webPort}`;
  await waitForHealth(webBase, {}, [webDev, api, worker, faultProxy], 'Vite dev server');
  throwIfInterrupted();

  // Smoke-check the dev-auth proxy end to end before handing off to Playwright:
  // an unauthenticated curl-style request to the proxied path must succeed
  // because Vite injects the bearer token server-side.
  const proxyCheck = await fetch(`${webBase}/v1/session`, { signal: AbortSignal.timeout(3000) });
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
  let playwrightError: unknown;
  try {
    await run('pnpm', ['exec', 'playwright', 'test'], playwrightEnvironment, resolve(root, 'apps/web'), false);
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
  throw error;
} finally {
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
