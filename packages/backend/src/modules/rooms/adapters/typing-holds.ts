import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { HoldCast } from '../public.js';

/** How long one typing hint holds back an AI turn. The device repeats it every few seconds while the person types. */
export const TYPING_HOLD_MS = 10_000;

/**
 * Records that someone is typing in a discussion, only to hold back an AI turn (D-067, D-165). A current member of
 * the room, on the pool: the socket gateway has no personal scope. The row names the discussion and a time, never
 * the person or the text; it is rewritten in place and lapses by itself. A non-member, an unknown discussion and a
 * hint for another room's discussion write nothing, and the caller cannot tell which.
 */
export function holdCast(db: Kysely<Database>, now: () => Date = () => new Date()): HoldCast {
  return async ({ accountId, roomId, discussionId }) => {
    const at = now();
    await sql`
      insert into rooms.typing_holds (discussion_id, held_until)
      select discussion.discussion_id, ${new Date(at.getTime() + TYPING_HOLD_MS)}
      from rooms.discussions discussion
      join rooms.members member on member.room_id = discussion.room_id
      where discussion.discussion_id = ${discussionId}::uuid and discussion.room_id = ${roomId}::uuid
        and member.account_id = ${accountId}::uuid and member.ended_at is null
      on conflict (discussion_id) do update set held_until = excluded.held_until`.execute(db);
  };
}
