import { ConfigurationError, readWorkerOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeCatalogue } from '@knowscroll/backend/modules/content/nest-providers';
import { evidenceRebuildInterestRollups } from '@knowscroll/backend/modules/evidence/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const DEFAULT_UNIVERSES = 1000;
const MAX_UNIVERSES = 5000;
const LOCK_TIMEOUT_MS = 5000;
const USAGE = 'usage: operator.js evidence rebuild-interest-rollups [--max-universes <1-5000>]';

export interface RebuildInterestRollupsOptions {
  readonly maxUniverses: string | undefined;
}

/**
 * `evidence rebuild-interest-rollups [--max-universes <1-5000>]` (#674, D-420): builds every person's system and person interest
 * roll-ups from their topic rows, stamps what each topic row was counted as, and fills the `log_weight` of rows no writer has touched
 * since migration 0117. Run it once after the deploy that applies 0117 and before a world sets `KS_COMPOSER_POLICY=v3`, and again
 * after any rollback to a binary that does not write roll-ups (docs/v2/operations/environments.md). Each person is one transaction
 * under their own personal scope, so it never runs beside that person's projection; it is idempotent, so it can be stopped and run
 * again. It stops after `--max-universes` (default 1000) and says whether the scan finished. Prints counts only: no person, universe
 * or topic. Writes derived rows and nothing else; no model, no network. Exit 0 done, 2 bad usage, 1 failure.
 */
export async function rebuildInterestRollupsCommand(
  options: RebuildInterestRollupsOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const maxUniverses = options.maxUniverses === undefined ? DEFAULT_UNIVERSES : Number(options.maxUniverses);
  if (!Number.isInteger(maxUniverses) || maxUniverses < 1 || maxUniverses > MAX_UNIVERSES) {
    print({ result: 'usage', usage: USAGE });
    return 2;
  }
  try {
    const config = readWorkerOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: LOCK_TIMEOUT_MS });
      const result = await evidenceRebuildInterestRollups(
        database.db,
        withPersonalScope,
        makeCatalogue(database.db),
      )({ maxUniverses });
      logEvent('operator.read', {
        route: '/cli/evidence/rebuild-interest-rollups',
        outcome: result.complete ? 'done' : 'partial',
        count: result.rebuilt,
      });
      print({ command: 'evidence rebuild-interest-rollups', maxUniverses, ...result });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'evidence_rebuild_interest_rollups_failed', error });
    return 1;
  }
}
