import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { expireStalePlannedDemand, recoverOpenDemand } from '@knowscroll/backend/modules/supply/nest-providers';

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

const EXPIRE_DEFAULT_LIMIT = 100;
const EXPIRE_MAX_LIMIT = 1000;

/**
 * `supply expire-stale-planned-demand [--dry-run] [--limit <1-1000>]`: the bounded recovery for the Planner's demand
 * that lost its resolver. It sends one resolver job for each planned demand still `deferred` well past the wait limit,
 * oldest first, at most `--limit` (default 100) per run, and prints how many it found, queued and already queued, and
 * whether more remain. The jobs close each demand in a worker under the person's own scope; nothing is produced or
 * bound here, and no provider is called. A second run on the same day sends nothing new. Names no personal data.
 */
export async function expireStalePlannedDemandCommand(
  options: { readonly dryRun: boolean; readonly limit: string | undefined },
  print: (result: Record<string, unknown>) => void,
  logEvent: LogEvent,
): Promise<number> {
  const limit = options.limit === undefined ? EXPIRE_DEFAULT_LIMIT : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPIRE_MAX_LIMIT) {
    print({ result: 'usage', usage: 'supply expire-stale-planned-demand [--dry-run] [--limit <1-1000>]' });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const boss = createBoss(config.database, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const expired = await expireStalePlannedDemand(database.db, boss, { dryRun: options.dryRun, limit });
        print({ command: 'supply expire-stale-planned-demand', dryRun: options.dryRun, limit, ...expired });
        return 0;
      } finally {
        await boss.stop({ graceful: true, timeout: 5000 });
      }
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'expire_stale_planned_demand_failed', error });
    return 1;
  }
}
