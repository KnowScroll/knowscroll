import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { CastStore } from '../application/ports.js';

/**
 * What the router reads about a room that no other store holds (migrations 0062, 0069 and 0071). Every method is
 * one explicit query inside the room's lock; none decides anything.
 */
export const castStore: CastStore = {
  async listeners(lock) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.members')
      .select((builder) => builder.fn.countAll<string>().as('total'))
      .where('room_id', '=', lock.roomId)
      .where('ended_at', 'is', null)
      .where('ai_level', '<>', 'off')
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },

  async activityAfter(lock, discussionId, sequence, authorAccountId) {
    // A tombstone (a deleted account's message) and a message a moderator removed are not an answer.
    const row = await sql<{ by_others: string; by_ai: string }>`
      select count(*) filter (where author_kind = 'person' and author_account_id is not null
          and author_account_id is distinct from ${authorAccountId}::uuid) as by_others,
        count(*) filter (where author_kind = 'ai') as by_ai
      from rooms.messages
      where discussion_id = ${discussionId}::uuid and sequence > ${sequence} and hidden_at is null`.execute(
      sharedTransactionOf(lock.shared),
    );
    return { byOthers: Number(row.rows[0]?.by_others ?? 0), byAi: Number(row.rows[0]?.by_ai ?? 0) };
  },

  async messagesBy(lock, accountId) {
    const row = await sql<{ total: string }>`
      select count(*) as total
      from rooms.messages message
      join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
      where discussion.room_id = ${lock.roomId}::uuid and message.author_account_id = ${accountId}::uuid`.execute(
      sharedTransactionOf(lock.shared),
    );
    return Number(row.rows[0]?.total ?? 0);
  },

  async typingUntil(lock, discussionId, now) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.typing_holds')
      .select('held_until')
      .where('discussion_id', '=', discussionId)
      .where('held_until', '>', now)
      .executeTakeFirst();
    return row === undefined ? undefined : new Date(row.held_until);
  },
};
