import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PostStore } from '../application/ports.js';

/**
 * A member's posts to the Feed and the votes on every post (migration 0098). Every method is one explicit query inside the room's
 * lock and the caller's personal transaction; none decides access. A vote is a row of its voter, and nothing here reads one back as
 * a list: the Feed counts rows and asks only whether the reader's own is among them.
 */
export const postStore: PostStore = {
  async postsSince(lock, accountId, since) {
    const row = await sql<{ n: string }>`
      select count(*) as n from rooms.discussions
      where room_id = ${lock.roomId}::uuid and kind = 'find' and started_by_account_id = ${accountId}::uuid
        and created_at >= ${since}`.execute(sharedTransactionOf(lock.shared));
    return Number(row.rows[0]?.n ?? 0);
  },

  async existing(lock, link) {
    const trx = sharedTransactionOf(lock.shared);
    const row =
      link.kind === 'content'
        ? await sql<{ discussion_id: string }>`
            select discussion_id from rooms.discussions
            where room_id = ${lock.roomId}::uuid and kind = 'find' and root_asset_id = ${link.assetId}::uuid
            limit 1`.execute(trx)
        : await sql<{ discussion_id: string }>`
            select discussion_id from rooms.discussions
            where room_id = ${lock.roomId}::uuid and kind = 'find' and source_url = ${link.url}
            limit 1`.execute(trx);
    return row.rows[0]?.discussion_id;
  },

  async votable(lock, discussionId) {
    const row = await sql<{ author_account_id: string | null }>`
      select note.author_account_id
      from rooms.discussions discussion
      join rooms.messages note on note.discussion_id = discussion.discussion_id and note.sequence = 1
      where discussion.room_id = ${lock.roomId}::uuid and discussion.discussion_id = ${discussionId}::uuid
        and discussion.kind = 'find' and note.hidden_at is null and note.body_text is not null`.execute(
      sharedTransactionOf(lock.shared),
    );
    const found = row.rows[0];
    return found === undefined ? undefined : { authorAccountId: found.author_account_id };
  },

  async setVote(lock, discussionId, accountId, voted, now) {
    const trx = sharedTransactionOf(lock.shared);
    if (voted)
      await sql`
        insert into rooms.post_votes (discussion_id, account_id, voted_at)
        values (${discussionId}::uuid, ${accountId}::uuid, ${now})
        on conflict (discussion_id, account_id) do nothing`.execute(trx);
    else
      await sql`delete from rooms.post_votes
        where discussion_id = ${discussionId}::uuid and account_id = ${accountId}::uuid`.execute(trx);
  },

  async votesOf(lock, discussionId) {
    const row = await sql<{ n: string }>`
      select count(*) as n from rooms.post_votes where discussion_id = ${discussionId}::uuid`.execute(
      sharedTransactionOf(lock.shared),
    );
    return Number(row.rows[0]?.n ?? 0);
  },

  async voteView(lock, discussionId, accountId) {
    const row = await sql<{ votes: string; voted: boolean }>`
      select count(*) as votes, bool_or(account_id = ${accountId}::uuid) as voted
      from rooms.post_votes where discussion_id = ${discussionId}::uuid`.execute(sharedTransactionOf(lock.shared));
    return { votes: Number(row.rows[0]?.votes ?? 0), voted: row.rows[0]?.voted === true };
  },

  async introductionOf(lock, inhabitant) {
    const row = await sql<{ discussion_id: string }>`
      select discussion_id from rooms.discussions
      where room_id = ${lock.roomId}::uuid and kind = 'intro' and intro_inhabitant = ${inhabitant}`.execute(
      sharedTransactionOf(lock.shared),
    );
    return row.rows[0]?.discussion_id;
  },

  async forgetMember(lock, accountId) {
    await sql`delete from rooms.post_votes where account_id = ${accountId}::uuid and discussion_id in (
      select discussion_id from rooms.discussions where room_id = ${lock.roomId}::uuid)`.execute(
      sharedTransactionOf(lock.shared),
    );
  },
};
