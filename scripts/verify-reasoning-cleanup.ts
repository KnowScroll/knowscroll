/** Independently interrupt J004, then inspect PostgreSQL and OS process groups. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Manifest = {
  journey: string; runnerPid: number; ready: boolean; cleanedUp?: boolean;
  apiBase: string; fixtureBase: string;
  database: {host: string; port: string | number; name: string};
  processes: Array<{role: string; pid: number; pgid: number; readyAt: string}>;
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function configDatabase() {
  let config: Record<string, string> = {};
  try {
    config = Object.fromEntries((await readFile(resolve(root, '.env'), 'utf8')).split('\n').flatMap(line => {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return match ? [[match[1]!, match[2]!]] : [];
    }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const source = process.env.DATABASE_URL ?? config.DATABASE_URL;
  assert.ok(source, 'loopback database configuration required');
  const url = new URL(source);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback database required');
  return url;
}

const database = await configDatabase();
const adminUrl = new URL(database); adminUrl.pathname = '/postgres';
const admin = new pg.Client({connectionString: adminUrl.toString()});
await admin.connect();
const observations: unknown[] = [];
const suffix = randomBytes(8).toString('hex');
await mkdir(resolve(root, 'artifacts'), {recursive: true});
try {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const manifestPath = resolve(root, `artifacts/j004-interrupt-${suffix}-${signal}.json`);
    const receiptPath = resolve(root, `artifacts/j004-interrupt-${suffix}-${signal}-receipt.json`);
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'TMPDIR'].flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    env.DATABASE_URL = database.toString();
    env.NODE_ENV = 'test';
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-isolated-reasoning-journey.ts',
      '--manifest', manifestPath, '--receipt', receiptPath, '--pause-for-interrupt'],
    {cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true});
    let exit: {code: number | null; signal: NodeJS.Signals | null} | undefined;
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.once('exit', (code, signal) => { exit = {code, signal}; });
    // Drain without printing possibly sensitive subprocess diagnostics.
    child.stderr?.resume();
    let manifest: Manifest | undefined;
    let validated: Manifest | undefined;
    let primaryFailure: unknown;
    const fallbackErrors: unknown[] = [];
    const attemptCleanup = async (fn: () => Promise<void>) => {
      try { await fn(); } catch (error) { fallbackErrors.push(error); }
    };
    try {
      for (let i = 0; i < 600; i++) {
        if (spawnError) throw spawnError;
        assert.equal(exit, undefined, 'runner exited before the interruption barrier');
        try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (manifest?.ready) break;
        await delay(100);
      }
      assert.ok(manifest?.ready, 'runner never reached the interruption barrier');
      assert.equal(manifest.journey, 'J004');
      assert.equal(manifest.runnerPid, child.pid);
      assert.match(manifest.database.name, /^knowscroll_j004_[a-f0-9]+$/);
      assert.equal(manifest.database.host, database.hostname);
      assert.equal(String(manifest.database.port), database.port || '5432');
      assert.ok(manifest.processes.length >= 3, 'API, fixture and worker processes required');
      assert.equal(new Set(manifest.processes.map(p => p.pid)).size, manifest.processes.length);
      assert.equal(new Set(manifest.processes.map(p => p.role)).size, manifest.processes.length);
      assert.ok(manifest.processes.some(p => p.role === 'api'));
      assert.ok(manifest.processes.some(p => p.role === 'fixture'));
      assert.ok(manifest.processes.some(p => p.role.startsWith('worker')));
      for (const process of manifest.processes) {
        assert.ok(Number.isInteger(process.pid) && process.pid > 1);
        assert.equal(process.pgid, process.pid, 'each child must own its detached process group');
        assert.notEqual(process.pid, child.pid);
        assert.ok(Number.isFinite(Date.parse(process.readyAt)), 'child readiness observation required');
        assert.ok(alive(process.pid), `${process.role} must exist before interruption`);
      }
      const present = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [manifest.database.name]);
      assert.equal(present.rowCount, 1, 'database must exist before interruption');
      validated = structuredClone(manifest);
      for (const base of [manifest.apiBase, manifest.fixtureBase]) {
        const url = new URL(base);
        assert.equal(url.hostname, '127.0.0.1');
        assert.equal(url.protocol, 'http:');
        const health = await fetch(new URL('/health', url), {signal: AbortSignal.timeout(3000), redirect: 'error'});
        assert.equal(health.ok, true, 'independent readiness probe failed');
      }
      assert.equal(child.kill(signal), true, 'failed to deliver interruption signal');
      for (let i = 0; i < 300 && !exit; i++) await delay(100);
      assert.ok(exit, 'runner did not exit after interruption');
      assert.notEqual(exit.code, 0, 'interrupted run must not claim success');
      const final = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
      assert.equal(final.cleanedUp, true, 'runner must acknowledge completed cleanup');
      assert.deepEqual(final.database, manifest.database);
      assert.equal(final.runnerPid, manifest.runnerPid);
      for (let i = 0; i < 50 && manifest.processes.some(p => alive(p.pid) || alive(-p.pgid)); i++) await delay(100);
      for (const process of manifest.processes) {
        assert.equal(alive(process.pid), false, `${process.role} process leaked`);
        assert.equal(alive(-process.pgid), false, `${process.role} process group leaked`);
      }
      assert.equal(alive(child.pid!), false, 'runner process leaked');
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [manifest.database.name])).rowCount, 0,
        'interrupted runner left its disposable database');
      observations.push({signal, runnerPid: child.pid, database: manifest.database, processes: manifest.processes,
        exit, runnerAck: true, databaseAbsent: true, processGroupsAbsent: true, observedAt: new Date().toISOString()});
    } catch (error) {
      primaryFailure = error;
    } finally {
      await attemptCleanup(async () => {
        if (!exit && child.pid) {
          child.kill('SIGTERM');
          for (let i = 0; i < 100 && !exit; i++) await delay(100);
          if (!exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        }
      });
      if (!validated && manifest && manifest.runnerPid === child.pid
        && manifest.database.host === database.hostname
        && String(manifest.database.port) === (database.port || '5432')
        && /^knowscroll_j004_[a-f0-9]+$/.test(manifest.database.name)
        && manifest.processes.every(p => Number.isInteger(p.pid) && p.pid > 1 && p.pgid === p.pid && p.pid !== child.pid)) {
        validated = manifest;
      }
      // Scoped fallback prevents a failed check leaking its own resources. It
      // never changes the failed assertion into passing cleanup evidence.
      if (validated) {
        for (const process of validated.processes) {
          await attemptCleanup(async () => {
            try { globalThis.process.kill(-process.pgid, 'SIGTERM'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          });
        }
        await attemptCleanup(async () => {
          for (let i = 0; i < 50 && validated!.processes.some(p => alive(-p.pgid)); i++) await delay(100);
        });
        for (const process of validated.processes) {
          await attemptCleanup(async () => {
            try { globalThis.process.kill(-process.pgid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          });
        }
        await attemptCleanup(async () => {
          await admin.query(`DROP DATABASE IF EXISTS "${validated!.database.name}" WITH (FORCE)`);
          assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [validated!.database.name])).rowCount, 0);
        });
      }
    }
    if (primaryFailure !== undefined || fallbackErrors.length) {
      throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...fallbackErrors],
        'J004 interruption verification failed; fallback cleanup does not constitute passing evidence');
    }
  }
  const path = resolve(root, `artifacts/j004-cleanup-${suffix}.json`);
  await writeFile(path, JSON.stringify({journey: 'J004', result: 'passed', observations}, null, 2) + '\n');
  console.log(JSON.stringify({journey: 'J004', check: 'interrupted-cleanup', result: 'passed', receiptPath: path}));
} finally { await admin.end(); }
