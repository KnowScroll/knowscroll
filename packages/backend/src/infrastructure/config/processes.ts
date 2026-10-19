import { z } from 'zod';
import {
  PortSchema,
  PostgresUrlSchema,
  checkEnvironment,
  combineChecks,
  positiveInteger,
  type Environment,
} from './environment.js';
import { checkReleaseIdentity, type ReleaseIdentity } from './release.js';

/** Connection settings for one process's PostgreSQL pool. `url` is a credential: never log it. */
export interface DatabaseSettings {
  readonly url: string;
  readonly applicationName: string;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
}

export interface ApiConfig extends ReleaseIdentity {
  readonly database: DatabaseSettings;
  readonly listen: { readonly host: string; readonly port: number };
  readonly bodyLimitBytes: number;
  readonly shutdownGraceMs: number;
}

export interface WorkerConfig extends ReleaseIdentity {
  readonly database: DatabaseSettings;
  readonly shutdownGraceMs: number;
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
 * `KS_BODY_LIMIT_BYTES` (default 65536), `KS_SHUTDOWN_GRACE_SECONDS` (default 20), plus the
 * release identity variables of {@link checkReleaseIdentity}. Throws one `ConfigurationError`
 * listing every problem of every variable.
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
      }),
      pick(env, [
        'DATABASE_URL',
        'KS_DB_STATEMENT_TIMEOUT_MS',
        'PORT',
        'KS_LISTEN_HOST',
        'KS_DB_POOL_MAX',
        'KS_BODY_LIMIT_BYTES',
        'KS_SHUTDOWN_GRACE_SECONDS',
      ]),
    ),
  );
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-api-${release.world}`, parsed.KS_DB_POOL_MAX),
    listen: { host: parsed.KS_LISTEN_HOST, port: parsed.PORT },
    bodyLimitBytes: parsed.KS_BODY_LIMIT_BYTES,
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
  };
}

/**
 * Worker process configuration. Variables: `DATABASE_URL`, `KS_DB_POOL_MAX` (default 5),
 * `KS_DB_STATEMENT_TIMEOUT_MS`, `KS_SHUTDOWN_GRACE_SECONDS` (default 20), plus the release
 * identity variables.
 */
export function readWorkerConfig(env: Environment): WorkerConfig {
  const [release, parsed] = combineChecks(
    checkReleaseIdentity(env),
    checkEnvironment(
      z.object({
        ...databaseVariables,
        KS_DB_POOL_MAX: positiveInteger(5, 100),
        KS_SHUTDOWN_GRACE_SECONDS: positiveInteger(20, 300),
      }),
      pick(env, ['DATABASE_URL', 'KS_DB_STATEMENT_TIMEOUT_MS', 'KS_DB_POOL_MAX', 'KS_SHUTDOWN_GRACE_SECONDS']),
    ),
  );
  return {
    ...release,
    database: databaseSettings(parsed, `knowscroll-worker-${release.world}`, parsed.KS_DB_POOL_MAX),
    shutdownGraceMs: parsed.KS_SHUTDOWN_GRACE_SECONDS * 1000,
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
