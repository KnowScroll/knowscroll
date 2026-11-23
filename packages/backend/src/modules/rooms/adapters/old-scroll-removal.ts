import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  OLD_SCROLL_REVISIONS,
  countSteps,
  namesOldRevision,
  runSteps,
  type ModuleRemovalReport,
  type OldScrollRemoval,
  type RemovalStep,
} from '../../../infrastructure/erasure/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { NEUTRAL_TOPIC_TITLE } from '../domain/titles.js';

/**
 * What Rooms does when the Scrolls of the retired document formats leave the database (`content cleanup-old-scrolls`, #791, D-437).
 * Content has written the old revisions to its temporary table first; Rooms reads it. Every Rooms store is keyed by account or room,
 * so selective Clear, which the cleanup runs first, keeps them all except a person's play results (launch answers, flaw taps).
 *
 * - A discussion rooted at an old revision (a resident's find, a daily item, a Scroll's own talk) has no revision to be about and
 *   no later one to point at, so it goes whole: its messages, snippets, Useful marks, debate and votes, the turns that wrote into
 *   it and the typing hold. A find turn that never reached a discussion goes too, because a find turn must name its asset.
 * - A card to an old revision in a discussion that stays becomes a tombstone, as account deletion makes one (`erasure.ts`): no
 *   author, words, card or note, the same place and number, a fresh change number.
 * - What a derived summary or the room's memory read from a message that leaves is erased and written again later from what is left
 *   (D-247); a memory's pointer to a deleted turn is let go.
 * - A daily question, a Spot the flaw and a Launch name their source Scroll inside a JSON payload with no foreign key; those that
 *   name an asset that goes whole are deleted, the Launch before the ritual it plays. An answer's recorded support that cites such
 *   an asset is cleared: the cited Scroll is gone, and the answer's words stay.
 */
const OLD_ASSET = sql.table(OLD_SCROLL_REVISIONS);

/** The discussion rooted at an old revision. Valid while the discussion's row exists, which it does until the last step. */
const inRemovedDiscussion = (column: string): RawBuilder<boolean> =>
  sql<boolean>`${sql.ref(column)} in (select d.discussion_id from rooms.discussions d
    where d.root_asset_id is not null and ${namesOldRevision('d', 'root_asset_id', 'root_asset_revision')})`;

/** A card to an old revision, or a card that opens a discussion that goes. */
const cardLeaves = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`((${sql.ref(`${alias}.asset_id`)} is not null and ${namesOldRevision(alias, 'asset_id', 'asset_revision')})
    or (${sql.ref(`${alias}.topic_discussion_id`)} is not null and ${inRemovedDiscussion(`${alias}.topic_discussion_id`)}))`;

const messageLeaves = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${inRemovedDiscussion(`${alias}.discussion_id`)} or ${cardLeaves(alias)})`;

const tombstoned = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${cardLeaves(alias)} and not ${inRemovedDiscussion(`${alias}.discussion_id`)})`;

/** A turn that goes: one that wrote into a removed discussion, or a find of an old revision. */
const turnLeaves = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${inRemovedDiscussion(`${alias}.discussion_id`)}
    or (${sql.ref(`${alias}.find_asset_id`)} is not null and ${namesOldRevision(alias, 'find_asset_id', 'find_asset_revision')}))`;

/** JSON text that names an asset that goes whole. The payloads hold its id in a nested field, so the text is searched. */
const mentionsRemovedAsset = (text: RawBuilder<unknown>): RawBuilder<boolean> =>
  sql<boolean>`exists (select 1 from ${OLD_ASSET} named where named.whole_asset and position(named.asset_id::text in ${text}) > 0)`;

/** A message that leaves in a room, in the window a summary or the memory read. */
const messageInWindow = (alias: string, from: string, through: string, inclusiveFrom: boolean): RawBuilder<boolean> =>
  sql<boolean>`exists (select 1 from rooms.messages m join rooms.discussions d on d.discussion_id = m.discussion_id
    where d.room_id = ${sql.ref(`${alias}.room_id`)} and ${messageLeaves('m')}
      and m.recorded_at ${inclusiveFrom ? sql`>=` : sql`>`} ${sql.ref(`${alias}.${from}`)}
      and m.recorded_at <= ${sql.ref(`${alias}.${through}`)})`;

const tombstoneStatement = (where: RawBuilder<unknown>) => sql`
  with mine as (
    select t.discussion_id, t.sequence,
      row_number() over (partition by t.discussion_id order by t.sequence) as position,
      count(*) over (partition by t.discussion_id) as total
    from rooms.messages t where ${where}
  ), bumped as (
    update rooms.discussions d set last_change_sequence = d.last_change_sequence + counted.total
    from (select discussion_id, max(total) as total from mine group by discussion_id) counted
    where d.discussion_id = counted.discussion_id
    returning d.discussion_id, d.last_change_sequence as top, counted.total
  )
  update rooms.messages m set author_kind = 'person', author_account_id = null, agent_owner_account_id = null,
    ai_kind = null, trigger = null, command_id = null, body_text = null,
    asset_id = null, asset_revision = null, note = null, topic_discussion_id = null,
    change_sequence = bumped.top - bumped.total + mine.position
  from mine join bumped on bumped.discussion_id = mine.discussion_id
  where m.discussion_id = mine.discussion_id and m.sequence = mine.sequence`;

function roomSteps(): readonly RemovalStep[] {
  const summaryRead = sql<boolean>`t.state in ('queued', 'ready') and ${messageInWindow('t', 'covers_from', 'covers_through', false)}`;
  const memoryRead = sql<boolean>`t.source = 'derived' and t.state = 'ready' and t.covers_from is not null
    and ${messageInWindow('t', 'covers_from', 'covers_through', true)}`;
  const memoryTurnLeaves = sql<boolean>`t.turn_id in (select turn.turn_id from rooms.ai_turns turn where ${turnLeaves('turn')})`;
  const supportCites = sql<boolean>`t.answer_support is not null and ${mentionsRemovedAsset(sql`t.answer_support::text`)}
    and not ${turnLeaves('t')}`;
  const launchNames = sql<boolean>`${mentionsRemovedAsset(sql`t.questions::text`)}
    or t.deck_ritual_id in (select ritual.ritual_id from rooms.rituals ritual where ${mentionsRemovedAsset(sql`ritual.payload::text`)})`;
  const ritualNames = mentionsRemovedAsset(sql`t.payload::text`);
  const originLeaves = sql<boolean>`t.origin_message_id is not null and not ${inRemovedDiscussion('t.discussion_id')}
    and t.origin_message_id in (select m.message_id from rooms.messages m where ${inRemovedDiscussion('m.discussion_id')})`;
  const rootedAtOld = sql<boolean>`t.root_asset_id is not null and ${namesOldRevision('t', 'root_asset_id', 'root_asset_revision')}`;
  const tombstoneWhere = tombstoned('t');
  const onMessageThatLeaves = (alias: string) =>
    sql<boolean>`exists (select 1 from rooms.messages m where m.message_id = ${sql.ref(`${alias}.message_id`)} and ${messageLeaves('m')})`;
  return [
    { table: 'rooms.launches', action: 'delete', where: launchNames },
    { table: 'rooms.rituals', action: 'delete', where: ritualNames },
    {
      table: 'rooms.summaries',
      action: 'update',
      label: 'erased words, written again later',
      where: summaryRead,
      run: sql`update rooms.summaries t set state = 'stale', body = null, settled_at = coalesce(t.settled_at, now())
        where ${summaryRead}`,
    },
    {
      table: 'rooms.room_memory',
      action: 'update',
      label: 'erased words, written again later',
      where: memoryRead,
      run: sql`update rooms.room_memory t set state = 'stale', body = null, covers_from = null, covers_through = null,
          messages_read = 0, updated_at = now()
        where ${memoryRead}`,
    },
    {
      table: 'rooms.room_memory',
      action: 'update',
      label: 'lets go of a deleted turn',
      where: memoryTurnLeaves,
      run: sql`update rooms.room_memory t set turn_id = null where ${memoryTurnLeaves}`,
    },
    {
      table: 'rooms.ai_turns',
      action: 'update',
      label: 'answer support cleared',
      where: supportCites,
      run: sql`update rooms.ai_turns t set answer_support = null where ${supportCites}`,
    },
    { table: 'rooms.ai_turns', action: 'delete', where: turnLeaves('t') },
    { table: 'rooms.typing_holds', action: 'delete', where: inRemovedDiscussion('t.discussion_id') },
    { table: 'rooms.message_useful', action: 'delete', where: onMessageThatLeaves('t') },
    { table: 'rooms.message_snippets', action: 'delete', where: onMessageThatLeaves('t') },
    { table: 'rooms.debate_votes', action: 'delete', where: inRemovedDiscussion('t.discussion_id') },
    { table: 'rooms.debates', action: 'delete', where: inRemovedDiscussion('t.discussion_id') },
    { table: 'rooms.post_votes', action: 'delete', where: inRemovedDiscussion('t.discussion_id') },
    {
      table: 'rooms.discussions',
      action: 'update',
      label: 'a topic from a message that goes is named neutrally',
      where: originLeaves,
      run: sql`update rooms.discussions t set title = ${NEUTRAL_TOPIC_TITLE}, title_derived = false, origin_message_id = null
        where ${originLeaves}`,
    },
    {
      table: 'rooms.discussions',
      action: 'update',
      label: 'a discussion that goes lets go of its origin message',
      where: sql<boolean>`${rootedAtOld} and t.origin_message_id is not null`,
      run: sql`update rooms.discussions t set origin_message_id = null, title_derived = false
        where ${rootedAtOld} and t.origin_message_id is not null`,
    },
    { table: 'rooms.messages', action: 'tombstone', where: tombstoneWhere, run: tombstoneStatement(tombstoneWhere) },
    {
      table: 'rooms.messages',
      action: 'delete',
      label: 'in a removed discussion',
      where: inRemovedDiscussion('t.discussion_id'),
    },
    { table: 'rooms.discussions', action: 'delete', where: rootedAtOld },
  ];
}

/** The discussions that go, by kind, and the rituals and Launches that go: counts only. */
async function describe(trx: Transaction<Database>): Promise<Readonly<Record<string, unknown>>> {
  const rows = await sql<{ kind: string; n: string }>`
    select t.kind, count(*)::text as n from rooms.discussions t
    where t.root_asset_id is not null and ${namesOldRevision('t', 'root_asset_id', 'root_asset_revision')}
    group by 1 order by 1`.execute(trx);
  return { discussionsRemovedByKind: rows.rows.map((row) => ({ kind: row.kind, discussions: Number(row.n) })) };
}

/** Rooms' part of the cleanup. */
export const roomsOldScrollRemoval: OldScrollRemoval = {
  module: 'rooms',
  async count(trx): Promise<ModuleRemovalReport> {
    return { tables: await countSteps(trx, roomSteps()), detail: await describe(trx) };
  },
  async run(trx): Promise<ModuleRemovalReport> {
    const detail = await describe(trx);
    return { tables: await runSteps(trx, roomSteps()), detail };
  },
};
