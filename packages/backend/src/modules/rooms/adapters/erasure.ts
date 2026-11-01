import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { exportReading, type ModuleErasure, type ModuleExport } from '../../../infrastructure/erasure/registry.js';
import { deleteClearJobPayloads, deleteJobPayloads } from '../../../infrastructure/jobs/erasure.js';
import { JOB_SCHEMA, deadLetterQueueName } from '../../../infrastructure/jobs/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';
import { NEUTRAL_POST_TITLE } from '../domain/posts.js';
import { NEUTRAL_TOPIC_TITLE } from '../domain/titles.js';
import { castDueQueue, castPassQueue, contributeQueue, summariseQueue } from '../events.js';
import { staleMemoryOf } from './postgres-feed.js';

/**
 * The queues whose payloads name a universe: the ask, the check whether a resident answers, the call it may lead to and the
 * call that writes a window's "while you were away".
 */
const QUEUES = [contributeQueue.name, castDueQueue.name, castPassQueue.name, summariseQueue.name];

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
 * seconds) hold no account, so they have no owner to erase for. Account deletion also deletes the person's marks of
 * Useful and the marks on the messages that become tombstones, deletes the place where they left off, and erases the
 * words of every "while you were away" that covered a message they wrote (D-167, D-169). `summaries` hold a window's
 * words and no account; a queued one whose job is erased with a universe ends as failed, like a queued turn.
 */
const LIFECYCLE = {
  'rooms.members': 'the account membership is removed, with its AI level, keep-out choice and notice mark',
  'rooms.room_presence': 'the lease is deleted with the membership; it also ends by itself after a minute',
  'rooms.invitations': 'invitations made to or by the account are removed',
  'rooms.discussions':
    'the starter link is cleared; the discussion stays for the others; the starter\'s "tell me when a person answers" switch and the marker of the answer they noticed are cleared by a Clear too, and when they leave or are removed',
  'rooms.messages':
    'the account authored messages become tombstones, and so do the notes of the scouts the account sent (no owner, no words, same place and number)',
  'rooms.message_snippets': 'deleted with the author tombstoned message',
  'rooms.ai_turns': 'the asker link is cleared; a turn and its contribution stay with the room',
  'rooms.activities': 'the creator link is cleared; the poll or quiz stays with the room',
  'rooms.poll_votes': 'the account votes are deleted',
  'rooms.message_useful': 'the account marks are deleted, and so are the marks on messages that become tombstones',
  'rooms.read_positions':
    'the place where the account left off is deleted; it also goes when they leave or are removed',
  'rooms.debates': 'kept with its discussion: two sides and a close time, no account',
  'rooms.constellation_votes':
    'the account votes on constellation names are deleted; they also go when they leave or are removed',
  'rooms.debate_votes': 'the account votes on debates are deleted; they also go when they leave or are removed',
  'rooms.ritual_solves':
    'the account taps on Spot the flaw are deleted, by a Clear too (a play result); they also go when they leave or are removed',
  'rooms.launch_players':
    'the account place in a Launch is deleted, by a Clear too (a play result); it also goes when they leave or are removed, and seven days after the Launch',
  'rooms.launch_answers':
    'the account answers in a Launch are deleted, by a Clear too (a play result); they also go when they leave or are removed, and seven days after the Launch',
  'rooms.watch_sessions':
    'the link that says the account shared a session is emptied, by a Clear too, and when they leave, are removed or delete the account; the session stays with the room (a Reel and a start time, no position) and goes seven days after it ended',
  'rooms.watch_viewers':
    'the account place among the people watching is deleted, by a Clear too (D-258); it also goes when they leave or are removed, and when the session ends or is stopped',
  'rooms.room_memory':
    'the words of a derived memory that read what the account wrote are erased (stale) before their messages become tombstones; the moderator link is cleared; a moderator text stays with the room',
  'rooms.memory_edits': 'the moderator link of an edit is cleared; the edit stays as a fact about the room',
  'rooms.post_votes':
    'the account votes on posts are deleted, and so are the votes on posts of theirs that become tombstones; they also go when they leave or are removed; a Clear keeps them (a vote holds no reading)',
  'rooms.scouts':
    'the account scouts are deleted, by leaving or removal from the room too; a Clear keeps them (they hold no reading); the moderator link of a stop is cleared and the stop stands',
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
  const summaryNames = [summariseQueue.name, deadLetterQueueName(summariseQueue.name)];
  const summaries = await sql`
    update rooms.summaries set state = 'failed', settled_at = now(), dispatched = true
    where state = 'queued' and summary_id in (
      select (job.data ->> 'summaryId')::uuid from ${sql.table(`${JOB_SCHEMA}.job`)} as job
      where job.name = any(${summaryNames}::text[]) and job.data ->> 'universeId' = ${universeId})`.execute(trx);
  return (
    Number(asks.numAffectedRows ?? 0) + Number(residents.numAffectedRows ?? 0) + Number(summaries.numAffectedRows ?? 0)
  );
}

/**
 * Takes the row of every room the account wrote in, shared and in id order, before anything else of theirs is touched. A
 * hide and a keep-out take it shared, and the residents' memory takes it exclusively before it stores words: so a memory
 * that read this person's messages is either written before this deletion starts (and erased below) or after it commits
 * (and cannot read them), never in between (D-247). Shared locks do not wait for each other, so deletions and sends are
 * not slowed down.
 */
async function lockRoomsOf(trx: ReturnType<typeof transactionOf>, account: string): Promise<void> {
  await sql`select room_id from rooms.rooms
    where room_id in (select discussion.room_id from rooms.messages message
      join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
      where message.author_account_id = ${account}::uuid or message.agent_owner_account_id = ${account}::uuid)
    order by room_id for share`.execute(trx);
}

/**
 * Takes the row of every discussion the account wrote in or started, in id order, before anything else of
 * theirs is touched. A send in flight holds its discussion's row; waiting here first, in one order, means
 * two deletions that touch the same discussions never wait on each other in opposite orders.
 */
async function lockDiscussionsOf(trx: ReturnType<typeof transactionOf>, account: string): Promise<void> {
  await sql`select discussion_id from rooms.discussions
    where started_by_account_id = ${account}::uuid
      or discussion_id in (select discussion_id from rooms.messages
        where author_account_id = ${account}::uuid or agent_owner_account_id = ${account}::uuid)
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
    {
      name: `pgboss/${summariseQueue.name}`,
      description: "Queued, active, retained and dead-lettered model calls that write a window's summary (IDs).",
    },
  ],
  accountTables: [
    { schema: 'rooms', table: 'members', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'invitations', ownerColumn: 'invitee_account_id,inviter_account_id' },
    { schema: 'rooms', table: 'discussions', ownerColumn: 'started_by_account_id' },
    { schema: 'rooms', table: 'messages', ownerColumn: 'author_account_id,agent_owner_account_id' },
    { schema: 'rooms', table: 'message_snippets', ownerColumn: 'message_id' },
    { schema: 'rooms', table: 'ai_turns', ownerColumn: 'requested_by_account_id' },
    { schema: 'rooms', table: 'activities', ownerColumn: 'created_by_account_id' },
    { schema: 'rooms', table: 'poll_votes', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'room_presence', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'message_useful', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'read_positions', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'debates', ownerColumn: 'discussion_id' },
    { schema: 'rooms', table: 'constellation_votes', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'debate_votes', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'ritual_solves', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'launch_players', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'launch_answers', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'watch_sessions', ownerColumn: 'started_by' },
    { schema: 'rooms', table: 'watch_viewers', ownerColumn: 'account_id' },
    { schema: 'rooms', table: 'room_memory', ownerColumn: 'edited_by_account_id' },
    { schema: 'rooms', table: 'memory_edits', ownerColumn: 'by_account_id' },
    { schema: 'rooms', table: 'scouts', ownerColumn: 'owner_account_id,stopped_by_account_id' },
    { schema: 'rooms', table: 'post_votes', ownerColumn: 'account_id' },
  ],
  accountColumns: [
    { schema: 'rooms', table: 'members', column: 'account_id' },
    { schema: 'rooms', table: 'invitations', column: 'invitee_account_id' },
    { schema: 'rooms', table: 'invitations', column: 'inviter_account_id' },
    { schema: 'rooms', table: 'discussions', column: 'started_by_account_id' },
    { schema: 'rooms', table: 'messages', column: 'author_account_id' },
    { schema: 'rooms', table: 'messages', column: 'agent_owner_account_id' },
    { schema: 'rooms', table: 'ai_turns', column: 'requested_by_account_id' },
    { schema: 'rooms', table: 'activities', column: 'created_by_account_id' },
    { schema: 'rooms', table: 'poll_votes', column: 'account_id' },
    { schema: 'rooms', table: 'room_presence', column: 'account_id' },
    { schema: 'rooms', table: 'message_useful', column: 'account_id' },
    { schema: 'rooms', table: 'read_positions', column: 'account_id' },
    { schema: 'rooms', table: 'constellation_votes', column: 'account_id' },
    { schema: 'rooms', table: 'debate_votes', column: 'account_id' },
    { schema: 'rooms', table: 'ritual_solves', column: 'account_id' },
    { schema: 'rooms', table: 'launch_players', column: 'account_id' },
    { schema: 'rooms', table: 'launch_answers', column: 'account_id' },
    { schema: 'rooms', table: 'watch_sessions', column: 'started_by' },
    { schema: 'rooms', table: 'watch_viewers', column: 'account_id' },
    { schema: 'rooms', table: 'room_memory', column: 'edited_by_account_id' },
    { schema: 'rooms', table: 'memory_edits', column: 'by_account_id' },
    { schema: 'rooms', table: 'scouts', column: 'owner_account_id' },
    { schema: 'rooms', table: 'scouts', column: 'stopped_by_account_id' },
    { schema: 'rooms', table: 'post_votes', column: 'account_id' },
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
   * change. Only rows keyed by this account, and the discussions' atomic counters, are touched. The rooms the
   * person wrote in are held shared first (the memory's writer takes them exclusively); that does not wait for
   * a send or a hide, so it is safe beside them.
   */
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const account = scope.accountId;
    await lockRoomsOf(trx, account);
    await lockDiscussionsOf(trx, account);
    let removed = 0;
    const count = (result: { numAffectedRows?: bigint | undefined }) => Number(result.numAffectedRows ?? 0);
    // A summary that read what the person wrote must not outlive it: erase its words before the messages become tombstones.
    removed += count(
      await sql`
        update rooms.summaries summary set state = 'stale', body = null, settled_at = coalesce(settled_at, now())
        where summary.state in ('queued', 'ready') and exists (
          select 1 from rooms.messages message
          join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
          where discussion.room_id = summary.room_id and message.author_account_id = ${account}::uuid
            and message.recorded_at > summary.covers_from and message.recorded_at <= summary.covers_through)`.execute(
        trx,
      ),
    );
    // What the residents remember must not outlive it either (D-247): erased now, written again from what is left.
    removed += count(await staleMemoryOf({ byAccount: account }).execute(trx));
    removed += count(
      await sql`delete from rooms.message_useful where account_id = ${account}::uuid
        or message_id in (select message_id from rooms.messages
          where author_account_id = ${account}::uuid or agent_owner_account_id = ${account}::uuid)`.execute(trx),
    );
    // A post of theirs is a tombstone once its words go: its votes go with it, and so do the votes they cast.
    removed += count(
      await sql`delete from rooms.post_votes where account_id = ${account}::uuid
        or discussion_id in (select discussion_id from rooms.discussions where started_by_account_id = ${account}::uuid
          and person_post)`.execute(trx),
    );
    removed += count(await sql`delete from rooms.read_positions where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.constellation_votes where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.debate_votes where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.ritual_solves where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.launch_answers where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.launch_players where account_id = ${account}::uuid`.execute(trx));
    removed += count(await sql`delete from rooms.watch_viewers where account_id = ${account}::uuid`.execute(trx));
    removed += count(
      await sql`update rooms.watch_sessions set started_by = null where started_by = ${account}::uuid`.execute(trx),
    );
    // A topic named from this person's message is called what it says, so the name is theirs too: before the message is a
    // tombstone, it becomes the neutral title for everyone (D-168).
    removed += count(
      await sql`
        update rooms.discussions set title = ${NEUTRAL_TOPIC_TITLE}
        where title_derived and origin_message_id in (
          select message_id from rooms.messages where author_account_id = ${account}::uuid)`.execute(trx),
    );
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
          from rooms.messages where author_account_id = ${account}::uuid or agent_owner_account_id = ${account}::uuid
        ), bumped as (
          update rooms.discussions d set last_change_sequence = d.last_change_sequence + t.total
          from (select discussion_id, max(total) as total from mine group by discussion_id) t
          where d.discussion_id = t.discussion_id
          returning d.discussion_id, d.last_change_sequence as top, t.total
        )
        update rooms.messages m set author_kind = 'person', author_account_id = null, agent_owner_account_id = null,
          ai_kind = null, trigger = null, command_id = null, body_text = null,
          asset_id = null, asset_revision = null, note = null, topic_discussion_id = null,
          change_sequence = bumped.top - bumped.total + mine.position
        from mine join bumped on bumped.discussion_id = mine.discussion_id
        where m.discussion_id = mine.discussion_id and m.sequence = mine.sequence`.execute(trx),
    );
    removed += count(
      await sql`update rooms.discussions set notify_answer = false, answer_noticed_at = null
        where started_by_account_id = ${account}::uuid and (notify_answer or answer_noticed_at is not null)`.execute(
        trx,
      ),
    );
    // The headline and the source of a post were the person's own words: they go before the link to the account does.
    removed += count(
      await sql`update rooms.discussions set title = ${NEUTRAL_POST_TITLE}, source_url = null
        where person_post and started_by_account_id = ${account}::uuid`.execute(trx),
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
    removed += count(await sql`delete from rooms.scouts where owner_account_id = ${account}::uuid`.execute(trx));
    removed += count(
      await sql`update rooms.scouts set stopped_by_account_id = null where stopped_by_account_id = ${account}::uuid`.execute(
        trx,
      ),
    );
    removed += count(
      await sql`update rooms.room_memory set edited_by_account_id = null
        where edited_by_account_id = ${account}::uuid`.execute(trx),
    );
    removed += count(
      await sql`update rooms.memory_edits set by_account_id = null where by_account_id = ${account}::uuid`.execute(trx),
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
      // A tap on Spot the flaw is a play result of the person, so a Clear erases it (D-082); the star it earned has no account.
      'rooms.ritual_solves': 'erase' as const,
      // Answers and places in a Launch are play results too (D-082, D-220); the star a Launch earned has no account.
      'rooms.launch_answers': 'erase' as const,
      'rooms.launch_players': 'erase' as const,
      // Who is watching is the person's own and a Clear erases it; the link that says they shared a session is emptied too (D-258).
      'rooms.watch_viewers': 'erase' as const,
      ...Object.fromEntries(QUEUES.map((name) => [`store:pgboss/${name}`, 'erase' as const])),
    },
    async erase(scope) {
      const trx = clearCoreTransactionOf(scope);
      const asks = await failQueuedTurns(trx, scope.binding.universeId);
      const jobs = await deleteClearJobPayloads(scope, QUEUES);
      const owner = sql`(select account_id from identity.universes where id = ${scope.binding.universeId}::uuid)`;
      const taps = await sql`delete from rooms.ritual_solves where account_id = ${owner}`.execute(trx);
      const answers = await sql`delete from rooms.launch_answers where account_id = ${owner}`.execute(trx);
      const players = await sql`delete from rooms.launch_players where account_id = ${owner}`.execute(trx);
      const watching = await sql`delete from rooms.watch_viewers where account_id = ${owner}`.execute(trx);
      const shared = await sql`update rooms.watch_sessions set started_by = null where started_by = ${owner}`.execute(
        trx,
      );
      const played =
        Number(taps.numAffectedRows ?? 0) +
        Number(answers.numAffectedRows ?? 0) +
        Number(players.numAffectedRows ?? 0) +
        Number(watching.numAffectedRows ?? 0) +
        Number(shared.numAffectedRows ?? 0);
      // The topics stay with the room; the starter's switch and the answer they noticed are their own and go. Rows are taken in id order,
      // as account deletion takes them, so this waits on a send in flight in the same order.
      const notices = await sql`
        update rooms.discussions set notify_answer = false, answer_noticed_at = null
        where discussion_id in (
          select discussion_id from rooms.discussions
          where started_by_account_id = ${owner} and (notify_answer or answer_noticed_at is not null)
          order by discussion_id for update)`.execute(trx);
      return {
        module: 'rooms',
        status: 'completed',
        removed: asks + jobs + played + Number(notices.numAffectedRows ?? 0),
      };
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
      'rooms.message_useful',
      'rooms.constellation_votes',
      'rooms.debate_votes',
      'rooms.ritual_solves',
      'rooms.launch_players',
      'rooms.launch_answers',
      'rooms.watch_sessions',
      'rooms.watch_viewers',
      'rooms.memory_edits',
      'rooms.scouts',
      'rooms.post_votes',
    ],
    'What the residents remember belongs to the room and is derived from many people; an invitation is a notice between two members and holds no words of the person; a presence lease lasts a minute and records only that the room was open; the place where they left off is private bookkeeping that holds no words; a summary holds a window of the room and no one of its own; the job queue is delivery bookkeeping.',
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
      // A title made from someone else's message is their words, not this person's: the file says so neutrally.
      const started = await sql<{
        title: string;
        room: string;
        created_at: Date;
        tag: string | null;
        notify_answer: boolean;
        answer_noticed_at: Date | null;
        source_url: string | null;
      }>`
        select case when discussion.title_derived and origin.author_account_id is distinct from ${person.accountId}::uuid
            then ${NEUTRAL_TOPIC_TITLE} else discussion.title end as title,
          room.name as room, discussion.created_at, discussion.tag, discussion.notify_answer, discussion.answer_noticed_at,
          discussion.source_url
        from rooms.discussions discussion join rooms.rooms room on room.room_id = discussion.room_id
        left join rooms.messages origin on origin.message_id = discussion.origin_message_id
        where discussion.started_by_account_id = ${person.accountId}::uuid
        order by discussion.created_at desc limit 500`.execute(trx);
      const messages = await sql<{
        recorded_at: Date;
        body_text: string | null;
        note: string | null;
        room: string;
        topic_title: string | null;
      }>`
        select message.recorded_at, message.body_text, message.note, room.name as room,
          case when topic.title_derived and topic_origin.author_account_id is distinct from ${person.accountId}::uuid
            then ${NEUTRAL_TOPIC_TITLE} else topic.title end as topic_title
        from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        join rooms.rooms room on room.room_id = discussion.room_id
        left join rooms.discussions topic on topic.discussion_id = message.topic_discussion_id
        left join rooms.messages topic_origin on topic_origin.message_id = topic.origin_message_id
        where message.author_account_id = ${person.accountId}::uuid
        order by message.recorded_at desc, message.sequence desc limit ${EXPORT_MESSAGE_LIMIT}`.execute(trx);
      const written = await sql<{ n: string }>`
        select count(*) as n from rooms.messages where author_account_id = ${person.accountId}::uuid`.execute(trx);
      const asks = await sql<{ n: string }>`
        select count(*) as n from rooms.ai_turns
        where requested_by_account_id = ${person.accountId}::uuid and trigger = 'asked'`.execute(trx);
      // Which room and when, never whose post: a vote is the voter's own, and the post belongs to its author.
      const postVotes = await sql<{ room: string; voted_at: Date }>`
        select room.name as room, vote.voted_at
        from rooms.post_votes vote
        join rooms.discussions discussion on discussion.discussion_id = vote.discussion_id
        join rooms.rooms room on room.room_id = discussion.room_id
        where vote.account_id = ${person.accountId}::uuid
        order by vote.voted_at desc limit 500`.execute(trx);
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
      const marks = await sql<{ room: string; marked_at: Date }>`
        select room.name as room, mark.marked_at
        from rooms.message_useful mark
        join rooms.messages message on message.message_id = mark.message_id
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        join rooms.rooms room on room.room_id = discussion.room_id
        where mark.account_id = ${person.accountId}::uuid
        order by mark.marked_at desc limit 500`.execute(trx);
      // The person's own sky acts: which name they chose for which room's constellation, which side of which debate, and
      // whether their tap on a day's Spot the flaw was right. A star has no account, so none is listed.
      const skyVotes = await sql<{ room: string; name: string; voted_at: Date }>`
        select room.name as room, constellation.candidates[vote.candidate + 1] as name, vote.voted_at
        from rooms.constellation_votes vote
        join rooms.constellations constellation on constellation.room_id = vote.room_id and constellation.no = vote.no
        join rooms.rooms room on room.room_id = vote.room_id
        where vote.account_id = ${person.accountId}::uuid
        order by vote.voted_at desc limit 500`.execute(trx);
      const debateVotes = await sql<{ room: string; side: string; voted_at: Date }>`
        select room.name as room, case vote.side when 'a' then debate.side_a else debate.side_b end as side, vote.voted_at
        from rooms.debate_votes vote
        join rooms.debates debate on debate.discussion_id = vote.discussion_id
        join rooms.discussions discussion on discussion.discussion_id = vote.discussion_id
        join rooms.rooms room on room.room_id = discussion.room_id
        where vote.account_id = ${person.accountId}::uuid
        order by vote.voted_at desc limit 500`.execute(trx);
      const taps = await sql<{ room: string; day: string; correct: boolean; solved_at: Date }>`
        select room.name as room, to_char(ritual.day, 'YYYY-MM-DD') as day, solve.correct, solve.solved_at
        from rooms.ritual_solves solve
        join rooms.rituals ritual on ritual.ritual_id = solve.ritual_id
        join rooms.rooms room on room.room_id = ritual.room_id
        where solve.account_id = ${person.accountId}::uuid
        order by solve.solved_at desc limit 500`.execute(trx);
      // The person's own Launches: which room and day, how many questions they got right. Never what they picked, never another person.
      const launches = await sql<{ room: string; day: string; right: string; answered: string }>`
        select room.name as room, to_char(launch.starts_at at time zone 'UTC', 'YYYY-MM-DD') as day,
          count(*) filter (where answer.correct) as right, count(*) as answered
        from rooms.launch_players player
        join rooms.launches launch on launch.launch_id = player.launch_id
        join rooms.rooms room on room.room_id = launch.room_id
        left join rooms.launch_answers answer on answer.launch_id = player.launch_id and answer.account_id = player.account_id
        where player.account_id = ${person.accountId}::uuid and launch.state = 'finished'
        group by room.name, launch.launch_id, launch.starts_at
        order by launch.starts_at desc limit 500`.execute(trx);
      // What the person still has in Watch together: a session they shared, and a session they joined that is still on. Which room and
      // day, never a position (there is none) and never another person.
      const watching = await sql<{ room: string; day: string; role: string }>`
        select room.name as room, to_char(session.starts_at at time zone 'UTC', 'YYYY-MM-DD') as day, 'shared' as role
        from rooms.watch_sessions session join rooms.rooms room on room.room_id = session.room_id
        where session.started_by = ${person.accountId}::uuid
        union all
        select room.name, to_char(session.starts_at at time zone 'UTC', 'YYYY-MM-DD'), 'joined'
        from rooms.watch_viewers viewer
        join rooms.watch_sessions session on session.session_id = viewer.session_id
        join rooms.rooms room on room.room_id = session.room_id
        where viewer.account_id = ${person.accountId}::uuid
        order by day desc limit 500`.execute(trx);
      const memoryEdits = await sql<{ room: string; action: string; at: Date }>`
        select room.name as room, edit.action, edit.at
        from rooms.memory_edits edit join rooms.rooms room on room.room_id = edit.room_id
        where edit.by_account_id = ${person.accountId}::uuid
        order by edit.at desc limit 500`.execute(trx);
      // The scouts the person sent: where, which of the room's topics they chose, how often, and what each posted in their name.
      const scouts = await sql<{
        room: string;
        interests: string[];
        cadence: string;
        paused: boolean;
        stopped: boolean;
      }>`
        select room.name as room, scout.interests, scout.cadence, scout.paused, scout.stopped_at is not null as stopped
        from rooms.scouts scout join rooms.rooms room on room.room_id = scout.room_id
        where scout.owner_account_id = ${person.accountId}::uuid
        order by scout.created_at desc limit 500`.execute(trx);
      const scoutNotes = await sql<{ room: string; sent_at: Date; body_text: string | null; title: string }>`
        select room.name as room, message.recorded_at as sent_at, message.body_text, discussion.title
        from rooms.messages message
        join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
        join rooms.rooms room on room.room_id = discussion.room_id
        where message.agent_owner_account_id = ${person.accountId}::uuid
        order by message.recorded_at desc, message.sequence desc limit ${EXPORT_MESSAGE_LIMIT}`.execute(trx);
      const messageCount = Number(written.rows[0]?.n ?? 0);
      const askCount = Number(asks.rows[0]?.n ?? 0);
      // A person who never took part in a room has no section: the file does not name the module.
      if (
        rooms.rows.length === 0 &&
        started.rows.length === 0 &&
        messageCount === 0 &&
        askCount === 0 &&
        votes.rows.length === 0 &&
        marks.rows.length === 0 &&
        skyVotes.rows.length === 0 &&
        debateVotes.rows.length === 0 &&
        taps.rows.length === 0 &&
        launches.rows.length === 0 &&
        watching.rows.length === 0 &&
        memoryEdits.rows.length === 0 &&
        scouts.rows.length === 0 &&
        scoutNotes.rows.length === 0 &&
        postVotes.rows.length === 0 &&
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
          // The address of a post the person made, as they pasted it: theirs, so the file has it.
          ...(row.source_url === null ? {} : { source: row.source_url }),
          // The person's own switch and the answer they last noticed, for a question they left.
          ...(row.tag === 'question'
            ? {
                tellMeWhenAPersonAnswers: row.notify_answer,
                ...(row.answer_noticed_at === null ? {} : { answerNoticedAt: row.answer_noticed_at.toISOString() }),
              }
            : {}),
        })),
        messagesWritten: messageCount,
        truncated: messageCount > messages.rows.length,
        yourMessages: messages.rows.map((row) =>
          row.body_text !== null
            ? { room: row.room, sentAt: row.recorded_at.toISOString(), text: row.body_text }
            : row.topic_title !== null
              ? { room: row.room, sentAt: row.recorded_at.toISOString(), startedTopic: row.topic_title }
              : {
                  room: row.room,
                  sentAt: row.recorded_at.toISOString(),
                  shared: SHARED_WORDS,
                  ...(row.note === null ? {} : { note: row.note }),
                },
        ),
        inhabitantAsks: askCount,
        pollVotes: votes.rows.map((row) => ({
          room: row.room,
          question: row.question,
          ...(row.choice === null ? {} : { choice: row.choice }),
          votedAt: row.voted_at.toISOString(),
        })),
        // Which room and when, never whose message or what it said: the message belongs to its author.
        postVotes: postVotes.rows.map((row) => ({ room: row.room, votedAt: row.voted_at.toISOString() })),
        usefulMarks: marks.rows.map((row) => ({ room: row.room, markedAt: row.marked_at.toISOString() })),
        constellationNameVotes: skyVotes.rows.map((row) => ({
          room: row.room,
          name: row.name,
          votedAt: row.voted_at.toISOString(),
        })),
        debateVotes: debateVotes.rows.map((row) => ({
          room: row.room,
          side: row.side,
          votedAt: row.voted_at.toISOString(),
        })),
        spotTheFlawTaps: taps.rows.map((row) => ({
          room: row.room,
          day: row.day,
          right: row.correct,
          tappedAt: row.solved_at.toISOString(),
        })),
        launchesPlayed: launches.rows.map((row) => ({
          room: row.room,
          day: row.day,
          questionsRight: Number(row.right),
          questionsAnswered: Number(row.answered),
        })),
        watchTogether: watching.rows.map((row) => ({ room: row.room, day: row.day, you: row.role })),
        // The person's own changes to what a room's residents remember: the room, what they did and when, never the words.
        memoryEdits: memoryEdits.rows.map((row) => ({
          room: row.room,
          action: row.action === 'clear' ? 'cleared' : 'replaced',
          at: row.at.toISOString(),
        })),
        scouts: scouts.rows.map((row) => ({
          room: row.room,
          topics: row.interests,
          often: row.cadence === 'weekly' ? 'once a week' : 'once a day',
          paused: row.paused,
          stoppedByAModerator: row.stopped,
        })),
        // What a scout posted, signed with the person's name: the find's title and the note a model wrote for it.
        scoutNotes: scoutNotes.rows.map((row) => ({
          room: row.room,
          find: row.title,
          note: row.body_text ?? '',
          sentAt: row.sent_at.toISOString(),
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
