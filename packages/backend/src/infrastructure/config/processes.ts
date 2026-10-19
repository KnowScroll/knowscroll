import { z } from 'zod';
import {
  ConfigurationError,
  PortSchema,
  PostgresUrlSchema,
  parseEnvironment,
  positiveInteger,
  type Environment,
} from './environment.js';
import { readReleaseIdentity, type ReleaseIdentity } from './release.js';

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
 * test.<accountId>`; refused unless `NODE_ENV=test`.
 */
export type AuthAdapter = 'none' | 'test-bearer';

export interface ApiConfig extends ReleaseIdentity {
  readonly database: DatabaseSettings;
  readonly listen: { readonly host: string; readonly port: number };
  readonly bodyLimitBytes: number;
  readonly shutdownGraceMs: number;
  readonly scopeLockTimeoutMs: number;
  readonly authAdapter: AuthAdapter;
}

export interface WorkerConfig extends ReleaseIdentity {
  readonly database: DatabaseSettings;
  readonly shutdownGraceMs: number;
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
  return { url: parsed.DATABASE_URL, applicationName, poolMax, statementTimeoutMs: parsed.KS_DB_STATEMENT_TIMEOUT_MS };
}

/**
 * API process configuration. Variables: `DATABASE_URL`, `PORT`, `KS_LISTEN_HOST` (default
 * `127.0.0.1`), `KS_DB_POOL_MAX` (default 10), `KS_DB_STATEMENT_TIMEOUT_MS` (default 15000),
 * `KS_BODY_LIMIT_BYTES` (default 65536), `KS_SHUTDOWN_GRACE_SECONDS` (default 20),
 * `KS_SCOPE_LOCK_TIMEOUT_MS` (default 5000), `KS_AUTH_ADAPTER` (default `none`; `test-bearer` only
 * with `NODE_ENV=test`), plus the release identity variables of {@link readReleaseIdentity}.
 */
export function readApiConfig(env: Environment): ApiConfig {
  const release = readReleaseIdentity(env);
  const parsed = parseEnvironment(
    z.object({
      ...databaseVariables,
      PORT: PortSchema,
      KS_LISTEN_HOST: z.string().min(1).default('127.0.0.1'),
      KS_DB_POOL_MAX: positiveInteger(10, 100),
      KS_BODY_LIMIT_BYTES: positiveInteger(65_536, 10 * 1024 * 1024),
      KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
      KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
      KS_AUTH_ADAPTER: z.enum(['none', 'test-bearer']).default('none'),
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
    ]),
  );
  if (parsed.KS_AUTH_ADAPTER === 'test-bearer' && release.nodeEnv !== 'test') {
    throw new ConfigurationError(['KS_AUTH_ADAPTER: test-bearer is refused unless NODE_ENV=test']);
  }
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-api-${release.world}`, parsed.KS_DB_POOL_MAX),
    listen: { host: parsed.KS_LISTEN_HOST, port: parsed.PORT },
    bodyLimitBytes: parsed.KS_BODY_LIMIT_BYTES,
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
    authAdapter: parsed.KS_AUTH_ADAPTER,
  };
}

/**
 * Worker process configuration. Variables: `DATABASE_URL`, `KS_DB_POOL_MAX` (default 5),
 * `KS_DB_STATEMENT_TIMEOUT_MS`, `KS_SHUTDOWN_GRACE_SECONDS` (default 20), plus the release
 * identity variables.
 */
export function readWorkerConfig(env: Environment): WorkerConfig {
  const release = readReleaseIdentity(env);
  const parsed = parseEnvironment(
    z.object({
      ...databaseVariables,
      KS_DB_POOL_MAX: positiveInteger(5, 100),
      KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
      KS_SCOPE_LOCK_TIMEOUT_MS: positiveInteger(5_000, 60_000),
    }),
    pick(env, [
      'DATABASE_URL',
      'KS_DB_STATEMENT_TIMEOUT_MS',
      'KS_DB_POOL_MAX',
      'KS_SHUTDOWN_GRACE_SECONDS',
      'KS_SCOPE_LOCK_TIMEOUT_MS',
    ]),
  );
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-worker-${release.world}`, parsed.KS_DB_POOL_MAX),
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
    scopeLockTimeoutMs: parsed.KS_SCOPE_LOCK_TIMEOUT_MS,
  };
}

/** Migration command configuration: `DATABASE_URL` and `KS_DB_STATEMENT_TIMEOUT_MS` (default 15 minutes). */
export function readMigrateConfig(env: Environment): MigrateConfig {
  const parsed = parseEnvironment(
    z.object({ DATABASE_URL: PostgresUrlSchema, KS_DB_STATEMENT_TIMEOUT_MS: positiveInteger(900_000, 3_600_000) }),
    pick(env, ['DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS']),
  );
  return { database: databaseSettings(parsed, 'knowscroll-migrate', 2) };
}

function pick(env: Environment, names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}
