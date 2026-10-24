import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadReportableRoomMessage } from '../public.js';

/**
 * A message of a discussion in a room the caller is a current member of, for a report. A message a
 * moderator removed, one whose author's account is gone (a tombstone) and an unknown ID are absent. An
 * inhabitant's message is reportable and has no author account.
 */
export const readReportableRoomMessage: ReadReportableRoomMessage = async (scope, accountId, messageId) => {
  const rows = await sql<{ room_id: string; author_account_id: string | null }>`
    select discussion.room_id, message.author_account_id
    from rooms.messages message
    join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
    join rooms.members member on member.room_id = discussion.room_id and member.account_id = ${accountId}::uuid
    where message.message_id = ${messageId}::uuid and message.hidden_at is null
      and (message.author_kind = 'ai' or message.author_account_id is not null)
      and member.ended_at is null`.execute(transactionOf(scope));
  const row = rows.rows[0];
  return row === undefined ? undefined : { roomId: row.room_id, authorAccountId: row.author_account_id };
};
