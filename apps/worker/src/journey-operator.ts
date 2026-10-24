import { parseArgs } from 'node:util';
import { ConfigurationError, readWorkerOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { accountUniverseReaderFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { renderJourney } from '@knowscroll/backend/modules/operator';
import { readJourneyFor } from '@knowscroll/backend/modules/operator/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const usage =
  'usage: operator.js journey <id> [--json] | operator.js journey --account <accountId> [--json]   (id: request, production run, Reel order, model attempt, reasoning run, exposure, asset or universe)';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `journey <id>` and `journey --account <accountId>`: one record's journey across modules, from the
 * allowlisted `ops` views (D-044). Read-only; prints a timeline (or one JSON line with `--json`) and
 * names no text, address or score. An account is resolved to its universe through Identity, which is
 * the separate authorised step blueprint §26 asks for: this command runs only from the server shell.
 * Exit 0 found, 2 not found or bad usage, 1 failure.
 */
export async function journeyCommand(argv: readonly string[], print: Print, logEvent: LogEvent): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      options: { account: { type: 'string' }, json: { type: 'boolean', default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage });
    return 2;
  }
  const [id] = args.positionals;
  const account = args.values.account;
  const hasOneTarget = (id === undefined) !== (account === undefined) && args.positionals.length <= 1;
  const target = account ?? id;
  if (!hasOneTarget || target === undefined || !UUID.test(target)) {
    print({ result: 'usage', usage });
    return 2;
  }
  try {
    const config = readWorkerOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      let journeyId = target;
      if (account !== undefined) {
        const found = await accountUniverseReaderFor(database.db)(account);
        if (found === undefined) {
          print({ command: 'journey', result: 'not_found' });
          return 2;
        }
        journeyId = found.universeId;
      }
      const outcome = await readJourneyFor(database.db)(journeyId);
      logEvent('operator.read', {
        route: 'cli.journey',
        outcome: outcome.kind,
        ...(outcome.kind === 'found' ? { count: outcome.journey.steps.length } : {}),
      });
      if (outcome.kind === 'not_found') {
        print({ command: 'journey', result: 'not_found' });
        return 2;
      }
      if (args.values.json) print({ command: 'journey', result: 'found', journey: outcome.journey });
      else process.stdout.write(`${renderJourney(outcome.journey)}\n`);
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'journey_failed', error });
    return 1;
  }
}
