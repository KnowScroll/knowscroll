import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { SCROLL_DOCUMENT_SCHEMA_VERSION, SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import {
  OLD_SCROLL_REVISIONS,
  countSteps,
  namesOldRevision,
  namesRemovedAsset,
  runSteps,
  type ModuleRemovalReport,
  type OldScrollRemoval,
  type RemovalCount,
  type RemovalStep,
} from '../../../infrastructure/erasure/index.js';
import { JOB_SCHEMA, deadLetterQueueName } from '../../../infrastructure/jobs/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withSessionLock } from '../../../infrastructure/postgres/session-lock.js';
import { produceAnswerQueue, produceScrollQueue } from '../production/events.js';
import { checkLibrarySupportQueue } from '../production/library-support-events.js';

/**
 * Removing the Scrolls of the retired document formats from one database (`content cleanup-old-scrolls`, #791, D-437). A revision is
 * old when its asset is a Scroll and its `document_version` is `scroll-document.v1` or `scroll-document.v2`; a Reel and a document
 * v3 are never old. An asset whose every revision is old goes whole. An asset that also holds a later revision keeps it, loses the
 * old ones and, when its current revision was old, points at its newest revision that a person may read.
 *
 * Content is the last module in the cleanup's order: every row of another module that points at an old revision is removed or
 * closed first (the foreign keys to a revision are `on delete restrict`), then the shared content, leaf first, ending at the assets.
 * The three guards that refuse every delete of coverage and of release risk raises (0022, 0115) let a delete through only while this
 * transaction has set `OLD_SCROLL_CLEANUP_SETTING` and the row's revision is an old one (0125); the setting is on for those steps
 * only, and the migration's helper checks the revision again for each row.
 */
const OLD_VERSIONS = [SCROLL_DOCUMENT_SCHEMA_VERSION, SCROLL_DOCUMENT_V2_SCHEMA_VERSION];
const oldVersionList = sql.join(OLD_VERSIONS.map((version) => sql.lit(version)));

/** The transaction-local setting the guards of 0125 read; the value they accept is `v1`. */
const OLD_SCROLL_CLEANUP_SETTING = 'knowscroll.old_scroll_cleanup';

/** The tables whose triggers refuse a delete unless the setting is on. */
const GUARDED_TABLES: ReadonlySet<string> = new Set([
  'content.coverage_heads',
  'content.coverage_revisions',
  'content.release_risk_raises',
]);

/**
 * Writes the old revisions to `OLD_SCROLL_REVISIONS`, a temporary table that ends with the transaction, so every module's step reads
 * one decision. Call it once, first, in the transaction that counts or removes.
 */
export async function prepareOldScrolls(trx: Transaction<Database>): Promise<void> {
  await sql`create temporary table ${sql.table(OLD_SCROLL_REVISIONS)} on commit drop as
    select revision.asset_id, revision.revision,
      not exists (select 1 from content.asset_revisions other
        where other.asset_id = revision.asset_id and other.document_version not in (${oldVersionList})) as whole_asset
    from content.asset_revisions revision
    join content.assets asset on asset.id = revision.asset_id
    where asset.kind = 'scroll' and revision.document_version in (${oldVersionList})`.execute(trx);
}

/**
 * Runs `work` only while this process holds the cleanup's session lock, taken with a try; another cleanup running means it returns
 * `undefined` and nothing runs. It does not stop the worker or the API: the runbook does that.
 */
export function withOldScrollCleanupLock<T>(db: Kysely<Database>, work: () => Promise<T>): Promise<T | undefined> {
  return withSessionLock(db, 'content.cleanup-old-scrolls', work);
}

/**
 * Withdraws every asset that goes whole, so no one opens it, nothing new is written about it and the production job refuses it,
 * before the people's history is cleared. A mixed asset is not withdrawn: its later revision stays served. Returns how many assets
 * changed (an asset already withdrawn is not changed, so a second call changes none).
 */
export async function withdrawOldAssets(trx: Transaction<Database>): Promise<number> {
  const result = await sql`update content.assets asset set status = 'withdrawn'
    where asset.status <> 'withdrawn' and ${namesRemovedAsset('asset', 'id')}`.execute(trx);
  return Number(result.numAffectedRows ?? 0);
}

const mixedAndCurrentIsOld = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`exists (select 1 from ${sql.table(OLD_SCROLL_REVISIONS)} current_old
    where current_old.asset_id = ${sql.ref(`${alias}.id`)} and current_old.revision = ${sql.ref(`${alias}.revision`)}
      and not current_old.whole_asset)`;

/**
 * A mixed asset's current revision moves to its newest revision that is not old and not waiting at, or refused by, the review gate.
 * When none is left the asset is held (an asset that is already withdrawn stays withdrawn), whether the newest kept revision still
 * waits for a decision or was rejected, and the pointer is that newest kept revision. That is where the review gate itself leaves an
 * asset whose only revisions are held or rejected (`rejectRevision` writes the review and leaves the asset's status as it was, and
 * a new asset is born `held`), and the readers serve only `admitted`, so nothing unreleased is served by the move and the recipe's
 * next take still publishes the next revision. It must never be `withdrawn`: `publish` refuses every take of a withdrawn asset
 * as `asset_conflict` (#800, D-439).
 */
const movePointer = sql`with target as (
    select asset.id,
      (select max(kept.revision) from content.asset_revisions kept
        where kept.asset_id = asset.id and kept.document_version not in (${oldVersionList})
          and not exists (select 1 from content.revision_reviews review
            where review.asset_id = kept.asset_id and review.revision = kept.revision and review.state in ('held', 'rejected'))) as servable,
      (select max(kept.revision) from content.asset_revisions kept
        where kept.asset_id = asset.id and kept.document_version not in (${oldVersionList})) as latest
    from content.assets asset
    where ${mixedAndCurrentIsOld('asset')}
  )
  update content.assets t
  set revision = coalesce(target.servable, target.latest),
    status = case
      when target.servable is not null then t.status
      when t.status = 'withdrawn' then t.status
      else 'held' end
  from target where t.id = target.id`;

/**
 * The assets the first version of this cleanup withdrew by mistake (#800, D-439): a Scroll that is `withdrawn`, and every one of whose
 * revisions is a kept (not v1 or v2) revision that the review gate rejected. Such an asset was served an old revision, lost it to the
 * cleanup, and was left with only its rejected newer revision, which the old `movePointer` wrongly withdrew instead of holding.
 *
 * Told apart from a real withdrawal by what a real withdrawal leaves. The release policy's withdrawal (`release-policy.ts`, the only
 * code that withdraws an asset besides this cleanup) requires the revision to be `released`, so the asset has a released review; and it
 * records the asset in `content.release_withdrawals`, which must have no row for the asset here. An asset the cleanup withdrew whole
 * has old revisions, so it is not "every revision kept". An asset with a revision that has no review row, or a held or released one,
 * is not this state. A withdrawn asset in this state serves nothing either way, so holding it exposes nothing; it only lets the
 * recipe's next take publish.
 */
const wronglyWithdrawn = sql<boolean>`asset.kind = 'scroll' and asset.status = 'withdrawn'
  and exists (select 1 from content.asset_revisions revision where revision.asset_id = asset.id)
  and not exists (select 1 from content.asset_revisions revision
    where revision.asset_id = asset.id
      and (revision.document_version in (${oldVersionList})
        or not exists (select 1 from content.revision_reviews review
          where review.asset_id = revision.asset_id and review.revision = revision.revision and review.state = 'rejected')))
  and not exists (select 1 from content.release_withdrawals withdrawal where withdrawal.asset_id = asset.id)`;

/** The ids of the assets {@link repairWronglyWithdrawnAssets} would put back to `held`, in id order. Changes nothing. */
export async function findWronglyWithdrawnAssets(trx: Transaction<Database>): Promise<readonly string[]> {
  const found = await sql<{ id: string }>`select asset.id::text as id from content.assets asset
    where ${wronglyWithdrawn} order by asset.id`.execute(trx);
  return found.rows.map((row) => row.id);
}

/**
 * Puts every asset {@link findWronglyWithdrawnAssets} finds back to `held` and returns their ids, in id order. One statement, so the
 * rows it changes are the rows its predicate reads; idempotent (a repaired asset is `held`, no longer `withdrawn`, so a second call
 * changes none). The pointer is left where it is: a held asset serves nothing.
 */
export async function repairWronglyWithdrawnAssets(trx: Transaction<Database>): Promise<readonly string[]> {
  const repaired = await sql<{ id: string }>`update content.assets asset set status = 'held'
    where ${wronglyWithdrawn} returning asset.id::text as id`.execute(trx);
  return repaired.rows.map((row) => row.id).sort();
}

const jobsNaming = (queues: readonly string[], match: RawBuilder<boolean>): RemovalStep => ({
  table: `${JOB_SCHEMA}.job`,
  action: 'delete',
  label: queues[0] ?? '',
  where: sql`t.name = any(${queues.flatMap((queue) => [queue, deadLetterQueueName(queue)])}::text[]) and ${match}`,
});

const revisionOf = (assetColumn = 'asset_id', revisionColumn = 'asset_revision') =>
  namesOldRevision('t', assetColumn, revisionColumn);

/**
 * The steps, in the order they run: what hangs off a discovery row, then coverage and review, then the revisions, the assets, and
 * last the rows that have no foreign key (an order, a recipe's standing, the production jobs and the queued work that names them).
 * A step's `where` reads rows that are still there when its turn comes: a production run is judged by the order row that is
 * deleted after it.
 */
function contentSteps(): readonly RemovalStep[] {
  const eitherEnd = sql<boolean>`${namesOldRevision('t', 'source_asset_id', 'source_asset_revision')}
    or ${namesOldRevision('t', 'target_asset_id', 'target_asset_revision')}`;
  const orderRecipesOfRemovedAssets = sql<boolean>`t.topic in (
    select recipe.recipe from content.made_to_order_scrolls recipe where ${namesRemovedAsset('recipe', 'asset_id')})`;
  return [
    { table: 'content.continuity_links', action: 'delete', where: eitherEnd },
    { table: 'content.series_units', action: 'delete', where: revisionOf() },
    { table: 'content.encounter_topics', action: 'delete', where: revisionOf() },
    { table: 'content.region_bindings', action: 'delete', where: revisionOf() },
    { table: 'content.coverage_heads', action: 'delete', where: revisionOf() },
    { table: 'content.coverage_revisions', action: 'delete', where: revisionOf() },
    { table: 'content.library_support_checks', action: 'delete', where: revisionOf('asset_id', 'revision') },
    { table: 'content.release_policy_looks', action: 'delete', where: revisionOf('asset_id', 'revision') },
    { table: 'content.release_withdrawals', action: 'delete', where: revisionOf('asset_id', 'revision') },
    { table: 'content.release_risk_raises', action: 'delete', where: revisionOf('asset_id', 'revision') },
    { table: 'content.revision_reviews', action: 'delete', where: revisionOf('asset_id', 'revision') },
    { table: 'content.discovery_revisions', action: 'delete', where: revisionOf() },
    { table: 'content.asset_provenance', action: 'delete', where: revisionOf('asset_id', 'revision') },
    { table: 'content.asset_revisions', action: 'delete', where: revisionOf('asset_id', 'revision') },
    {
      table: 'content.assets',
      action: 'update',
      label: 'current revision moves',
      where: mixedAndCurrentIsOld('t'),
      run: movePointer,
    },
    { table: 'content.assets', action: 'delete', label: 'every revision was old', where: namesRemovedAsset('t', 'id') },
    // The production run is final for its take once its Scroll is gone: a recipe whose only published take was the old Scroll is
    // not started again by the take counting, because the run that spent the take is deleted with the Scroll it made. A rejected
    // or unknown run of the same recipe stays and still counts, so no paid attempt is repeated. The runs of the reasoning ledger
    // (`writer_run_id`) are the audit of spend and stay.
    {
      table: 'content.scroll_production_runs',
      action: 'delete',
      where: sql<boolean>`(t.asset_id is not null and (${revisionOf('asset_id', 'asset_revision')} or ${namesRemovedAsset('t', 'asset_id')}))
        or ${orderRecipesOfRemovedAssets}`,
    },
    // The work a worker would still do for a Scroll that is gone: its library support check, and the production of an order.
    jobsNaming(
      [checkLibrarySupportQueue.name],
      sql<boolean>`exists (select 1 from ${sql.table(OLD_SCROLL_REVISIONS)} old_job
        where old_job.asset_id::text = t.data ->> 'assetId' and old_job.revision::text = t.data ->> 'revision')`,
    ),
    jobsNaming(
      [produceScrollQueue.name, produceAnswerQueue.name],
      sql<boolean>`t.data ->> 'recipe' in (
        select recipe.recipe from content.made_to_order_scrolls recipe where ${namesRemovedAsset('recipe', 'asset_id')})`,
    ),
    // A recipe whose Scroll is gone is to be produced again: back to `checked`, with the asset id it was given kept.
    {
      table: 'content.recipes',
      action: 'update',
      where: sql<boolean>`${namesRemovedAsset('t', 'asset_id')} and t.status in ('queued', 'produced')`,
      run: sql`update content.recipes t set status = 'checked', updated_at = now()
        where ${namesRemovedAsset('t', 'asset_id')} and t.status in ('queued', 'produced')`,
    },
    { table: 'content.made_to_order_scrolls', action: 'delete', where: namesRemovedAsset('t', 'asset_id') },
  ];
}

/** The facts the summary shows: what goes, what moves and what stays. Ids and counts only, never a title or a word of a Scroll. */
async function describe(trx: Transaction<Database>): Promise<Readonly<Record<string, unknown>>> {
  const versions = await sql<{ version: string; revisions: string; assets: string }>`
    select revision.document_version as version, count(*)::text as revisions, count(distinct revision.asset_id)::text as assets
    from content.asset_revisions revision
    join ${sql.table(OLD_SCROLL_REVISIONS)} old_revision
      on old_revision.asset_id = revision.asset_id and old_revision.revision = revision.revision
    group by 1 order by 1`.execute(trx);
  const whole = await sql<{ assets: string }>`select count(distinct asset_id)::text as assets
    from ${sql.table(OLD_SCROLL_REVISIONS)} where whole_asset`.execute(trx);
  const moves = await sql<{ assetId: string; from: number; kept: number[]; status: string }>`
    select asset.id as "assetId", asset.revision as "from", asset.status,
      array(select kept.revision from content.asset_revisions kept
        where kept.asset_id = asset.id and kept.document_version not in (${oldVersionList}) order by kept.revision) as kept
    from content.assets asset where ${mixedAndCurrentIsOld('asset')} order by asset.id`.execute(trx);
  const kept = await sql<{ assetId: string; kind: string; revisions: number[]; versions: string[] }>`
    select asset.id as "assetId", asset.kind,
      array_agg(revision.revision order by revision.revision) as revisions,
      array_agg(distinct revision.document_version) as versions
    from content.assets asset
    join content.asset_revisions revision on revision.asset_id = asset.id
    where not exists (select 1 from ${sql.table(OLD_SCROLL_REVISIONS)} old_revision
      where old_revision.asset_id = revision.asset_id and old_revision.revision = revision.revision)
    group by asset.id, asset.kind order by asset.id`.execute(trx);
  return {
    oldRevisionsByDocumentVersion: versions.rows.map((row) => ({
      documentVersion: row.version,
      revisions: Number(row.revisions),
      assets: Number(row.assets),
    })),
    assetsRemovedWhole: Number(whole.rows[0]?.assets ?? 0),
    assetsWithCurrentRevisionMoved: moves.rows,
    assetsKept: kept.rows,
  };
}

/** Content's part of the cleanup: the shared rows of the old Scrolls, leaf first, ending at the assets. Runs last. */
export const contentOldScrollRemoval: OldScrollRemoval = {
  module: 'content',
  async count(trx): Promise<ModuleRemovalReport> {
    return { tables: await countSteps(trx, contentSteps()), detail: await describe(trx) };
  },
  async run(trx): Promise<ModuleRemovalReport> {
    const detail = await describe(trx);
    const counts: RemovalCount[] = [];
    for (const step of contentSteps()) {
      const guarded = step.action === 'delete' && GUARDED_TABLES.has(step.table);
      if (guarded) await sql`select set_config(${OLD_SCROLL_CLEANUP_SETTING}, 'v1', true)`.execute(trx);
      counts.push(...(await runSteps(trx, [step])));
      if (guarded) await sql`select set_config(${OLD_SCROLL_CLEANUP_SETTING}, '', true)`.execute(trx);
    }
    const left = await sql<{ n: string }>`select count(*)::text as n from content.asset_revisions revision
      join content.assets asset on asset.id = revision.asset_id
      where asset.kind = 'scroll' and revision.document_version in (${oldVersionList})`.execute(trx);
    if (Number(left.rows[0]?.n ?? 0) !== 0) throw new Error('OLD_SCROLL_REVISIONS_REMAIN');
    return { tables: counts, detail };
  },
};
