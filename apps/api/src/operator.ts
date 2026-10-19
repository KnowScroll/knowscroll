import { parseArgs } from 'node:util';
import {
  ConfigurationError,
  LIVE_WORLD,
  commitForDiagnostics,
  readOperatorConfig,
  worldForDiagnostics,
  type Environment,
} from '@knowscroll/backend/infrastructure/config';
import { createEventLog, type LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { operatorSignInUseCase } from './modules/identity.js';

/**
 * Operator sign-in for disposable test accounts on dev and stage (D-007):
 *
 *   node dist/operator.js issue-sign-in --email <address>
 *
 * Run on the server shell with the world's environment (its v2 settings and database secret).
 * Creates the disposable account for the address if it has none (an address that signed up by
 * mail is refused: this never opens a real person's account), then prints one sign-in link on
 * stdout: it works once, for 15 minutes, like a mailed link.
 *
 * Refused, before touching the database and again just before issuing, when `KS_WORLD` is `live`
 * or `KS_ALLOW_OPERATOR_SIGN_IN` is not exactly `1`. The API refuses to start with the flag in
 * live and refuses operator links wherever it is not set. Every use writes one
 * `identity.operator_sign_in` record (stderr, JSON; never the address, token or link) and a
 * durable receipt in the account's universe. Exit 0 issued, 1 refused or failed, 2 usage.
 */
const usage = 'usage: node dist/operator.js issue-sign-in --email <address>\n';

/** The run-time check, repeated just before issuing: never live, flag exactly `1`. */
function operatorSignInAllowed(env: Environment): boolean {
  return env['KS_WORLD'] !== LIVE_WORLD && env['KS_ALLOW_OPERATOR_SIGN_IN'] === '1';
}

function refusalCode(problems: readonly string[]): string {
  if (problems.some((problem) => problem.startsWith('KS_WORLD: operator_sign_in_refused_in_live')))
    return 'refused_in_live';
  if (problems.some((problem) => problem.startsWith('KS_ALLOW_OPERATOR_SIGN_IN'))) return 'not_enabled';
  return 'config_invalid';
}

async function run(env: Environment, logEvent: LogEvent): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: { email: { type: 'string' } },
    });
  } catch {
    process.stderr.write(usage);
    return 2;
  }
  if (
    parsed.positionals.length !== 1 ||
    parsed.positionals[0] !== 'issue-sign-in' ||
    parsed.values.email === undefined
  ) {
    process.stderr.write(usage);
    return 2;
  }
  let config;
  try {
    config = readOperatorConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    logEvent('config.invalid', { problems: error.problems });
    logEvent('identity.operator_sign_in', {
      severity: 'warn',
      outcome: 'refused',
      reasonCode: refusalCode(error.problems),
    });
    return 1;
  }
  const database = createDatabase<Database>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
  });
  try {
    if (!operatorSignInAllowed(env)) {
      logEvent('identity.operator_sign_in', { severity: 'warn', outcome: 'refused', reasonCode: 'not_enabled' });
      return 1;
    }
    const issue = operatorSignInUseCase({
      db: database.db,
      publicOrigin: config.publicOrigin,
      lockTimeoutMs: config.scopeLockTimeoutMs,
    });
    const result = await issue({ email: parsed.values.email });
    if (result.kind === 'refused') {
      logEvent('identity.operator_sign_in', { severity: 'warn', outcome: 'refused', reasonCode: result.reason });
      return 1;
    }
    logEvent('identity.operator_sign_in', {
      severity: 'info',
      outcome: 'issued',
      reasonCode: result.outcome.accountCreated ? 'account_created' : 'account_existing',
    });
    process.stdout.write(`${result.link}\n`);
    return 0;
  } finally {
    await database.close();
  }
}

const environment: Environment = process.env;
const logEvent = createEventLog({
  service: 'operator',
  environment: worldForDiagnostics(environment),
  revision: commitForDiagnostics(environment),
  // Diagnostics go to stderr so stdout carries only the link.
  destination: process.stderr,
});
try {
  process.exitCode = await run(environment, logEvent);
} catch (error) {
  logEvent('identity.operator_sign_in', { severity: 'error', outcome: 'failed', reasonCode: 'unexpected', error });
  process.exitCode = 1;
}
