import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PlaceStore } from '../application/thread-ports.js';
import type { PlaceState } from '../domain/places.js';

/** Postgres party places (migration 0080). The use cases decide who may read or write; this only runs queries. */
export const placeStore: PlaceStore = {
  async list(lock) {
    const rows = await sharedTransactionOf(lock.shared)
      .selectFrom('social.thread_places')
      .select(['account_id', 'part', 'state', sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day')])
      .where('thread_id', '=', lock.threadId)
      .execute();
    return rows.map((row) => ({
      accountId: row.account_id,
      part: row.part,
      state: row.state as PlaceState,
      day: row.day,
    }));
  },

  async find(lock, accountId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('social.thread_places')
      .select(['part', 'state', sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day')])
      .where('thread_id', '=', lock.threadId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined ? undefined : { part: row.part, state: row.state as PlaceState, day: row.day };
  },

  async save(lock, accountId, place) {
    await sharedTransactionOf(lock.shared)
      .insertInto('social.thread_places')
      .values({
        thread_id: lock.threadId,
        account_id: accountId,
        part: place.part,
        state: place.state,
        day: place.day,
      })
      .onConflict((conflict) =>
        conflict.columns(['thread_id', 'account_id']).doUpdateSet({
          part: place.part,
          state: place.state,
          day: place.day,
        }),
      )
      .execute();
  },

  async remove(lock, accountId) {
    await sharedTransactionOf(lock.shared)
      .deleteFrom('social.thread_places')
      .where('thread_id', '=', lock.threadId)
      .where('account_id', '=', accountId)
      .execute();
  },

  async setHidden(lock, accountId, hidden) {
    await sharedTransactionOf(lock.shared)
      .updateTable('social.conversation_members')
      .set({ place_hidden: hidden })
      .where('conversation_id', '=', lock.threadId)
      .where('account_id', '=', accountId)
      .execute();
  },

  async blockedWith(lock, readerAccountId, accountIds) {
    if (accountIds.length === 0) return new Set();
    const rows = await sql<{ account_id: string }>`
      select distinct case when pair.low_account_id = ${readerAccountId}::uuid
        then pair.high_account_id else pair.low_account_id end as account_id
      from social.pairs pair
      join social.pair_sides side on side.pair_id = pair.pair_id and side.own_blocked
      where (pair.low_account_id = ${readerAccountId}::uuid and pair.high_account_id = any(${[...accountIds]}::uuid[]))
         or (pair.high_account_id = ${readerAccountId}::uuid and pair.low_account_id = any(${[...accountIds]}::uuid[]))`.execute(
      sharedTransactionOf(lock.shared),
    );
    return new Set(rows.rows.map((row) => row.account_id));
  },
};
