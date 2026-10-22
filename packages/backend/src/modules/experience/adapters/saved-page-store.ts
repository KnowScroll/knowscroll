import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { SavedPageKey, SavedPagePorts } from '../application/saved-page.js';

/** Exact microseconds remain strings throughout the keyset; no JS Date or OFFSET seek.
 * Split tie/older ranges use the existing (universe,saved_at DESC,asset_id ASC) index. */
export const savedPageCandidates: SavedPagePorts['candidates'] = async (scope, after) => {
  const trx = transactionOf(scope),
    universe = scope.authority.universeId;
  type Key = { asset_id: string; key_time: string };
  const columns = sql`asset_id,to_char(saved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as key_time`;
  let keys: Key[];
  if (!after)
    keys = (
      await sql<Key>`select ${columns} from experience.saved_items where universe_id=${universe}::uuid order by saved_at desc,asset_id asc limit 101`.execute(
        trx,
      )
    ).rows;
  else {
    keys = (
      await sql<Key>`select ${columns} from experience.saved_items where universe_id=${universe}::uuid and saved_at=${after.savedAt}::timestamptz and asset_id>${after.assetId}::uuid order by saved_at desc,asset_id asc limit 101`.execute(
        trx,
      )
    ).rows;
    if (keys.length < 101)
      keys.push(
        ...(
          await sql<Key>`select ${columns} from experience.saved_items where universe_id=${universe}::uuid and saved_at<${after.savedAt}::timestamptz order by saved_at desc,asset_id asc limit ${101 - keys.length}`.execute(
            trx,
          )
        ).rows,
      );
  }
  // The 101st row is a key-only lookahead. Hydrate identities and Content facts for at most100.
  const consumed = keys.slice(0, 100);
  if (!consumed.length) return { items: [], more: false };
  const identities = await sql<{
    asset_id: string;
    asset_revision: number;
    saved_entry_id: string;
  }>`select asset_id,asset_revision,saved_entry_id from experience.saved_items where universe_id=${universe}::uuid and asset_id=any(${consumed.map((key) => key.asset_id)}::uuid[])`.execute(
    trx,
  );
  return {
    more: keys.length > 100,
    items: consumed.map((key) => {
      const row = identities.rows.find((candidate) => candidate.asset_id === key.asset_id);
      if (!row) throw new Error('SAVED_PAGE_MEMBERSHIP_UNAVAILABLE');
      return {
        entry: { assetId: row.asset_id, assetRevision: row.asset_revision, savedEntryId: row.saved_entry_id },
        key: { assetId: key.asset_id, savedAt: key.key_time } satisfies SavedPageKey,
      };
    }),
  };
};
