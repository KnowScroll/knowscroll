import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import {
  ConfigurationError,
  commitForDiagnostics,
  readContentOperatorConfig,
  readOperatorConfig,
  worldForDiagnostics,
  type Environment,
} from '@knowscroll/backend/infrastructure/config';
import { createEventLog, type LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { OPERATOR_WORLDS } from '@knowscroll/backend/modules/identity';
import { importEditorialScrollUseCase } from './modules/content.js';
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
 *
 * The same command admits the authored starter Scroll (D-005, S1.6):
 *
 *   node dist/operator.js content import-editorial --file <path>
 *
 * `<path>` is an `editorial-scroll.v1` JSON file; the release tree carries the starter at
 * `node_modules/@knowscroll/backend/dist/modules/content/starter/`. Allowed only in the same
 * allow-listed worlds (`dev`, `stage`, `ci`, `local`), with that world's `DATABASE_URL`. The source
 * is compiled and admitted through scroll-model's admission path; importing the same file again is
 * a no-op (same revision), a changed file makes a new revision. Prints one JSON line on stdout
 * (`outcome`, `assetId`, `revision`, `documentSha256`, `path`) and one
 * `content.scroll_admitted` record on stderr; a refusal prints its stage and issue codes and paths
 * (never source text) on stderr. Exit 0 admitted or unchanged, 1 refused or failed, 2 usage.
 */
const usage =
  'usage: node dist/operator.js issue-sign-in --email <address>\n' +
  '       node dist/operator.js content import-editorial --file <path>\n';

/** The largest editorial source file the command reads (the document limit is 128 KiB). */
const MAX_SOURCE_BYTES = 1_048_576;

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

/** Reads and parses the editorial source file; a refusal carries a code, never the file's text. */
function readSourceFile(path: string): { readonly source: unknown } | { readonly code: string } {
  try {
    if (statSync(path).size > MAX_SOURCE_BYTES) return { code: 'source_too_large' };
    return { source: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (error) {
    return { code: error instanceof SyntaxError ? 'source_not_json' : 'source_unreadable' };
  }
}

/**
 * `content import-editorial --file <path>`: admits an authored editorial Scroll (D-005). Refused
 * before touching the database outside the allow-listed worlds.
 */
async function importEditorial(env: Environment, logEvent: LogEvent, file: string): Promise<number> {
  let config;
  try {
    config = readContentOperatorConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    logEvent('config.invalid', { problems: error.problems });
    logEvent('content.scroll_admitted', {
      severity: 'warn',
      outcome: 'refused',
      reasonCode: error.problems.some((problem) => problem.startsWith('KS_WORLD: operator_command_refused'))
        ? 'refused_in_this_world'
        : 'config_invalid',
    });
    return 1;
  }
  const read = readSourceFile(file);
  if ('code' in read) {
    logEvent('content.scroll_admitted', { severity: 'warn', outcome: 'refused', reasonCode: read.code });
    return 1;
  }
  const database = createDatabase<Database>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
  });
  try {
    const result = await importEditorialScrollUseCase(database.db)(read.source);
    if (result.kind === 'refused') {
      logEvent('content.scroll_admitted', { severity: 'warn', outcome: 'refused', reasonCode: result.reason });
      // Stable codes and paths only: the operator can find the problem without the source's text.
      process.stderr.write(`${JSON.stringify({ stage: result.stage ?? null, issues: result.issues.slice(0, 32) })}\n`);
      return 1;
    }
    logEvent('content.scroll_admitted', { severity: 'info', outcome: result.outcome });
    process.stdout.write(
      `${JSON.stringify({
        outcome: result.outcome,
        assetId: result.assetId,
        revision: result.revision,
        documentSha256: result.documentSha256,
        path: `/scroll/${result.assetId}`,
      })}\n`,
    );
    return 0;
  } finally {
    await database.close();
  }
}

async function run(env: Environment, logEvent: LogEvent): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: { email: { type: 'string' }, file: { type: 'string' } },
    });
  } catch {
    process.stderr.write(usage);
    return 2;
  }
  if (
    parsed.positionals.length === 2 &&
    parsed.positionals[0] === 'content' &&
    parsed.positionals[1] === 'import-editorial' &&
    parsed.values.file !== undefined &&
    parsed.values.email === undefined
  ) {
    return importEditorial(env, logEvent, parsed.values.file);
  }
  if (
    parsed.positionals.length !== 1 ||
    parsed.positionals[0] !== 'issue-sign-in' ||
    parsed.values.email === undefined ||
    parsed.values.file !== undefined
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
