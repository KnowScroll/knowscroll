import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  countSteps,
  namesOldRevision,
  namesRemovedAsset,
  runSteps,
  type ModuleRemovalReport,
  type OldScrollRemoval,
  type RemovalStep,
} from '../../../infrastructure/erasure/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';

/**
 * What Experience does when the Scrolls of the retired document formats leave the database (`content cleanup-old-scrolls`, #791,
 * D-437). Selective Clear, which the cleanup runs for every account first, erases a person's readings, offers and reactions but keeps
 * their Saved items and places (a person's own library). A Keep of a Scroll that is going has nothing left to open, and its
 * foreign key to the asset is `restrict`, so it is deleted, with its kept place, the way Unsave deletes one (a later save mints a
 * new identity). A Keep pins a revision without a foreign key to it, so a Keep of an old revision of an asset that stays goes too.
 */
const keepsAnOldScroll = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${namesRemovedAsset(alias, 'asset_id')} or ${namesOldRevision(alias, 'asset_id', 'asset_revision')})`;

function experienceSteps(): readonly RemovalStep[] {
  return [
    {
      table: 'experience.saved_places',
      action: 'delete',
      where: sql<boolean>`exists (select 1 from experience.saved_items keep
        where keep.universe_id = t.universe_id and keep.saved_entry_id = t.saved_entry_id and ${keepsAnOldScroll('keep')})`,
    },
    { table: 'experience.saved_items', action: 'delete', where: keepsAnOldScroll('t') },
  ];
}

/** How many Keeps each universe loses: the summary maps a universe to its account. */
async function describe(trx: Transaction<Database>): Promise<Readonly<Record<string, unknown>>> {
  const rows = await sql<{ universeId: string; keeps: string }>`
    select t.universe_id as "universeId", count(*)::text as keeps
    from experience.saved_items t where ${keepsAnOldScroll('t')} group by 1 order by 1`.execute(trx);
  return { keepsByUniverse: rows.rows.map((row) => ({ universeId: row.universeId, keeps: Number(row.keeps) })) };
}

/** Experience's part of the cleanup. */
export const experienceOldScrollRemoval: OldScrollRemoval = {
  module: 'experience',
  async count(trx): Promise<ModuleRemovalReport> {
    return { tables: await countSteps(trx, experienceSteps()), detail: await describe(trx) };
  },
  async run(trx): Promise<ModuleRemovalReport> {
    const detail = await describe(trx);
    return { tables: await runSteps(trx, experienceSteps()), detail };
  },
};
