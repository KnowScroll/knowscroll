import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { recoverOpenDemand } from '@knowscroll/backend/modules/supply/nest-providers';

/**
 * `supply recover-open-demand [--dry-run]`: the one-time recovery for asks that were left open before
 * Create existed. It sends one resolver job for every open ask (waiting to be matched or produced) and
 * prints how many it found by state, queued and already queued. Running it again is harmless: the job
 * for a request has a stable ID. The jobs do the work in a worker; nothing is produced or bound here, and
 * no provider is called. Shared database and pg-boss only; names no personal data.
 */
export async function recoverOpenDemandCommand(
  options: { readonly dryRun: boolean },
  print: (result: Record<string, unknown>) => void,
  logEvent: LogEvent,
): Promise<number> {
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const boss = createBoss(config.database, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const recovered = await recoverOpenDemand(database.db, boss, options);
        print({ command: 'supply recover-open-demand', dryRun: options.dryRun, ...recovered });
        return 0;
      } finally {
        await boss.stop({ graceful: true, timeout: 5000 });
      }
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'recover_open_demand_failed', error });
    return 1;
  }
}
