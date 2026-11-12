import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { catalogueStatus, syncCatalogue } from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const CATALOGUE_USAGE = 'content catalogue sync [--dry-run] | content catalogue status';

/**
 * `content catalogue sync [--dry-run]` and `content catalogue status` (#674, D-419): the topic catalogue is data in Postgres,
 * released in numbered steps, and the library plan in TypeScript is its authoring source. `sync` imports the plan as the next
 * release (a topic added to the plan is a topic added with no deploy of the code that reads it) and makes servable the topics whose
 * supply has been released; `--dry-run` says what it would do and writes nothing. Running it twice makes one release. `status`
 * prints the current release and counts. Shared content only: no provider, no personal root, no network. Output is counts and
 * codes, never a label, meaning or reader.
 *
 * Exit status: 0 done, 2 refused (a change code did not admit; nothing was written) or bad usage, 1 a failure.
 */
export async function catalogueCommand(
  options: { readonly subcommand: string | undefined; readonly dryRun: boolean },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (options.subcommand !== 'sync' && options.subcommand !== 'status') {
    print({ result: 'usage', usage: CATALOGUE_USAGE });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      if (options.subcommand === 'status') {
        print({ command: 'content catalogue status', ...(await catalogueStatus(database.db)) });
        return 0;
      }
      const summary = await syncCatalogue(database.db, { dryRun: options.dryRun });
      print({ command: 'content catalogue sync', ...summary });
      return summary.plan === 'refused' ? 2 : 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'catalogue_command_failed', error });
    return 1;
  }
}
