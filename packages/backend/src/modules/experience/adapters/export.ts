import { sql } from 'kysely';
import { EXPORT_LIST_LIMIT, boundedSection, type ModuleExport } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';

/** What the person did with content, in words they know: titles and times, never IDs or revisions. */
export const experienceExportRead: ModuleExport['read'] = async (scope) => {
  const trx = transactionOf(scope);
  const universeId = scope.authority.universeId;
  const limit = EXPORT_LIST_LIMIT + 1;
  const saved = await sql<{ title: string; format: string; saved_at: Date; position: unknown }>`
    select revision.title, asset.kind as format, item.saved_at, place.position
    from experience.saved_items item
    join content.asset_revisions revision on revision.asset_id = item.asset_id and revision.revision = item.asset_revision
    join content.assets asset on asset.id = item.asset_id
    left join experience.saved_places place
      on place.universe_id = item.universe_id and place.saved_entry_id = item.saved_entry_id
    where item.universe_id = ${universeId}::uuid
    order by item.saved_at desc, item.saved_entry_id
    limit ${limit}`.execute(trx);
  const encounters = await sql<{ title: string; format: string; opened_at: Date; activated_at: Date | null }>`
    select revision.title, exposure.kind as format, exposure.opened_at, exposure.activated_at
    from experience.exposures exposure
    join content.asset_revisions revision
      on revision.asset_id = exposure.asset_id and revision.revision = exposure.asset_revision
    where exposure.universe_id = ${universeId}::uuid
    order by exposure.opened_at desc, exposure.id
    limit ${limit}`.execute(trx);
  const reactions = await sql<{ title: string; action: string; created_at: Date }>`
    select revision.title, action.kind as action, action.created_at
    from experience.actions action
    join content.asset_revisions revision
      on revision.asset_id = action.asset_id and revision.revision = action.asset_revision
    where action.universe_id = ${universeId}::uuid
    order by action.created_at desc, action.id
    limit ${limit}`.execute(trx);
  return {
    saved: boundedSection(
      saved.rows.map((row) => ({
        title: row.title,
        format: row.format,
        savedAt: row.saved_at.toISOString(),
        place: row.position ?? null,
      })),
    ),
    encounters: boundedSection(
      encounters.rows.map((row) => ({
        title: row.title,
        format: row.format,
        openedAt: row.opened_at.toISOString(),
        started: row.activated_at !== null,
      })),
    ),
    reactions: boundedSection(
      reactions.rows.map((row) => ({ title: row.title, action: row.action, at: row.created_at.toISOString() })),
    ),
  };
};
