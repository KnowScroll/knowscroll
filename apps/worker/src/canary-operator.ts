import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ConfigurationError, readOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { operatorSignInUseCase } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  CanaryRunFailed,
  DEFAULT_MANY_READS,
  MAX_MANY_READS,
  canaryAddressFor,
  parsePersonas,
  parseSpeed,
  runCanary,
  type CanaryReport,
  type Speed,
} from '@knowscroll/backend/modules/operator';
import { canaryPortsFor } from '@knowscroll/backend/modules/operator/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const usage =
  'usage: operator.js canary run [--personas cold-start,deep-reader,topic-switcher,reel-watcher,many-reads] [--base-url <url>] [--speed <1-60|max>] [--many <1-60>] [--wait <seconds>] [--keep]';

/** The bound on the wait, after the journeys, for projection, formation and Planner runs to settle. */
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3_600;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

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

function summaryOf(report: CanaryReport, world: string, speed: Speed): Record<string, unknown> {
  const { evaluation } = report;
  return {
    command: 'canary run',
    result: evaluation.passed ? 'passed' : 'failed',
    world,
    pacing: report.pacing,
    speed: speedLabel(speed),
    durationSeconds: report.durationSeconds,
    personas: evaluation.personas,
    checks: evaluation.checks,
    violations: evaluation.violations,
    jobs: evaluation.jobs,
    planner: evaluation.planner,
    geography: evaluation.geography,
    composerPolicies: evaluation.composerPolicies,
    cleanup: report.cleanup,
  };
}

/**
 * `canary run [--personas a,b] [--base-url <url>] [--speed <1-60|max>] [--many <n>] [--wait <seconds>] [--keep]`
 * (#674, D-413): a post-deploy canary that drives the deployed API and worker with disposable test accounts, the way
 * a client does, and reports whether the recommendation, formation and supply algorithms behave.
 *
 * It mints one disposable account per persona with the operator sign-in use case (a unique
 * `canary-<run>-<persona>` address inside `KS_OPERATOR_SIGN_IN_PATTERN`), redeems each link through the real HTTP
 * route, and from then on uses only public routes with that session. It never writes to the database itself. After
 * the journeys it waits, within `--wait`, for readings to be projected and for the places and Planner runs they
 * entitle, then reads back through the public routes and the read-only operator views and judges the invariants.
 * Unless `--keep`, each account is deleted through the real account deletion flow and the receipt confirmed.
 *
 * Refused outside the world that allows operator sign-in (`dev`, `stage`, `ci`, `local`, with
 * `KS_ALLOW_OPERATOR_SIGN_IN=1`), the same check as `issue-sign-in`. `--base-url` may only be the world's own
 * origin or this machine. `--speed` is how fast the readers read, never how long the canary waits: the server
 * bounds every claimed interval by the wall time since activation, so waiting is always real time.
 *
 * One JSON line on stdout with counts and codes only (no id, title, address or link); diagnostics on stderr.
 * Exit 0 passed, 1 an invariant was violated or the run failed, 2 refused or bad usage.
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
        keep: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage });
    return 2;
  }
  const personas = parsePersonas(args.values.personas);
  const speed = parseSpeed(args.values.speed);
  const manyReads = integerIn(args.values.many, 1, MAX_MANY_READS, DEFAULT_MANY_READS);
  const waitSeconds = integerIn(args.values.wait, 0, MAX_WAIT_SECONDS, DEFAULT_WAIT_SECONDS);
  if (
    args.positionals.length !== 1 ||
    args.positionals[0] !== 'run' ||
    personas === undefined ||
    speed === undefined ||
    manyReads === undefined ||
    waitSeconds === undefined
  ) {
    print({ result: 'usage', usage });
    return 2;
  }
  let config;
  try {
    config = readOperatorConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    logEvent('config.invalid', { problems: error.problems });
    print({ command: 'canary run', result: 'refused', reasonCode: 'config_refused' });
    return 2;
  }
  const baseUrl = baseUrlFor(args.values['base-url'], config.publicOrigin);
  if (baseUrl === undefined) {
    print({ command: 'canary run', result: 'refused', reasonCode: 'base_url_not_allowed' });
    return 2;
  }
  const runId = randomBytes(4).toString('hex');
  if (canaryAddressFor(config.pattern, runId, personas[0] ?? 'cold-start') === undefined) {
    print({ command: 'canary run', result: 'refused', reasonCode: 'pattern_has_no_wildcard' });
    return 2;
  }
  const database = createDatabase<Database>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
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
      baseUrl,
      publicOrigin: config.publicOrigin,
    });
    const report = await runCanary(ports, {
      personas,
      speed,
      manyReads,
      keep: args.values.keep,
      waitSeconds,
      addressFor: (persona) => canaryAddressFor(config.pattern, runId, persona) ?? '',
    });
    logEvent('operator.read', {
      route: '/cli/canary/run',
      outcome: report.evaluation.passed ? 'passed' : 'failed',
      count: report.evaluation.violations.length,
    });
    print(summaryOf(report, config.world, speed));
    return report.evaluation.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof CanaryRunFailed) {
      const refused = error.code === 'mint_refused';
      logEvent('operator.read', { route: '/cli/canary/run', outcome: error.code });
      print({
        command: 'canary run',
        result: refused ? 'refused' : 'failed',
        reasonCode: error.code,
        ...(error.reason === undefined ? {} : { mintReason: error.reason }),
        orphanedAccounts: error.orphaned,
      });
      return refused ? 2 : 1;
    }
    logEvent('process.crashed', { reasonCode: 'canary_failed', error });
    return 1;
  } finally {
    await database.close();
  }
}
