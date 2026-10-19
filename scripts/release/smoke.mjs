#!/usr/bin/env node
// Checks one built KnowScroll v2 release the way the server will (#228).
//
//   node scripts/release/smoke.mjs <out>/release-<commit>.tar [--start] [--world <name>] [--port <n>]
//                                  [--unauthenticated <path>]... [--pass-env NAME]... [--keep]
//
// Always: release-<commit>.tar.sha256 beside the tar is exactly one line naming it and its hash
// matches; the archive's listing has nothing the server refuses (devices, FIFOs, absolute paths,
// `..`, writes through links); it unpacks into an empty temporary folder; its root holds exactly
// release.json, files.sha256 and the program and web folders, all real folders; release.json has
// the ks-release.v2 shape for this commit; files.sha256 describes every file and link exactly and
// every link stays inside the release (none under web/); each program's script, the migrate script
// and web/index.html exist. The rules and the reading are ops/vps/tool/plan.ts and tree.ts, the
// same code `ks deploy` runs.
//
// With --start and DATABASE_URL in the environment (a disposable database), the programs run the way
// a world's v2 units run them, with only the settings those units give (KS_WORLD, PORT,
// NODE_ENV=production, KS_MEDIA_ROOT, KS_PUBLIC_ORIGIN, KS_COMMIT, KS_ARTIFACT_SHA256,
// DATABASE_URL; plus PATH, HOME and any variable named by --pass-env):
// - the release's migrate command exits 0;
// - its api answers GET /health with this world, commit and artifact and the release's latest
//   migration, answers an unknown route with a 404 application/problem+json, answers every
//   --unauthenticated path (no credentials) with a 401 application/problem+json, and stops with
//   exit 0 on SIGTERM;
// - its worker starts (a `process.started` record) and stops with exit 0 on SIGTERM.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkFileList,
  checksumFor,
  healthMatches,
  V2_PROGRAMS,
  validateV2Manifest,
} from '../../ops/vps/tool/plan.ts';
import {
  checkTarFile,
  hashReleaseTree,
  requireRealFolder,
  sha256Stream,
} from './files.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    start: { type: 'boolean', default: false },
    world: { type: 'string', default: 'dev' },
    port: { type: 'string', default: '4399' },
    'pass-env': { type: 'string', multiple: true, default: [] },
    unauthenticated: { type: 'string', multiple: true, default: [] },
    keep: { type: 'boolean', default: false },
  },
});
if (positionals.length !== 1) {
  console.error(
    'usage: node scripts/release/smoke.mjs <release-<commit>.tar> [--start] [--world <name>] [--port <n>] [--keep]',
  );
  process.exit(2);
}

const tarPath = resolve(positionals[0]);
const checks = [];
function check(name, ok, detail) {
  checks.push({ check: name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

const match = /^release-([0-9a-f]{40})\.tar$/.exec(basename(tarPath));
let work;
let root;
let exitCode = 0;
/** Programs this smoke test started (only these are ever signalled). */
const running = [];

/** Starts one release program as its unit would; its JSON records are echoed to stderr and kept. */
function startProgram(name, program, env) {
  const child = spawn(process.execPath, program.exec.slice(1), {
    cwd: join(root, program.cwd),
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const events = [];
  const waiters = [];
  let pending = '';
  child.stdout.on('data', (chunk) => {
    process.stderr.write(chunk);
    pending += chunk.toString('utf8');
    for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      try {
        const record = JSON.parse(line);
        if (record && typeof record.event === 'string') {
          events.push(record.event);
          for (const waiter of waiters) waiter();
        }
      } catch {
        // not a diagnostic record
      }
    }
  });
  const exited = new Promise((done) => child.once('exit', (code) => done(code)));
  const handle = {
    name,
    child,
    events,
    exited,
    waitForEvent(event, ms) {
      if (events.includes(event)) return Promise.resolve(true);
      return new Promise((done) => {
        const timer = setTimeout(() => done(false), ms);
        waiters.push(() => {
          if (events.includes(event)) {
            clearTimeout(timer);
            done(true);
          }
        });
        exited.then(() => done(events.includes(event)));
      });
    },
  };
  running.push(handle);
  return handle;
}

/** SIGTERM to a program this test started; its exit code, or null if it had to be killed. */
async function stopProgram(handle, ms) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return handle.child.exitCode;
  handle.child.kill('SIGTERM');
  const code = await Promise.race([handle.exited, new Promise((r) => setTimeout(() => r(undefined), ms))]);
  if (code === undefined) {
    handle.child.kill('SIGKILL');
    await handle.exited;
    return null;
  }
  return code;
}
try {
  check('tar name is release-<commit>.tar', match, basename(tarPath));
  const commit = match[1];
  check('tar exists', existsSync(tarPath), tarPath);

  const shaPath = `${tarPath}.sha256`;
  check('sha256 file exists beside the tar', existsSync(shaPath), shaPath);
  const recorded = checksumFor(readFileSync(shaPath, 'utf8'), basename(tarPath));
  check('sha256 file is one line naming the tar', recorded.ok, recorded.ok ? undefined : recorded.reason);
  const artifact = await sha256Stream(tarPath);
  check('tar matches its recorded sha256', artifact === recorded.value, artifact);
  try {
    checkTarFile(tarPath);
    check('the archive lists nothing the server refuses', true);
  } catch (error) {
    check('the archive lists nothing the server refuses', false, error.message);
  }

  work = mkdtempSync(join(tmpdir(), 'ks-release-smoke-'));
  root = join(work, 'release');
  mkdirSync(root);
  const unpack = spawnSync('tar', ['-x', '--no-same-owner', '--no-same-permissions', '-f', tarPath, '-C', root], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  check('tar unpacks', unpack.status === 0, `exit ${unpack.status}`);

  const releaseJson = join(root, 'release.json');
  check(
    'release.json is a regular file',
    existsSync(releaseJson) && lstatSync(releaseJson).isFile(),
  );
  const manifest = validateV2Manifest(JSON.parse(readFileSync(releaseJson, 'utf8')), commit);
  check('release.json is a ks-release.v2 manifest for this commit', manifest.ok, manifest.ok ? undefined : manifest.reason);
  const m = manifest.value;

  const expectedTop = [
    'files.sha256',
    'release.json',
    'web',
    ...new Set([...V2_PROGRAMS.map((p) => m.programs[p].cwd), m.migrate.cwd]),
  ].sort();
  const top = readdirSync(root).sort();
  check(
    'the release root holds exactly release.json, files.sha256, the program folders and web/',
    top.join(',') === expectedTop.join(','),
    top.join(', '),
  );

  const listPath = join(root, 'files.sha256');
  check('files.sha256 is a regular file', lstatSync(listPath).isFile());
  let actual;
  try {
    for (const folder of [...new Set([...V2_PROGRAMS.map((p) => m.programs[p].cwd), m.migrate.cwd, 'web'])])
      requireRealFolder(root, folder);
    actual = hashReleaseTree(root, 'refuse');
  } catch (error) {
    check('every entry is a file, a folder or a link inside the release', false, error.message);
  }
  const listed = checkFileList(readFileSync(listPath, 'utf8'), actual);
  check('files.sha256 describes every file exactly', listed.ok, listed.ok ? `${listed.value} files` : listed.reason);

  const scriptOf = (exec) => exec.slice(1).find((a) => !a.startsWith('-'));
  for (const name of V2_PROGRAMS) {
    const program = m.programs[name];
    check(`${name} script exists`, existsSync(join(root, program.cwd, scriptOf(program.exec))), `${program.cwd}/${scriptOf(program.exec)}`);
  }
  check('migrate script exists', existsSync(join(root, m.migrate.cwd, scriptOf(m.migrate.exec))), `${m.migrate.cwd}/${scriptOf(m.migrate.exec)}`);
  check('web/index.html exists', existsSync(join(root, 'web', 'index.html')));

  if (args.start) {
    check('--start has a DATABASE_URL (a disposable database)', Boolean(process.env.DATABASE_URL));
    const port = args.port;
    // Only what a world's v2 units give the program, not the CI job's whole environment.
    const passed = Object.fromEntries(
      ['PATH', 'HOME', ...args['pass-env']]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    );
    const env = {
      ...passed,
      KS_MEDIA_ROOT: join(work, 'media-v2'),
      KS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      DATABASE_URL: process.env.DATABASE_URL,
      KS_WORLD: args.world,
      PORT: port,
      NODE_ENV: 'production',
      KS_COMMIT: commit,
      KS_ARTIFACT_SHA256: artifact,
    };
    mkdirSync(env.KS_MEDIA_ROOT, { recursive: true });

    const migrate = spawnSync(process.execPath, m.migrate.exec.slice(1), {
      cwd: join(root, m.migrate.cwd),
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 5 * 60_000,
    });
    check('migrate exits 0', migrate.status === 0, `exit ${migrate.status}`);

    const api = startProgram('api', m.programs.api, env);
    let body;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && api.child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          body = await res.json();
          if (healthMatches(body, { world: args.world, commit, artifact })) break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('api answers /health with this world, commit and artifact', healthMatches(body, { world: args.world, commit, artifact }), JSON.stringify(body ?? null));
    const latest = m.migrations.at(-1);
    check(
      '/health reports the latest migration',
      latest === undefined ? body && 'migration' in body : body.migration === latest,
      `${body?.migration} (release lists ${latest ?? 'none'})`,
    );

    const missing = await fetch(`http://127.0.0.1:${port}/v1/release-smoke-no-such-route`);
    check(
      'an unknown route answers 404 application/problem+json',
      missing.status === 404 && (missing.headers.get('content-type') ?? '').startsWith('application/problem+json'),
      `${missing.status} ${missing.headers.get('content-type')}`,
    );
    for (const path of args.unauthenticated) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const type = res.headers.get('content-type') ?? '';
      const problem = type.startsWith('application/problem+json') ? await res.json() : null;
      check(
        `${path} without credentials answers 401 application/problem+json`,
        res.status === 401 && problem?.status === 401,
        `${res.status} ${type} ${JSON.stringify(problem)}`,
      );
    }
    const apiExit = await stopProgram(api, 30_000);
    check('api stops with exit 0 on SIGTERM', apiExit === 0, `exit ${apiExit}`);

    const worker = startProgram('worker', m.programs.worker, env);
    const started = await worker.waitForEvent('process.started', 60_000);
    check('worker starts (process.started)', started, worker.events.join(', '));
    const workerExit = await stopProgram(worker, 40_000);
    check('worker stops with exit 0 on SIGTERM', workerExit === 0, `exit ${workerExit}`);
  }
} catch (error) {
  exitCode = 1;
  if (!checks.some((c) => !c.ok)) checks.push({ check: 'smoke test ran', ok: false, detail: error.message });
} finally {
  for (const program of running) await stopProgram(program, 10_000);
  if (work && !args.keep) rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify({ release: basename(tarPath), ok: exitCode === 0, checks, kept: args.keep ? work : undefined }, null, 2));
process.exit(exitCode);
