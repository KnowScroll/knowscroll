import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportReading, type ModuleErasure, type ModuleExport } from '../../../infrastructure/erasure/registry.js';
import { deleteClearJobPayloads, deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { JOB_SCHEMA, deadLetterQueueName } from '../../../infrastructure/jobs/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { castDueQueue, castPassQueue, contributeQueue } from '../events.js';

/** The queues whose payloads name a universe: the ask, the check whether a resident answers, and the call it may lead to. */
const QUEUES = [contributeQueue.name, castDueQueue.name, castPassQueue.name];

/**
 * Every Rooms store is keyed by account, not universe: a room, its members and its discussions are
 * explicit communication, not exploration evidence, so selective Clear keeps all of them. What Clear
 * (and a full erasure of the universe) does remove is the queued work that names the universe: the
 * pending ask jobs, and with them the asks they would have answered, which end as failed so no
 * discussion waits for an inhabitant that will not come.
 *
 * Account deletion (D-043) removes the person's membership and invitations, turns their messages
 * into tombstones with fresh change numbers (no author, body, card or note; same place and number),
 * deletes their snippet rows, and clears the starter link of discussions they began and the asker
 * of AI requests. The room goes on for the others, and "Deleted account" stands where the person was.
 * An AI contribution a deleted person asked for stays: it belongs to the room. An unprompted turn never had an asker,
 * and its message belongs to the room. `room_cast` (a room's residents) and `typing_holds` (a discussion and a few
 * seconds) hold no account, so they have no owner to erase for.
 */
const LIFECYCLE = {
  'rooms.members': 'the account membership is removed, with its AI level, keep-out choice and notice mark',
  'rooms.room_presence': 'the lease is deleted with the membership; it also ends by itself after a minute',
  'rooms.invitations': 'invitations made to or by the account are removed',
  'rooms.discussions': 'the starter link is cleared; the discussion stays for the others',
  'rooms.messages': 'the account authored messages become tombstones',
  'rooms.message_snippets': 'deleted with the author tombstoned message',
  'rooms.ai_turns': 'the asker link is cleared; a turn and its contribution stay with the room',
  'rooms.activities': 'the creator link is cleared; the poll or quiz stays with the room',
  'rooms.poll_votes': 'the account votes are deleted',
} as const;

/**
 * Ends the turns that are still queued and whose job is being erased with this universe: the asks of its account, and
 * the unprompted turns whose model call (`rooms.cast-pass`) was queued under its universe. Without this the row would stay
 * queued, keep a discussion looking busy for fifteen minutes and count toward the caps for a call nobody will make. A
 * queued turn may already have its model call running, so it stays counted (`dispatched`): a Clear does not hand a turn
 * back. A held answer is dropped with it.
 */
async function failQueuedTurns(trx: ReturnType<typeof transactionOf>, universeId: string): Promise<number> {
  const asks = await sql`
    update rooms.ai_turns set state = 'failed', settled_at = now(), dispatched = true, held_kind = null, held_text = null
    where state = 'queued' and requested_by_account_id = (select account_id from identity.universes where id = ${universeId}::uuid)`.execute(
    trx,
  );
  const names = [castPassQueue.name, deadLetterQueueName(castPassQueue.name)];
  const residents = await sql`
    update rooms.ai_turns set state = 'failed', settled_at = now(), dispatched = true, held_kind = null, held_text = null
    where state = 'queued' and trigger <> 'asked' and turn_id in (
      select (job.data ->> 'turnId')::uuid from ${sql.table(`${JOB_SCHEMA}.job`)} as job
      where job.name = any(${names}::text[]) and job.data ->> 'universeId' = ${universeId})`.execute(trx);
  return Number(asks.numAffectedRows ?? 0) + Number(residents.numAffectedRows ?? 0);
}

/**
 * Takes the row of every discussion the account wrote in or started, in id order, before anything else of
 * theirs is touched. A send in flight holds its discussion's row; waiting here first, in one order, means
 * two deletions that touch the same discussions never wait on each other in opposite orders.
 */
async function lockDiscussionsOf(trx: ReturnType<typeof transactionOf>, account: string): Promise<void> {
  await sql`select discussion_id from rooms.discussions
    where started_by_account_id = ${account}::uuid
      or discussion_id in (select discussion_id from rooms.messages where author_account_id = ${account}::uuid)
    order by discussion_id for update`.execute(trx);
}

/** The most messages one export file carries; the file says how many there are and whether it was cut. */
const EXPORT_MESSAGE_LIMIT = 2000;

export const roomsErasure: ModuleErasure = declareErasure({
  module: 'rooms',
  tables: [],
  nonRowStores: [
    {
      name: `pgboss/${contributeQueue.name}`,
      description: 'Queued, active, retained and dead-lettered ask IDs.',
    },
    {
      name: `pgboss/${castDueQueue.name}`,
      description: 'Queued, active, retained and dead-lettered checks of whether a resident answers a message (IDs).',
    },
    {
      name: `pgboss/${castPassQueue.name}`,
      description: 'Queued, active, retained and dead-lettered model calls of residents speaking on their own (IDs).',
    },
  ],
  accountTables: [
    { schema: 'rooms', table: 'members', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'invitations', ownerColumn: 'invitee_account_id,inviter_account_id' },
    { schema: 'rooms', table: 'discussions', ownerColumn: 'started_by_account_id' },
    { schema: 'rooms', table: 'messages', ownerColumn: 'author_account_id' },
    { schema: 'rooms', table: 'message_snippets', ownerColumn: 'message_id' },
    { schema: 'rooms', table: 'ai_turns', ownerColumn: 'requested_by_account_id' },
    { schema: 'rooms', table: 'activities', ownerColumn: 'created_by_account_id' },
    { schema: 'rooms', table: 'poll_votes', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'room_presence', ownerColumn: 'account_id' },
  ],
  accountColumns: [
    { schema: 'rooms', table: 'members', column: 'account_id' },
    { schema: 'rooms', table: 'invitations', column: 'invitee_account_id' },
    { schema: 'rooms', table: 'invitations', column: 'inviter_account_id' },
    { schema: 'rooms', table: 'discussions', column: 'started_by_account_id' },
    { schema: 'rooms', table: 'messages', column: 'author_account_id' },
    { schema: 'rooms', table: 'ai_turns', column: 'requested_by_account_id' },
    { schema: 'rooms', table: 'activities', column: 'created_by_account_id' },
    { schema: 'rooms', table: 'poll_votes', column: 'account_id' },
    { schema: 'rooms', table: 'room_presence', column: 'account_id' },
  ],

  /** Full erasure of one universe: the queued ask jobs and the asks waiting on them. */
  async erase(scope) {
    const trx = transactionOf(scope);
    const asks = await failQueuedTurns(trx, scope.authority.universeId);
    const jobs = await deleteJobPayloads(scope, QUEUES);
    return { module: 'rooms', status: 'completed', removed: asks + jobs };
  },

  /**
   * Account deletion, after every universe eraser (D-043). Idempotent: a second run finds nothing to
   * change. Only rows keyed by this account, and the discussions' atomic counters, are touched, so
   * no room lock is needed and it is safe beside a concurrent send.
   */
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const account = scope.accountId;
    await lockDiscussionsOf(trx, account);
    let removed = 0;
    const count = (result: { numAffectedRows?: bigint | undefined }) => Number(result.numAffectedRows ?? 0);
    removed += count(
      await sql`delete from rooms.message_snippets where message_id in (
        select message_id from rooms.messages where author_account_id = ${account}::uuid)`.execute(trx),
    );
    removed += count(
      await sql`
        with mine as (
          select discussion_id, sequence,
            row_number() over (partition by discussion_id order by sequence) as position,
            count(*) over (partition by discussion_id) as total
          from rooms.messages where author_account_id = ${account}::uuid
        ), bumped as (
          update rooms.discussions d set last_change_sequence = d.last_change_sequence + t.total
          from (select discussion_id, max(total) as total from mine group by discussion_id) t
          where d.discussion_id = t.discussion_id
          returning d.discussion_id, d.last_change_sequence as top, t.total
        )
        update rooms.messages m set author_account_id = null, command_id = null, body_text = null,
          asset_id = null, asset_revision = null, note = null,
          change_sequence = bumped.top - bumped.total + mine.position
        from mine join bumped on bumped.discussion_id = mine.discussion_id
        where m.discussion_id = mine.discussion_id and m.sequence = mine.sequence`.execute(trx),
    );
    removed += count(
      await sql`update rooms.discussions set started_by_account_id = null
        where started_by_account_id = ${account}::uuid`.execute(trx),
    );
    removed += count(
      await sql`update rooms.ai_turns set requested_by_account_id = null,
          state = case when state = 'queued' then 'failed' else state end,
          settled_at = case when state = 'queued' then now() else settled_at end
        where requested_by_account_id = ${account}::uuid`.execute(trx),
    );
    removed += count(await sql`delete from rooms.poll_votes where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.room_presence where account_id = ${account}::uuid`.execute(trx));
    removed += count(
      await sql`update rooms.activities set created_by_account_id = null
        where created_by_account_id = ${account}::uuid`.execute(trx),
    );
    removed += count(
      await sql`delete from rooms.invitations
        where invitee_account_id = ${account}::uuid or inviter_account_id = ${account}::uuid`.execute(trx),
    );
    removed += count(await sql`delete from rooms.members where account_id = ${account}::uuid`.execute(trx));
    return { module: 'rooms', status: 'completed', removed };
  },

  clear: {
    dispositions: {
      ...Object.fromEntries(Object.keys(LIFECYCLE).map((store) => [store, 'preserve' as const])),
      ...Object.fromEntries(QUEUES.map((name) => [`store:pgboss/${name}`, 'erase' as const])),
    },
    async erase(scope) {
      const asks = await failQueuedTurns(clearCoreTransactionOf(scope), scope.binding.universeId);
      const jobs = await deleteClearJobPayloads(scope, QUEUES);
      return { module: 'rooms', status: 'completed', removed: asks + jobs };
    },
  },

  export: (declaration) => exportRooms(declaration),
});

const SHARED_WORDS = 'a Reel or Scroll';

/**
 * The person's rooms, the discussions they started and their own words in rooms (newest first). The
 * file names no other person and no AI contribution: what an inhabitant said belongs to the room,
 * and what a person said to another is theirs to export.
 */
function exportRooms(declaration: ModuleErasure): ModuleExport {
  return exportReading(
    declaration,
    [
      'rooms.members',
      'rooms.discussions',
      'rooms.messages',
      'rooms.message_snippets',
      'rooms.ai_turns',
      'rooms.activities',
      'rooms.poll_votes',
    ],
    'An invitation is a notice between two members and holds no words of the person; a presence lease lasts a minute and records only that the room was open; the job queue is delivery bookkeeping.',
    async (scope, person) => {
      const trx = transactionOf(scope);
      const rooms = await sql<{
        name: string;
        role: string;
        joined_at: Date;
        ended_at: Date | null;
        ai_level: string;
        keep_out: boolean;
        notice_seen_at: Date | null;
      }>`
        select room.name, member.role, member.joined_at, member.ended_at, member.ai_level, member.keep_out,
          member.notice_seen_at
        from rooms.members member join rooms.rooms room on room.room_id = member.room_id
        where member.account_id = ${person.accountId}::uuid
        order by member.joined_at desc limit 500`.execute(trx);
      const started = await sql<{ title: string; room: string; created_at: Date }>`
        select discussion.title, room.name as room, discussion.created_at
        from rooms.discussions discussion join rooms.rooms room on room.room_id = discussion.room_id
        where discussion.started_by_account_id = ${person.accountId}::uuid
        order by discussion.created_at desc limit 500`.execute(trx);
      const messages = await sql<{ recorded_at: Date; body_text: string | null; note: string | null; room: string }>`
        select message.recorded_at, message.body_text, message.note, room.name as room
        from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        join rooms.rooms room on room.room_id = discussion.room_id
        where message.author_account_id = ${person.accountId}::uuid
        order by message.recorded_at desc, message.sequence desc limit ${EXPORT_MESSAGE_LIMIT}`.execute(trx);
      const written = await sql<{ n: string }>`
        select count(*) as n from rooms.messages where author_account_id = ${person.accountId}::uuid`.execute(trx);
      const asks = await sql<{ n: string }>`
        select count(*) as n from rooms.ai_turns
        where requested_by_account_id = ${person.accountId}::uuid and trigger = 'asked'`.execute(trx);
      const votes = await sql<{ room: string; question: string; choice: string | null; voted_at: Date }>`
        select room.name as room, activity.title as question, vote.voted_at,
          (select option ->> 'text' from jsonb_array_elements(activity.definition -> 'options') option
            where option ->> 'id' = vote.option_id) as choice
        from rooms.poll_votes vote
        join rooms.activities activity on activity.activity_id = vote.activity_id
        join rooms.rooms room on room.room_id = activity.room_id
        where vote.account_id = ${person.accountId}::uuid
        order by vote.voted_at desc limit 500`.execute(trx);
      const startedActivities = await sql<{ room: string; title: string; kind: string; created_at: Date }>`
        select room.name as room, activity.title, activity.kind, activity.created_at
        from rooms.activities activity join rooms.rooms room on room.room_id = activity.room_id
        where activity.created_by_account_id = ${person.accountId}::uuid
        order by activity.created_at desc limit 500`.execute(trx);
      const messageCount = Number(written.rows[0]?.n ?? 0);
      const askCount = Number(asks.rows[0]?.n ?? 0);
      // A person who never took part in a room has no section: the file does not name the module.
      if (
        rooms.rows.length === 0 &&
        started.rows.length === 0 &&
        messageCount === 0 &&
        askCount === 0 &&
        votes.rows.length === 0 &&
        startedActivities.rows.length === 0
      )
        return {};
      return {
        rooms: rooms.rows.map((row) => ({
          name: row.name,
          role: row.role,
          joinedAt: row.joined_at.toISOString(),
          ...(row.ended_at === null ? {} : { leftAt: row.ended_at.toISOString() }),
          aiLevel: row.ai_level,
          keepMessagesOutOfAi: row.keep_out,
          ...(row.notice_seen_at === null ? {} : { aiNoticeSeenAt: row.notice_seen_at.toISOString() }),
        })),
        discussionsStarted: started.rows.map((row) => ({
          title: row.title,
          room: row.room,
          startedAt: row.created_at.toISOString(),
        })),
        messagesWritten: messageCount,
        truncated: messageCount > messages.rows.length,
        yourMessages: messages.rows.map((row) =>
          row.body_text === null
            ? {
                room: row.room,
                sentAt: row.recorded_at.toISOString(),
                shared: SHARED_WORDS,
                ...(row.note === null ? {} : { note: row.note }),
              }
            : { room: row.room, sentAt: row.recorded_at.toISOString(), text: row.body_text },
        ),
        inhabitantAsks: askCount,
        pollVotes: votes.rows.map((row) => ({
          room: row.room,
          question: row.question,
          ...(row.choice === null ? {} : { choice: row.choice }),
          votedAt: row.voted_at.toISOString(),
        })),
        activitiesStarted: startedActivities.rows.map((row) => ({
          room: row.room,
          title: row.title,
          kind: row.kind,
          startedAt: row.created_at.toISOString(),
        })),
      };
    },
  );
}
