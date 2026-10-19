import { z } from 'zod';
import { ConfigurationError, PortSchema, PostgresUrlSchema, checkEnvironment, combineChecks, positiveInteger, type Environment } from './environment.js';
import { checkReleaseIdentity, type ReleaseIdentity } from './release.js';

/** Connection settings for one process's PostgreSQL pool. `url` is a credential: never log it. */
export interface DatabaseSettings {
  readonly url: string;
  readonly applicationName: string;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
}

/**
 * How the API resolves an authenticated caller. `none`: no caller (every personal route answers
 * 401) until S1.3 adds sessions. `test-bearer`: a CI-only adapter that trusts `Bearer
 * test.<accountId>`; refused unless `NODE_ENV=test` and `KS_WORLD` is `ci` or `local`.
 */
export type AuthAdapter = 'none' | 'test-bearer';

/** The only worlds in which test-only adapters may run. */
export const TEST_ADAPTER_WORLDS: readonly string[] = ['ci', 'local'];

export interface ApiConfig extends ReleaseIdentity {
  readonly database: DatabaseSettings;
  readonly listen: { readonly host: string; readonly port: number };
  readonly bodyLimitBytes: number;
  readonly shutdownGraceMs: number;
  /** Personal-scope lock wait; always shorter than the statement timeout. */
  readonly scopeLockTimeoutMs: number;
  readonly authAdapter: AuthAdapter;
  /** How long a socket subscription's authorisation may be reused before it is rechecked. */
  readonly socketAuthorisationCacheMs: number;
}

export interface WorkerConfig extends ReleaseIdentity {
  readonly database: DatabaseSettings;
  readonly shutdownGraceMs: number;
  /** Personal-scope lock wait; always shorter than the statement timeout. */
  readonly scopeLockTimeoutMs: number;
}

export interface MigrateConfig {
  readonly database: DatabaseSettings;
}

const databaseVariables = {
  DATABASE_URL: PostgresUrlSchema,
  KS_DB_STATEMENT_TIMEOUT_MS: positiveInteger(15_000, 600_000),
};

function databaseSettings(
  parsed: { DATABASE_URL: string; KS_DB_STATEMENT_TIMEOUT_MS: number },
  applicationName: string,
  poolMax: number,
): DatabaseSettings {
  return {
    url: parsed.DATABASE_URL,
    applicationName,
    poolMax,
    statementTimeoutMs: parsed.KS_DB_STATEMENT_TIMEOUT_MS,
  };
}

/**
 * Cross-variable rules, checked after each variable is valid on its own: the lock wait must end
 * before the statement timeout (so a lock wait is reported as retryable busy, not as a cancelled
 * statement), and a test-only adapter needs `NODE_ENV=test` in a CI or local world.
 */
function crossChecks(rules: readonly (readonly [boolean, string])[]): void {
  const problems = rules.filter(([violated]) => violated).map(([, problem]) => problem);
  if (problems.length > 0) throw new ConfigurationError(problems);
}

/**
 * API process configuration. Variables: `DATABASE_URL`, `PORT`, `KS_LISTEN_HOST` (default
 * `127.0.0.1`), `KS_DB_POOL_MAX` (default 10), `KS_DB_STATEMENT_TIMEOUT_MS` (default 15000),
 * `KS_BODY_LIMIT_BYTES` (default 65536), `KS_SHUTDOWN_GRACE_SECONDS` (default 20),
 * `KS_SCOPE_LOCK_TIMEOUT_MS` (default 5000, below the statement timeout), `KS_AUTH_ADAPTER`
 * (default `none`; `test-bearer` only with `NODE_ENV=test` and `KS_WORLD` `ci` or `local`),
 * `KS_SOCKET_AUTH_CACHE_MS` (default 30000, at most 30000), plus the release identity variables of
 * {@link checkReleaseIdentity}. Throws one `ConfigurationError` listing every problem.
 */
export function readApiConfig(env: Environment): ApiConfig {
  const [release, parsed] = combineChecks(
    checkReleaseIdentity(env),
    checkEnvironment(
      z.object({
        ...databaseVariables,
        PORT: PortSchema,
        KS_LISTEN_HOST: z.string().min(1).default('127.0.0.1'),
        KS_DB_POOL_MAX: positiveInteger(10, 100),
        KS_BODY_LIMIT_BYTES: positiveInteger(65_536, 10 * 1024 * 1024),
        KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
        KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
        KS_AUTH_ADAPTER: z.enum(['none', 'test-bearer']).default('none'),
        KS_SOCKET_AUTH_CACHE_MS: z.coerce.number().int().min(0).max(30_000).default(30_000),
      }),
      pick(env, [
        'DATABASE_URL',
        'KS_DB_STATEMENT_TIMEOUT_MS',
        'PORT',
        'KS_LISTEN_HOST',
        'KS_DB_POOL_MAX',
        'KS_BODY_LIMIT_BYTES',
        'KS_SHUTDOWN_GRACE_SECONDS',
        'KS_SCOPE_LOCK_TIMEOUT_MS',
        'KS_AUTH_ADAPTER',
        'KS_SOCKET_AUTH_CACHE_MS',
      ]),
    ),
  );
  crossChecks([
    [parsed.KS_SCOPE_LOCK_TIMEOUT_MS >= parsed.KS_DB_STATEMENT_TIMEOUT_MS, 'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout'],
    [parsed.KS_AUTH_ADAPTER === 'test-bearer' && release.nodeEnv !== 'test', 'KS_AUTH_ADAPTER: refused_outside_test'],
    [parsed.KS_AUTH_ADAPTER === 'test-bearer' && !TEST_ADAPTER_WORLDS.includes(release.world), 'KS_AUTH_ADAPTER: refused_in_this_world'],
  ]);
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-api-${release.world}`, parsed.KS_DB_POOL_MAX),
    listen: { host: parsed.KS_LISTEN_HOST, port: parsed.PORT },
    bodyLimitBytes: parsed.KS_BODY_LIMIT_BYTES,
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
    authAdapter: parsed.KS_AUTH_ADAPTER,
    socketAuthorisationCacheMs: parsed.KS_SOCKET_AUTH_CACHE_MS,
  };
}

/**
 * Worker process configuration. Variables: `DATABASE_URL`, `KS_DB_POOL_MAX` (default 5),
 * `KS_DB_STATEMENT_TIMEOUT_MS`, `KS_SHUTDOWN_GRACE_SECONDS` (default 20),
 * `KS_SCOPE_LOCK_TIMEOUT_MS` (default 5000, below the statement timeout), plus the release
 * identity variables. Throws one `ConfigurationError` listing every problem.
 */
export function readWorkerConfig(env: Environment): WorkerConfig {
  const [release, parsed] = combineChecks(
    checkReleaseIdentity(env),
    checkEnvironment(
      z.object({
        ...databaseVariables,
        KS_DB_POOL_MAX: positiveInteger(5, 100),
        KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
        KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
      }),
      pick(env, ['DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS', 'KS_DB_POOL_MAX', 'KS_SHUTDOWN_GRACE_SECONDS', 'KS_SCOPE_LOCK_TIMEOUT_MS']),
    ),
  );
  crossChecks([[parsed.KS_SCOPE_LOCK_TIMEOUT_MS >= parsed.KS_DB_STATEMENT_TIMEOUT_MS, 'KS_SCOPE_LOCK_TIMEOUT_MS: must_be_below_statement_timeout']]);
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-worker-${release.world}`, parsed.KS_DB_POOL_MAX),
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
  };
}

/** Migration command configuration: `DATABASE_URL` and `KS_DB_STATEMENT_TIMEOUT_MS` (default 15 minutes). */
export function readMigrateConfig(env: Environment): MigrateConfig {
  const [parsed] = combineChecks(
    checkEnvironment(
      z.object({ DATABASE_URL: PostgresUrlSchema, KS_DB_STATEMENT_TIMEOUT_MS: positiveInteger(900_000, 3_600_000) }),
      pick(env, ['DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS']),
    ),
  );
  return { database: databaseSettings(parsed, 'knowscroll-migrate', 2) };
}

function pick(env: Environment, names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}
