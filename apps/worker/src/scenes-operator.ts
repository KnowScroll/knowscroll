import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { sendBackfillLooks } from '@knowscroll/backend/modules/scenes/nest-providers';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * `scenes backfill-looks [--dry-run] [--limit <n>]`: gives worlds that were projected before looks
 * existed their look (D-102). It sends one `scenes.backfill-looks` job for each universe that has a
 * projected system, planet or region without a look, at most `--limit` (default 100) per run, and
 * prints how many it found and queued and whether more are left. The worker assigns the looks under each
 * universe's lock. No slot, seed, family or anchor moves, no provider is called, and running it again
 * is harmless: a world with all its looks is no longer found. Shared database and pg-boss only; names
 * only universe IDs and epochs in its jobs.
 */
export async function backfillLooksCommand(
  options: { readonly dryRun: boolean; readonly limit: string | undefined },
  print: (result: Record<string, unknown>) => void,
  logEvent: LogEvent,
): Promise<number> {
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    print({ result: 'usage', usage: 'scenes backfill-looks [--dry-run] [--limit <1-1000>]' });
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
        const sent = await sendBackfillLooks(database.db, boss, { dryRun: options.dryRun, limit });
        print({ command: 'scenes backfill-looks', dryRun: options.dryRun, ...sent });
        return 0;
      } finally {
        await boss.stop({ graceful: true, timeout: 5000 });
      }
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'scenes_backfill_looks_failed', error });
    return 1;
  }
}
