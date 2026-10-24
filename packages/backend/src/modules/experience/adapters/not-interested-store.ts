import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { NotInterestedStore } from '../application/not-interested.js';
import { NOT_INTERESTED_DAYS, NOT_INTERESTED_LIMIT } from '../domain/not-interested.js';

/**
 * `experience.not_interested` (migration 0065). Times come from the database clock, which is also
 * the clock `readNotInterested` compares against, so the lapse needs no agreement between hosts.
 * Every write first drops the person's lapsed rows and, after inserting, anything past the newest
 * `NOT_INTERESTED_LIMIT`, so a person never holds more than that many.
 */
export const notInterestedStore: NotInterestedStore = {
  async mark(scope, assetId) {
    const db = transactionOf(scope);
    const { universeId, privacyEpoch } = scope.authority;
    await sql`delete from experience.not_interested where universe_id = ${universeId}::uuid and expires_at <= now()`.execute(
      db,
    );
    const marked = await sql<{ expires_at: Date }>`
      insert into experience.not_interested (universe_id, privacy_epoch, asset_id, marked_at, expires_at)
      values (${universeId}::uuid, ${privacyEpoch}, ${assetId}::uuid, now(), now() + make_interval(days => ${NOT_INTERESTED_DAYS}::int))
      on conflict (universe_id, asset_id) do update
        set privacy_epoch = excluded.privacy_epoch, marked_at = excluded.marked_at, expires_at = excluded.expires_at
      returning expires_at`.execute(db);
    await sql`
      delete from experience.not_interested
      where universe_id = ${universeId}::uuid and asset_id in (
        select asset_id from experience.not_interested where universe_id = ${universeId}::uuid
        order by marked_at desc, asset_id offset ${NOT_INTERESTED_LIMIT}::int)`.execute(db);
    return marked.rows[0]!.expires_at;
  },

  async unmark(scope, assetId) {
    await sql`delete from experience.not_interested where universe_id = ${scope.authority.universeId}::uuid and asset_id = ${assetId}::uuid`.execute(
      transactionOf(scope),
    );
  },
};

/** Which of these assets (at most 100) the person has marked "Not interested" and that has not lapsed. */
export async function readNotInterested(
  scope: PersonalScopeTx,
  assetIds: readonly string[],
): Promise<readonly string[]> {
  const { universeId, privacyEpoch } = scope.authority;
  const rows = await sql<{ asset_id: string }>`
    select asset_id from experience.not_interested
    where universe_id = ${universeId}::uuid and privacy_epoch = ${privacyEpoch}
      and expires_at > now() and asset_id = any(${assetIds}::uuid[])`.execute(transactionOf(scope));
  return rows.rows.map((row) => row.asset_id);
}
