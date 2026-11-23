import { sql, type Kysely, type Transaction } from 'kysely';
import { explorationStores } from '@knowscroll/backend/erasure-registry';
import type { ModuleRemovalReport, OldScrollRemoval, RemovalCount } from '@knowscroll/backend/infrastructure/erasure';
import { withTransaction, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  contentOldScrollRemoval,
  prepareOldScrolls,
  withdrawOldAssets,
  withOldScrollCleanupLock,
} from '@knowscroll/backend/modules/content/nest-providers';
import { experienceOldScrollRemoval } from '@knowscroll/backend/modules/experience/nest-providers';
import { feedbackOldScrollRemoval } from '@knowscroll/backend/modules/feedback/nest-providers';
import { roomsOldScrollRemoval } from '@knowscroll/backend/modules/rooms/nest-providers';
import { scenariosOldScrollRemoval } from '@knowscroll/backend/modules/scenarios/nest-providers';
import { socialOldScrollRemoval } from '@knowscroll/backend/modules/social/nest-providers';
import { clearEveryAccount, type ClearOutcome } from './old-scroll-cleanup-clear.js';

/** The worlds the cleanup runs in. Stage and production are refused until the owner says go, in another change. */
export const CLEANUP_WORLDS: readonly string[] = ['local', 'ci', 'dev'];

/**
 * The modules' parts, in the order they run. A row that points at a revision is removed or closed before the row it points at:
 * Rooms and the branches first, then Social (a thread's messages and the conversation), then the Keeps and the reports, and
 * Content last (coverage, review, revisions, assets), because every foreign key to a Scroll is `on delete restrict`.
 */
const REMOVALS: readonly OldScrollRemoval[] = [
  roomsOldScrollRemoval,
  scenariosOldScrollRemoval,
  socialOldScrollRemoval,
  experienceOldScrollRemoval,
  feedbackOldScrollRemoval,
  contentOldScrollRemoval,
];

export type CleanupMode = 'dry_run' | 'run';

interface TableRows extends RemovalCount {
  readonly module: string;
}

/** What one account loses (ids and counts only): the rows Clear erases, by module, and the Keeps of removed Scrolls. */
interface AccountLoss {
  readonly accountId: string;
  /** False when Clear refuses the account now (suspended or being deleted): a run stops before it removes anything. */
  readonly clearable: boolean;
  readonly clearRows: number;
  readonly clearRowsByModule: Readonly<Record<string, number>>;
  readonly keepsRemoved: number;
}

/** The summary both modes print. In a dry run every number is counted on the rows as they stand; in a run it is what was done. */
export interface CleanupSummary {
  readonly command: 'content cleanup-old-scrolls';
  readonly mode: CleanupMode;
  readonly world: string;
  readonly result: 'planned' | 'done' | 'nothing_to_do' | 'refused' | 'failed';
  readonly code?: string;
  readonly [key: string]: unknown;
}

interface Plan {
  readonly reports: Readonly<Record<string, ModuleRemovalReport>>;
  readonly accounts: readonly AccountLoss[];
  readonly clearRowsByTable: Readonly<Record<string, number>>;
}

const tablesOf = (reports: Readonly<Record<string, ModuleRemovalReport>>): TableRows[] =>
  REMOVALS.flatMap((removal) =>
    (reports[removal.module]?.tables ?? []).map((count) => ({ module: removal.module, ...count })),
  );

/** The tables Clear erases (it keeps the others), each keyed by universe. */
const clearedTables = (): string[] =>
  explorationStores.flatMap((owner) =>
    owner.tables
      .filter((table) => owner.clearExploration?.dispositions[`${table.schema}.${table.table}`] === 'erase')
      .map((table) => `${table.schema}.${table.table}`),
  );

async function accountLosses(
  trx: Transaction<Database>,
  keeps: ReadonlyMap<string, number>,
): Promise<{ accounts: AccountLoss[]; byTable: Record<string, number> }> {
  const universes = await sql<{ universeId: string; accountId: string; clearable: boolean }>`
    select universe.id::text as "universeId", universe.account_id::text as "accountId",
      (universe.status = 'active' and account.status = 'active') as clearable
    from identity.universes universe join identity.accounts account on account.id = universe.account_id
    order by universe.account_id`.execute(trx);
  const rowsOf = new Map<string, Map<string, number>>();
  const byTable: Record<string, number> = {};
  for (const table of clearedTables()) {
    const counted = await sql<{ universeId: string; n: string }>`
      select universe_id::text as "universeId", count(*)::text as n from ${sql.table(table)} group by 1`.execute(trx);
    for (const row of counted.rows) {
      const module = table.slice(0, table.indexOf('.'));
      const perModule = rowsOf.get(row.universeId) ?? new Map<string, number>();
      perModule.set(module, (perModule.get(module) ?? 0) + Number(row.n));
      rowsOf.set(row.universeId, perModule);
      byTable[table] = (byTable[table] ?? 0) + Number(row.n);
    }
  }
  const accounts = universes.rows.map((universe): AccountLoss => {
    const perModule = rowsOf.get(universe.universeId) ?? new Map<string, number>();
    const byModule = Object.fromEntries([...perModule].sort(([left], [right]) => (left < right ? -1 : 1)));
    return {
      accountId: universe.accountId,
      clearable: universe.clearable,
      clearRows: [...perModule.values()].reduce((sum, n) => sum + n, 0),
      clearRowsByModule: byModule,
      keepsRemoved: keeps.get(universe.universeId) ?? 0,
    };
  });
  return { accounts, byTable };
}

/** Thrown to end the planning transaction by rolling it back; carries what it counted. */
class PlanDone extends Error {
  constructor(readonly plan: Plan) {
    super('PLAN_DONE');
  }
}

/**
 * Counts everything the cleanup would do, on one consistent snapshot. It only reads (and writes the temporary table of the old
 * revisions, which ends with the transaction), and it always rolls back.
 */
async function plan(db: Kysely<Database>): Promise<Plan> {
  try {
    await withTransaction(db, 'old-scroll-cleanup-plan', async (trx) => {
      await sql`set transaction isolation level repeatable read`.execute(trx);
      await prepareOldScrolls(trx);
      const reports: Record<string, ModuleRemovalReport> = {};
      for (const removal of REMOVALS) reports[removal.module] = await removal.count(trx);
      const keepRows = (reports['experience']?.detail?.['keepsByUniverse'] ?? []) as {
        universeId: string;
        keeps: number;
      }[];
      const { accounts, byTable } = await accountLosses(
        trx,
        new Map(keepRows.map((row) => [row.universeId, row.keeps])),
      );
      throw new PlanDone({ reports, accounts, clearRowsByTable: byTable });
    });
  } catch (error) {
    if (error instanceof PlanDone) return error.plan;
    throw error;
  }
  throw new Error('PLAN_NOT_ROLLED_BACK');
}

function summaryOf(
  mode: CleanupMode,
  world: string,
  result: CleanupSummary['result'],
  reports: Readonly<Record<string, ModuleRemovalReport>>,
  accounts: readonly AccountLoss[],
  clearRowsByTable: Readonly<Record<string, number>>,
  extra: Readonly<Record<string, unknown>> = {},
): CleanupSummary {
  return {
    command: 'content cleanup-old-scrolls',
    mode,
    world,
    result,
    assets: reports['content']?.detail ?? {},
    accounts,
    clearRowsByTable,
    threads: reports['social']?.detail?.['conversations'] ?? [],
    branches: reports['scenarios']?.detail?.['branches'] ?? [],
    rooms: reports['rooms']?.detail ?? {},
    tables: tablesOf(reports),
    ...extra,
  };
}

/** A database error reduced to what is safe to print: the SQLSTATE and the names of the constraint and table, never a value. */
function failureOf(error: unknown): Readonly<Record<string, unknown>> {
  const fields = error as { code?: unknown; constraint?: unknown; table?: unknown; message?: unknown };
  return {
    code: typeof fields.code === 'string' ? fields.code : 'error',
    ...(typeof fields.constraint === 'string' ? { constraint: fields.constraint } : {}),
    ...(typeof fields.table === 'string' ? { table: fields.table } : {}),
    ...(typeof fields.message === 'string' && fields.message.startsWith('OLD_SCROLL_')
      ? { reason: fields.message }
      : {}),
  };
}

/**
 * Removes every v1 and v2 Scroll from the database `db`, and everything that points at them, keeping the accounts, the document v3
 * Scrolls and the Reels (`content cleanup-old-scrolls`, #791, D-437). `dry_run` counts and changes nothing. `run`:
 *
 * 1. Withdraws the assets that go whole, in one short transaction, so no one opens one and no job writes about it while the rest
 *    runs. (Stop the worker first anyway: `docs/v2/operations/scroll-cleanup.md`.)
 * 2. Clears the exploration history of every account with the product's own Clear, one account at a time in its own transaction,
 *    because the foreign keys from a person's readings to a Scroll are `restrict` and nothing existing subtracts a removed reading
 *    from the totals derived from it.
 * 3. Removes and closes everything else in ONE transaction, the modules' parts in the order of `REMOVALS`, ending at the assets, so
 *    the shared content is either all removed or untouched. It takes the guard exemption of migration 0125 for the coverage and risk
 *    rows only, inside that transaction.
 *
 * Refuses outside `CLEANUP_WORLDS` before opening any connection work, and while another cleanup runs. Idempotent: it counts first
 * and, finding nothing to remove, clears nobody and changes nothing. A failure in 3 rolls it back whole; a failure in 2 leaves some
 * accounts cleared, which is safe to repeat.
 */
export async function cleanupOldScrolls(
  db: Kysely<Database>,
  options: { readonly mode: CleanupMode; readonly world: string },
): Promise<CleanupSummary> {
  const { mode, world } = options;
  if (!CLEANUP_WORLDS.includes(world))
    return { command: 'content cleanup-old-scrolls', mode, world, result: 'refused', code: 'world_not_allowed' };
  const outcome = await withOldScrollCleanupLock(db, async (): Promise<CleanupSummary> => {
    const planned = await plan(db);
    const nothing = !tablesOf(planned.reports).some((table) => table.rows > 0);
    if (nothing || mode === 'dry_run')
      return summaryOf(
        mode,
        world,
        nothing ? 'nothing_to_do' : 'planned',
        planned.reports,
        planned.accounts,
        planned.clearRowsByTable,
      );
    return run(db, world, planned);
  });
  return (
    outcome ?? {
      command: 'content cleanup-old-scrolls',
      mode,
      world,
      result: 'refused',
      code: 'cleanup_already_running',
    }
  );
}

async function run(db: Kysely<Database>, world: string, planned: Plan): Promise<CleanupSummary> {
  const withdrawn = await withTransaction(db, 'old-scroll-cleanup-withdraw', async (trx) => {
    await prepareOldScrolls(trx);
    return withdrawOldAssets(trx);
  });
  let outcomes: readonly ClearOutcome[];
  try {
    outcomes = await clearEveryAccount(db);
  } catch (error) {
    return summaryOf('run', world, 'failed', planned.reports, planned.accounts, planned.clearRowsByTable, {
      ...failureOf(error),
      phase: 'clear',
      withdrawnAssets: withdrawn,
      note: 'Some accounts may be cleared and none of the removal has started. A Clear in flight is finished by the next run.',
    });
  }
  const refused = outcomes.filter((outcome) => outcome.outcome === 'refused');
  if (refused.length > 0)
    return summaryOf('run', world, 'failed', planned.reports, planned.accounts, planned.clearRowsByTable, {
      code: 'clear_incomplete',
      withdrawnAssets: withdrawn,
      accountsNotCleared: refused,
    });
  const reports: Record<string, ModuleRemovalReport> = {};
  try {
    await withTransaction(db, 'old-scroll-cleanup-remove', async (trx) => {
      await sql`select set_config('lock_timeout', '15s', true), set_config('statement_timeout', '300s', true)`.execute(
        trx,
      );
      await prepareOldScrolls(trx);
      for (const removal of REMOVALS) reports[removal.module] = await removal.run(trx);
    });
  } catch (error) {
    return summaryOf('run', world, 'failed', planned.reports, planned.accounts, planned.clearRowsByTable, {
      ...failureOf(error),
      phase: 'remove',
      withdrawnAssets: withdrawn,
      accountsCleared: outcomes.length,
      note: 'Nothing was removed: the transaction rolled back. The accounts are cleared and the assets withdrawn; the cleanup can be repeated.',
    });
  }
  return summaryOf('run', world, 'done', reports, planned.accounts, planned.clearRowsByTable, {
    withdrawnAssets: withdrawn,
    accountsCleared: outcomes.length,
  });
}
