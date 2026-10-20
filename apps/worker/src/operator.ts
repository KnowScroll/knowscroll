import { parseArgs } from 'node:util';
import {
  ConfigurationError,
  commitForDiagnostics,
  readWorkerOperatorConfig,
  worldForDiagnostics,
} from '@knowscroll/backend/infrastructure/config';
import { createEventLog } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { reasoningOperatorFor } from '@knowscroll/backend/reasoning/nest-providers';

/**
 * `node dist/operator.js <area> <command> [options]`: operator commands of the worker release,
 * run from a server shell with the world's environment (`KS_WORLD`, `DATABASE_URL`). Results are
 * one JSON line on stdout; diagnostics (typed `logEvent` records) go to stderr.
 *
 *   reasoning write-off --attempt <uuid> --reason <text>   unknown → written_off, reason recorded
 *   reasoning unknown [--limit <n>]                        attempts awaiting reconciliation
 *   reasoning purge-expired                                delete expired protected requests
 *
 * Exit status: 0 done, 2 refused or not applicable (bad usage, not unknown, missing), 1 failure.
 * MiniMax offers no request lookup: an `unknown` attempt is never resent; a write-off records the
 * unresolved liability and its reason, and does not prove that the provider stopped work.
 */
const usage =
  'usage: operator.js reasoning write-off --attempt <uuid> --reason <text> | reasoning unknown [--limit <n>] | reasoning purge-expired';

function print(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<number> {
  const logEvent = createEventLog({
    service: 'operator',
    environment: worldForDiagnostics(process.env),
    revision: commitForDiagnostics(process.env),
    destination: process.stderr,
  });
  let args;
  try {
    args = parseArgs({
      args: process.argv.slice(2),
      options: { attempt: { type: 'string' }, reason: { type: 'string' }, limit: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage });
    return 2;
  }
  const [area, command] = args.positionals;
  const known =
    area === 'reasoning' && (command === 'write-off' || command === 'unknown' || command === 'purge-expired');
  if (!known || args.positionals.length !== 2) {
    print({ result: 'usage', usage });
    return 2;
  }
  let config;
  try {
    config = readWorkerOperatorConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.start_failed', { reasonCode: 'config_failed', error });
    return 1;
  }
  const database = createDatabase<Database>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
  });
  const operator = reasoningOperatorFor(database.db, logEvent);
  try {
    switch (command) {
      case 'write-off': {
        if (args.values.attempt === undefined || args.values.reason === undefined) {
          print({ result: 'usage', usage });
          return 2;
        }
        const result = await operator.writeOff(args.values.attempt, args.values.reason);
        print({ command: 'reasoning write-off', result: result.kind, ...result });
        return result.kind === 'written_off' ? 0 : 2;
      }
      case 'unknown': {
        const limit = args.values.limit === undefined ? 50 : Number(args.values.limit);
        if (!Number.isInteger(limit) || limit < 1) {
          print({ result: 'usage', usage });
          return 2;
        }
        const attempts = await operator.listUnknown(limit);
        print({
          command: 'reasoning unknown',
          result: 'listed',
          attempts: attempts.map((attempt) => ({
            ...attempt,
            dispatchedAt: attempt.dispatchedAt === null ? null : attempt.dispatchedAt.toISOString(),
          })),
        });
        return 0;
      }
      case 'purge-expired': {
        print({ command: 'reasoning purge-expired', result: 'purged', count: await operator.purgeExpired() });
        return 0;
      }
    }
  } catch (error) {
    logEvent('process.crashed', { reasonCode: 'operator_failed', error });
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
