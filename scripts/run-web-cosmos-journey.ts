/**
 * The cosmic-origin and star-Universe journeys (ADR-0049; apps/web/e2e-cosmos/,
 * apps/web/playwright.cosmos.config.ts) against two disposable stacks, each started by
 * scripts/run-web-cosmos-preview.ts in its own `knowscroll_preview_*` database with a real API,
 * worker and Vite dev server:
 *
 *   fresh  a first visit: nothing recorded, so the opening plays
 *   grown  --grow: read into shape through the real HTTP API (Gravity and Tides are stars)
 *
 * It waits for both READY lines, runs Playwright with PW_FRESH_URL / PW_GROWN_URL (streaming its
 * output), then sends SIGTERM to each preview's own PID (the one its READY line names) and waits
 * for it to stop its children and drop its database. Exits non-zero if a journey failed, a stack
 * never became ready, or a database was not confirmed dropped.
 *
 *   . ./scripts/env.sh
 *   pnpm exec tsx scripts/run-web-cosmos-journey.ts                     # chromium
 *   pnpm exec tsx scripts/run-web-cosmos-journey.ts --browser all       # chromium, then webkit
 *   pnpm exec tsx scripts/run-web-cosmos-journey.ts -- -g "phone"       # extra Playwright args
 *
 * Options:
 *   --browser chromium|webkit|all   default: $KS_PW_BROWSER, else chromium
 *   --fresh-port N / --grown-port N Vite ports for the two stacks (default: free loopback ports)
 *   --run-dir PATH                  preview logs under PATH/fresh and PATH/grown
 *                                   (default: each preview's own default under $KS_DEV_ROOT/tmp)
 *
 * Nothing here reads or prints a credential: each preview finds its PostgreSQL server itself and
 * the browser is authenticated by the preview's Vite dev-auth proxy. Only processes this script
 * started are ever signalled.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Owner stacks (scripts/run-web-cosmos-preview.ts refuses these too) and the preview's default
// port 4398 and 4400, which other local work keeps running.
const RESERVED_PORTS = new Set([
  4310, 4320, 4322, 4325, 4392, 4393, 4394, 4395, 4398, 4400,
]);
const READY_TIMEOUT_MS = 6 * 60_000;
const STOP_TIMEOUT_MS = 60_000;

type Browser = 'chromium' | 'webkit';
type Options = {
  browsers: Browser[];
  freshPort: number | null;
  grownPort: number | null;
  runDir: string | null;
  playwrightArgs: string[];
};

function usage(message: string): never {
  console.error(
    `${message}\nUsage: pnpm exec tsx scripts/run-web-cosmos-journey.ts [--browser chromium|webkit|all] [--fresh-port N] [--grown-port N] [--run-dir PATH] [-- <playwright args>]`,
  );
  process.exit(2);
}

function portOption(raw: string, flag: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    usage(`${flag} must be a port between 1024 and 65535`);
  if (RESERVED_PORTS.has(port))
    usage(`${flag} ${port} is reserved for other stacks; choose another`);
  return port;
}

function browsersOption(raw: string): Browser[] {
  if (raw === 'all') return ['chromium', 'webkit'];
  if (raw === 'chromium' || raw === 'webkit') return [raw];
  usage(`--browser must be chromium, webkit or all (got ${raw})`);
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    browsers: browsersOption(process.env.KS_PW_BROWSER || 'chromium'),
    freshPort: null,
    grownPort: null,
    runDir: null,
    playwrightArgs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = () => argv[++i] ?? usage(`${flag} needs a value`);
    if (flag === '--') {
      options.playwrightArgs = argv.slice(i + 1);
      break;
    } else if (flag === '--browser') options.browsers = browsersOption(value());
    else if (flag === '--fresh-port')
      options.freshPort = portOption(value(), flag);
    else if (flag === '--grown-port')
      options.grownPort = portOption(value(), flag);
    else if (flag === '--run-dir') options.runDir = resolve(value());
    else usage(`Unknown option ${flag}`);
  }
  if (options.freshPort !== null && options.freshPort === options.grownPort)
    usage('--fresh-port and --grown-port must differ');
  return options;
}

const options = parseOptions(process.argv.slice(2));

/** Only what the children need; never a `.env` value or a credential. */
const runtimeEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
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
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }),
);

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
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
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

// ------------------------------------------------------------------------------------------------
// The two preview stacks
// ------------------------------------------------------------------------------------------------
type Stack = {
  label: 'fresh' | 'grown';
  child: ChildProcess;
  /** The preview script's own PID, from its READY line (the one to SIGTERM). */
  previewPid: number | null;
  url: string | null;
  database: string | null;
  dropped: boolean;
  tail: string[];
  ready: Promise<string>;
  closed: Promise<void>;
};

function startStack(
  label: 'fresh' | 'grown',
  port: number,
  runDir: string | null,
): Stack {
  const args = [
    'exec',
    'tsx',
    'scripts/run-web-cosmos-preview.ts',
    ...(label === 'grown' ? ['--grow'] : []),
    '--web-port',
    String(port),
    ...(runDir ? ['--run-dir', join(runDir, label)] : []),
  ];
  // Its own process group, so a Ctrl-C at this terminal reaches the preview only through the
  // orderly SIGTERM below (a double signal could interrupt its database drop).
  const child = spawn('pnpm', args, {
    cwd: root,
    env: runtimeEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((ok, fail) => {
    resolveReady = ok;
    rejectReady = fail;
  });
  ready.catch(() => undefined);
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const stack: Stack = {
    label,
    child,
    previewPid: null,
    url: null,
    database: null,
    dropped: false,
    tail: [],
    ready,
    closed,
  };
  let buffered = '';
  const onData = (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[${label}] ${line}`);
      stack.tail.push(line);
      if (stack.tail.length > 60) stack.tail.shift();
      const database = /database (knowscroll_preview_[a-f0-9]{12})/.exec(line);
      if (database) stack.database ??= database[1]!;
      const isReady =
        /\[preview\] READY (http:\/\/127\.0\.0\.1:\d+)\/? .*kill -TERM (\d+)/.exec(
          line,
        );
      if (isReady) {
        stack.url = isReady[1]!;
        stack.previewPid = Number(isReady[2]);
        resolveReady(stack.url);
      }
      if (/\[preview\] stopped; database \S+ dropped\./.test(line))
        stack.dropped = true;
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('error', (error) =>
    rejectReady(new Error(`${label} stack could not start: ${error.message}`)),
  );
  child.once('exit', (code, signal) =>
    rejectReady(
      new Error(
        `${label} stack exited before READY (${signal ?? `exit ${code}`})`,
      ),
    ),
  );
  return stack;
}

/**
 * SIGTERM to the preview's own PID (named by its READY line); it stops its children and drops its
 * database, then exits. Before READY that PID is not known yet, so the signal goes to the process
 * group this runner started for it (its own children run in groups of their own; its handler is
 * idempotent).
 */
async function stopStack(stack: Stack): Promise<void> {
  if (exited(stack.child)) return;
  try {
    if (stack.previewPid) process.kill(stack.previewPid, 'SIGTERM');
    else if (stack.child.pid) process.kill(-stack.child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  const stopped = await Promise.race([
    stack.closed.then(() => true),
    sleep(STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped && stack.child.pid) {
    console.error(
      `[cosmos-journey] ${stack.label} stack did not stop within ${STOP_TIMEOUT_MS / 1000}s; signalling the process group this runner started`,
    );
    try {
      process.kill(-stack.child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    await Promise.race([stack.closed, sleep(10_000)]);
  }
}

// ------------------------------------------------------------------------------------------------
// Playwright
// ------------------------------------------------------------------------------------------------
let playwright: ChildProcess | null = null;

function runPlaywright(
  browser: Browser,
  freshUrl: string,
  grownUrl: string,
): Promise<number> {
  const devRoot = process.env.KS_DEV_ROOT ?? '';
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnvironment,
    PW_FRESH_URL: freshUrl,
    PW_GROWN_URL: grownUrl,
    KS_PW_BROWSER: browser,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      resolve(devRoot, 'playwright-browsers'),
    // As scripts/run-web-reader-journey.ts: the browser binaries stay on the SSD, but each
    // launch's scratch profile on the SSD made launches unreliable; the boot volume's /tmp holds
    // only that throwaway profile.
    TMPDIR: '/tmp',
  };
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      'pnpm',
      [
        '--filter',
        'web',
        'exec',
        'playwright',
        'test',
        '-c',
        'playwright.cosmos.config.ts',
        ...options.playwrightArgs,
      ],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
      },
    );
    playwright = child;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      playwright = null;
      resolveRun(code ?? (signal ? 1 : 0));
    });
  });
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------
const stacks: Stack[] = [];
let interrupted = false;
let rejectInterrupted!: (error: Error) => void;
const interruption = new Promise<never>((_resolve, reject) => {
  rejectInterrupted = reject;
});
interruption.catch(() => undefined);

function onSignal(): void {
  if (interrupted) return;
  interrupted = true;
  console.error(
    '[cosmos-journey] interrupted; stopping what this runner started',
  );
  rejectInterrupted(new Error('interrupted'));
  if (playwright?.pid && !exited(playwright)) {
    try {
      process.kill(-playwright.pid, 'SIGTERM');
    } catch {
      playwright.kill('SIGTERM');
    }
  }
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

async function main(): Promise<number> {
  const freshPort = options.freshPort ?? (await freePort());
  let grownPort = options.grownPort ?? (await freePort());
  while (grownPort === freshPort) grownPort = await freePort();
  for (const [label, port] of [
    ['fresh', freshPort],
    ['grown', grownPort],
  ] as const) {
    if (await portInUse(port))
      throw new Error(`${label} port ${port} is already in use`);
  }
  if (options.runDir) mkdirSync(options.runDir, { recursive: true });
  console.log(
    `[cosmos-journey] starting a fresh stack on ${freshPort} and a grown stack on ${grownPort}`,
  );
  stacks.push(startStack('fresh', freshPort, options.runDir));
  stacks.push(startStack('grown', grownPort, options.runDir));

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `stacks not READY within ${READY_TIMEOUT_MS / 60_000} minutes`,
          ),
        ),
      READY_TIMEOUT_MS,
    );
  });
  let freshUrl: string;
  let grownUrl: string;
  try {
    [freshUrl, grownUrl] = await Promise.race([
      Promise.all([stacks[0]!.ready, stacks[1]!.ready]),
      timeout,
      interruption,
    ]);
  } finally {
    clearTimeout(timer);
  }
  console.log(
    `[cosmos-journey] READY: fresh ${freshUrl}, grown ${grownUrl}; running ${options.browsers.join(', ')}`,
  );

  const results: { browser: Browser; code: number }[] = [];
  for (const browser of options.browsers) {
    if (interrupted) break;
    console.log(`[cosmos-journey] Playwright (${browser})`);
    const code = await runPlaywright(browser, freshUrl, grownUrl);
    results.push({ browser, code });
    console.log(
      `[cosmos-journey] ${browser}: ${code === 0 ? 'passed' : `failed (exit ${code})`}`,
    );
  }
  if (interrupted) return 130;
  return results.every((result) => result.code === 0) &&
    results.length === options.browsers.length
    ? 0
    : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  if (interrupted) code = 130;
  else console.error(`[cosmos-journey] ${(error as Error).message}`);
  for (const stack of stacks)
    if (!stack.url)
      console.error(
        `[cosmos-journey] ${stack.label} stack, last output:\n  ${stack.tail.slice(-20).join('\n  ') || '(none)'}`,
      );
  code ||= 1;
} finally {
  await Promise.all(stacks.map((stack) => stopStack(stack)));
  for (const stack of stacks) {
    const database = stack.database ?? '(no database reported)';
    if (stack.dropped)
      console.log(
        `[cosmos-journey] ${stack.label} stack stopped; ${database} dropped`,
      );
    else {
      console.error(
        `[cosmos-journey] ${stack.label} stack: ${database} NOT confirmed dropped; check its log`,
      );
      if (stack.database) code ||= 1;
    }
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
process.exit(code);
