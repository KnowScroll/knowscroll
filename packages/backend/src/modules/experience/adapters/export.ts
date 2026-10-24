import { sql } from 'kysely';
import { EXPORT_LIST_LIMIT, boundedSection, type ModuleExport } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';

interface SavedRow {
  readonly title: string;
  readonly format: string;
  readonly saved_at: Date;
  readonly place_kind: string | null;
  readonly position_ms: number | null;
  readonly part: string | number | null;
  readonly parts: number | null;
}

/** "0:31": a Reel's position as a clock, to the second. */
function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Where the person left off, in words: "at 0:31" in a Reel, "part 2 of 5" in a Scroll. The stored
 * place names a block id and an offset; those are internal and never leave. A Scroll whose block is
 * no longer in the document gets its kind alone.
 */
export function readablePlace(row: Pick<SavedRow, 'place_kind' | 'position_ms' | 'part' | 'parts'>) {
  if (row.place_kind === 'reel' && row.position_ms !== null)
    return { kind: 'reel' as const, position: `at ${clock(row.position_ms)}` };
  if (row.place_kind === 'scroll')
    return row.part !== null && row.parts !== null
      ? { kind: 'scroll' as const, position: `part ${String(row.part)} of ${String(row.parts)}` }
      : { kind: 'scroll' as const };
  return null;
}

/** What the person did with content, in words they know: titles and times, never IDs or revisions. */
export const experienceExportRead: ModuleExport['read'] = async (scope) => {
  const trx = transactionOf(scope);
  const universeId = scope.authority.universeId;
  const limit = EXPORT_LIST_LIMIT + 1;
  const saved = await sql<SavedRow>`
    select revision.title, asset.kind as format, item.saved_at,
      place.position ->> 'kind' as place_kind,
      case when place.position ->> 'kind' = 'reel' then (place.position ->> 'positionMs')::float8 end as position_ms,
      case when jsonb_typeof(revision.reading_facts -> 'blocks') = 'array' then
        (select block.number from jsonb_array_elements(revision.reading_facts -> 'blocks')
           with ordinality as block(value, number)
         where block.value ->> 'id' = place.position ->> 'blockId')
      end as part,
      case when jsonb_typeof(revision.reading_facts -> 'blocks') = 'array'
        then jsonb_array_length(revision.reading_facts -> 'blocks') end as parts
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
        place: readablePlace(row),
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
