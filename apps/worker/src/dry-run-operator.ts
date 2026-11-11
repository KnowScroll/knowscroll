import { parseArgs } from 'node:util';
import { ConfigurationError, readDryRunOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { dryRunsFor } from './dry-run-wiring.js';

type Print = (result: Record<string, unknown>) => void;

export const DRY_RUN_USAGE =
  'usage: operator.js geography dry-run --universe <uuid> | operator.js planner dry-run --universe <uuid>';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `geography dry-run --universe <uuid>` and `planner dry-run --universe <uuid>` (#674, D-411): what one run of the
 * Cartographer or the Planner would do for one universe now, without doing it. Each enters the universe's personal
 * scope (the root lock a read takes) in a READ ONLY transaction that always rolls back, freezes the same context a real
 * run freezes, applies the same pure rules and calls no model; it writes no row and sends no job. It prints one JSON
 * line of counts and codes only: no label, title, topic, unit, reference or text, so the line is safe to paste into a
 * public issue. Needs only `KS_WORLD` and `DATABASE_URL` (and `KS_CARTOGRAPHER_ENABLED` / `KS_PLANNER_ENABLED`, to say
 * whether a real run would be switched off). Exit 0 read, 2 refused (bad usage, unknown or suspended universe), 1 failure.
 */
export async function dryRunCommand(argv: readonly string[], print: Print, logEvent: LogEvent): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      options: { universe: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage: DRY_RUN_USAGE });
    return 2;
  }
  const [area, command] = args.positionals;
  const universe = args.values.universe?.toLowerCase();
  if (
    (area !== 'geography' && area !== 'planner') ||
    command !== 'dry-run' ||
    args.positionals.length !== 2 ||
    universe === undefined ||
    !UUID.test(universe)
  ) {
    print({ result: 'usage', usage: DRY_RUN_USAGE });
    return 2;
  }
  try {
    const config = readDryRunOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const dryRuns = dryRunsFor(database.db, config, logEvent);
      const result = await (area === 'geography' ? dryRuns.geography : dryRuns.planner)(universe);
      logEvent('operator.read', { route: `/cli/${area}/dry-run`, outcome: result.kind });
      if (result.kind === 'refused') {
        print({ command: `${area} dry-run`, result: 'refused', reason: result.refusal });
        return 2;
      }
      print({ command: `${area} dry-run`, result: 'read', ...result.report });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'dry_run_failed', error });
    return 1;
  }
}
