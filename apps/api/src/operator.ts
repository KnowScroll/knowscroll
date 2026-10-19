import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import {
  ConfigurationError,
  commitForDiagnostics,
  readOperatorConfig,
  worldForDiagnostics,
  type Environment,
} from '@knowscroll/backend/infrastructure/config';
import { createEventLog, type LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { OPERATOR_WORLDS } from '@knowscroll/backend/modules/identity';
import { operatorSignInUseCase } from './modules/identity.js';

/**
 * Operator sign-in for disposable test accounts on dev and stage (D-007):
 *
 *   node dist/operator.js issue-sign-in --email <address>
 *
 * Run on the server shell as the world's v2 user with the world's environment (its v2 settings
 * and database secret). Only for addresses the world's disposable pattern matches
 * (`KS_OPERATOR_SIGN_IN_PATTERN`, for example `*@test.knowscroll.space`; review m2), so it never
 * opens a real person's account. Creates the disposable account for the address if it has none,
 * then prints one sign-in link on stdout: it works once, for 15 minutes, like a mailed link (on
 * the web; operator links carry no native binding).
 *
 * Refused, before touching the database and again just before issuing, outside the allow-listed
 * worlds (`dev`, `stage`, `ci`, `local`: never live, whatever it is called; review m3), when
 * `KS_ALLOW_OPERATOR_SIGN_IN` is not exactly `1`, or without a valid pattern. The API refuses the
 * same and checks the pattern again when the link is redeemed. Every issue writes a durable audit
 * row in `ops.operator_sign_ins` (world, time, who ran it, the account; it survives "clear
 * history" and is tombstoned by account deletion; review m9), one `identity.operator_sign_in`
 * record on stderr (JSON; never the address, token or link) and a receipt in the account's
 * universe. Exit 0 issued, 1 refused or failed, 2 usage.
 */
const usage = 'usage: node dist/operator.js issue-sign-in --email <address>\n';

/** The run-time check, repeated just before issuing: an allow-listed world, flag exactly `1`. */
function operatorSignInAllowed(env: Environment): boolean {
  return OPERATOR_WORLDS.includes(env['KS_WORLD'] ?? '') && env['KS_ALLOW_OPERATOR_SIGN_IN'] === '1';
}

function refusalCode(problems: readonly string[]): string {
  if (problems.some((problem) => problem.startsWith('KS_WORLD: operator_sign_in_refused')))
    return 'refused_in_this_world';
  if (problems.some((problem) => problem.startsWith('KS_ALLOW_OPERATOR_SIGN_IN'))) return 'not_enabled';
  if (problems.some((problem) => problem.startsWith('KS_OPERATOR_SIGN_IN_PATTERN'))) return 'pattern_invalid';
  return 'config_invalid';
}

const operatorName = /^[a-z_][a-z0-9_.-]{0,31}$/;

/**
 * Who ran the command, for the audit row: the user behind `sudo` (`SUDO_USER`), else the login
 * user, as `cli:<name>`; `cli:unknown` when neither is a plain user name.
 */
function operatorSource(env: Environment): string {
  const candidates = [env['SUDO_USER'], env['USER'], env['LOGNAME']];
  try {
    candidates.push(userInfo().username);
  } catch {
    // No passwd entry for this uid: the environment's names are all there is.
  }
  const name = candidates.find((candidate) => candidate !== undefined && operatorName.test(candidate));
  return `cli:${name ?? 'unknown'}`;
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
      pattern: config.pattern,
      world: config.world,
      operatorSource: operatorSource(env),
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
