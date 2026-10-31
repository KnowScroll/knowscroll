import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { CallStore } from '../application/thread-ports.js';

/**
 * Postgres thread calls (migration 0083). The use cases decide who may read or write; this only runs queries.
 * The right answer is never stored: it is read from the immutable Scroll revision when a reveal is built.
 */
export const callStore: CallStore = {
  async list(lock) {
    const rows = await sharedTransactionOf(lock.shared)
      .selectFrom('social.thread_calls')
      .select([
        'account_id',
        'asset_id',
        'revision',
        'stop_id',
        'option',
        sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'),
      ])
      .where('thread_id', '=', lock.threadId)
      .execute();
    return rows.map((row) => ({
      accountId: row.account_id,
      assetId: row.asset_id,
      revision: row.revision,
      stopId: row.stop_id,
      option: row.option,
      day: row.day,
    }));
  },

  async insert(lock, accountId, call, option, day) {
    await sharedTransactionOf(lock.shared)
      .insertInto('social.thread_calls')
      .values({
        thread_id: lock.threadId,
        account_id: accountId,
        asset_id: call.assetId,
        revision: call.revision,
        stop_id: call.stopId,
        option,
        day,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  },

  async removeOf(lock, accountId) {
    await sharedTransactionOf(lock.shared)
      .deleteFrom('social.thread_calls')
      .where('thread_id', '=', lock.threadId)
      .where('account_id', '=', accountId)
      .execute();
  },

  async reveals(lock) {
    const rows = await sharedTransactionOf(lock.shared)
      .selectFrom('social.thread_call_reveals')
      .select(['asset_id', 'revision', 'stop_id'])
      .where('thread_id', '=', lock.threadId)
      .execute();
    return rows.map((row) => ({ assetId: row.asset_id, revision: row.revision, stopId: row.stop_id }));
  },

  async markRevealed(lock, call) {
    await sharedTransactionOf(lock.shared)
      .insertInto('social.thread_call_reveals')
      .values({ thread_id: lock.threadId, asset_id: call.assetId, revision: call.revision, stop_id: call.stopId })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  },
};
