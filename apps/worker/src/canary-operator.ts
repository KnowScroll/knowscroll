import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ConfigurationError, readOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { disposableAddressListerFor, operatorSignInUseCase } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  CanaryRunFailed,
  DEFAULT_MANY_READS,
  MAX_MANY_READS,
  RUN_ID_PATTERN,
  canaryAddressFor,
  canaryAddressShape,
  cleanupCanary,
  parsePersonas,
  parseSpeed,
  runCanary,
  type CanaryReport,
  type Speed,
} from '@knowscroll/backend/modules/operator';
import { canaryPortsFor } from '@knowscroll/backend/modules/operator/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const usage =
  'usage: operator.js canary run [--personas cold-start,deep-reader,topic-switcher,reel-watcher,many-reads] [--base-url <url>] [--speed <1-60|max>] [--many <1-60>] [--wait <seconds>] [--timeout <minutes>] [--keep] [--strict] [--allow-stage] | operator.js canary cleanup [--run <id>] [--dry-run] [--base-url <url>] [--allow-stage]';

/** The bound on the wait, after the journeys, for projection, formation and Planner runs to settle. */
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3_600;
/** The whole run, journeys and waits and all: past it the run is stopped and its accounts are deleted. */
const DEFAULT_TIMEOUT_MINUTES = 90;
const MAX_TIMEOUT_MINUTES = 480;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const RUN_ONLY_OPTIONS = ['personas', 'speed', 'many', 'wait', 'timeout', 'keep', 'strict'] as const;
const CLEANUP_ONLY_OPTIONS = ['run', 'dry-run'] as const;

function integerIn(raw: string | undefined, min: number, max: number, fallback: number): number | undefined {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

/**
 * Where the canary may send its requests: the world's own public origin, or this machine. Never another host, so a
 * mistyped `--base-url` cannot point a disposable-account journey at a world the operator command was not run for.
 */
function baseUrlFor(raw: string | undefined, publicOrigin: string): string | undefined {
  try {
    const url = new URL(raw ?? publicOrigin);
    const allowed = url.origin === new URL(publicOrigin).origin || LOOPBACK_HOSTS.has(url.hostname);
    if (!allowed || (url.protocol !== 'https:' && url.protocol !== 'http:')) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function speedLabel(speed: Speed): string | number {
  return speed.kind === 'factor' ? speed.value : speed.kind;
}

function completedSummary(
  report: Extract<CanaryReport, { kind: 'completed' }>,
  world: string,
  speed: Speed,
): Record<string, unknown> {
  const { evaluation } = report;
  return {
    command: 'canary run',
    result: evaluation.passed ? 'passed' : 'failed',
    // A strict run that broke no invariant still fails when some were never exercised or are inconclusive.
    ...(!evaluation.passed && evaluation.violations.length === 0 ? { reasonCode: 'strict_unfinished' } : {}),
    world,
    strict: evaluation.strict,
    pacing: report.pacing,
    speed: speedLabel(speed),
    durationSeconds: report.durationSeconds,
    personas: evaluation.personas,
    checks: evaluation.checks,
    notExercised: evaluation.notExercised,
    violations: evaluation.violations,
    jobs: evaluation.jobs,
    planner: evaluation.planner,
    geography: evaluation.geography,
    composerPolicies: evaluation.composerPolicies,
    spend: evaluation.spend,
    cleanup: report.cleanup,
  };
}

/**
 * Turns SIGINT, SIGTERM and SIGHUP into an abort of the run, with a time limit as one more reason. The first stops
 * the journeys and starts the bounded deletion of the run's accounts; a second one while that is under way gives up
 * on waiting and exits (the accounts it did not finish are found again by `canary cleanup`).
 */
function stopSources(timeoutMinutes: number | undefined, onSecond: () => void) {
  const controller = new AbortController();
  let received = 0;
  const handlers = SIGNALS.map((name) => {
    const handler = () => {
      received += 1;
      if (received === 1) controller.abort(name.toLowerCase());
      else onSecond();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  const timer =
    timeoutMinutes === undefined ? undefined : setTimeout(() => controller.abort('timeout'), timeoutMinutes * 60_000);
  return {
    signal: controller.signal,
    release() {
      if (timer !== undefined) clearTimeout(timer);
      for (const [name, handler] of handlers) process.off(name, handler);
    },
  };
}

/**
 * `canary run [--personas a,b] [--base-url <url>] [--speed <1-60|max>] [--many <n>] [--wait <seconds>]
 * [--timeout <minutes>] [--keep] [--strict] [--allow-stage]` and `canary cleanup [--run <id>] [--dry-run]`
 * (#674, D-413): a post-deploy canary that drives the deployed API and worker with disposable test accounts, the way
 * a client does, and reports whether the recommendation, formation and supply algorithms behave.
 *
 * It mints one disposable account per persona with the operator sign-in use case (a unique
 * `canary-<run>-<persona>` address inside `KS_OPERATOR_SIGN_IN_PATTERN`; minting writes the accounts and their audit
 * rows), redeems each link through the real HTTP route, and from then on uses only public routes with that session.
 * What those routes cause is what a reader causes, including the Planner, Cartographer and Jev model calls within the
 * world's caps; a disposable account never starts or joins shared supply (Supply, D-413). After the journeys it waits,
 * within `--wait`, for readings to be projected and for the places and Planner runs they entitle, then reads back
 * through the public routes and the read-only operator views and judges the invariants. Unless `--keep`, each account
 * is deleted through the real account deletion flow and the receipt confirmed.
 *
 * The run id is printed on stderr at the start. SIGINT, SIGTERM and SIGHUP, and `--timeout` (default 90 minutes),
 * stop the journeys and delete the run's accounts within a bounded wait; the result is then `aborted`. `canary
 * cleanup` finds this world's `canary-<run>-<persona>` accounts again (optionally one run) and deletes them through the
 * same flow, for a run that was killed or kept; it opens no other address.
 *
 * Refused outside the world that allows operator sign-in (`dev`, `stage`, `ci`, `local`, with
 * `KS_ALLOW_OPERATOR_SIGN_IN=1`), the same check as `issue-sign-in`; on `stage` it also needs `--allow-stage`.
 * `--base-url` may only be the world's own origin or this machine. `--speed` is how fast the readers read, never how
 * long the canary waits: the server bounds every claimed interval by the wall time since activation. `--strict` also
 * fails a run in which some invariant was never exercised, or whose evidence was inconclusive.
 *
 * One JSON line on stdout with counts and codes only (no id, title, address or link), whatever happens, even a crash;
 * diagnostics on stderr. Exit 0 passed or done, 1 an invariant was violated, the run was aborted or it failed, 2
 * refused or bad usage.
 */
export async function canaryCommand(
  argv: readonly string[],
  print: Print,
  logEvent: LogEvent,
  operatorSource: string,
): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      options: {
        personas: { type: 'string' },
        'base-url': { type: 'string' },
        speed: { type: 'string' },
        many: { type: 'string' },
        wait: { type: 'string' },
        timeout: { type: 'string' },
        run: { type: 'string' },
        keep: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        'allow-stage': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage });
    return 2;
  }
  const subcommand = args.positionals[0];
  const wrongOptions = (subcommand === 'run' ? CLEANUP_ONLY_OPTIONS : RUN_ONLY_OPTIONS).some(
    (name) => argv.includes(`--${name}`) || argv.some((arg) => arg.startsWith(`--${name}=`)),
  );
  const personas = parsePersonas(args.values.personas);
  const speed = parseSpeed(args.values.speed);
  const manyReads = integerIn(args.values.many, 1, MAX_MANY_READS, DEFAULT_MANY_READS);
  const waitSeconds = integerIn(args.values.wait, 0, MAX_WAIT_SECONDS, DEFAULT_WAIT_SECONDS);
  const timeoutMinutes = integerIn(args.values.timeout, 1, MAX_TIMEOUT_MINUTES, DEFAULT_TIMEOUT_MINUTES);
  const only = args.values.run;
  if (
    args.positionals.length !== 1 ||
    (subcommand !== 'run' && subcommand !== 'cleanup') ||
    wrongOptions ||
    personas === undefined ||
    speed === undefined ||
    manyReads === undefined ||
    waitSeconds === undefined ||
    timeoutMinutes === undefined ||
    (only !== undefined && !RUN_ID_PATTERN.test(only))
  ) {
    print({ result: 'usage', usage });
    return 2;
  }
  const command = `canary ${subcommand}`;
  let config;
  try {
    config = readOperatorConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    logEvent('config.invalid', { problems: error.problems });
    print({ command, result: 'refused', reasonCode: 'config_refused' });
    return 2;
  }
  if (config.world === 'stage' && !args.values['allow-stage']) {
    print({ command, result: 'refused', reasonCode: 'stage_requires_allow_stage' });
    return 2;
  }
  const baseUrl = baseUrlFor(args.values['base-url'], config.publicOrigin);
  if (baseUrl === undefined) {
    print({ command, result: 'refused', reasonCode: 'base_url_not_allowed' });
    return 2;
  }
  const shape = canaryAddressShape(config.pattern);
  if (shape === undefined) {
    print({ command, result: 'refused', reasonCode: 'pattern_has_no_wildcard' });
    return 2;
  }
  const runId = randomBytes(4).toString('hex');
  const database = createDatabase<Database>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
  });
  const stop = stopSources(subcommand === 'run' ? timeoutMinutes : undefined, () => {
    logEvent('operator.canary_stopped', { canaryRun: runId, reasonCode: 'stopped_twice' });
    print({ command, result: 'failed', reasonCode: 'stopped_twice' });
    process.exit(1);
  });
  try {
    const ports = canaryPortsFor({
      db: database.db,
      issueSignIn: operatorSignInUseCase({
        db: database.db,
        publicOrigin: config.publicOrigin,
        lockTimeoutMs: config.scopeLockTimeoutMs,
        pattern: config.pattern,
        world: config.world,
        operatorSource,
      }),
      listDisposableAddresses: disposableAddressListerFor(database.db),
      baseUrl,
      publicOrigin: config.publicOrigin,
    });
    if (subcommand === 'cleanup') {
      const report = await cleanupCanary(
        ports,
        shape,
        { ...(only === undefined ? {} : { run: only }), dryRun: args.values['dry-run'] },
        stop.signal,
      );
      logEvent('operator.read', { route: '/cli/canary/cleanup', outcome: 'done', count: report.found });
      print({
        command,
        result: args.values['dry-run'] ? 'dry_run' : report.failed === 0 && !report.stopped ? 'done' : 'failed',
        world: config.world,
        ...report,
      });
      return args.values['dry-run'] || (report.failed === 0 && !report.stopped) ? 0 : 1;
    }
    logEvent('operator.canary_started', { canaryRun: runId, count: personas.length });
    const report = await runCanary(
      ports,
      {
        personas,
        speed,
        manyReads,
        keep: args.values.keep,
        strict: args.values.strict,
        waitSeconds,
        addressFor: (persona) => canaryAddressFor(config.pattern, runId, persona) ?? '',
      },
      stop.signal,
    );
    if (report.kind === 'aborted') {
      logEvent('operator.canary_stopped', {
        canaryRun: runId,
        reasonCode: report.reason,
        count: report.cleanup.completed,
      });
      print({
        command,
        result: 'aborted',
        reasonCode: report.reason,
        world: config.world,
        durationSeconds: report.durationSeconds,
        cleanup: report.cleanup,
      });
      return 1;
    }
    logEvent('operator.read', {
      route: '/cli/canary/run',
      outcome: report.evaluation.passed ? 'passed' : 'failed',
      count: report.evaluation.violations.length,
    });
    print(completedSummary(report, config.world, speed));
    return report.evaluation.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof CanaryRunFailed) {
      const refused = error.code === 'mint_refused';
      logEvent('operator.read', { route: '/cli/canary/run', outcome: error.code });
      print({
        command,
        result: refused ? 'refused' : 'failed',
        reasonCode: error.code,
        ...(error.reason === undefined ? {} : { mintReason: error.reason }),
        orphanedAccounts: error.orphaned,
      });
      return refused ? 2 : 1;
    }
    // Whatever went wrong, the operator still gets one line to read; the run's accounts were deleted on the way out.
    logEvent('process.crashed', { reasonCode: 'canary_failed', error });
    print({ command, result: 'failed', reasonCode: 'crashed' });
    return 1;
  } finally {
    stop.release();
    await database.close();
  }
}
