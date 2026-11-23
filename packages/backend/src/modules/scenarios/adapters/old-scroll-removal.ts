import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  countSteps,
  namesOldRevision,
  runSteps,
  type ModuleRemovalReport,
  type OldScrollRemoval,
  type RemovalStep,
} from '../../../infrastructure/erasure/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';

/**
 * What the branches (What if and Another perspective) do when the Scrolls of the retired document formats leave the database
 * (`content cleanup-old-scrolls`, #791, D-437). Content has written the old revisions to its temporary table first.
 *
 * - A branch in a thread rooted at an old revision goes with the thread, which Social removes after this.
 * - A branch of a thread that stays whose own Scroll is old is closed the way the product closes one (`removeNode`): status
 *   `removed`, the revision counter up by one, the short answer cleared, and the pointer to the revision let go, because the
 *   revision is about to be deleted and a ready card cannot outlive it. The card is then a bare placeholder for every member,
 *   which is what the thread list already draws for a removed branch. The asset id it was given stays on the row.
 *
 * Drafts are not touched here: they are a person's own composer sessions and Clear deletes every one of them first.
 */
const inRemovedThread = (column: string): RawBuilder<boolean> =>
  sql<boolean>`${sql.ref(column)} in (select link.thread_id from social.content_threads link
    where ${namesOldRevision('link', 'root_asset_id', 'root_asset_revision')})`;

const ownScrollIsOld = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${sql.ref(`${alias}.asset_revision`)} is not null and ${namesOldRevision(alias, 'asset_id', 'asset_revision')})`;

function scenarioSteps(): readonly RemovalStep[] {
  const closed = sql<boolean>`${ownScrollIsOld('t')} and not ${inRemovedThread('t.thread_id')}`;
  return [
    {
      table: 'scenarios.nodes',
      action: 'close',
      where: closed,
      run: sql`update scenarios.nodes t set status = 'removed', revision = t.revision + 1, updated_at = now(),
          asset_revision = null, answer_state = null, answer = null, answer_settled_at = null
        where ${closed}`,
    },
    { table: 'scenarios.nodes', action: 'delete', label: 'in a removed thread', where: inRemovedThread('t.thread_id') },
  ];
}

/** Branches by what becomes of them, ids only. */
async function describe(trx: Transaction<Database>): Promise<Readonly<Record<string, unknown>>> {
  const rows = await sql<{ kind: string; status: string; fate: string; n: string }>`
    select t.kind, t.status, case when ${inRemovedThread('t.thread_id')} then 'removed with its thread' else 'closed' end as fate,
      count(*)::text as n
    from scenarios.nodes t
    where ${inRemovedThread('t.thread_id')} or ${ownScrollIsOld('t')}
    group by 1, 2, 3 order by 1, 2, 3`.execute(trx);
  return {
    branches: rows.rows.map((row) => ({ kind: row.kind, status: row.status, fate: row.fate, branches: Number(row.n) })),
  };
}

/** Scenarios' part of the cleanup. */
export const scenariosOldScrollRemoval: OldScrollRemoval = {
  module: 'scenarios',
  async count(trx): Promise<ModuleRemovalReport> {
    return { tables: await countSteps(trx, scenarioSteps()), detail: await describe(trx) };
  },
  async run(trx): Promise<ModuleRemovalReport> {
    const detail = await describe(trx);
    return { tables: await runSteps(trx, scenarioSteps()), detail };
  },
};
