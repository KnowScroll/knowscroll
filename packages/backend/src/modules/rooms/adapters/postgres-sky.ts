import { sql } from 'kysely';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type {
  ConstellationRow,
  DebateStore,
  RitualRow,
  SkyFigures,
  SkyStore,
  StarActName,
  TodayStore,
} from '../application/ports.js';

const trxOf = (lock: Parameters<SkyStore['lock']>[0]) => sharedTransactionOf(lock.shared);

const asDate = (value: Date | string): Date => new Date(value);

interface ConstellationColumns {
  no: number;
  completed_at: Date | string;
  candidates: string[];
  vote_closes_at: Date | string;
  name: string | null;
}

const constellationOf = (row: ConstellationColumns): ConstellationRow => ({
  no: row.no,
  completedAt: asDate(row.completed_at),
  candidates: [row.candidates[0]!, row.candidates[1]!, row.candidates[2]!],
  voteClosesAt: asDate(row.vote_closes_at),
  name: row.name,
});

/**
 * The room's stars, constellations and the vote that names one (migration 0085). Every method is one explicit query inside
 * the room's lock; none decides access or an award. `lock` takes the room's sky advisory lock, which the use case takes
 * last, so the day's count and the unique insert after it are exact.
 */
export const skyStore: SkyStore = {
  async lock(lock) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`rooms.sky:${lock.roomId}`}, 0))`.execute(trxOf(lock));
  },

  async hasStar(lock, act, sourceKey) {
    const row = await trxOf(lock)
      .selectFrom('rooms.stars')
      .select('star_id')
      .where('room_id', '=', lock.roomId)
      .where('act', '=', act)
      .where('source_key', '=', sourceKey)
      .executeTakeFirst();
    return row !== undefined;
  },

  async starsOn(lock, day) {
    const result = await sql<{ n: string }>`
      select count(*) as n from rooms.stars where room_id = ${lock.roomId}::uuid and earned_on = ${day}::date`.execute(
      trxOf(lock),
    );
    return Number(result.rows[0]!.n);
  },

  async starTotal(lock) {
    const row = await trxOf(lock)
      .selectFrom('rooms.stars')
      .select(sql<string>`count(*)`.as('n'))
      .where('room_id', '=', lock.roomId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  },

  async insertStar(lock, star) {
    await sql`
      insert into rooms.stars (star_id, room_id, act, source_key, earned_at, earned_on, constellation_no)
      values (${star.starId}::uuid, ${lock.roomId}::uuid, ${star.act}, ${star.sourceKey}::uuid, ${star.at},
        ${star.day}::date, ${star.constellationNo})`.execute(trxOf(lock));
  },

  async latestStars(lock, limit) {
    const result = await sql<{ act: string; day: string; constellation_no: number }>`
      select act, to_char(earned_on, 'YYYY-MM-DD') as day, constellation_no
      from rooms.stars where room_id = ${lock.roomId}::uuid
      order by earned_at desc, star_id desc limit ${limit}`.execute(trxOf(lock));
    return result.rows.map((row) => ({
      act: row.act as StarActName,
      day: row.day,
      constellation: row.constellation_no,
    }));
  },

  async constellations(lock) {
    const rows = await trxOf(lock)
      .selectFrom('rooms.constellations')
      .select(['no', 'completed_at', 'candidates', 'vote_closes_at', 'name'])
      .where('room_id', '=', lock.roomId)
      .orderBy('no')
      .execute();
    return rows.map(constellationOf);
  },

  async insertConstellation(lock, row) {
    await trxOf(lock)
      .insertInto('rooms.constellations')
      .values({
        room_id: lock.roomId,
        no: row.no,
        completed_at: row.completedAt,
        candidates: [...row.candidates],
        vote_closes_at: row.voteClosesAt,
      })
      .execute();
  },

  async name(lock, no, name, at) {
    await trxOf(lock)
      .updateTable('rooms.constellations')
      .set({ name, named_at: at })
      .where('room_id', '=', lock.roomId)
      .where('no', '=', no)
      .where('name', 'is', null)
      .execute();
  },

  async votes(lock, no) {
    const rows = await trxOf(lock)
      .selectFrom('rooms.constellation_votes')
      .select(['candidate', sql<string>`count(*)`.as('n')])
      .where('room_id', '=', lock.roomId)
      .where('no', '=', no)
      .groupBy('candidate')
      .execute();
    const counts: [number, number, number] = [0, 0, 0];
    for (const row of rows) counts[row.candidate] = Number(row.n);
    return counts;
  },

  async yourVote(lock, no, accountId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.constellation_votes')
      .select('candidate')
      .where('room_id', '=', lock.roomId)
      .where('no', '=', no)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined ? undefined : (row.candidate as 0 | 1 | 2);
  },

  async setVote(lock, no, accountId, candidate, now) {
    await trxOf(lock)
      .insertInto('rooms.constellation_votes')
      .values({ room_id: lock.roomId, no, account_id: accountId, candidate, voted_at: now })
      .onConflict((conflict) =>
        conflict.columns(['room_id', 'no', 'account_id']).doUpdateSet({ candidate, voted_at: now }),
      )
      .execute();
  },

  async forgetMember(lock, accountId) {
    const trx = trxOf(lock);
    await sql`delete from rooms.constellation_votes where room_id = ${lock.roomId}::uuid and account_id = ${accountId}::uuid`.execute(
      trx,
    );
    await sql`delete from rooms.debate_votes where account_id = ${accountId}::uuid and discussion_id in (
      select discussion_id from rooms.discussions where room_id = ${lock.roomId}::uuid)`.execute(trx);
    await sql`delete from rooms.ritual_solves where account_id = ${accountId}::uuid and ritual_id in (
      select ritual_id from rooms.rituals where room_id = ${lock.roomId}::uuid)`.execute(trx);
  },

  async figures(scope, roomIds) {
    if (roomIds.length === 0) return new Map<string, SkyFigures>();
    const result = await sql<{
      room_id: string;
      stars: string;
      latest_name: string | null;
      latest_is_named: boolean | null;
    }>`
      select room.room_id,
        (select count(*) from rooms.stars star where star.room_id = room.room_id) as stars,
        (select constellation.name from rooms.constellations constellation
          where constellation.room_id = room.room_id and constellation.name is not null
          order by constellation.no desc limit 1) as latest_name,
        (select constellation.name is not null from rooms.constellations constellation
          where constellation.room_id = room.room_id order by constellation.no desc limit 1) as latest_is_named
      from rooms.rooms room where room.room_id = any(${[...roomIds]}::uuid[])`.execute(transactionOf(scope));
    return new Map(
      result.rows.map((row) => [
        row.room_id,
        {
          stars: Number(row.stars),
          latestIsNamed: row.latest_is_named === true,
          latestName: row.latest_name ?? undefined,
        } satisfies SkyFigures,
      ]),
    );
  },
};

/** Debates (migration 0085): the two sides and the close of a topic tagged `debate`, and its votes. */
export const debateStore: DebateStore = {
  async insert(lock, debate) {
    await trxOf(lock)
      .insertInto('rooms.debates')
      .values({
        discussion_id: debate.discussionId,
        side_a: debate.sides[0],
        side_b: debate.sides[1],
        closes_at: debate.closesAt,
        state: 'open',
      })
      .execute();
  },

  async load(lock, discussionId, rowLock) {
    const trx = trxOf(lock);
    const inRoom = await trx
      .selectFrom('rooms.discussions')
      .select('discussion_id')
      .where('discussion_id', '=', discussionId)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    if (inRoom === undefined) return undefined;
    const query = trx
      .selectFrom('rooms.debates')
      .select(['discussion_id', 'side_a', 'side_b', 'closes_at', 'state', 'winner'])
      .where('discussion_id', '=', discussionId);
    // A vote holds the row FOR SHARE, so it cannot land while a close (which takes it FOR UPDATE) is deciding.
    const row = await (rowLock === 'share' ? query.forShare() : query).executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          discussionId: row.discussion_id,
          sides: [row.side_a, row.side_b] as const,
          closesAt: asDate(row.closes_at),
          state: row.state as 'open' | 'closed',
          winner: row.winner as 'a' | 'b' | null,
        };
  },

  async tally(lock, discussionId) {
    const rows = await trxOf(lock)
      .selectFrom('rooms.debate_votes')
      .select(['side', sql<string>`count(*)`.as('n')])
      .where('discussion_id', '=', discussionId)
      .groupBy('side')
      .execute();
    const count = (side: string) => Number(rows.find((row) => row.side === side)?.n ?? 0);
    return { a: count('a'), b: count('b') };
  },

  async yourVote(lock, discussionId, accountId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.debate_votes')
      .select('side')
      .where('discussion_id', '=', discussionId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined ? undefined : (row.side as 'a' | 'b');
  },

  async setVote(lock, discussionId, accountId, side, now) {
    await trxOf(lock)
      .insertInto('rooms.debate_votes')
      .values({ discussion_id: discussionId, account_id: accountId, side, voted_at: now })
      .onConflict((conflict) => conflict.columns(['discussion_id', 'account_id']).doUpdateSet({ side, voted_at: now }))
      .execute();
  },

  async closeDue(lock, now, decide) {
    const trx = trxOf(lock);
    // The debate row is the guard: whoever updates it from open wins, so a debate closes and earns once.
    const due = await sql<{ discussion_id: string }>`
      select debate.discussion_id from rooms.debates debate
      join rooms.discussions discussion on discussion.discussion_id = debate.discussion_id
      where discussion.room_id = ${lock.roomId}::uuid and debate.state = 'open' and debate.closes_at <= ${now}
      order by debate.discussion_id for update of debate skip locked`.execute(trx);
    const closed: { discussionId: string; voters: number }[] = [];
    for (const { discussion_id: discussionId } of due.rows) {
      const tally = await debateStore.tally(lock, discussionId);
      const { winner } = decide(tally);
      await trx
        .updateTable('rooms.debates')
        .set({ state: 'closed', closed_at: now, winner: winner ?? null, voters: tally.a + tally.b })
        .where('discussion_id', '=', discussionId)
        .where('state', '=', 'open')
        .execute();
      closed.push({ discussionId, voters: tally.a + tally.b });
    }
    return closed;
  },
};

const ritualOf = (row: { ritual_id: string; day: string; kind: string; payload: unknown }): RitualRow => ({
  ritualId: row.ritual_id,
  day: row.day,
  kind: row.kind as 'question' | 'flaw',
  payload: row.payload,
});

/** Today's approved items and what people tapped (migration 0085). Nothing here is shown until an operator approved it. */
export const todayStore: TodayStore = {
  async approvedOn(lock, day) {
    const result = await sql<{ ritual_id: string; day: string; kind: string; payload: unknown }>`
      select ritual_id, to_char(day, 'YYYY-MM-DD') as day, kind, payload from rooms.rituals
      where room_id = ${lock.roomId}::uuid and day = ${day}::date and state = 'approved'`.execute(trxOf(lock));
    return result.rows.map(ritualOf);
  },

  async approved(lock, ritualId) {
    const result = await sql<{ ritual_id: string; day: string; kind: string; payload: unknown }>`
      select ritual_id, to_char(day, 'YYYY-MM-DD') as day, kind, payload from rooms.rituals
      where room_id = ${lock.roomId}::uuid and ritual_id = ${ritualId}::uuid and state = 'approved'`.execute(
      trxOf(lock),
    );
    const [row] = result.rows;
    return row === undefined ? undefined : ritualOf(row);
  },

  async pastQuestions(lock, day, limit) {
    const result = await sql<{ ritual_id: string; day: string; kind: string; payload: unknown }>`
      select ritual_id, to_char(day, 'YYYY-MM-DD') as day, kind, payload from rooms.rituals
      where room_id = ${lock.roomId}::uuid and day < ${day}::date and kind = 'question' and state = 'approved'
      order by day desc limit ${limit}`.execute(trxOf(lock));
    return result.rows.map(ritualOf);
  },

  async solveOf(lock, ritualId, accountId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.ritual_solves')
      .select(['picked', 'correct'])
      .where('ritual_id', '=', ritualId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined ? undefined : { picked: row.picked, correct: row.correct };
  },

  async insertSolve(lock, solve) {
    const result = await trxOf(lock)
      .insertInto('rooms.ritual_solves')
      .values({
        ritual_id: solve.ritualId,
        account_id: solve.accountId,
        picked: solve.picked,
        correct: solve.correct,
        solved_at: solve.now,
      })
      .onConflict((conflict) => conflict.columns(['ritual_id', 'account_id']).doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  },

  async found(lock, ritualId) {
    const row = await trxOf(lock)
      .selectFrom('rooms.ritual_solves')
      .select(sql<string>`count(*)`.as('n'))
      .where('ritual_id', '=', ritualId)
      .where('correct', '=', true)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  },

  async messagesSince(lock, discussionId, since) {
    const row = await trxOf(lock)
      .selectFrom('rooms.messages')
      .select(sql<string>`count(*)`.as('n'))
      .where('discussion_id', '=', discussionId)
      .where('author_kind', '=', 'person')
      .where('author_account_id', 'is not', null)
      .where('body_text', 'is not', null)
      .where('hidden_at', 'is', null)
      .where('recorded_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  },
};
