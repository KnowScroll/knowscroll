/**
 * A disposable local preview of the web Universe and Atlas (apps/web), for design work on the
 * opening and Universe screens: a new PostgreSQL database `knowscroll_preview_*` on the project
 * cluster, migrated and seeded with the editorial library and substrate, the real API, the real
 * worker and the Vite dev server. It stays up until Ctrl-C or SIGTERM, then stops what it started
 * and drops its own database (only that one).
 *
 *   . ./scripts/env.sh   # optional: this script sources scripts/env.sh itself
 *   pnpm exec tsx scripts/run-web-cosmos-preview.ts            # fresh: a first visit, nothing recorded
 *   pnpm exec tsx scripts/run-web-cosmos-preview.ts --grow     # grown through the real HTTP API
 *
 * Options:
 *   --web-port N            Vite port (default 4398; owner ports are refused)
 *   --api-port N            API port (default: a free loopback port)
 *   --grow                  read the universe into shape first (below), then print its atlas
 *   --same-day              with --grow: skip the one simulated step (no place can then form)
 *   --rich-scroll-preview   open the API's and web's authored-Scroll preview gates
 *                           (KS_RICH_SCROLL_PREVIEW / VITE_KS_RICH_SCROLL_PREVIEW; the API accepts
 *                           them only in development against a knowscroll_preview_* database)
 *   --run-dir PATH          child logs and a secret-free runtime.json
 *                           (default $KS_DEV_ROOT/tmp/cosmos-preview/<run>)
 *
 * The browser is authenticated by the Vite dev-auth proxy (ADR-0022): it injects this run's random
 * development token, which the API enrols at start-up as the seeded universe's device session. No
 * token reaches the browser, the logs or the terminal. The PostgreSQL server and role come from
 * DATABASE_URL in the environment, else this checkout's `.env`, else the main checkout's `.env`;
 * only its host, port and role are used (the database name is always replaced) and nothing of it is
 * printed. The owner `knowscroll` database is never connected to.
 *
 * Growth (--grow) does only what a client does: `GET /v1/feed` (skipping offered Scrolls, as the
 * reader does, until the chosen one is offered) -> `POST /v1/exposures` -> `POST /v1/interactions`
 * (keep), `POST /v1/asks`, `GET /v1/assets/:id/branches` -> `POST /v1/branches`. The API refreshes
 * attention, the Cartographer and the Keeper inside those requests and the worker projects each
 * Keep; nothing here writes a place, delta, room, account or trace row.
 *
 * ONE SIMULATED STEP: attention-v1 anchors a concept only after voluntary acts on two UTC days, and
 * an Idea Room needs Asks on two days, but a preview lives inside one day. As tests/helpers/reading.ts
 * and the Android places/rooms journeys do, the first day's ledger rows are moved back 24 hours
 * (scripts/lib/backdate.ts) in this run's own database before the second day is read. The summary
 * says so. `--same-day` skips it.
 *
 * What the editorial library (content/substrate.json, editorial-substrate-2026-09-24) can reach:
 * only Gravity and Tides have Scrolls from two source families (NASA and NOAA), so they are the only
 * concepts that can anchor: two planets. No region (no child concept has a second family). Gravity's
 * horizon offers Orbit and Star formation as sightings, which this walk never shows (reading one
 * would retire it as "You came across ..."). No foundation: Gravity explains Tides, Orbit and Star
 * formation, but only Tides can be a place, and a foundation needs three connections across two
 * places. Rooms open on Gravity and Tides and stay `opened`: no editorial claim about either is
 * qualified or contradicted, so no doubter is seated.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  atlasResponseSchema,
  webAtlasResponseSchema,
} from '@knowscroll/contracts/atlas';
import { roomResponse } from '@knowscroll/contracts/rooms';
import { universeSchema } from '@knowscroll/contracts/web-bootstrap';
import pg from 'pg';
import { backdateOneDay } from './lib/backdate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The same owner ports scripts/android-hands-on.py refuses.
const OWNER_PORTS = new Set([4310, 4320, 4322, 4325, 4392, 4393, 4394, 4395]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const DATABASE_NAME = /^knowscroll_preview_[a-f0-9]{12}$/;

// ------------------------------------------------------------------------------------------------
// Options
// ------------------------------------------------------------------------------------------------
type Options = {
  grow: boolean;
  sameDay: boolean;
  richScrollPreview: boolean;
  webPort: number;
  apiPort: number | null;
  runDir: string | null;
};

function usage(message: string): never {
  console.error(
    `${message}\nUsage: pnpm exec tsx scripts/run-web-cosmos-preview.ts [--grow [--same-day]] [--web-port N] [--api-port N] [--rich-scroll-preview] [--run-dir PATH]`,
  );
  process.exit(2);
}

function portOption(raw: string, flag: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    usage(`${flag} must be a port between 1024 and 65535`);
  if (OWNER_PORTS.has(port))
    usage(`${flag} ${port} belongs to the owner stack; choose another`);
  return port;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    grow: false,
    sameDay: false,
    richScrollPreview: false,
    webPort: 4398,
    apiPort: null,
    runDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => argv[++i] ?? usage(`${flag} needs a value`);
    if (flag === '--') continue;
    else if (flag === '--grow') options.grow = true;
    else if (flag === '--same-day') options.sameDay = true;
    else if (flag === '--rich-scroll-preview') options.richScrollPreview = true;
    else if (flag === '--web-port') options.webPort = portOption(value(), flag);
    else if (flag === '--api-port') options.apiPort = portOption(value(), flag);
    else if (flag === '--run-dir') options.runDir = resolve(value());
    else usage(`Unknown option ${flag}`);
  }
  if (options.sameDay && !options.grow) usage('--same-day needs --grow');
  if (options.apiPort !== null && options.apiPort === options.webPort)
    usage('--api-port and --web-port must differ');
  return options;
}

const options = parseOptions(process.argv.slice(2));

// ------------------------------------------------------------------------------------------------
// Environment: scripts/env.sh semantics, and the cluster's connection base (never printed)
// ------------------------------------------------------------------------------------------------
/** scripts/env.sh sourced by a real shell, so its semantics (SSD TMPDIR, caches, PATH) are exact. */
function sourcedEnvironment(): NodeJS.ProcessEnv {
  const json = execFileSync(
    'sh',
    [
      '-c',
      '. ./scripts/env.sh && exec "$0" -e "process.stdout.write(JSON.stringify(process.env))"',
      process.execPath,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(json) as NodeJS.ProcessEnv;
}

function localConfig(path: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return Object.fromEntries(
    text.split('\n').flatMap((line) => {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return match ? [[match[1]!, match[2]!]] : [];
    }),
  );
}

/** The main checkout of this worktree (a fresh worktree has no `.env` of its own). */
function mainCheckout(): string | null {
  try {
    const common = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return dirname(common);
  } catch {
    return null;
  }
}

function connectionBase(): { url: URL; configKeys: string[]; from: string } {
  const own = localConfig(join(root, '.env'));
  const main = mainCheckout();
  const shared = main && main !== root ? localConfig(join(main, '.env')) : null;
  const configKeys = [
    ...new Set([...Object.keys(own ?? {}), ...Object.keys(shared ?? {})]),
  ];
  const [raw, from]: [string | undefined, string] = process.env.DATABASE_URL
    ? [process.env.DATABASE_URL, 'the environment']
    : own?.DATABASE_URL
      ? [own.DATABASE_URL, "this checkout's .env"]
      : shared?.DATABASE_URL
        ? [shared.DATABASE_URL, "the main checkout's .env"]
        : [undefined, ''];
  if (!raw || !URL.canParse(raw))
    throw new Error(
      "DATABASE_URL is required (the environment, this checkout's .env or the main checkout's .env)",
    );
  const url = new URL(raw);
  if (!LOOPBACK.has(url.hostname))
    throw new Error('This preview only permits a loopback PostgreSQL server');
  return { url, configKeys, from };
}

function databaseUrl(base: URL, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const shellEnvironment = sourcedEnvironment();
const base = connectionBase();
const databaseName = `knowscroll_preview_${randomBytes(6).toString('hex')}`;
if (!DATABASE_NAME.test(databaseName) || databaseName === 'knowscroll')
  throw new Error('Refusing an unexpected preview database name');
const disposableUrl = databaseUrl(base.url, databaseName);
const token = randomBytes(32).toString('hex');
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const runDir =
  options.runDir ??
  join(
    shellEnvironment.KS_DEV_ROOT ?? join(root, 'artifacts'),
    'tmp',
    'cosmos-preview',
    `${stamp}Z-${databaseName.slice(-6)}`,
  );
mkdirSync(join(runDir, 'media'), { recursive: true });

const runtimeEnvironment = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'KS_DEV_ROOT',
    'npm_config_cache',
    'COREPACK_HOME',
    'TMPDIR',
  ].flatMap((name) => {
    const value = shellEnvironment[name];
    return value === undefined ? [] : [[name, value]];
  }),
);
// Never inherit any `.env` value (provider keys included) into a child; then this run's own values.
const blanked = Object.fromEntries(base.configKeys.map((key) => [key, '']));
const backendEnvironment: NodeJS.ProcessEnv = {
  ...runtimeEnvironment,
  ...blanked,
  DATABASE_URL: disposableUrl,
  KS_DEV_TOKEN: token,
  NODE_ENV: 'development',
  KS_MEDIA_ROOT: join(runDir, 'media'),
  ...(options.richScrollPreview ? { KS_RICH_SCROLL_PREVIEW: '1' } : {}),
};

// ------------------------------------------------------------------------------------------------
// Processes: one-shot commands and the three long-running children, each in its own process group
// ------------------------------------------------------------------------------------------------
type Managed = {
  label: string;
  child: ChildProcess;
  stopping: boolean;
  tail: string[];
  log: string;
};
const managed: Managed[] = [];
const oneShots = new Set<ChildProcess>();
let shuttingDown = false;
let databaseCreated = false;
let databaseDropped = false;
const runtime: Record<string, unknown> = {
  database: databaseName,
  runDir,
  previewPid: process.pid,
  mode: options.grow ? (options.sameDay ? 'grown-same-day' : 'grown') : 'fresh',
  richScrollPreview: options.richScrollPreview,
  connectionBaseFrom: base.from,
  startedAt: new Date().toISOString(),
};

function writeRuntime(): void {
  writeFileSync(
    join(runDir, 'runtime.json'),
    `${JSON.stringify(runtime, null, 2)}\n`,
  );
}

function appendTail(tail: string[], text: string): void {
  tail.push(...text.split('\n').filter((line) => line.length > 0));
  if (tail.length > 40) tail.splice(0, tail.length - 40);
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || exited(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function run(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const log = createWriteStream(join(runDir, `${label}.log`), { flags: 'a' });
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    oneShots.add(child);
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      log.write(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => {
      oneShots.delete(child);
      log.end();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      oneShots.delete(child);
      log.end();
      if (code === 0) resolveRun(output);
      else
        reject(
          new Error(
            `${label} failed (${signal ?? `exit ${code}`}); see ${join(runDir, `${label}.log`)}`,
          ),
        );
    });
  });
}

function start(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Managed {
  const log = join(runDir, `${label}.log`);
  const stream = createWriteStream(log, { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const process_: Managed = { label, child, stopping: false, tail: [], log };
  const collect = (chunk: Buffer) => {
    stream.write(chunk);
    appendTail(process_.tail, chunk.toString());
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.once('error', (error) =>
    unexpectedExit(process_, `could not start: ${error.message}`),
  );
  child.once('exit', (code, signal) => {
    stream.end();
    if (!process_.stopping)
      unexpectedExit(process_, signal ? `signal ${signal}` : `exit ${code}`);
  });
  managed.push(process_);
  return process_;
}

function unexpectedExit(process_: Managed, reason: string): void {
  if (shuttingDown) return;
  console.error(
    `[preview] ${process_.label} stopped unexpectedly (${reason}); last output:\n  ${process_.tail.join('\n  ') || '(none)'}\n  full log: ${process_.log}`,
  );
  void shutdown(1);
}

async function stop(process_: Managed): Promise<void> {
  const { child } = process_;
  process_.stopping = true;
  if (exited(child)) return;
  signalGroup(child, 'SIGTERM');
  await Promise.race([
    new Promise<void>((done) => child.once('exit', () => done())),
    sleep(8000),
  ]);
  if (!exited(child)) signalGroup(child, 'SIGKILL');
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({
    connectionString: databaseUrl(base.url, 'postgres'),
    connectionTimeoutMillis: 5000,
  });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

let shutdownPromise: Promise<never> | undefined;
function shutdown(code: number): Promise<never> {
  shutdownPromise ??= (async () => {
    shuttingDown = true;
    console.log('[preview] stopping ...');
    for (const child of oneShots) signalGroup(child, 'SIGTERM');
    for (const process_ of [...managed].reverse()) {
      try {
        await stop(process_);
      } catch (error) {
        console.error(`[preview] could not stop ${process_.label}:`, error);
      }
    }
    if (databaseCreated) {
      if (!DATABASE_NAME.test(databaseName))
        throw new Error('Refusing to drop an unexpected database name');
      try {
        await withAdmin((admin) =>
          admin.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
          ),
        );
        databaseDropped = true;
      } catch (error) {
        console.error(
          `[preview] could not drop ${databaseName}; drop it by hand:`,
          (error as Error).message,
        );
        code ||= 1;
      }
    }
    runtime.stoppedAt = new Date().toISOString();
    runtime.databaseDropped = databaseDropped;
    try {
      writeRuntime();
    } catch {
      // The run directory is diagnostic only.
    }
    console.log(
      `[preview] stopped${databaseCreated ? `; database ${databaseName} ${databaseDropped ? 'dropped' : 'NOT dropped'}` : ''}.`,
    );
    process.exit(code);
  })();
  return shutdownPromise;
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGHUP', () => void shutdown(0));

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('No TCP port assigned'));
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

/** A live listener on the port (any process) refuses it. */
async function assertPortFree(port: number, label: string): Promise<void> {
  const inUse = await new Promise<boolean>((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
  if (inUse)
    throw new Error(
      `${label} port ${port} is already in use; pass another port or stop that process`,
    );
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  attempts = 200,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (shuttingDown) throw new Error('stopping');
    try {
      if (await probe()) return;
    } catch {
      // not yet
    }
    await sleep(150);
  }
  throw new Error(`${label} never became ready`);
}

// ------------------------------------------------------------------------------------------------
// The reader's HTTP calls (the same requests the web and Android clients make)
// ------------------------------------------------------------------------------------------------
type FeedResponse = {
  decisionId: string;
  items: { assetId: string; title: string }[];
};
/** One exposure: what the reader was shown, and where. */
type Shown = { exposureId: string; assetId: string; title: string };
type EncounterBranch = {
  bridgeId: string;
  toConcept: { code: string; name: string };
  relationPhrase: string;
  target: { assetId: string; title: string };
};

function client(apiBase: string) {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    expected: number,
  ): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (response.status !== expected)
      throw new Error(
        `${method} ${path.split('?')[0]} expected ${expected}, got ${response.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const get = <T>(path: string) => call<T>('GET', path, undefined, 200);
  const epoch = async () =>
    (await get<{ privacyEpoch: number }>('/v1/universe')).privacyEpoch;

  /** Asks for more, skipping what this trip was offered, until `title` is offered; exposes it. */
  async function expose(title: string): Promise<Shown> {
    const skipped: string[] = [];
    for (let step = 0; step < 80; step += 1) {
      const query = skipped.length ? `&exclude=${skipped.join(',')}` : '';
      const feed = await get<FeedResponse>(`/v1/feed?kinds=Scroll${query}`);
      if (feed.items.length === 0) break;
      const target = feed.items.find((item) => item.title === title);
      if (!target) {
        skipped.push(...feed.items.map((item) => item.assetId));
        continue;
      }
      return exposeServed(feed.decisionId, target.assetId, title);
    }
    throw new Error(`The feed never offered "${title}"`);
  }
  async function exposeServed(
    decisionId: string,
    assetId: string,
    title: string,
  ): Promise<Shown> {
    const { exposureId } = await call<{ exposureId: string }>(
      'POST',
      '/v1/exposures',
      { decisionId, assetId, clientExposureId: randomUUID() },
      201,
    );
    return { exposureId, assetId, title };
  }
  async function keep({ exposureId, assetId }: Shown): Promise<void> {
    const { eventId } = await call<{ eventId: string }>(
      'POST',
      '/v1/interactions',
      { clientEventId: randomUUID(), exposureId, assetId, kind: 'keep' },
      202,
    );
    // The worker projects the Keep; the Universe shows it once projected.
    await waitFor(
      `the worker's projection of a Keep`,
      async () =>
        (await get<{ projected: boolean }>(`/v1/events/${eventId}`))
          .projected === true,
    );
  }
  async function ask({ exposureId }: Shown, question: string): Promise<void> {
    await call(
      'POST',
      '/v1/asks',
      {
        clientAskId: randomUUID(),
        exposureId,
        question,
        expectedPrivacyEpoch: await epoch(),
      },
      201,
    );
  }
  async function branches(assetId: string): Promise<EncounterBranch[]> {
    return (
      await get<{ branches: EncounterBranch[] }>(
        `/v1/assets/${assetId}/branches`,
      )
    ).branches;
  }
  /** Takes a listed continuation and is exposed to its target, as the web reader does. */
  async function openBranch(
    from: Shown,
    branch: EncounterBranch,
  ): Promise<Shown> {
    const opened = await call<{
      decisionId: string | null;
      branch: { recorded: boolean };
    }>(
      'POST',
      '/v1/branches',
      {
        clientBranchId: randomUUID(),
        fromExposureId: from.exposureId,
        bridgeId: branch.bridgeId,
        targetAssetId: branch.target.assetId,
        expectedPrivacyEpoch: await epoch(),
      },
      201,
    );
    if (!opened.decisionId || !opened.branch.recorded)
      throw new Error('The branch was served but not recorded');
    return exposeServed(
      opened.decisionId,
      branch.target.assetId,
      branch.target.title,
    );
  }
  return { get, expose, keep, ask, branches, openBranch };
}
type Reader = ReturnType<typeof client>;

// ------------------------------------------------------------------------------------------------
// Growth: two days of reading (the first moved back a day), then some wandering
// ------------------------------------------------------------------------------------------------
const SCROLL = {
  pull: "The pull you can't see",
  range: 'A pull with a range',
  rhythm: 'A rhythm the ocean keeps',
  moon: 'The Moon tugs at the sea',
};
const QUESTIONS = {
  pull: 'Why does everything fall toward the ground?',
  moon: 'Why are there two high tides a day, not one?',
  range: 'So what is gravity, really?',
  rhythm: 'How can tides be predicted years in advance?',
};
// None of these is annotated with Orbit or Star formation, so Gravity's sightings stay unmet.
const WANDER_KEEPS = [
  'A star is a balancing act',
  'An ordinary star with a big job',
  "Earth's energy has to balance",
  'Your body has a thermostat',
];
const WANDER_SEEN = ["A tilt that doesn't change"];

function say(line: string): void {
  console.log(`[grow] ${line}`);
}

async function grow(reader: Reader, universeId: string): Promise<void> {
  say(
    options.sameDay
      ? 'one day of reading (--same-day: nothing is moved back)'
      : 'day one (moved back 24 h afterwards: the one simulated step)',
  );
  const pull = await reader.expose(SCROLL.pull);
  await reader.keep(pull);
  await reader.ask(pull, QUESTIONS.pull);
  say(`kept "${pull.title}" and asked about it`);
  const moon = await reader.expose(SCROLL.moon);
  await reader.ask(moon, QUESTIONS.moon);
  say(`read "${moon.title}" and asked about it (not kept yet)`);

  if (!options.sameDay) {
    const db = new pg.Client({ connectionString: disposableUrl });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT 1 FROM universe WHERE id=$1 FOR UPDATE', [
        universeId,
      ]);
      await backdateOneDay(db, universeId);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await db.end();
    }
    say('SIMULATED: moved day one back 24 hours (scripts/lib/backdate.ts)');
    say('day two');
  }

  const range = await reader.expose(SCROLL.range);
  await reader.keep(range);
  await reader.ask(range, QUESTIONS.range);
  say(`kept "${range.title}" and asked about it`);

  // Follow the sourced connection Gravity -> Tides from it, as a reader taking a branch would.
  const toTides = (await reader.branches(range.assetId)).find(
    (b) =>
      b.toConcept.code === 'earth.tides' &&
      [SCROLL.rhythm, SCROLL.moon].includes(b.target.title),
  );
  const tides = toTides
    ? await reader.openBranch(range, toTides)
    : await reader.expose(SCROLL.rhythm);
  say(
    toTides
      ? `took the branch "${toTides.relationPhrase} ${toTides.toConcept.name}" to "${tides.title}"`
      : `no branch toward Tides was offered; read "${tides.title}" from the feed`,
  );
  await reader.keep(tides);
  await reader.ask(tides, QUESTIONS.rhythm);
  say(`kept "${tides.title}" and asked about it`);

  const other = await reader.expose(
    tides.title === SCROLL.rhythm ? SCROLL.moon : SCROLL.rhythm,
  );
  await reader.keep(other);
  say(`kept "${other.title}"`);

  for (const title of WANDER_KEEPS)
    await reader.keep(await reader.expose(title));
  for (const title of WANDER_SEEN) await reader.expose(title);
  say(
    `wandered: kept ${WANDER_KEEPS.length} more and read ${WANDER_SEEN.length} without keeping`,
  );
}

// ------------------------------------------------------------------------------------------------
// What the browser sees, and the atlas summary
// ------------------------------------------------------------------------------------------------
async function verifyThroughProxy(webBase: string): Promise<string> {
  const page = await fetch(`${webBase}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  const html = await page.text();
  if (page.status !== 200 || !html.includes('id="root"'))
    throw new Error(
      `The web dev server did not serve the app (HTTP ${page.status})`,
    );
  // No Authorization header here: the Vite proxy injects it, exactly as for the browser.
  const universe = universeSchema.parse(
    await (await fetch(`${webBase}/v1/universe`)).json(),
  );
  const atlasResponse = await fetch(`${webBase}/v1/atlas?webReader=v1`);
  if (atlasResponse.status !== 200)
    throw new Error(
      `/v1/atlas through the proxy: HTTP ${atlasResponse.status}`,
    );
  const atlas = webAtlasResponseSchema.parse(await atlasResponse.json());
  return `web app served; through the Vite proxy /v1/universe -> ${universe.traces.length} kept Traces, /v1/atlas?webReader=v1 -> ${atlas.places.length} places (both pass the web client's strict schemas)`;
}

const clip = (text: string, length = 110) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

async function printAtlas(reader: Reader): Promise<void> {
  const atlas = atlasResponseSchema.parse(await reader.get('/v1/atlas'));
  const byId = new Map(atlas.places.map((p) => [p.placeId, p]));
  const name = (id: string | null) =>
    (id && byId.get(id)?.anchor.name) ?? '(not a live place)';
  const count = (kind: string) =>
    atlas.places.filter((p) => p.kind === kind).length;
  const rooms = atlas.places.flatMap((p) => p.rooms);
  console.log(
    `[atlas] GET /v1/atlas (${atlas.policyVersion}): ${count('planet')} planets, ${count('region')} regions, ${count('sighting')} sightings, ${atlas.relations.length} relations, ${atlas.places.filter((p) => p.foundation).length} foundations, ${rooms.length} rooms`,
  );
  for (const place of atlas.places) {
    const parent = place.parentPlaceId
      ? ` of ${name(place.parentPlaceId)}`
      : '';
    const attention = place.attention
      ? ` · ${place.attention.state}, ${place.attention.episodes} episodes, ${place.attention.daysActive} days, ${place.attention.sourceFamilies} source families`
      : '';
    const basis = place.basis
      ? ` · basis: ${place.basis.from} ${place.basis.kind} ${place.basis.to}`
      : '';
    console.log(
      `[atlas]   ${place.kind.padEnd(8)} ${place.anchor.name}${parent}${attention}${basis} · Scrolls ${place.scrolls.seen}/${place.scrolls.total} seen`,
    );
    if (place.foundation)
      console.log(
        `[atlas]            foundation: holds up ${place.foundation.holdsUp.map(name).join(', ')}`,
      );
    for (const room of place.rooms)
      console.log(
        `[atlas]            room "${room.question}" (${room.state}): ${room.inhabitants.map((i) => `${i.role} holds ${i.claims.length}`).join(', ') || 'no one seated'}`,
      );
  }
  for (const relation of atlas.relations)
    console.log(
      `[atlas]   relation ${name(relation.fromPlaceId)} ${relation.kind} ${name(relation.toPlaceId)} · ${relation.claim ? `claim: "${clip(relation.claim.text, 90)}"` : relation.bridge ? `bridge: "${clip(relation.bridge.mechanism, 90)}"` : 'no basis'}`,
    );
  if (atlas.chronicle.length)
    console.log('[atlas]   chronicle (newest first):');
  for (const line of atlas.chronicle)
    console.log(`[atlas]     ${line.at.slice(0, 16)}Z ${line.line}`);
  for (const room of rooms) {
    const detail = roomResponse.parse(
      await reader.get(`/v1/rooms/${room.roomId}`),
    );
    console.log(
      `[atlas]   room on ${detail.placeName}: ${detail.chronicle.length} chronicle lines, e.g. "${clip(detail.chronicle.at(-1)?.line ?? '', 120)}"`,
    );
  }
  const missing = [
    count('planet') === 0 && 'planet',
    count('region') === 0 && 'region',
    count('sighting') === 0 && 'sighting',
    atlas.relations.length === 0 && 'relation between places',
    !atlas.places.some((p) => p.foundation) && 'foundation',
    rooms.length === 0 && 'Idea Room',
    !rooms.some((r) => r.state === 'arguing') && 'arguing room',
  ].filter(Boolean);
  if (missing.length)
    console.log(
      `[atlas]   not reached in this run: ${missing.join(', ')} (see this script's header for why, with the editorial library)`,
    );
}

// ------------------------------------------------------------------------------------------------
// The stack
// ------------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `[preview] run directory ${runDir}; database ${databaseName}; cluster connection from ${base.from}`,
  );
  await assertPortFree(options.webPort, 'Web');
  const apiPort = options.apiPort ?? (await freePort());
  await assertPortFree(apiPort, 'API');
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const webBase = `http://127.0.0.1:${options.webPort}`;
  Object.assign(runtime, {
    apiPort,
    webPort: options.webPort,
    url: `${webBase}/`,
  });
  writeRuntime();

  const cluster = await run('db-start', 'sh', ['scripts/db-start.sh'], {
    ...shellEnvironment,
    ...blanked,
  });
  console.log(
    `[preview] ${cluster.trim().split('\n').at(-1) ?? 'cluster checked'}`,
  );

  databaseCreated = true; // before CREATE: an interrupted CREATE that commits is still dropped
  await withAdmin((admin) =>
    admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`),
  );
  await run(
    'migrate',
    'pnpm',
    ['exec', 'tsx', 'scripts/migrate.ts'],
    backendEnvironment,
  );
  const seeded = await run(
    'seed',
    'pnpm',
    ['exec', 'tsx', 'scripts/seed.ts'],
    backendEnvironment,
  );
  for (const line of seeded.trim().split('\n'))
    if (line.startsWith('Editorial')) console.log(`[preview] ${line}`);

  const api = start(
    'api',
    'pnpm',
    ['exec', 'tsx', 'apps/api/src/main.ts'],
    { ...backendEnvironment, PORT: String(apiPort) },
    root,
  );
  const worker = start(
    'worker',
    'pnpm',
    ['exec', 'tsx', 'apps/worker/src/main.ts'],
    backendEnvironment,
    root,
  );
  await waitFor('the API', async () => (await fetch(`${apiBase}/health`)).ok);
  await waitFor('the worker', async () =>
    worker.tail.some((line) => line.includes('"service":"worker"')),
  );
  const reader = client(apiBase);
  const session = await reader.get<{ sessionId: string }>('/v1/session');
  const universe = await reader.get<{ universeId: string }>('/v1/universe');
  if (!session.sessionId)
    throw new Error('No session for the development token');
  console.log(
    `[preview] API on ${apiBase} and worker running; device session enrolled`,
  );

  if (options.grow) {
    await grow(reader, universe.universeId);
    runtime.simulated = options.sameDay
      ? 'nothing'
      : "day one's ledger rows moved back 24 hours (scripts/lib/backdate.ts)";
  }

  const web = start(
    'web',
    'pnpm',
    ['exec', 'vite', '--config', 'vite.config.ts'],
    {
      ...runtimeEnvironment,
      PORT: String(options.webPort),
      KS_WEB_API_URL: apiBase,
      KS_DEV_TOKEN: token,
      NODE_ENV: 'development',
      ...(options.richScrollPreview
        ? { VITE_KS_RICH_SCROLL_PREVIEW: '1' }
        : {}),
    },
    join(root, 'apps/web'),
  );
  await waitFor(
    'the Vite dev server',
    async () => (await fetch(`${webBase}/`)).ok,
  );
  console.log(`[preview] ${await verifyThroughProxy(webBase)}`);
  if (options.grow) await printAtlas(reader);

  runtime.pids = {
    preview: process.pid,
    api: api.child.pid,
    worker: worker.child.pid,
    web: web.child.pid,
  };
  runtime.readyAt = new Date().toISOString();
  writeRuntime();
  console.log(
    `[preview] READY ${webBase}/ (${options.grow ? 'grown' : 'fresh'} universe). Process groups: api ${api.child.pid}, worker ${worker.child.pid}, web ${web.child.pid}. Ctrl-C or kill -TERM ${process.pid} stops everything and drops ${databaseName}.`,
  );
  setInterval(() => undefined, 1 << 30);
}

main().catch((error: unknown) => {
  if (!shuttingDown)
    console.error('[preview] failed:', (error as Error).message);
  void shutdown(1);
});
