import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PresenceStore } from '../application/ports.js';

/**
 * Room presence rows (migration 0069): one lease per member, rewritten by the member's own presence command and
 * read only while fresh. Every method is one explicit query inside the room's lock; none decides access.
 */
export const presenceStore: PresenceStore = {
  async renew(lock, accountId, now, leaseMs) {
    const trx = sharedTransactionOf(lock.shared);
    const earlier = await trx
      .selectFrom('rooms.room_presence')
      .select('last_seen_at')
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    await trx
      .insertInto('rooms.room_presence')
      .values({ room_id: lock.roomId, account_id: accountId, last_seen_at: now })
      .onConflict((conflict) => conflict.columns(['room_id', 'account_id']).doUpdateSet({ last_seen_at: now }))
      .execute();
    const held = earlier !== undefined && now.getTime() - new Date(earlier.last_seen_at).getTime() < leaseMs;
    return held ? 'renewed' : 'began';
  },

  async clear(lock, accountId) {
    const deleted = await sharedTransactionOf(lock.shared)
      .deleteFrom('rooms.room_presence')
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return deleted.numDeletedRows > 0n;
  },

  async fresh(lock, since, limit) {
    const rows = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.room_presence as presence')
      .innerJoin('rooms.members as member', (join) =>
        join.onRef('member.room_id', '=', 'presence.room_id').onRef('member.account_id', '=', 'presence.account_id'),
      )
      .select('presence.account_id')
      .where('presence.room_id', '=', lock.roomId)
      .where('presence.last_seen_at', '>', since)
      .where('member.ended_at', 'is', null)
      .orderBy('presence.last_seen_at', 'desc')
      .orderBy('presence.account_id')
      .limit(limit)
      .execute();
    return rows.map((row) => row.account_id);
  },
};
