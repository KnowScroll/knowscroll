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
  database: {host: string; port: string | number; name: string};
  processes: Array<{role: string; pid: number; pgid?: number}>;
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
      for (const process of manifest.processes) {
        assert.ok(Number.isInteger(process.pid) && process.pid > 1);
        assert.notEqual(process.pid, child.pid);
        assert.ok(alive(process.pid), `${process.role} must exist before interruption`);
      }
      const present = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [manifest.database.name]);
      assert.equal(present.rowCount, 1, 'database must exist before interruption');
      child.kill(signal);
      for (let i = 0; i < 300 && !exit; i++) await delay(100);
      assert.ok(exit, 'runner did not exit after interruption');
      assert.notEqual(exit.code, 0, 'interrupted run must not claim success');
      const final = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
      assert.equal(final.cleanedUp, true, 'runner must acknowledge completed cleanup');
      assert.deepEqual(final.database, manifest.database);
      for (const process of manifest.processes) {
        assert.equal(alive(process.pid), false, `${process.role} process leaked`);
        assert.equal(alive(-(process.pgid ?? process.pid)), false, `${process.role} process group leaked`);
      }
      assert.equal(alive(child.pid!), false, 'runner process leaked');
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [manifest.database.name])).rowCount, 0,
        'interrupted runner left its disposable database');
      observations.push({signal, runnerPid: child.pid, database: manifest.database, processes: manifest.processes,
        exit, databaseAbsent: true, processGroupsAbsent: true, observedAt: new Date().toISOString()});
    } finally {
      if (!exit && child.pid) {
        child.kill('SIGTERM');
        for (let i = 0; i < 100 && !exit; i++) await delay(100);
        if (!exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
    }
  }
  const path = resolve(root, `artifacts/j004-cleanup-${suffix}.json`);
  await writeFile(path, JSON.stringify({journey: 'J004', result: 'passed', observations}, null, 2) + '\n');
  console.log(JSON.stringify({journey: 'J004', check: 'interrupted-cleanup', result: 'passed', receiptPath: path}));
} finally { await admin.end(); }
