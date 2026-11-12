import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  expireStalePlannedDemand,
  readGapSummary,
  recoverOpenDemand,
  settleBlockedGap,
} from '@knowscroll/backend/modules/supply/nest-providers';
import { GAP_STATUSES, type GapStatus } from '@knowscroll/backend/modules/supply';

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

const USAGE_GAPS = `supply gaps [--status ${GAP_STATUSES.join('|')}]`;

/**
 * `supply gaps [--status <status>]`: the gaps the loop found in the library (#674, D-414), read from the operator's view
 * (`ops.supply_gaps`): counts by status and kind, then the gaps, most pressing first, with their planet, facet, priority, readers,
 * attempts and reason code. Codes, catalogue ids and counts only: no recipe text and no person. Read-only; no provider is called.
 */
export async function supplyGapsCommand(
  options: { readonly status: string | undefined },
  print: (result: Record<string, unknown>) => void,
  logEvent: LogEvent,
): Promise<number> {
  const status = GAP_STATUSES.find((candidate): candidate is GapStatus => candidate === options.status);
  if (options.status !== undefined && status === undefined) {
    print({ result: 'usage', usage: USAGE_GAPS });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const summary = await readGapSummary(database.db, status === undefined ? {} : { status });
      print({ command: 'supply gaps', ...(status === undefined ? {} : { status }), ...summary });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'supply_gaps_failed', error });
    return 1;
  }
}

const USAGE_SETTLE = 'supply gaps settle --key <64 hex characters> [--reopen | --close]';

/**
 * `supply gaps settle --key <hex> [--reopen | --close]` (#674, D-414): an operator's decision about a gap that an attempt of unknown outcome blocked.
 * It acts only after that attempt has been settled in the ledger (written off or reconciled with `reasoning write-off` and its kin), and says why
 * when it refuses: the gap is not blocked, names no run, or an attempt of its run is still reserved, dispatched or unknown. `--reopen` makes the gap
 * `open` again (the blocked attempt counts as a failed one, so the next request is a new one), `--close` ends it; with neither it only says whether the ledger
 * is settled. No model and no provider. Exit status: 0 done or settled, 2 refused or bad usage, 1 a failure.
 */
export async function settleGapCommand(
  options: { readonly key: string | undefined; readonly reopen: boolean; readonly close: boolean },
  print: (result: Record<string, unknown>) => void,
  logEvent: LogEvent,
): Promise<number> {
  if (options.key === undefined || !/^[0-9a-f]{64}$/u.test(options.key) || (options.reopen && options.close)) {
    print({ result: 'usage', usage: USAGE_SETTLE });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const action = options.reopen ? 'reopen' : options.close ? 'close' : undefined;
      const outcome = await settleBlockedGap(database.db, {
        key: options.key,
        ...(action === undefined ? {} : { action }),
      });
      print({ command: 'supply gaps settle', key: options.key, ...outcome });
      return outcome.kind === 'refused' || outcome.kind === 'not_found' ? 2 : 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'supply_gaps_settle_failed', error });
    return 1;
  }
}
