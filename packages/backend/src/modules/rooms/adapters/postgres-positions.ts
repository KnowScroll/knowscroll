import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PositionStore, ReadPosition } from '../application/ports.js';

interface PositionColumns {
  here_until: Date | string;
  away_since: Date | string | null;
  away_window: string | null;
}

const positionOf = (row: PositionColumns): ReadPosition => ({
  hereUntil: new Date(row.here_until),
  awaySince: row.away_since === null ? undefined : new Date(row.away_since),
  awayWindow: row.away_window === null ? undefined : Number(row.away_window),
});

/**
 * Where members left off (migration 0076): one private row per member per room, rewritten by the member's own presence
 * command and read only for that member. Every method is one explicit query inside the room's lock; none decides access.
 */
export const positionStore: PositionStore = {
  async touch(lock, accountId, now) {
    // The row as it stood before this beat, in the same statement that moves it forward.
    const result = await sql<PositionColumns>`
      with before as (
        select here_until, away_since, away_window from rooms.read_positions
        where room_id = ${lock.roomId}::uuid and account_id = ${accountId}::uuid
      ), moved as (
        insert into rooms.read_positions (room_id, account_id, here_until)
        values (${lock.roomId}::uuid, ${accountId}::uuid, ${now})
        on conflict (room_id, account_id) do update set here_until = excluded.here_until
        returning 1
      )
      select here_until, away_since, away_window from before`.execute(sharedTransactionOf(lock.shared));
    const row = result.rows[0];
    return row === undefined ? undefined : positionOf(row);
  },

  async read(lock, accountId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.read_positions')
      .select(['here_until', 'away_since', 'away_window'])
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined ? undefined : positionOf(row);
  },

  async markAway(lock, accountId, away) {
    await sharedTransactionOf(lock.shared)
      .updateTable('rooms.read_positions')
      .set({ away_since: away.since, away_window: String(away.window) })
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .execute();
  },

  async dismissAway(lock, accountId) {
    await sharedTransactionOf(lock.shared)
      .updateTable('rooms.read_positions')
      .set({ away_since: null, away_window: null })
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .execute();
  },

  async forget(lock, accountId) {
    await sharedTransactionOf(lock.shared)
      .deleteFrom('rooms.read_positions')
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .execute();
  },
};
