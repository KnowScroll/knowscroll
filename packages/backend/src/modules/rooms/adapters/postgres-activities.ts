import { sql } from 'kysely';
import { z } from 'zod';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { StoredDefinition } from '../domain/activities.js';
import type { ActivityRow, ActivityStore } from '../application/ports.js';

const Option = z.strictObject({ id: z.string().regex(/^o[1-5]$/), text: z.string().min(1).max(80) });
const Explanation = z.strictObject({
  heading: z.string().min(1).max(80),
  text: z.string().min(1).max(240),
  note: z.string().min(1).max(160).optional(),
});
/** The shape this module wrote. A row that does not match fails loudly instead of being served. */
const StoredDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('poll'),
    prompt: z.string().min(1).max(160),
    options: z.array(Option).min(2).max(5),
  }),
  z.strictObject({
    kind: z.literal('quiz'),
    title: z.string().min(1).max(160),
    questions: z
      .array(
        z.strictObject({
          id: z.string().regex(/^q[1-5]$/),
          prompt: z.string().min(1).max(160),
          options: z.array(Option).min(2).max(4),
          explanation: Explanation,
        }),
      )
      .min(1)
      .max(5),
  }),
]);

interface ActivityColumns {
  activity_id: string;
  room_id: string;
  kind: string;
  title: string;
  definition: unknown;
  state: string;
  created_at: Date | string;
}

function activityOf(row: ActivityColumns): ActivityRow {
  const definition: StoredDefinition = StoredDefinitionSchema.parse(row.definition);
  if (row.kind !== definition.kind) throw new Error('ROOMS_ACTIVITY_KIND_MISMATCH');
  if (row.state !== 'open' && row.state !== 'closed' && row.state !== 'removed')
    throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: state');
  return {
    activityId: row.activity_id,
    roomId: row.room_id,
    kind: definition.kind,
    title: row.title,
    definition,
    state: row.state,
    createdAt: new Date(row.created_at),
  };
}

/** Postgres polls, quizzes and votes (migration 0064). The use cases decide access; this only runs queries. */
export const activityStore: ActivityStore = {
  async list(lock, accountId, limit) {
    const rows = await sql<ActivityColumns & { voted: boolean }>`
      select activity.activity_id, activity.room_id, activity.kind, activity.title, activity.definition,
        activity.state, activity.created_at,
        exists (
          select 1 from rooms.poll_votes vote
          where vote.activity_id = activity.activity_id and vote.account_id = ${accountId}::uuid
        ) as voted
      from rooms.activities activity
      where activity.room_id = ${lock.roomId}::uuid and activity.state <> 'removed'
      order by (activity.state = 'open') desc, activity.created_at desc, activity.activity_id
      limit ${limit}`.execute(sharedTransactionOf(lock.shared));
    return rows.rows.map((row) => ({ row: activityOf(row), voted: row.voted }));
  },

  async load(lock, activityId, rowLock) {
    const query = sharedTransactionOf(lock.shared)
      .selectFrom('rooms.activities')
      .select(['activity_id', 'room_id', 'kind', 'title', 'definition', 'state', 'created_at'])
      .where('room_id', '=', lock.roomId)
      .where('activity_id', '=', activityId);
    const row = await (
      rowLock === 'none' ? query : rowLock === 'share' ? query.forShare() : query.forUpdate()
    ).executeTakeFirst();
    return row === undefined ? undefined : activityOf(row);
  },

  async create(lock, activity) {
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.activities')
      .values({
        activity_id: activity.activityId,
        room_id: lock.roomId,
        kind: activity.kind,
        title: activity.title,
        definition: JSON.stringify(activity.definition),
        state: 'open',
        created_by_account_id: activity.createdByAccountId,
        created_at: activity.now,
      })
      .execute();
  },

  async setState(lock, activityId, state, now) {
    await sharedTransactionOf(lock.shared)
      .updateTable('rooms.activities')
      .set({ state, closed_at: now })
      .where('room_id', '=', lock.roomId)
      .where('activity_id', '=', activityId)
      .execute();
  },

  async openCount(lock) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.activities')
      .select((builder) => builder.fn.countAll<string>().as('count'))
      .where('room_id', '=', lock.roomId)
      .where('state', '=', 'open')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  },

  async startedSince(lock, since) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.activities')
      .select((builder) => builder.fn.countAll<string>().as('count'))
      .where('room_id', '=', lock.roomId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  },

  async vote(lock, activityId, accountId, optionId, now) {
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.poll_votes')
      .values({ activity_id: activityId, account_id: accountId, option_id: optionId, voted_at: now })
      .onConflict((conflict) =>
        conflict.columns(['activity_id', 'account_id']).doUpdateSet({ option_id: optionId, voted_at: now }),
      )
      .execute();
  },

  async yourVote(lock, activityId, accountId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.poll_votes')
      .select('option_id')
      .where('activity_id', '=', activityId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row?.option_id;
  },

  async tally(lock, activityId, votersPerOption) {
    // Counts are exact; the voters named are the first to have voted, in a stable order.
    const rows = await sql<{ option_id: string; votes: string; voters: string[] }>`
      select option_id, count(*) as votes,
        (array_agg(account_id order by voted_at, account_id))[1:${votersPerOption}::int] as voters
      from rooms.poll_votes
      where activity_id = ${activityId}::uuid
      group by option_id`.execute(sharedTransactionOf(lock.shared));
    return rows.rows.map((row) => ({
      optionId: row.option_id,
      votes: Number(row.votes),
      voterAccountIds: row.voters,
    }));
  },
};
