// A disposable KnowScroll API for the native lane's journeys (#249). Labelled fixture world:
// the built release trees (`pnpm deploy`, as `checks` builds them) over an empty PostgreSQL
// database, the authored starter Scroll, one Reel made from generated colour-bar video through a
// fake Cutroom (no provider, no spend), sign-in mail recorded in a file instead of sent, and
// native sign-in binding on. Nothing here can run in a deployed world: the configuration refuses
// the fixture mail sender and the operator commands outside `ci` and `local`.
//
//   node serve.mjs --release <dir> --database-url <empty database> --port <n> --out <dir>
//
// Prints one line, `ready <origin>`, when /health answers; runs until SIGTERM or SIGINT, then stops
// the API and worker it started. The out folder gets `mail.jsonl` (one `{to, link}` per mail; live
// test tokens, never uploaded), `api.log`, `worker.log` and `operator.log`.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cutroomFixture, fixtureRunId } from '../../../../tests/integration/support/cutroom-fixture.ts';

const { values } = parseArgs({
  options: {
    release: { type: 'string' },
    'database-url': { type: 'string' },
    port: { type: 'string' },
    out: { type: 'string' },
  },
});
for (const name of ['release', 'database-url', 'port', 'out']) {
  if (!values[name]) {
    process.stderr.write(`missing --${name}\n`);
    process.exit(2);
  }
}
const release = resolve(values.release);
const out = resolve(values.out);
const origin = `http://127.0.0.1:${values.port}`;
mkdirSync(out, { recursive: true });

const logs = {
  api: createWriteStream(join(out, 'api.log')),
  worker: createWriteStream(join(out, 'worker.log')),
  operator: createWriteStream(join(out, 'operator.log')),
};
const children = [];

/** The release tree's own environment rule: only what is passed, plus PATH. */
function spawnRelease(program, entry, args, env, log) {
  const child = spawn(process.execPath, [join('dist', `${entry}.js`), ...args], {
    cwd: join(release, program),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  return child;
}

function runToEnd(program, entry, args, env) {
  const child = spawnRelease(program, entry, args, env, logs.operator);
  return new Promise((resolveRun, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.once('exit', (code) =>
      code === 0 ? resolveRun(stdout) : reject(new Error(`${program} ${entry} ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('the API did not answer /health in 60 seconds');
}

let fixture;
let stopping = false;
async function stop() {
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((done) => setTimeout(done, 1500));
  await fixture?.close();
  process.exit(0);
}

try {
  const base = { NODE_ENV: 'test', KS_WORLD: 'ci', DATABASE_URL: values['database-url'] };
  await runToEnd('api', 'migrate', [], base);

  const starter = join(
    release,
    'api/node_modules/@knowscroll/backend/dist/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json',
  );
  await runToEnd('api', 'operator', ['content', 'import-editorial', '--file', starter], base);

  const root = await mkdtemp(join(out, 'cutroom-'));
  fixture = await cutroomFixture(root);
  const mediaEnv = {
    ...base,
    KS_MEDIA_ROOT: fixture.mediaRoot,
    KS_CUTROOM_ORIGIN: fixture.origin,
    KS_CUTROOM_ARTIFACT_ROOT: fixture.artifactRoot,
    // ffprobe is at /usr/bin on the runner; a Mac names it.
    ...(process.env.KS_FFPROBE_PATH ? { KS_FFPROBE_PATH: process.env.KS_FFPROBE_PATH } : {}),
  };
  await runToEnd(
    'worker',
    'operator',
    ['content', 'import-cutroom-reel', '--run', fixtureRunId, '--script', 'greenhouse', '--fixture'],
    mediaEnv,
  );

  const api = spawnRelease(
    'api',
    'main',
    [],
    {
      ...mediaEnv,
      PORT: values.port,
      KS_PUBLIC_ORIGIN: origin,
      KS_MAIL_SENDER: 'fixture',
      KS_FIXTURE_MAIL_FILE: join(out, 'mail.jsonl'),
      KS_NATIVE_SIGN_IN_BINDING: '1',
    },
    logs.api,
  );
  const worker = spawnRelease('worker', 'main', [], mediaEnv, logs.worker);
  children.push(api, worker);
  for (const child of children)
    child.once('exit', (code) => {
      if (stopping) return;
      process.stderr.write(`a child process exited early with ${code}\n`);
      process.exit(1);
    });
  await waitForHealth();
  process.stdout.write(`ready ${origin}\n`);
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await stop();
}
