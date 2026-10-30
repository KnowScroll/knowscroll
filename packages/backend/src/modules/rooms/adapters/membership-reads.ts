import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { ReadRoomMembership } from '../public.js';

/** Whether the account is a current member of the room, read on the pool: the socket gateway has no personal scope. */
export function readRoomMembership(db: Kysely<Database>): ReadRoomMembership {
  return async (accountId, roomId) => {
    const row = await db
      .selectFrom('rooms.members')
      .select('account_id')
      .where('room_id', '=', roomId)
      .where('account_id', '=', accountId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  };
}
