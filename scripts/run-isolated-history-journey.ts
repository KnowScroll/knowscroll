/** Disposable process runner for J003. */
import {type ChildProcess, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suffix = randomBytes(8).toString('hex'), name = `knowscroll_j003_${suffix}`;
const active = new Set<ChildProcess>();
let interrupted = false;
function throwIfInterrupted() { if (interrupted) throw new Error('isolated J003 runner interrupted'); }
function dbUrl(base: string, n: string) {
  const u = new URL(base);
  u.pathname = `/${n}`;
  return u.toString()
}
function quote(n: string) {
  return `"${n}"`
}
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((ok, bad) => {
    const child = spawn(cmd, args, {cwd: root, env, stdio: 'inherit', detached: true});
    active.add(child);
    child.once('error', error => { active.delete(child); bad(error); });
    child.once('exit', code => { active.delete(child); code === 0 ? ok() : bad(new Error(`${cmd} exited ${code}`)); })
  })
}
async function port() {
  return await new Promise<number>((ok, bad) => {
    const server = createServer();
    server.once('error', bad);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (!a || typeof a === 'string') return bad(new Error('no port'));
      server.close(e => e ? bad(e) : ok(a.port))
    })
  })
}
async function stop(child: ChildProcess|undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([new Promise<void>(done => child.once('exit', () => done())), new Promise(done => setTimeout(done, 5000))]);
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
}
let admin: pg.Client|undefined, api: ChildProcess|undefined, created = false;
const onSignal = () => { interrupted = true; for (const child of active) void stop(child); void stop(api); };
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
try {
  let config: Record < string, string >= {};
  try {
    config = Object.fromEntries((await readFile(resolve(root, '.env'), 'utf8')).split('\n').flatMap(line => {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return m ? [[m[1], m[2]]] : []
    }))
  } catch {
  }
  throwIfInterrupted();
  const source = process.env.DATABASE_URL ?? config.DATABASE_URL;
  if (!source || !['127.0.0.1', 'localhost', '::1'].includes(new URL(source).hostname))
    throw new Error('J003 requires loopback DATABASE_URL');
  admin = new pg.Client({connectionString: dbUrl(source, 'postgres')});
  await admin.connect();
  throwIfInterrupted();
  await admin.query(`CREATE DATABASE ${quote(name)}`);
  created = true;
  throwIfInterrupted();
  const p = await port(), database = dbUrl(source, name);
  const allowed = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'KS_DEV_ROOT', 'npm_config_cache', 'COREPACK_HOME', 'TMPDIR'].flatMap(key => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]]
      }));
  const blanks = Object.fromEntries(Object.keys(config).map(key => [key, '']));
  const env = {
    ...allowed,
    ...blanks,
    DATABASE_URL: database,
    KS_DEV_TOKEN: randomBytes(32).toString('hex'),
    PORT: String(p),
    NODE_ENV: 'test'
  };
  await run('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], env);
  throwIfInterrupted();
  await run('pnpm', ['exec', 'tsx', 'scripts/seed.ts'], env);
  throwIfInterrupted();
  api = spawn('pnpm', ['exec', 'tsx', 'apps/api/src/main.ts'], {cwd: root, env, stdio: 'inherit', detached: true});
  active.add(api); api.once('exit', () => active.delete(api!));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${p}/health`)).ok) break
    } catch {
    }
    if (i === 79) throw new Error('API health failed');
    await new Promise(done => setTimeout(done, 100))
  }
  throwIfInterrupted();
  await run('pnpm', ['exec', 'tsx', 'scripts/history-journey.ts'], {
    ...env,
    JOURNEY_DATABASE_URL: database,
    JOURNEY_API_BASE: `http://127.0.0.1:${p}`,
    JOURNEY_RECEIPT_PATH: `artifacts/j003-isolated-${suffix}.json`
  });
  throwIfInterrupted();
  console.log(JSON.stringify({journey: 'J003', result: 'passed'}));
} finally {
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  await stop(api);
  if (admin && created) {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    await admin.end()
  }
}
