import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { Database } from '../postgres/database.js';

/**
 * The cleanup of the Scrolls of the retired document formats (`content cleanup-old-scrolls`, #791). Content decides which
 * revisions are old and writes them, once per transaction, to a temporary table of this name; every other module reads it
 * to remove or close what points at them, so the old set is decided in one place and each module still owns its own tables.
 *
 * Columns: `asset_id uuid`, `revision integer`, `whole_asset boolean` (true when every revision of the asset is old, so the
 * asset itself goes). The table lives until the transaction ends.
 */
export const OLD_SCROLL_REVISIONS = 'old_scroll_revisions';

/** SQL: the row of alias `alias` names an old revision, by its asset and revision columns. */
export const namesOldRevision = (alias: string, assetColumn: string, revisionColumn: string): RawBuilder<boolean> =>
  sql<boolean>`exists (select 1 from ${sql.table(OLD_SCROLL_REVISIONS)} old_revision
    where old_revision.asset_id = ${sql.ref(`${alias}.${assetColumn}`)}
      and old_revision.revision = ${sql.ref(`${alias}.${revisionColumn}`)})`;

/** SQL: the row names an asset that goes whole (every revision of it is old). */
export const namesRemovedAsset = (alias: string, assetColumn: string): RawBuilder<boolean> =>
  sql<boolean>`${sql.ref(`${alias}.${assetColumn}`)} in (
    select old_revision.asset_id from ${sql.table(OLD_SCROLL_REVISIONS)} old_revision where old_revision.whole_asset)`;

/** What one step does to its table. `tombstone` and `close` are updates that keep the row, with the words the owning module uses. */
export type RemovalAction = 'delete' | 'update' | 'tombstone' | 'close';

/**
 * One change to one table. `where` is a predicate over the table's alias `t` and decides which rows the step touches, in the
 * count and in the change alike, so a dry run and a run cannot disagree about a step. Without `run` the change is a delete.
 */
export interface RemovalStep {
  /** `schema.table`. */
  readonly table: string;
  readonly action: RemovalAction;
  /** A short label when one table has more than one step. */
  readonly label?: string;
  readonly where: RawBuilder<unknown>;
  /** The statement that makes the change, for an update; it must touch exactly the rows `where` selects. */
  readonly run?: RawBuilder<unknown>;
}

/** What a step touched (counted, or changed). */
export interface RemovalCount {
  readonly table: string;
  readonly action: RemovalAction;
  readonly label?: string;
  readonly rows: number;
}

/** What one module reports for the cleanup: its steps' counts in order, and facts the summary shows (ids only, never words). */
export interface ModuleRemovalReport {
  readonly tables: readonly RemovalCount[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * A module's part of the cleanup. `count` reads the rows as they stand and changes nothing. `run` changes them, inside the
 * cleanup's one transaction, and may rely on the old set being in `OLD_SCROLL_REVISIONS`. The two must agree: `run` reports
 * the rows it changed with the same steps `count` read.
 */
export interface OldScrollRemoval {
  readonly module: string;
  count(trx: Transaction<Database>): Promise<ModuleRemovalReport>;
  run(trx: Transaction<Database>): Promise<ModuleRemovalReport>;
}

const labelled = (step: RemovalStep) => ({
  table: step.table,
  action: step.action,
  ...(step.label ? { label: step.label } : {}),
});

/** Counts the rows each step would touch. Changes nothing. */
export async function countSteps(trx: Transaction<Database>, steps: readonly RemovalStep[]): Promise<RemovalCount[]> {
  const counts: RemovalCount[] = [];
  for (const step of steps) {
    const result = await sql<{
      n: string;
    }>`select count(*)::text as n from ${sql.table(step.table)} t where ${step.where}`.execute(trx);
    counts.push({ ...labelled(step), rows: Number(result.rows[0]?.n ?? 0) });
  }
  return counts;
}

/** Makes each step's change in order and reports the rows it touched. A step's `where` must still hold for the rows of the steps after it. */
export async function runSteps(trx: Transaction<Database>, steps: readonly RemovalStep[]): Promise<RemovalCount[]> {
  const counts: RemovalCount[] = [];
  for (const step of steps) {
    const statement = step.run ?? sql`delete from ${sql.table(step.table)} t where ${step.where}`;
    const result = await statement.execute(trx);
    counts.push({ ...labelled(step), rows: Number(result.numAffectedRows ?? 0) });
  }
  return counts;
}
