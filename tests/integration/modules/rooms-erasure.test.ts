/**
 * Idea rooms and the two erasures (#245, D-043, D-051) over real PostgreSQL: deleting an account turns its
 * words in rooms into tombstones and leaves the room to the others; selective Clear keeps the room and
 * only cancels the asks of AI inhabitants that were waiting. CI fixture accounts, fixture model, no provider.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel } from '../support/fixture-model.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  ask,
  joinRoom,
  makeModerator,
  markUseful,
  memberView,
  readActivity,
  readDiscussion,
  roomWorld,
  say,
  seedRoom,
  setPreferences,
  setPresence,
  startPoll,
  startTopic,
  startTopicFrom,
  unwrap,
  votePoll,
  type RoomWorld,
} from '../support/rooms.js';
import { seedFriend, type Friend } from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';

const version = 'rooms.v1' as const;

describe('idea rooms and erasure (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_erasure');
    world = await roomWorld(database);
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });

  /** A person created by the real operator sign-in (deletion and Clear need the real lifecycle), with a claimed profile. */
  async function namedPerson(): Promise<Friend> {
    const person = await recordingPerson(database);
    const set = await world.friends.setProfile(person.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: `ci.${person.accountId.replaceAll('-', '').slice(0, 14)}`,
      displayName: 'Fixture person',
    });
    if (set.kind !== 'ok') throw new Error('profile refused');
    const read = await world.friends.readProfile(person.authority);
    if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('profile unreadable');
    return { ...person, person: read.value.person };
  }

  const countOf = async (table: string, column: string, value: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*)::text as n from ${sql.table(table)} where ${sql.ref(column)}::text = ${value}`.execute(
          database.db,
        )
      ).rows[0]?.n ?? 0,
    );

  it('turns a deleted person’s words into tombstones and leaves the room to the others', async () => {
    const { roomId } = await seedRoom(world);
    const erased = await namedPerson();
    const staying = await seedFriend(world.db, world.friends);
    unwrap(await joinRoom(world, erased, roomId));
    unwrap(await joinRoom(world, staying, roomId));
    const reel = await seedReel(world.db, { durationMs: 40_000, title: 'Tokens' });
    const started = unwrap(
      await world.rooms.create(erased.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        start: { kind: 'content', root: { assetId: reel.assetId, assetRevision: 1 } },
      }),
    );
    const discussionId = started.discussionId;
    unwrap(await say(world, erased, roomId, discussionId, 'words that will go'));
    unwrap(
      await world.rooms.send(erased.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        discussionId,
        body: {
          kind: 'snippet',
          target: { assetId: reel.assetId, assetRevision: 1 },
          anchor: { kind: 'reel_range', startMs: 5_000, endMs: 15_000 },
        },
      }),
    );
    unwrap(await say(world, staying, roomId, discussionId, 'words that stay'));
    // An inhabitant answers the person who will leave; its words belong to the room.
    const model = fixtureModel(() => ({
      kind: 'success',
      text: JSON.stringify({ kind: 'explanation', text: 'A tokenizer splits text into pieces a model can count.' }),
    }));
    const { harness } = fixtureHarness(database.db, { model });
    const before = world.queued.length;
    unwrap(await ask(world, erased, roomId, discussionId, 'explainer'));
    await world.contribute(harness)(world.queued[before]!);

    const view = await readDiscussion(world, staying, roomId, discussionId);
    if (view.status !== 'ready') throw new Error('expected ready');
    const cursor = view.catchUpCursor;
    expect(view.discussion.startedBy?.displayName).toBe('Fixture person');
    expect(view.messages).toHaveLength(4);

    // The export holds the person's own words and none of anyone else's.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(erased.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: erased.accountId }, openToEveryone),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = JSON.stringify(exported.value.sections['rooms']);
    expect(section).toContain('words that will go');
    expect(section).not.toContain('words that stay');
    expect(section).not.toContain('A tokenizer splits');
    expect(JSON.stringify(exported.value.sections['rooms'])).toMatch(/"inhabitantAsks":1/);

    const receiptId = randomUUID();
    const deleting = deleteAccountFor(database.db, boss, {
      eraseAccountData: eraseCurrentAccount,
      lockTimeoutMs: 5_000,
    });
    expect((await deleting.request(erased.authority, { receiptId })).kind).toBe('accepted');
    expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');

    for (const [table, column] of [
      ['rooms.members', 'account_id'],
      ['rooms.messages', 'author_account_id'],
      ['rooms.discussions', 'started_by_account_id'],
      ['rooms.ai_turns', 'requested_by_account_id'],
    ] as const)
      expect(await countOf(table, column, erased.accountId), table).toBe(0);
    expect(
      await world.db.selectFrom('rooms.message_snippets').select('message_id').execute(),
      'the deleted author’s snippet goes with the message',
    ).toEqual([]);

    const after = await readDiscussion(world, staying, roomId, discussionId);
    if (after.status !== 'ready') throw new Error('expected ready');
    // Same places and numbers; the person's words are markers, the others' words and the AI's stay.
    expect(after.messages.map((message) => [message.sequence, message.status])).toEqual([
      [1, 'unavailable'],
      [2, 'unavailable'],
      [3, 'available'],
      [4, 'available'],
    ]);
    expect(after.messages[3]).toMatchObject({
      author: { kind: 'ai', label: 'AI · Explainer' },
      body: { text: 'A tokenizer splits text into pieces a model can count.' },
    });
    expect(after.discussion.startedBy).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain('words that will go');
    // Everyone's catch-up replaces the bubbles.
    const changes = unwrap(
      await world.rooms.changes(staying.authority, {
        version,
        readId: randomUUID(),
        roomId,
        discussionId,
        limit: 10,
        cursor,
      }),
    );
    if (changes.status !== 'ready') throw new Error('expected changes');
    expect(changes.changes.map((change) => change.message.status)).toEqual(['unavailable', 'unavailable']);
    const roomView = unwrap(await world.rooms.read(staying.authority, { version, readId: randomUUID(), roomId }));
    expect(roomView.status).toBe('member');
  });

  it('deletes a voter’s votes and leaves a deleted moderator’s poll to the room', async () => {
    const { roomId, slug } = await seedRoom(world);
    const moderator = await namedPerson();
    const voter = await namedPerson();
    const staying = await seedFriend(world.db, world.friends);
    for (const person of [moderator, voter, staying]) unwrap(await joinRoom(world, person, roomId));
    await makeModerator(world, slug, moderator);
    const { activityId } = unwrap(await startPoll(world, moderator, roomId, ['Batching', 'Instances']));
    unwrap(await votePoll(world, voter, roomId, activityId, 'o1'));
    unwrap(await votePoll(world, staying, roomId, activityId, 'o1'));

    // The voter's export holds their own vote, with the words of the option they chose.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(voter.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: voter.accountId }, openToEveryone),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = JSON.stringify(exported.value.sections['rooms']);
    expect(section).toContain('"choice":"Batching"');
    expect(section).toContain('At 10x requests, what would you try first?');

    const erase = async (person: Friend) => {
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
    };
    await erase(voter);
    expect(await countOf('rooms.poll_votes', 'account_id', voter.accountId)).toBe(0);
    let view = await readActivity(world, staying, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view.activity.options.map((option) => option.votes)).toEqual([1, 0]);

    // Deleting the moderator clears the creator link; the poll stays open and countable for the others.
    await erase(moderator);
    expect(await countOf('rooms.activities', 'created_by_account_id', moderator.accountId)).toBe(0);
    expect(
      await world.db
        .selectFrom('rooms.activities')
        .select('activity_id')
        .where('activity_id', '=', activityId)
        .execute(),
    ).toHaveLength(1);
    unwrap(await votePoll(world, staying, roomId, activityId, 'o2'));
    view = await readActivity(world, staying, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view.activity.options.map((option) => option.votes)).toEqual([0, 1]);
  });

  it('exports a person’s own room settings and removes them, and the presence lease, with the account', async () => {
    const { roomId } = await seedRoom(world);
    const erased = await namedPerson();
    unwrap(await joinRoom(world, erased, roomId));
    unwrap(await setPreferences(world, erased, roomId, { aiLevel: 'quieter', keepOut: true, noticeSeen: true }));
    unwrap(await setPresence(world, erased, roomId));
    expect(await countOf('rooms.room_presence', 'account_id', erased.accountId)).toBe(1);

    // The export holds the person's own choices about AI and says nothing about where they were.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(erased.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: erased.accountId }, openToEveryone),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = exported.value.sections['rooms'] as { rooms: Record<string, unknown>[] };
    expect(section.rooms[0]).toMatchObject({ aiLevel: 'quieter', keepMessagesOutOfAi: true });
    expect(section.rooms[0]).toHaveProperty('aiNoticeSeenAt');
    expect(JSON.stringify(section)).not.toMatch(/presence|lastSeen/i);

    const receiptId = randomUUID();
    const deleting = deleteAccountFor(database.db, boss, {
      eraseAccountData: eraseCurrentAccount,
      lockTimeoutMs: 5_000,
    });
    expect((await deleting.request(erased.authority, { receiptId })).kind).toBe('accepted');
    expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
    expect(await countOf('rooms.room_presence', 'account_id', erased.accountId)).toBe(0);
    expect(await countOf('rooms.members', 'account_id', erased.accountId)).toBe(0);
  });

  it('leaves a person’s room settings and lease alone through a Clear, as it leaves their membership', async () => {
    const { roomId } = await seedRoom(world);
    const person = await namedPerson();
    unwrap(await joinRoom(world, person, roomId));
    unwrap(await setPreferences(world, person, roomId, { aiLevel: 'off', keepOut: true }));
    unwrap(await setPresence(world, person, roomId));
    await clearRecordingPerson(database, boss, person);
    const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
    const view = await memberView(world, cleared, roomId);
    expect(view.you).toMatchObject({ aiLevel: 'off', keepOut: true });
    expect(await countOf('rooms.room_presence', 'account_id', person.accountId)).toBe(1);
  });

  it('keeps the room through a Clear and cancels only the asks that were waiting', async () => {
    const { roomId } = await seedRoom(world);
    const person = await namedPerson();
    unwrap(await joinRoom(world, person, roomId));
    const discussionId = await startTopic(world, person, roomId, 'Before the clear');
    unwrap(await say(world, person, roomId, discussionId, 'still here after a clear'));
    unwrap(await ask(world, person, roomId, discussionId));
    const asking = await world.db
      .selectFrom('rooms.ai_turns')
      .select(['turn_id', 'state'])
      .where('requested_by_account_id', '=', person.accountId)
      .executeTakeFirstOrThrow();
    expect(asking.state).toBe('queued');
    const jobsBefore = await jobsOf(person.universeId);
    expect(jobsBefore).toBe(1);

    await clearRecordingPerson(database, boss, person);

    expect(await jobsOf(person.universeId)).toBe(0);
    // The ask is ended but not handed back: its call may already have been running, so it stays counted.
    expect(
      await world.db
        .selectFrom('rooms.ai_turns')
        .select(['state', 'dispatched'])
        .where('turn_id', '=', asking.turn_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'failed', dispatched: true });
    const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
    const view = await readDiscussion(world, cleared, roomId, discussionId);
    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.messages).toMatchObject([{ status: 'available', body: { text: 'still here after a clear' } }]);
    // The ask that was cancelled does not hold the discussion: it can be asked again.
    expect(view.inhabitants.map((entry) => entry.ask)).toEqual(['available', 'available']);
  });

  /**
   * A person whose question a resident has been cleared to answer: the turn is queued and its model call is a real
   * pg-boss job under the person's universe. A second member is in the room; the clock is the resident world's own.
   */
  async function queuedResidentTurn() {
    const residents = await roomWorld(database, { now: new Date('2026-10-30T10:00:00Z') }, { residentsEnabled: true });
    const { roomId } = await seedRoom(residents);
    const person = await namedPerson();
    const other = await seedFriend(residents.db, residents.friends);
    unwrap(await joinRoom(residents, person, roomId));
    unwrap(await joinRoom(residents, other, roomId));
    const general = (await memberView(residents, person, roomId)).general.discussionId;
    unwrap(await say(residents, person, roomId, general, 'Why do we have seasons at all?'));
    const check = residents.castChecks.at(-1)!;
    residents.clock.now = check.startAfter!;
    await residents.decide()(check.job);
    const turn = () =>
      residents.db
        .selectFrom('rooms.ai_turns')
        .select(['state', 'dispatched', 'trigger'])
        .where('room_id', '=', roomId)
        .executeTakeFirstOrThrow();
    expect(await turn()).toEqual({ state: 'queued', dispatched: false, trigger: 'unanswered_question' });
    expect(await castJobsOf(person.universeId)).toBe(1);
    return { residents, roomId, general, person, other, turn };
  }

  it('ends a resident’s queued turn with the job that Clear erases, so no turn waits for a call nobody will make', async () => {
    const { residents, roomId, general, person, other, turn } = await queuedResidentTurn();
    try {
      await clearRecordingPerson(database, boss, person);
      expect(await castJobsOf(person.universeId)).toBe(0);
      // The call may already have been running, so the turn stays counted, but it is no longer queued.
      expect(await turn()).toEqual({ state: 'failed', dispatched: true, trigger: 'unanswered_question' });
      // Nothing was posted, and the other member can still ask.
      const view = await readDiscussion(residents, other, roomId, general);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages.every((message) => message.status !== 'available' || message.author.kind === 'person')).toBe(
        true,
      );
      expect((await ask(residents, other, roomId, general, 'skeptic')).kind).toBe('ok');
    } finally {
      await residents.close();
    }
  });

  it('ends a resident’s queued turn when the account behind its job is deleted', async () => {
    const { residents, person, turn } = await queuedResidentTurn();
    try {
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await castJobsOf(person.universeId)).toBe(0);
      expect(await turn()).toEqual({ state: 'failed', dispatched: true, trigger: 'unanswered_question' });
    } finally {
      await residents.close();
    }
  });

  /**
   * A room where a person made marks of Useful, started a topic from another member's words, left a card, has a place
   * and wrote in a window that a resident summarised. Returns what the checks below read.
   */
  async function markedPerson() {
    const { roomId } = await seedRoom(world);
    const person = await namedPerson();
    const staying = await seedFriend(world.db, world.friends);
    unwrap(await joinRoom(world, person, roomId));
    unwrap(await joinRoom(world, staying, roomId));
    const general = (await memberView(world, person, roomId)).general.discussionId;
    const mine = unwrap(await say(world, person, roomId, general, 'a claim the person made'));
    const theirs = unwrap(await say(world, staying, roomId, general, 'a reply that stays with the room'));
    unwrap(await markUseful(world, person, roomId, general, theirs.messageId));
    unwrap(await markUseful(world, staying, roomId, general, mine.messageId));
    // The person makes a topic from the other member's words: the card they leave carries no words of its own.
    const topic = unwrap(
      await startTopicFrom(
        world,
        person,
        roomId,
        { discussionId: general, messageId: theirs.messageId },
        { title: 'Comparing notes' },
      ),
    );
    unwrap(await setPresence(world, person, roomId));
    unwrap(await setPresence(world, staying, roomId));
    const written = await world.db
      .selectFrom('rooms.messages')
      .select('recorded_at')
      .where('message_id', '=', mine.messageId)
      .executeTakeFirstOrThrow();
    const from = new Date(new Date(written.recorded_at).getTime() - 60_000);
    const through = new Date(new Date(written.recorded_at).getTime() + 60_000);
    // A resident's summary of the window that covered what the person wrote (its text is what must not outlive it).
    const summaryId = randomUUID();
    await sql`
      insert into rooms.summaries (summary_id, room_id, window_no, resident, state, covers_from, covers_through, body,
        created_at, settled_at, role_version, prompt_version, model, dispatched)
      values (${summaryId}::uuid, ${roomId}::uuid, 1, 'skeptic', 'ready', ${from}, ${through},
        'People compared notes about a claim.', ${through}, ${through}, 'away.1', 'hp2', 'fixture-model-v1', true)`.execute(
      world.db,
    );
    return { roomId, general, person, staying, mine, theirs, topic, summaryId };
  }

  it('deletes a person’s marks of Useful, the marks on their words and their place, and erases the summaries that read them', async () => {
    const { roomId, person, staying, mine, theirs, topic, summaryId } = await markedPerson();
    const marks = (messageId: string) =>
      world.db.selectFrom('rooms.message_useful').selectAll().where('message_id', '=', messageId).execute();
    expect(await marks(theirs.messageId)).toHaveLength(1);
    expect(await marks(mine.messageId)).toHaveLength(1);

    // The export names the room and when, never whose message it was or what it said.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = exported.value.sections['rooms'] as { usefulMarks: { room: string; markedAt: string }[] };
    expect(section.usefulMarks).toHaveLength(1);
    expect(JSON.stringify(section)).not.toContain('a reply that stays with the room');
    // The card the person left is described as the topic they started, never as shared content.
    expect(JSON.stringify(section)).toContain('"startedTopic":"Comparing notes"');
    expect(JSON.stringify(section)).not.toContain('a Reel or Scroll');

    const receiptId = randomUUID();
    const deleting = deleteAccountFor(database.db, boss, {
      eraseAccountData: eraseCurrentAccount,
      lockTimeoutMs: 5_000,
    });
    expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
    expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');

    expect(await countOf('rooms.message_useful', 'account_id', person.accountId)).toBe(0);
    // The mark on the deleted person's own words goes with them; the mark the person made on someone else's is gone too.
    expect(await marks(mine.messageId)).toEqual([]);
    expect(await marks(theirs.messageId)).toEqual([]);
    expect(await countOf('rooms.read_positions', 'account_id', person.accountId)).toBe(0);
    expect(await countOf('rooms.read_positions', 'account_id', staying.accountId)).toBe(1);
    expect(
      await world.db
        .selectFrom('rooms.summaries')
        .select(['state', 'body'])
        .where('summary_id', '=', summaryId)
        .execute(),
    ).toEqual([{ state: 'stale', body: null }]);

    // The topic the person began stays for the room, with no starter, and their card is a marker with no topic behind it.
    const cards = await world.db
      .selectFrom('rooms.messages')
      .select(['author_account_id', 'topic_discussion_id', 'body_text'])
      .where('discussion_id', '=', (await memberView(world, staying, roomId)).general.discussionId)
      .execute();
    expect(cards.every((row) => row.topic_discussion_id === null)).toBe(true);
    const after = await readDiscussion(world, staying, roomId, topic.discussionId);
    if (after.status !== 'ready') throw new Error('expected ready');
    expect(after.discussion.startedBy).toBeUndefined();
  });

  it('renames a topic that was titled from a deleted person’s message, and leaves a title the starter typed', async () => {
    const NEUTRAL = 'A topic from a message';
    const { roomId } = await seedRoom(world);
    const author = await namedPerson();
    const starter = await namedPerson();
    unwrap(await joinRoom(world, author, roomId));
    unwrap(await joinRoom(world, starter, roomId));
    const general = (await memberView(world, author, roomId)).general.discussionId;
    const first = unwrap(await say(world, author, roomId, general, 'ORIGINAL-WORDS that name a topic'));
    const second = unwrap(await say(world, author, roomId, general, 'SECOND-WORDS that the starter retitles'));
    const derived = unwrap(
      await startTopicFrom(world, starter, roomId, { discussionId: general, messageId: first.messageId }),
    ).discussionId;
    const typed = unwrap(
      await startTopicFrom(
        world,
        starter,
        roomId,
        { discussionId: general, messageId: second.messageId },
        { title: 'A title the starter typed' },
      ),
    ).discussionId;
    const titleOf = async (discussionId: string) =>
      (
        await world.db
          .selectFrom('rooms.discussions')
          .select('title')
          .where('discussion_id', '=', discussionId)
          .executeTakeFirstOrThrow()
      ).title;
    expect(await titleOf(derived)).toBe('ORIGINAL-WORDS that name a topic');

    // The starter's own file holds their typed title, and the other person's words only as the neutral title.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(starter.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: starter.accountId }, openToEveryone),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = JSON.stringify(exported.value.sections['rooms']);
    expect(section).toContain('A title the starter typed');
    expect(section).toContain(NEUTRAL);
    expect(section).not.toContain('ORIGINAL-WORDS');

    const receiptId = randomUUID();
    const deleting = deleteAccountFor(database.db, boss, {
      eraseAccountData: eraseCurrentAccount,
      lockTimeoutMs: 5_000,
    });
    expect((await deleting.request(author.authority, { receiptId })).kind).toBe('accepted');
    expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');

    // The words are gone from the stored title, not merely hidden when it is served.
    expect(await titleOf(derived)).toBe(NEUTRAL);
    expect(await titleOf(typed)).toBe('A title the starter typed');
    expect(
      (
        await sql<{ n: string }>`
          select count(*)::text as n from rooms.discussions where title like '%ORIGINAL-WORDS%'`.execute(world.db)
      ).rows[0]!.n,
    ).toBe('0');
    const after = await readDiscussion(world, starter, roomId, derived);
    if (after.status !== 'ready') throw new Error('expected ready');
    expect(after.discussion.title).toBe(NEUTRAL);
  });

  it('keeps marks of Useful, places and summaries through a Clear, as it keeps the room', async () => {
    const { roomId, general, person, theirs, summaryId } = await markedPerson();
    await clearRecordingPerson(database, boss, person);
    expect(await countOf('rooms.message_useful', 'account_id', person.accountId)).toBe(1);
    expect(await countOf('rooms.read_positions', 'account_id', person.accountId)).toBe(1);
    expect(
      await world.db.selectFrom('rooms.summaries').select('state').where('summary_id', '=', summaryId).execute(),
    ).toEqual([{ state: 'ready' }]);
    const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
    const view = await readDiscussion(world, cleared, roomId, general);
    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.messages.find((message) => message.messageId === theirs.messageId)).toMatchObject({
      usefulByYou: true,
    });
  });

  /**
   * A person whose return a resident has been asked to write up: the summary is queued, and its model call is a real
   * pg-boss job under the person's universe.
   */
  async function queuedSummary() {
    const T0 = new Date('2026-10-30T06:00:00Z');
    const residents = await roomWorld(database, { now: T0 }, { residentsEnabled: true });
    const { roomId } = await seedRoom(residents);
    const person = await namedPerson();
    const writer = await seedFriend(residents.db, residents.friends);
    unwrap(await joinRoom(residents, person, roomId));
    unwrap(await joinRoom(residents, writer, roomId));
    const general = (await memberView(residents, person, roomId)).general.discussionId;
    unwrap(await setPresence(residents, person, roomId));
    for (let index = 0; index < 16; index++) {
      residents.clock.now = new Date(T0.getTime() + 13 * 3_600_000 + index * 60_000);
      unwrap(await say(residents, writer, roomId, general, `Interesting point about orbits number ${String(index)}`));
    }
    residents.clock.now = new Date(T0.getTime() + 14 * 3_600_000);
    unwrap(await setPresence(residents, person, roomId));
    const summary = () =>
      residents.db
        .selectFrom('rooms.summaries')
        .select(['state', 'dispatched'])
        .where('room_id', '=', roomId)
        .executeTakeFirstOrThrow();
    expect(await summary()).toEqual({ state: 'queued', dispatched: false });
    expect(await summaryJobsOf(person.universeId)).toBe(1);
    return { residents, person, summary };
  }

  it('ends a queued summary with the job that Clear erases, so no window waits for a call nobody will make', async () => {
    const { residents, person, summary } = await queuedSummary();
    try {
      await clearRecordingPerson(database, boss, person);
      expect(await summaryJobsOf(person.universeId)).toBe(0);
      // The call may already have been running, so the window stays used, but nothing is queued.
      expect(await summary()).toEqual({ state: 'failed', dispatched: true });
    } finally {
      await residents.close();
    }
  });

  it('ends a queued summary when the account behind its job is deleted', async () => {
    const { residents, person, summary } = await queuedSummary();
    try {
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await summaryJobsOf(person.universeId)).toBe(0);
      expect(await summary()).toEqual({ state: 'failed', dispatched: true });
    } finally {
      await residents.close();
    }
  });

  async function summaryJobsOf(universeId: string): Promise<number> {
    const row = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
      where name = 'rooms.summarise' and data ->> 'universeId' = ${universeId}`.execute(database.db);
    return Number(row.rows[0]?.n ?? 0);
  }

  async function castJobsOf(universeId: string): Promise<number> {
    const row = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
      where name = 'rooms.cast-pass' and data ->> 'universeId' = ${universeId}`.execute(database.db);
    return Number(row.rows[0]?.n ?? 0);
  }

  async function jobsOf(universeId: string): Promise<number> {
    const row = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
      where name = 'rooms.contribute' and data ->> 'universeId' = ${universeId}`.execute(database.db);
    return Number(row.rows[0]?.n ?? 0);
  }
});
