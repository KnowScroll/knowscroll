/**
 * Optional room activity (#245, R03, D-051) over real PostgreSQL: a moderator's poll and quiz, inside one
 * room only. Votes are visible to the room and can be changed until the poll closes; a quiz stores nothing
 * about anyone; nothing here is evidence, and nobody can be pushed into it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  joinRoom,
  joined,
  makeModerator,
  readActivity,
  roomWorld,
  seedRoom,
  startPoll,
  unwrap,
  votePoll,
  type RoomWorld,
} from '../support/rooms.js';
import { consumptionRows, seedFriend, type Friend } from '../support/talk.js';

const version = 'rooms.v1' as const;

describe('optional room activity (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_activities');
    world = await roomWorld(database);
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  /** A room with a moderator and two members. */
  async function room(overrides: Parameters<typeof seedRoom>[1] = {}) {
    const { roomId, slug } = await seedRoom(world, overrides);
    const moderator = await seedFriend(world.db, world.friends);
    unwrap(await joinRoom(world, moderator, roomId));
    await makeModerator(world, slug, moderator);
    const [one, two] = await joined(world, roomId, 2);
    return { roomId, slug, moderator, one: one!, two: two! };
  }

  const listOf = async (person: Friend, roomId: string) =>
    unwrap(await world.rooms.activities(person.authority, { version, readId: randomUUID(), roomId }));

  it('lets only a moderator start a poll, and shows it to members only', async () => {
    const { roomId, moderator, one } = await room();
    expect((await startPoll(world, one, roomId)).kind).toBe('refused');
    const created = unwrap(await startPoll(world, moderator, roomId));
    const stranger = await seedFriend(world.db, world.friends);
    expect(await listOf(stranger, roomId)).toMatchObject({ status: 'unavailable' });
    expect(
      unwrap(
        await world.rooms.readActivity(stranger.authority, {
          version,
          readId: randomUUID(),
          roomId,
          activityId: created.activityId,
        }),
      ),
    ).toMatchObject({ status: 'unavailable' });
    const list = await listOf(one, roomId);
    if (list.status !== 'ready') throw new Error('expected a list');
    expect(list.canCreate).toBe(false);
    expect(list.activities).toMatchObject([
      { activityId: created.activityId, kind: 'poll', state: 'open', voted: false },
    ]);
    const asModerator = await listOf(moderator, roomId);
    expect(asModerator.status === 'ready' && asModerator.canCreate).toBe(true);
  });

  it('counts each person’s one vote, lets them change it, and shows the room who voted', async () => {
    const { roomId, moderator, one, two } = await room();
    const { activityId } = unwrap(await startPoll(world, moderator, roomId));
    const consumptionBefore = await consumptionRows(world.db);
    unwrap(await votePoll(world, one, roomId, activityId, 'o1'));
    unwrap(await votePoll(world, two, roomId, activityId, 'o1'));
    let view = await readActivity(world, one, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view.activity.options.map((option) => option.votes)).toEqual([2, 0, 0]);
    expect(view.activity.options[0]?.voters?.map((voter) => voter.personId).sort()).toEqual(
      [one.person.personId, two.person.personId].sort(),
    );
    expect(view.canModerate).toBe(false);

    // A change of mind is a new command: the vote moves, the total stays at one each.
    unwrap(await votePoll(world, two, roomId, activityId, 'o3'));
    view = await readActivity(world, two, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view.activity.options.map((option) => option.votes)).toEqual([1, 0, 1]);
    expect(view.activity.yourVote).toBe('o3');
    // A vote is conversation: it leaves no exposure, observation or Keep behind.
    expect(await consumptionRows(world.db)).toBe(consumptionBefore);
    expect(
      await world.db
        .selectFrom('rooms.poll_votes')
        .select('account_id')
        .where('activity_id', '=', activityId)
        .execute(),
    ).toHaveLength(2);
  });

  it('replays the same vote command, refuses it with another body, and refuses an option the poll does not have', async () => {
    const { roomId, moderator, one } = await room();
    const { activityId } = unwrap(await startPoll(world, moderator, roomId));
    const commandId = randomUUID();
    const first = unwrap(
      await world.rooms.votePoll(one.authority, { version, commandId, roomId, activityId, optionId: 'o2' }),
    );
    const again = unwrap(
      await world.rooms.votePoll(one.authority, { version, commandId, roomId, activityId, optionId: 'o2' }),
    );
    expect(again).toMatchObject({ commandId, optionId: 'o2', replayed: true, recordedAt: first.recordedAt });
    expect(
      await world.rooms.votePoll(one.authority, { version, commandId, roomId, activityId, optionId: 'o1' }),
    ).toEqual({
      kind: 'refused',
      code: 'command_key_reused',
    });
    expect(await votePoll(world, one, roomId, activityId, 'o5')).toEqual({ kind: 'refused', code: 'invalid_input' });
  });

  it('takes no vote after the moderator closes the poll, keeps the votes it has, and never serves a removed one', async () => {
    const { roomId, moderator, one, two } = await room();
    const { activityId } = unwrap(await startPoll(world, moderator, roomId));
    unwrap(await votePoll(world, one, roomId, activityId, 'o2'));
    const closing = { version, roomId, activityId, action: 'close' as const };
    expect((await world.rooms.moderateActivity(one.authority, { ...closing, commandId: randomUUID() })).kind).toBe(
      'refused',
    );
    unwrap(await world.rooms.moderateActivity(moderator.authority, { ...closing, commandId: randomUUID() }));
    // Closing again is already what was asked.
    unwrap(await world.rooms.moderateActivity(moderator.authority, { ...closing, commandId: randomUUID() }));
    expect((await votePoll(world, two, roomId, activityId, 'o1')).kind).toBe('refused');
    expect((await votePoll(world, one, roomId, activityId, 'o3')).kind).toBe('refused');
    const view = await readActivity(world, two, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view).toMatchObject({ state: 'closed' });
    expect(view.activity.canVote).toBe(false);
    expect(view.activity.options.map((option) => option.votes)).toEqual([0, 1, 0]);

    unwrap(
      await world.rooms.moderateActivity(moderator.authority, {
        ...closing,
        action: 'remove',
        commandId: randomUUID(),
      }),
    );
    expect(await readActivity(world, one, roomId, activityId)).toMatchObject({ status: 'unavailable' });
    const list = await listOf(one, roomId);
    expect(list.status === 'ready' && list.activities).toEqual([]);
  });

  it('refuses a vote and a new poll while the room is paused', async () => {
    const { roomId, moderator, one } = await room();
    const { activityId } = unwrap(await startPoll(world, moderator, roomId));
    unwrap(
      await world.rooms.moderate(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        action: { kind: 'pause' },
      }),
    );
    expect((await votePoll(world, one, roomId, activityId, 'o1')).kind).toBe('refused');
    expect((await startPoll(world, moderator, roomId)).kind).toBe('refused');
    const view = await readActivity(world, one, roomId, activityId);
    expect(view.status === 'ready' && view.activity.kind === 'poll' && view.activity.canVote).toBe(false);
    unwrap(
      await world.rooms.moderate(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        action: { kind: 'resume' },
      }),
    );
    unwrap(await votePoll(world, one, roomId, activityId, 'o1'));
  });

  it('bounds a room to five open activities and twenty a day', async () => {
    const { roomId, moderator } = await room();
    const opened = [];
    for (let index = 0; index < 5; index++) opened.push(unwrap(await startPoll(world, moderator, roomId)));
    expect(await startPoll(world, moderator, roomId)).toEqual({ kind: 'refused', code: 'rate_limited' });
    for (const poll of opened)
      unwrap(
        await world.rooms.moderateActivity(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          activityId: poll.activityId,
          action: 'close',
        }),
      );
    // Closed ones free the open bound but still count toward the day.
    for (let index = 0; index < 5; index++) {
      const next = unwrap(await startPoll(world, moderator, roomId));
      unwrap(
        await world.rooms.moderateActivity(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          activityId: next.activityId,
          action: 'close',
        }),
      );
    }
    for (let index = 0; index < 5; index++) {
      const next = unwrap(await startPoll(world, moderator, roomId));
      unwrap(
        await world.rooms.moderateActivity(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          activityId: next.activityId,
          action: 'close',
        }),
      );
    }
    for (let index = 0; index < 5; index++) {
      const next = unwrap(await startPoll(world, moderator, roomId));
      unwrap(
        await world.rooms.moderateActivity(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          activityId: next.activityId,
          action: 'close',
        }),
      );
    }
    expect(await startPoll(world, moderator, roomId)).toEqual({ kind: 'refused', code: 'rate_limited' });
    // The next UTC day starts afresh.
    const before = world.clock.now;
    world.clock.now = new Date(before.getTime() + 24 * 60 * 60 * 1000);
    try {
      unwrap(await startPoll(world, moderator, roomId));
    } finally {
      world.clock.now = before;
    }
  });

  it('serves a quiz whole and keeps nothing about anyone who reads it', async () => {
    const { roomId, moderator, one, two } = await room();
    const created = unwrap(
      await world.rooms.createActivity(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        activity: {
          kind: 'quiz',
          title: 'Room quiz',
          questions: [
            {
              prompt: 'Requests arrive one every few seconds. Does a large batch size help?',
              options: ['Yes, bigger is always faster', 'Not much, batches rarely fill', 'Only on new hardware'],
              explanation: {
                heading: 'Slow trickle of requests',
                text: 'Batches rarely fill, so a big batch size mostly adds waiting.',
                note: 'A maximum wait sends whatever has arrived.',
              },
            },
            {
              prompt: 'Traffic grows tenfold. What changes?',
              options: ['Batches fill quickly', 'Nothing changes'],
              explanation: { heading: 'Ten times the traffic', text: 'Throughput rises with little extra wait.' },
            },
          ],
        },
      }),
    );
    const before = await rowCounts();
    const consumptionBefore = await consumptionRows(world.db);
    const first = await readActivity(world, one, roomId, created.activityId);
    const second = await readActivity(world, two, roomId, created.activityId);
    if (first.status !== 'ready' || first.activity.kind !== 'quiz') throw new Error('expected a quiz');
    expect(first.activity.questions.map((question) => question.questionId)).toEqual(['q1', 'q2']);
    expect(first.activity.questions[0]?.options.map((option) => option.optionId)).toEqual(['o1', 'o2', 'o3']);
    // Two readers get the same quiz; there is no per-person field and no way to send an answer.
    expect({ ...first, readId: 'x' }).toEqual({ ...second, scope: first.scope, readId: 'x' });
    expect(JSON.stringify(first)).not.toMatch(/yourVote|score|answered|correct/i);
    expect(await rowCounts()).toEqual(before);
    expect(await consumptionRows(world.db)).toEqual(consumptionBefore);
    const row = await world.db
      .selectFrom('rooms.activities')
      .select(['kind', 'title'])
      .where('activity_id', '=', created.activityId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ kind: 'quiz', title: 'Room quiz' });
    // A quiz is not a poll: a vote on it is refused.
    expect((await votePoll(world, one, roomId, created.activityId, 'o1')).kind).toBe('refused');
  });

  it('refuses a malformed activity with one invalid answer, and never starts one without a moderator', async () => {
    const { roomId, moderator } = await room();
    const bad = (activity: object) =>
      world.rooms.createActivity(moderator.authority, { version, commandId: randomUUID(), roomId, activity });
    expect(await bad({ kind: 'poll', prompt: 'One option?', options: ['Only'] })).toEqual({
      kind: 'refused',
      code: 'invalid_input',
    });
    expect(await bad({ kind: 'poll', prompt: 'Same?', options: ['A', 'a'] })).toEqual({
      kind: 'refused',
      code: 'invalid_input',
    });
    expect(await bad({ kind: 'quiz', title: 'Empty', questions: [] })).toEqual({
      kind: 'refused',
      code: 'invalid_input',
    });
    expect(await bad({ kind: 'poll', prompt: 'Extra field', options: ['A', 'B'], score: 3 })).toEqual({
      kind: 'refused',
      code: 'invalid_input',
    });
    // The inhabitants have no path to an activity: only a moderator account ever appears as a creator.
    const creators = await sql<{ n: string }>`
      select count(*)::text as n from rooms.activities a
      where a.created_by_account_id is not null and not exists (
        select 1 from rooms.members m where m.room_id = a.room_id and m.account_id = a.created_by_account_id and m.role = 'moderator')`.execute(
      world.db,
    );
    expect(creators.rows[0]?.n).toBe('0');
  });

  it('sends a tally and the voters only to someone who has voted, or to anyone once the poll is closed', async () => {
    const { roomId, moderator, one, two } = await room();
    const { activityId } = unwrap(await startPoll(world, moderator, roomId));
    unwrap(await votePoll(world, one, roomId, activityId, 'o1'));
    const pollOf = async (person: typeof one) => {
      const view = await readActivity(world, person, roomId, activityId);
      if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
      return { view, poll: view.activity, json: JSON.stringify(view) };
    };

    // Someone who has not voted (a member, and the moderator) is told nothing of how others voted.
    for (const person of [two, moderator]) {
      const hidden = await pollOf(person);
      expect(hidden.poll.resultsVisible).toBe(false);
      expect(hidden.poll.yourVote).toBeUndefined();
      expect(hidden.poll.options.every((option) => option.votes === undefined && option.voters === undefined)).toBe(
        true,
      );
      expect(hidden.json).not.toContain(one.person.displayName);
      expect(hidden.json).not.toContain(one.person.personId);
      expect(hidden.json).not.toMatch(/"votes"|"voters"/);
    }
    // The voter sees results, with names.
    const voted = await pollOf(one);
    expect(voted.poll.resultsVisible).toBe(true);
    expect(voted.poll.options.map((option) => option.votes)).toEqual([1, 0, 0]);
    // Voting opens the results to the one who voted, and only to them.
    unwrap(await votePoll(world, two, roomId, activityId, 'o2'));
    const after = await pollOf(two);
    expect(after.poll.resultsVisible).toBe(true);
    expect(after.poll.options.map((option) => option.votes)).toEqual([1, 1, 0]);
    expect((await pollOf(moderator)).poll.resultsVisible).toBe(false);
    // Closing shows everyone, who voted or not.
    unwrap(
      await world.rooms.moderateActivity(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        activityId,
        action: 'close',
      }),
    );
    const closed = await pollOf(moderator);
    expect(closed.poll.resultsVisible).toBe(true);
    expect(closed.poll.options.map((option) => option.votes)).toEqual([1, 1, 0]);
  });

  it('keeps the open and daily bounds exact when many moderators start an activity at once', async () => {
    let mostOpen = 0;
    for (let round = 0; round < 6; round++) {
      const { roomId, slug } = await seedRoom(world);
      const moderators: Friend[] = [];
      for (let index = 0; index < 10; index++) {
        const moderator = await seedFriend(world.db, world.friends);
        unwrap(await joinRoom(world, moderator, roomId));
        await makeModerator(world, slug, moderator);
        moderators.push(moderator);
      }
      for (let index = 0; index < 4; index++) unwrap(await startPoll(world, moderators[0]!, roomId));
      const outcomes = await Promise.all(moderators.map((moderator) => startPoll(world, moderator, roomId)));
      const open = await world.db
        .selectFrom('rooms.activities')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('room_id', '=', roomId)
        .where('state', '=', 'open')
        .executeTakeFirstOrThrow();
      mostOpen = Math.max(mostOpen, Number(open.n));
      // Exactly one of the ten fits under the bound of five; the rest are told the room has enough open.
      expect(outcomes.filter((outcome) => outcome.kind === 'ok')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'refused' && outcome.code === 'rate_limited')).toHaveLength(
        9,
      );
    }
    expect(mostOpen).toBe(5);

    // The same under the daily bound: nineteen already started and closed today, ten start at once.
    const { roomId, slug } = await seedRoom(world);
    const moderators: Friend[] = [];
    for (let index = 0; index < 10; index++) {
      const moderator = await seedFriend(world.db, world.friends);
      unwrap(await joinRoom(world, moderator, roomId));
      await makeModerator(world, slug, moderator);
      moderators.push(moderator);
    }
    for (let index = 0; index < 19; index++)
      await world.db
        .insertInto('rooms.activities')
        .values({
          activity_id: randomUUID(),
          room_id: roomId,
          kind: 'poll',
          title: 'Earlier today',
          definition: JSON.stringify({
            kind: 'poll',
            prompt: 'Earlier today',
            options: [
              { id: 'o1', text: 'A' },
              { id: 'o2', text: 'B' },
            ],
          }),
          state: 'closed',
          created_by_account_id: moderators[0]!.accountId,
          created_at: world.clock.now,
          closed_at: world.clock.now,
        })
        .execute();
    const outcomes = await Promise.all(moderators.map((moderator) => startPoll(world, moderator, roomId)));
    expect(outcomes.filter((outcome) => outcome.kind === 'ok')).toHaveLength(1);
    const today = await world.db
      .selectFrom('rooms.activities')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('room_id', '=', roomId)
      .executeTakeFirstOrThrow();
    expect(Number(today.n)).toBe(20);
  }, 120_000);

  it('keeps a full-length quiz in a script of three-byte letters, as the contract allows', async () => {
    const { roomId, moderator, one } = await room();
    // 160 + 5 x (160 + 4 x 80 + 80 + 240 + 160) letters, each three bytes in UTF-8.
    const letters = (count: number, tag: string) => (tag + '界'.repeat(count)).slice(0, count);
    const question = (q: number) => ({
      prompt: letters(160, `q${String(q)}`),
      options: [1, 2, 3, 4].map((o) => letters(80, `o${String(o)}`)),
      explanation: { heading: letters(80, 'h'), text: letters(240, 't'), note: letters(160, 'n') },
    });
    const created = unwrap(
      await world.rooms.createActivity(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        activity: { kind: 'quiz', title: letters(160, 'title'), questions: [1, 2, 3, 4, 5].map(question) },
      }),
    );
    const stored = await sql<{ bytes: number }>`
      select octet_length(definition::text) as bytes from rooms.activities where activity_id = ${created.activityId}::uuid`.execute(
      world.db,
    );
    // Bigger than the old 12 KiB bound, inside the new one.
    expect(stored.rows[0]!.bytes).toBeGreaterThan(12_288);
    expect(stored.rows[0]!.bytes).toBeLessThan(32_768);
    const view = await readActivity(world, one, roomId, created.activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'quiz') throw new Error('expected a quiz');
    expect(view.activity.questions).toHaveLength(5);
    expect(view.activity.questions[4]!.explanation.note).toBe(letters(160, 'n'));
  });

  /** The rows of every rooms table: reading a quiz writes none. */
  async function rowCounts() {
    const result = await sql<{ table: string; n: string }>`
      select 'activities' as table, count(*)::text as n from rooms.activities
      union all select 'poll_votes', count(*)::text from rooms.poll_votes
      union all select 'members', count(*)::text from rooms.members
      union all select 'messages', count(*)::text from rooms.messages`.execute(world.db);
    return result.rows;
  }
});
