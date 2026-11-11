import { parseArgs } from 'node:util';
import { ConfigurationError, readWorkerOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { reconcileCoverageDirty } from '@knowscroll/backend/modules/personal-context/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export const RECONCILE_USAGE =
  'usage: operator.js geography reconcile-coverage [--universe <uuid>] [--unit <explanationUnitId>]... [--dry-run]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `geography reconcile-coverage [--universe <uuid>] [--unit <id>]... [--dry-run]` (#674, D-416): the one-time pass for readers
 * who read before dirty tracking existed. With `--unit` only the topics holding a key of those explanation units are marked,
 * and a row waiting out a backoff is made eligible at once: what Content trusts changed for them. It marks every topic that has a support key dirty, for one universe or for all, so the
 * Cartographer's next runs read each topic once, newest first, in paced batches. It reads no support, calls no model and
 * starts no run; running it twice marks nothing new. It prints one JSON line of counts only. Exit 0 done, 2 bad usage,
 * 1 failure.
 */
export async function reconcileCoverageCommand(
  argv: readonly string[],
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      options: {
        universe: { type: 'string' },
        unit: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage: RECONCILE_USAGE });
    return 2;
  }
  const universe = args.values.universe?.toLowerCase();
  if (
    args.positionals.length !== 2 ||
    args.positionals[0] !== 'geography' ||
    args.positionals[1] !== 'reconcile-coverage' ||
    (universe !== undefined && !UUID.test(universe))
  ) {
    print({ result: 'usage', usage: RECONCILE_USAGE });
    return 2;
  }
  try {
    const config = readWorkerOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const dryRun = args.values['dry-run'] === true;
      const result = await reconcileCoverageDirty(database.db, {
        ...(universe === undefined ? {} : { universeId: universe }),
        ...(args.values.unit?.length ? { units: args.values.unit } : {}),
        dryRun,
      });
      print({ command: 'geography reconcile-coverage', result: dryRun ? 'would_mark' : 'marked', ...result });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'reconcile_coverage_failed', error });
    return 1;
  }
}
