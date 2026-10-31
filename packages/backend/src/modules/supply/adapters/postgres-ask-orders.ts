import { sql, type Kysely } from 'kysely';
import type { ReadOrderAudience } from '../../content/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readerOn, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { AskOrderLedger } from '../application/ports.js';

/** Quartermaster's ledger of ask orders (`supply.ask_orders`): ID and times, no person and no words. */
export const askOrderLedger: AskOrderLedger = {
  async countSince(scope, since) {
    const row = await transactionOf(scope)
      .selectFrom('supply.ask_orders')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
  async insert(scope, orderId) {
    await transactionOf(scope).insertInto('supply.ask_orders').values({ order_id: orderId }).execute();
  },
  async markReady(scope, orderId) {
    await sql`update supply.ask_orders set ready_at = greatest(now(), created_at)
      where order_id = ${orderId}::uuid and ready_at is null`.execute(transactionOf(scope));
  },
  async recentWaitsSeconds(scope, limit) {
    const rows = await sql<{ seconds: string }>`select extract(epoch from (ready_at - created_at))::text as seconds
      from supply.ask_orders where ready_at is not null order by ready_at desc limit ${limit}`.execute(
      transactionOf(scope),
    );
    return rows.rows.map((row) => Number(row.seconds));
  },
};

/**
 * Who may open the Scroll of an ask order (`READ_ASK_ORDER_AUDIENCE`, which Content asks on every way in): the person
 * who asked, while their request exists and was not cancelled. Nobody else, ever: not a friend, not a room, not a
 * thread. Erasing the request (Clear, account deletion) closes the Scroll to everyone. Reads on the caller's own
 * transaction (`on`), so a check made inside a personal write never takes a second connection.
 */
export function makeReadAskOrderAudience(db: Kysely<Database>): ReadOrderAudience {
  return async (on, authority, assetIds) => {
    // Another module's authority is never enough: the caller must be the person, an account.
    if (authority.actor.kind !== 'account' || assetIds.length === 0) return new Set();
    const rows = await readerOn(db, on)
      .selectFrom('supply.requests')
      .select('ask_asset_id')
      .where('universe_id', '=', authority.universeId)
      .where('privacy_epoch', '=', authority.privacyEpoch)
      .where('state', '<>', 'cancelled')
      .where('ask_asset_id', 'in', assetIds)
      .execute();
    return new Set(rows.flatMap((row) => (row.ask_asset_id === null ? [] : [row.ask_asset_id.toLowerCase()])));
  };
}
