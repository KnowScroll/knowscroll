import { sql } from 'kysely';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { LaunchRow } from '../application/launch-ports.js';
import type { LaunchStore } from '../application/ports.js';
import { PLAY_MS } from '../domain/launch.js';

const trxOf = (lock: Parameters<LaunchStore['latest']>[0]) => sharedTransactionOf(lock.shared);

interface Columns {
  launch_id: string;
  deck_ritual_id: string;
  questions: unknown;
  starts_at: Date | string;
  created_at: Date | string;
  state: string;
  finished_at: Date | string | null;
  played: number | null;
  star: boolean | null;
}

const COLUMNS = [
  'launch_id',
  'deck_ritual_id',
  'questions',
  'starts_at',
  'created_at',
  'state',
  'finished_at',
  'played',
  'star',
] as const;

const rowOf = (row: Columns): LaunchRow => {
  if (row.state !== 'live' && row.state !== 'finished') throw new Error('ROOMS_COLUMN_OUT_OF_RANGE: launch state');
  return {
    launchId: row.launch_id,
    deckRitualId: row.deck_ritual_id,
    questions: row.questions,
    startsAt: new Date(row.starts_at),
    createdAt: new Date(row.created_at),
    state: row.state,
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
    played: row.played,
    star: row.star,
  };
};

/**
 * The room's Launches, their players and answers (migration 0088). Every method is one explicit query inside the room's lock; none
 * decides access or a result. An unfinished Launch is at most one per room (a partial unique index), and a deck is played once (a
 * unique key), so a retry or two commands at once cannot make a second.
 */
export const launchStore: LaunchStore = {
  async unfinished(lock, rowLock) {
    const query = trxOf(lock)
      .selectFrom('rooms.launches')
      .select(COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('state', '=', 'live');
    const found = await (
      rowLock === 'share' ? query.forShare() : rowLock === 'update' ? query.forUpdate() : query
    ).executeTakeFirst();
    return found === undefined ? undefined : rowOf(found);
  },

  async latest(lock) {
    const found = await trxOf(lock)
      .selectFrom('rooms.launches')
      .select(COLUMNS)
      .where('room_id', '=', lock.roomId)
      .orderBy('starts_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return found === undefined ? undefined : rowOf(found);
  },

  async readyDeck(lock, fromDay, toDay) {
    const found = await sql<{ ritual_id: string; payload: unknown }>`
      select ritual.ritual_id, ritual.payload from rooms.rituals ritual
      where ritual.room_id = ${lock.roomId}::uuid and ritual.kind = 'launch' and ritual.state = 'approved'
        and ritual.day between ${fromDay}::date and ${toDay}::date
        and not exists (select 1 from rooms.launches launch where launch.deck_ritual_id = ritual.ritual_id)
      order by ritual.day desc limit 1`.execute(trxOf(lock));
    const [row] = found.rows;
    return row === undefined ? undefined : { ritualId: row.ritual_id, payload: row.payload };
  },

  async insert(lock, launch) {
    await trxOf(lock)
      .insertInto('rooms.launches')
      .values({
        launch_id: launch.launchId,
        room_id: lock.roomId,
        deck_ritual_id: launch.deckRitualId,
        questions: JSON.stringify(launch.questions),
        starts_at: launch.startsAt,
        created_at: launch.now,
        state: 'live',
      })
      .execute();
  },

  async addPlayer(lock, launchId, accountId, now) {
    const inserted = await trxOf(lock)
      .insertInto('rooms.launch_players')
      .values({ launch_id: launchId, account_id: accountId, joined_at: now })
      .onConflict((conflict) => conflict.columns(['launch_id', 'account_id']).doNothing())
      .executeTakeFirst();
    return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
  },

  async players(lock, launchId) {
    const found = await trxOf(lock)
      .selectFrom('rooms.launch_players')
      .select(['account_id', 'joined_at'])
      .where('launch_id', '=', launchId)
      .orderBy('joined_at')
      .orderBy('account_id')
      .execute();
    return found.map((row) => ({ accountId: row.account_id, joinedAt: new Date(row.joined_at) }));
  },

  async isPlayer(lock, launchId, accountId) {
    const found = await trxOf(lock)
      .selectFrom('rooms.launch_players')
      .select('account_id')
      .where('launch_id', '=', launchId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return found !== undefined;
  },

  async answers(lock, launchId) {
    const found = await trxOf(lock)
      .selectFrom('rooms.launch_answers')
      .select(['account_id', 'round', 'choice', 'correct', 'elapsed_ms'])
      .where('launch_id', '=', launchId)
      .execute();
    return found.map((row) => ({
      accountId: row.account_id,
      round: row.round,
      choice: row.choice,
      correct: row.correct,
      elapsedMs: row.elapsed_ms,
    }));
  },

  async ownAnswer(lock, launchId, round, accountId) {
    const found = await trxOf(lock)
      .selectFrom('rooms.launch_answers')
      .select(['account_id', 'round', 'choice', 'correct', 'elapsed_ms'])
      .where('launch_id', '=', launchId)
      .where('round', '=', round)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return found === undefined
      ? undefined
      : {
          accountId: found.account_id,
          round: found.round,
          choice: found.choice,
          correct: found.correct,
          elapsedMs: found.elapsed_ms,
        };
  },

  async addAnswer(lock, answer) {
    const inserted = await trxOf(lock)
      .insertInto('rooms.launch_answers')
      .values({
        launch_id: answer.launchId,
        round: answer.round,
        account_id: answer.accountId,
        choice: answer.choice,
        elapsed_ms: answer.elapsedMs,
        correct: answer.correct,
        answered_at: answer.now,
      })
      .onConflict((conflict) => conflict.columns(['launch_id', 'round', 'account_id']).doNothing())
      .executeTakeFirst();
    return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
  },

  async finish(lock, launchId, result) {
    const updated = await trxOf(lock)
      .updateTable('rooms.launches')
      .set({ state: 'finished', finished_at: result.at, played: result.played, star: result.star })
      .where('launch_id', '=', launchId)
      .where('state', '=', 'live')
      .executeTakeFirst();
    return (updated.numUpdatedRows ?? 0n) > 0n;
  },

  async purgeResults(lock, before) {
    const trx = trxOf(lock);
    const old = sql`(select launch_id from rooms.launches where room_id = ${lock.roomId}::uuid
      and state = 'finished' and finished_at < ${before})`;
    await sql`delete from rooms.launch_answers where launch_id in ${old}`.execute(trx);
    await sql`delete from rooms.launch_players where launch_id in ${old}`.execute(trx);
  },

  async forgetMember(lock, accountId) {
    const trx = trxOf(lock);
    const own = sql`(select launch_id from rooms.launches where room_id = ${lock.roomId}::uuid)`;
    await sql`delete from rooms.launch_answers where account_id = ${accountId}::uuid and launch_id in ${own}`.execute(
      trx,
    );
    await sql`delete from rooms.launch_players where account_id = ${accountId}::uuid and launch_id in ${own}`.execute(
      trx,
    );
  },

  async liveRooms(scope, roomIds, now) {
    if (roomIds.length === 0) return new Set();
    const cutoff = new Date(now.getTime() - PLAY_MS);
    const found = await sql<{ room_id: string }>`
      select distinct room_id from rooms.launches
      where room_id = any(${roomIds}::uuid[]) and state = 'live' and starts_at > ${cutoff}`.execute(
      transactionOf(scope),
    );
    return new Set(found.rows.map((row) => row.room_id));
  },
};
