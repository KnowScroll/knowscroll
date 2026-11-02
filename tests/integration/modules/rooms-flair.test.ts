/**
 * Flair and the sky's star moments (v3 R-11, D-341 to D-347) over real PostgreSQL: which acts earn which mark, who never earns
 * one, what shows beside a name and who may hide it, blocks in both directions, the moment each star shows, the "+1 star" a
 * marked answer carries, and what leaving, removal, a Clear, a deletion and the export take. CI fixture accounts; the Launch and
 * Spot the flaw rows are labelled fixtures, never provider output. No model is called.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { readBlockedAmong } from '@knowscroll/backend/modules/social/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  hideMessage,
  joinRoom,
  joined,
  makeModerator,
  markUseful,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  readDiscussion,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPresence,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, type Friend } from '../support/talk.js';
import { openToEveryone } from '../support/audience.js';

const version = 'rooms.v1' as const;
const START = new Date(Date.UTC(2026, 10, 2, 10, 0, 0));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** A labelled fixture of an approved Spot the flaw: the second sentence is the altered one. Not provider output. */
const FIXTURE_FLAW = {
  sentences: [
    'Seasons come from the tilt of the Earth.',
    'The Earth is closest to the Sun in July.',
    'So the northern summer is warm because of the tilt.',
  ],
  flawIndex: 1,
  original: 'The Earth is closest to the Sun in January.',
  source: {
    assetId: '0199b000-0000-7000-8000-000000000001',
    assetRevision: 1,
    blockId: 'b1',
    start: 0,
    end: 120,
    quoteHash: 'a'.repeat(64),
  },
};

describe('flair and the sky’s star moments (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_flair');
    world = await roomWorld(database, { now: START }, { starsPerDay: 20 });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });

  /** Each test starts at its own day so its fixture rituals, which are one per room per day, never meet another's. */
  let dayOfTest = 0;
  const begin = () => {
    dayOfTest += 20;
    world.clock.now = new Date(START.getTime() + dayOfTest * DAY);
    return world.clock.now;
  };
  const after = (ms: number) => {
    world.clock.now = new Date(world.clock.now.getTime() + ms);
  };

  const todayOf = async (roomId: string) =>
    (
      await world.db
        .selectFrom('rooms.discussions')
        .select('discussion_id')
        .where('room_id', '=', roomId)
        .where('kind', '=', 'today')
        .executeTakeFirstOrThrow()
    ).discussion_id;

  const flairCard = async (person: Friend, roomId: string) => {
    const view = unwrap(await world.rooms.flair(person.authority, { version, readId: randomUUID(), roomId }));
    if (view.status !== 'ready') throw new Error('expected a ready card');
    return view;
  };
  const choose = (person: Friend, roomId: string, flair: string) =>
    world.rooms.chooseFlair(person.authority, { version, commandId: randomUUID(), roomId, flair });
  const skyOf = async (person: Friend, roomId: string) => {
    const view = unwrap(await world.rooms.sky(person.authority, { version, readId: randomUUID(), roomId }));
    if (view.status !== 'ready') throw new Error('expected a ready sky');
    return view;
  };
  /** The message as `reader` reads it. */
  const messageAs = async (reader: Friend, roomId: string, discussionId: string, messageId: string) => {
    const view = await readDiscussion(world, reader, roomId, discussionId);
    if (view.status !== 'ready') throw new Error('expected a ready discussion');
    const found = view.messages.find((message) => message.messageId === messageId);
    if (found === undefined) throw new Error('message not found');
    return found;
  };
  const flairBesideName = async (reader: Friend, roomId: string, discussionId: string, messageId: string) => {
    const message = await messageAs(reader, roomId, discussionId, messageId);
    return message.status === 'available' ? message.flair : undefined;
  };

  /** A Spot the flaw approved for the room on the clock's day, as an operator's approval leaves it. */
  async function fixtureFlaw(roomId: string) {
    const ritualId = randomUUID();
    await sql`
      insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at,
        decided_at, decided_by)
      values (${ritualId}::uuid, ${roomId}::uuid, ${dayOf(world.clock.now)}::date, 'flaw',
        ${JSON.stringify(FIXTURE_FLAW)}::jsonb, 'ritual.v1', 'approved', 'template', ${world.clock.now},
        ${world.clock.now}, 'cli:ci')`.execute(world.db);
    return ritualId;
  }
  const tapFlaw = (person: Friend, roomId: string, ritualId: string, sentence: number) =>
    world.rooms.solveFlaw(person.authority, {
      version,
      commandId: randomUUID(),
      roomId,
      ritualId,
      sentence,
      recordingGeneration: 1,
    });
  /** Finds the day's flaw as `person`: one more right tap on the clock's day. */
  async function findFlaw(person: Friend, roomId: string) {
    unwrap(await tapFlaw(person, roomId, await fixtureFlaw(roomId), 1));
    after(DAY);
  }

  /**
   * A Launch that finished `daysAgo` days before now, which `players` answered, as a labelled fixture: the rows the room's own
   * Launch would have left (its deck, the Launch, who played and one answer each).
   */
  async function fixtureLaunch(
    roomId: string,
    players: readonly Friend[],
    options: { readonly daysAgo?: number; readonly live?: boolean; readonly answered?: boolean } = {},
  ) {
    const startsAt = new Date(world.clock.now.getTime() - (options.daysAgo ?? 0) * DAY);
    const deck = randomUUID();
    const launchId = randomUUID();
    const finished = options.live !== true;
    await sql`
      insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at,
        decided_at, decided_by)
      values (${deck}::uuid, ${roomId}::uuid, ${dayOf(startsAt)}::date, 'launch', '{"questions": []}'::jsonb, 'ritual.v1',
        'approved', 'template', ${startsAt}, ${startsAt}, 'cli:ci')`.execute(world.db);
    await sql`
      insert into rooms.launches (launch_id, room_id, deck_ritual_id, questions, starts_at, created_at, state, finished_at,
        played, star)
      values (${launchId}::uuid, ${roomId}::uuid, ${deck}::uuid, '[{},{},{},{},{}]'::jsonb, ${startsAt}, ${startsAt},
        ${finished ? 'finished' : 'live'}, ${finished ? startsAt : null},
        ${finished ? (options.answered === false ? 0 : players.length) : null}, ${finished ? false : null})`.execute(
      world.db,
    );
    for (const player of players) {
      await sql`
        insert into rooms.launch_players (launch_id, account_id, joined_at)
        values (${launchId}::uuid, ${player.accountId}::uuid, ${startsAt})`.execute(world.db);
      if (options.answered === false) continue;
      await sql`
        insert into rooms.launch_answers (launch_id, round, account_id, choice, elapsed_ms, correct, answered_at)
        values (${launchId}::uuid, 1, ${player.accountId}::uuid, 0, 1000, true, ${startsAt})`.execute(world.db);
    }
    return launchId;
  }

  /**
   * Fixture messages of a resident (`ai`) and of a scout (`agent`, owned by `owner`) at the end of a discussion, as the router and the
   * scout's heartbeat would have left them: the rows, and the discussion's counters that make a read reach them.
   */
  async function fixtureAiMessages(discussionId: string, owner: Friend) {
    const last = await world.db
      .selectFrom('rooms.discussions')
      .select(['last_sequence', 'last_change_sequence'])
      .where('discussion_id', '=', discussionId)
      .executeTakeFirstOrThrow();
    const resident = randomUUID();
    const scout = randomUUID();
    const next = Number(last.last_sequence) + 1;
    const change = Number(last.last_change_sequence) + 1;
    await sql`
      insert into rooms.messages (message_id, discussion_id, sequence, change_sequence, author_kind, inhabitant, ai_kind,
        body_text, recorded_at)
      values (${resident}::uuid, ${discussionId}::uuid, ${next}, ${change}, 'ai', 'explainer', 'explanation',
        'An explanation', ${world.clock.now})`.execute(world.db);
    await sql`
      insert into rooms.messages (message_id, discussion_id, sequence, change_sequence, author_kind, agent_owner_account_id,
        ai_kind, trigger, body_text, recorded_at)
      values (${scout}::uuid, ${discussionId}::uuid, ${next + 1}, ${change + 1}, 'agent', ${owner.accountId}::uuid, 'find',
        'scout_find', 'A find from a scout', ${world.clock.now})`.execute(world.db);
    await sql`
      update rooms.discussions set last_sequence = ${next + 1}, last_change_sequence = ${change + 1}
      where discussion_id = ${discussionId}::uuid`.execute(world.db);
    return { resident, scout };
  }

  const leaveQuestion = async (person: Friend, roomId: string, text: string) =>
    unwrap(
      await world.rooms.leaveQuestion(person.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        text,
        askNow: false,
        notify: false,
      }),
    ).discussionId;
  /** The first message of a topic, which a question leaves with its words. */
  const firstMessageOf = async (discussionId: string) =>
    (
      await world.db
        .selectFrom('rooms.messages')
        .select('message_id')
        .where('discussion_id', '=', discussionId)
        .where('sequence', '=', '1')
        .executeTakeFirstOrThrow()
    ).message_id;

  /** A person created by the real sign-in (deletion and Clear need the real lifecycle), with a claimed profile. */
  async function realMember(): Promise<Friend> {
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

  describe('which acts earn which mark', () => {
    it('gives First answer for words in Today, and not for chat in General or the asker’s own words in their question', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      unwrap(await say(world, asha, roomId, (await memberView(world, asha, roomId)).general.discussionId, 'Hello'));
      const question = await leaveQuestion(asha, roomId, 'Why is the sky dark at night?');
      unwrap(await say(world, asha, roomId, question, 'I wonder if it is the expansion'));
      expect(await flairCard(asha, roomId)).toMatchObject({ earned: [], coming: [] });
      const words = unwrap(
        await say(world, asha, roomId, await todayOf(roomId), 'Light from far stars has not arrived'),
      );
      expect(await flairCard(asha, roomId)).toMatchObject({ earned: ['first_answer'], shown: 'first_answer' });
      expect(await flairBesideName(ravi, roomId, await todayOf(roomId), words.messageId)).toBe('first_answer');
    });

    it('gives First answer for words in a question someone else left', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const question = await leaveQuestion(asha, roomId, 'How do astronomers know how far away a star is?');
      expect((await flairCard(ravi, roomId)).earned).toEqual([]);
      const answer = unwrap(await say(world, ravi, roomId, question, 'Parallax for the near ones'));
      expect((await flairCard(ravi, roomId)).earned).toEqual(['first_answer']);
      expect(await flairBesideName(asha, roomId, question, answer.messageId)).toBe('first_answer');
    });

    it('takes the mark back when the words are removed by a moderator, with nothing stored to forget', async () => {
      begin();
      const { roomId, slug } = await seedRoom(world);
      const [asha, ravi, moderator] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, asha, roomId, today, 'An answer'));
      expect((await flairCard(asha, roomId)).earned).toEqual(['first_answer']);
      unwrap(await hideMessage(world, moderator, roomId, today, words.messageId));
      expect((await flairCard(asha, roomId)).earned).toEqual([]);
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
    });

    it('gives Good question for three questions someone found useful, and shows the way there', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      for (const [index, expected] of [1, 2, 3].entries()) {
        const question = await leaveQuestion(asha, roomId, `Question number ${String(index)}?`);
        unwrap(await markUseful(world, ravi, roomId, question, await firstMessageOf(question)));
        const card = await flairCard(asha, roomId);
        if (expected < 3)
          expect(card).toMatchObject({ earned: [], coming: [{ flair: 'good_question', have: expected, of: 3 }] });
        else expect(card).toMatchObject({ earned: ['good_question'], coming: [] });
      }
    });

    it('counts a question only when another member marked its first message, not the asker’s own', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const unmarked = await leaveQuestion(asha, roomId, 'Nobody marked this one?');
      const marked = await leaveQuestion(asha, roomId, 'Somebody marked this one?');
      unwrap(await markUseful(world, ravi, roomId, marked, await firstMessageOf(marked)));
      // Their own mark on their own message is refused, and a mark on a later message of the question is not the question's.
      expect((await markUseful(world, asha, roomId, unmarked, await firstMessageOf(unmarked))).kind).toBe('refused');
      const later = unwrap(await say(world, asha, roomId, unmarked, 'More words'));
      unwrap(await markUseful(world, ravi, roomId, unmarked, later.messageId));
      expect((await flairCard(asha, roomId)).coming).toEqual([{ flair: 'good_question', have: 1, of: 3 }]);
    });

    it('gives Flaw finder for three right taps on Spot the flaw, and not for a wrong one', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      unwrap(await tapFlaw(asha, roomId, await fixtureFlaw(roomId), 0));
      after(DAY);
      expect((await flairCard(asha, roomId)).coming).toEqual([]);
      await findFlaw(asha, roomId);
      await findFlaw(asha, roomId);
      expect(await flairCard(asha, roomId)).toMatchObject({
        earned: [],
        coming: [{ flair: 'flaw_finder', have: 2, of: 3 }],
      });
      await findFlaw(asha, roomId);
      expect(await flairCard(asha, roomId)).toMatchObject({ earned: ['flaw_finder'], coming: [] });
    });

    it('gives Launch regular for three finished Launches answered, and not for one still on or never answered', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      await fixtureLaunch(roomId, [asha, ravi], { daysAgo: 3 });
      await fixtureLaunch(roomId, [asha, ravi], { daysAgo: 2 });
      await fixtureLaunch(roomId, [asha], { daysAgo: 1, answered: false });
      await fixtureLaunch(roomId, [asha], { daysAgo: 0, live: true });
      expect(await flairCard(asha, roomId)).toMatchObject({
        earned: [],
        coming: [{ flair: 'launch_regular', have: 2, of: 3 }],
      });
      await fixtureLaunch(roomId, [asha], { daysAgo: 4 });
      expect(await flairCard(asha, roomId)).toMatchObject({ earned: ['launch_regular'], coming: [] });
      expect((await flairCard(ravi, roomId)).earned).toEqual([]);
    });

    it('lets Launch regular fade with the seven days a Launch’s answers are kept, and shows nothing in its place', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      for (const daysAgo of [0, 1, 2]) await fixtureLaunch(roomId, [asha], { daysAgo });
      unwrap(await choose(asha, roomId, 'launch_regular'));
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, asha, roomId, today, 'Back from the Launch'));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBe('launch_regular');
      // The answers of those Launches are deleted seven days after they ended (D-220); the mark was a recent habit.
      await world.db.deleteFrom('rooms.launch_answers').where('account_id', '=', asha.accountId).execute();
      const card = await flairCard(asha, roomId);
      expect(card).toMatchObject({ earned: ['first_answer'], choice: 'launch_regular' });
      expect(card.shown).toBeUndefined();
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
    });
  });

  describe('who never earns one', () => {
    it('is never on a resident’s message or a scout’s note, whatever the owner of the scout earned', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const today = await todayOf(roomId);
      unwrap(await say(world, asha, roomId, today, 'A person’s answer'));
      expect((await flairCard(asha, roomId)).earned).toEqual(['first_answer']);
      const { resident, scout } = await fixtureAiMessages(today, asha);
      const view = await readDiscussion(world, ravi, roomId, today);
      if (view.status !== 'ready') throw new Error('expected a ready discussion');
      const byId = (id: string) => view.messages.find((message) => message.messageId === id);
      for (const id of [resident, scout]) {
        const message = byId(id);
        expect(message?.status).toBe('available');
        expect(message).not.toHaveProperty('flair');
        expect(message).not.toHaveProperty('star');
      }
    });

    it('counts nothing a resident or a scout said toward a person’s marks', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      await fixtureAiMessages(await todayOf(roomId), asha);
      expect(await flairCard(asha, roomId)).toMatchObject({ earned: [], coming: [] });
    });

    it('is shown only for a current member: a person who left shows none, and nothing is lost for when they return', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, asha, roomId, today, 'An answer before leaving'));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBe('first_answer');
      unwrap(await world.rooms.leave(asha.authority, { version, commandId: randomUUID(), roomId }));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
      expect((await world.rooms.flair(asha.authority, { version, readId: randomUUID(), roomId })).kind).toBe('refused');
      unwrap(await joinRoom(world, asha, roomId));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBe('first_answer');
    });
  });

  describe('what shows beside a name', () => {
    it('shows the first mark earned until the person chooses another, and lets them hide it and bring it back', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, asha, roomId, today, 'An answer'));
      for (let found = 0; found < 3; found++) await findFlaw(asha, roomId);
      expect(await flairCard(asha, roomId)).toMatchObject({
        earned: ['first_answer', 'flaw_finder'],
        shown: 'first_answer',
      });
      unwrap(await choose(asha, roomId, 'flaw_finder'));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBe('flaw_finder');
      expect(await flairCard(asha, roomId)).toMatchObject({ choice: 'flaw_finder', shown: 'flaw_finder' });
      unwrap(await choose(asha, roomId, 'none'));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
      const hidden = await flairCard(asha, roomId);
      expect(hidden).toMatchObject({ earned: ['first_answer', 'flaw_finder'], choice: 'none' });
      expect(hidden.shown).toBeUndefined();
      unwrap(await choose(asha, roomId, 'auto'));
      const automatic = await flairCard(asha, roomId);
      expect(automatic.choice).toBeUndefined();
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBe('first_answer');
    });

    it('refuses a mark that is not earned, and the same choice again is accepted', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      expect((await choose(asha, roomId, 'first_answer')).kind).toBe('refused');
      expect((await choose(asha, roomId, 'launch_regular')).kind).toBe('refused');
      expect((await choose(asha, roomId, 'karma')).kind).toBe('refused');
      unwrap(await choose(asha, roomId, 'none'));
      unwrap(await choose(asha, roomId, 'none'));
      const commandId = randomUUID();
      const body = { version, commandId, roomId, flair: 'auto' };
      const first = unwrap(await world.rooms.chooseFlair(asha.authority, body));
      const again = unwrap(await world.rooms.chooseFlair(asha.authority, body));
      expect(again).toMatchObject({ commandId: first.commandId, flair: 'auto', replayed: true });
    });

    it('leaves a person’s own message without a chip on their own screen, and says nothing of anyone else’s card', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, asha, roomId, today, 'An answer'));
      expect(await flairBesideName(asha, roomId, today, words.messageId)).toBeUndefined();
      // Nothing about the others' marks or choices is on a card, and no number counts anyone.
      const card = JSON.stringify(await flairCard(ravi, roomId));
      for (const secret of [asha.accountId, asha.person.handle, asha.person.personId])
        expect(card).not.toContain(secret);
    });

    it('is for members only: a stranger and a person who left read no card and choose nothing', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const stranger = (await joined(world, (await seedRoom(world)).roomId, 1))[0] as Friend;
      expect((await world.rooms.flair(stranger.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
      expect((await choose(stranger, roomId, 'none')).kind).toBe('refused');
      unwrap(await choose(asha, roomId, 'none'));
    });
  });

  describe('blocks', () => {
    it('hide a mark in both directions and are lifted with the block', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const today = await todayOf(roomId);
      const ashas = unwrap(await say(world, asha, roomId, today, 'Asha answers'));
      const kenjis = unwrap(await say(world, kenji, roomId, today, 'Kenji answers'));
      for (const reader of [asha, ravi, kenji]) {
        expect(await flairBesideName(reader, roomId, today, ashas.messageId), 'asha').toBe(
          reader === asha ? undefined : 'first_answer',
        );
        expect(await flairBesideName(reader, roomId, today, kenjis.messageId), 'kenji').toBe(
          reader === kenji ? undefined : 'first_answer',
        );
      }
      unwrap(await friendCommand(world.friends, kenji, asha, 'block'));
      // Kenji blocked Asha: Kenji reads Asha's words collapsed, and Asha, who is blocked, no longer sees Kenji's mark.
      expect((await messageAs(kenji, roomId, today, ashas.messageId)).status).toBe('blocked');
      expect(await flairBesideName(asha, roomId, today, kenjis.messageId)).toBeUndefined();
      // The room is the same for everyone else, and the person who is blocked still sees what they saw of the words.
      expect(await flairBesideName(ravi, roomId, today, ashas.messageId)).toBe('first_answer');
      expect(await flairBesideName(ravi, roomId, today, kenjis.messageId)).toBe('first_answer');
      expect((await messageAs(asha, roomId, today, kenjis.messageId)).status).toBe('available');
      unwrap(await friendCommand(world.friends, kenji, asha, 'unblock'));
      expect(await flairBesideName(asha, roomId, today, kenjis.messageId)).toBe('first_answer');
    });
  });

  describe('the block list the mark uses', () => {
    it('answers who the caller blocked, and who blocked them only when asked for both ways', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, kenji, ravi] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      unwrap(await friendCommand(world.friends, kenji, asha, 'block'));
      const among = async (reader: Friend, others: readonly Friend[], direction?: 'own' | 'either') => {
        const result = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(reader.authority, (scope) =>
          readBlockedAmong(
            scope,
            reader.accountId,
            others.map((other) => other.accountId),
            direction,
          ),
        );
        if (result.kind !== 'entered') throw new Error('scope refused');
        return [...result.value].sort();
      };
      // Kenji blocked Asha. Asked the old way, only Kenji's own side says so: the blocked person is never told.
      expect(await among(kenji, [asha, ravi])).toEqual([asha.accountId]);
      expect(await among(asha, [kenji, ravi])).toEqual([]);
      expect(await among(asha, [kenji, ravi], 'own')).toEqual([]);
      // Asked for both ways, either side of the block says so, and a person with no block with the caller is never in it.
      expect(await among(asha, [kenji, ravi], 'either')).toEqual([kenji.accountId]);
      expect(await among(kenji, [asha, ravi], 'either')).toEqual([asha.accountId]);
      expect(await among(ravi, [asha, kenji], 'either')).toEqual([]);
    });
  });

  describe('the sky’s star moments', () => {
    /** An answer in Today by `author` that `giver` marks Useful: a star for the room. */
    async function usefulAnswer(roomId: string, author: Friend, giver: Friend, text = 'Because of the tilt') {
      const today = await todayOf(roomId);
      const sent = unwrap(await say(world, author, roomId, today, text));
      const marked = unwrap(await markUseful(world, giver, roomId, today, sent.messageId));
      return { today, messageId: sent.messageId, marked };
    }

    it('names the person whose answer was found useful and opens it, and never says who marked it', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const { today } = await usefulAnswer(roomId, asha, ravi, 'A distinctive answer to remember');
      const view = await skyOf(kenji, roomId);
      expect(view.stars).toEqual([
        {
          act: 'answer_useful',
          day: dayOf(world.clock.now),
          constellation: 1,
          by: asha.person,
          opens: { discussionId: today },
        },
      ]);
      const text = JSON.stringify(view);
      for (const secret of [ravi.accountId, ravi.person.handle, ravi.person.personId, 'distinctive', asha.accountId])
        expect(text).not.toContain(secret);
    });

    it('names no blocked person and opens nothing the reader may not read', async () => {
      begin();
      const { roomId, slug } = await seedRoom(world);
      const [asha, ravi, kenji, moderator] = (await joined(world, roomId, 4)) as [Friend, Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      await usefulAnswer(roomId, asha, ravi, 'The first answer');
      after(1000);
      const second = await usefulAnswer(roomId, kenji, ravi, 'The second answer');
      unwrap(await friendCommand(world.friends, ravi, asha, 'block'));
      const seenByBlocker = await skyOf(ravi, roomId);
      const [blockedStar, plainStar] = [...seenByBlocker.stars].reverse();
      // Ravi blocked Asha: her star is a bare moment for him and still names Kenji's.
      expect(blockedStar).toEqual({ act: 'answer_useful', day: dayOf(world.clock.now), constellation: 1 });
      expect(plainStar).toMatchObject({ by: kenji.person, opens: { discussionId: second.today } });
      // Another reader still sees Asha's.
      expect([...(await skyOf(kenji, roomId)).stars].reverse()[0]).toMatchObject({ by: asha.person });
      unwrap(await friendCommand(world.friends, ravi, asha, 'unblock'));
      // A moderator removes Kenji's answer: nobody is named for it and it opens nothing.
      unwrap(await hideMessage(world, moderator, roomId, second.today, second.messageId));
      expect([...(await skyOf(asha, roomId)).stars].reverse()).toMatchObject([
        { by: asha.person },
        { act: 'answer_useful' },
      ]);
      expect([...(await skyOf(asha, roomId)).stars].reverse()[1]).not.toHaveProperty('by');
      expect([...(await skyOf(asha, roomId)).stars].reverse()[1]).not.toHaveProperty('opens');
    });

    it('names no one once the author’s account is gone', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const author = await realMember();
      unwrap(await joinRoom(world, author, roomId));
      await usefulAnswer(roomId, author, asha);
      expect((await skyOf(asha, roomId)).stars[0]).toMatchObject({ by: author.person });
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(author.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      const star = (await skyOf(asha, roomId)).stars[0]!;
      expect(star).toEqual({ act: 'answer_useful', day: dayOf(world.clock.now), constellation: 1 });
    });

    it('says which debate closed by its title, and how many people played a Launch, naming nobody', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const debate = unwrap(
        await world.rooms.create(asha.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: {
            kind: 'topic',
            title: 'Is Pluto a planet?',
            tag: 'debate',
            debate: { sides: ['Yes', 'No'], closesInHours: 24 },
          },
        }),
      ).discussionId;
      for (const [person, side] of [
        [asha, 'a'],
        [ravi, 'b'],
      ] as const)
        unwrap(
          await world.rooms.voteDebate(person.authority, {
            version,
            commandId: randomUUID(),
            roomId,
            discussionId: debate,
            side,
          }),
        );
      after(25 * HOUR);
      unwrap(await setPresence(world, kenji, roomId));
      const launchId = await fixtureLaunch(roomId, [asha, ravi, kenji]);
      await world.db
        .insertInto('rooms.stars')
        .values({
          star_id: randomUUID(),
          room_id: roomId,
          act: 'launch_finished',
          source_key: launchId,
          earned_at: world.clock.now,
          earned_on: dayOf(world.clock.now),
          constellation_no: 1,
        })
        .execute();
      const ritual = await fixtureFlaw(roomId);
      unwrap(await tapFlaw(ravi, roomId, ritual, 1));
      const stars = (await skyOf(kenji, roomId)).stars;
      expect(stars).toHaveLength(3);
      const byAct = Object.fromEntries(stars.map((star) => [star.act, star]));
      expect(byAct['debate_closed']).toMatchObject({ title: 'Is Pluto a planet?', opens: { discussionId: debate } });
      expect(byAct['launch_finished']).toMatchObject({ played: 3 });
      expect(byAct['launch_finished']).not.toHaveProperty('by');
      expect(byAct['launch_finished']).not.toHaveProperty('opens');
      expect(byAct['daily_solved']).toEqual({ act: 'daily_solved', day: dayOf(world.clock.now), constellation: 1 });
      const text = JSON.stringify(stars);
      for (const person of [asha, ravi, kenji]) expect(text).not.toContain(person.person.handle);
    });

    it('is the member’s alone: a stranger reads no sky and so no moment', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      await usefulAnswer(roomId, asha, ravi);
      const stranger = (await joined(world, (await seedRoom(world)).roomId, 1))[0] as Friend;
      expect((await world.rooms.sky(stranger.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
    });
  });

  describe('a marked answer’s "+1 star"', () => {
    it('is on the answer that earned the star, in its place among the seven, for everyone, and on no other message', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const today = await todayOf(roomId);
      const first = unwrap(await say(world, asha, roomId, today, 'First answer'));
      const plain = unwrap(await say(world, kenji, roomId, today, 'Just chat'));
      const second = unwrap(await say(world, kenji, roomId, today, 'Second answer'));
      const marked = unwrap(await markUseful(world, ravi, roomId, today, first.messageId));
      expect(marked).toMatchObject({ star: true });
      for (const reader of [asha, ravi, kenji]) {
        const message = await messageAs(reader, roomId, today, first.messageId);
        expect(message.status === 'available' && message.star).toEqual({ place: 1 });
      }
      unwrap(await markUseful(world, ravi, roomId, today, second.messageId));
      expect(await messageAs(asha, roomId, today, second.messageId)).toMatchObject({ star: { place: 2 } });
      expect(await messageAs(asha, roomId, today, plain.messageId)).not.toHaveProperty('star');
      // A second person marking the same answer earns nothing more, and says so.
      const again = unwrap(await markUseful(world, kenji, roomId, today, first.messageId));
      expect(again).not.toHaveProperty('star');
    });

    it('stays when the mark is taken back, as a star is nobody’s to lose, and is not on an AI’s answer', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const today = await todayOf(roomId);
      const answer = unwrap(await say(world, asha, roomId, today, 'An answer'));
      unwrap(await markUseful(world, ravi, roomId, today, answer.messageId));
      unwrap(await markUseful(world, ravi, roomId, today, answer.messageId, false));
      expect(await messageAs(ravi, roomId, today, answer.messageId)).toMatchObject({ star: { place: 1 } });
      const { resident } = await fixtureAiMessages(today, asha);
      expect(unwrap(await markUseful(world, ravi, roomId, today, resident))).not.toHaveProperty('star');
      expect(await messageAs(ravi, roomId, today, resident)).not.toHaveProperty('star');
    });
  });

  describe('what a person takes back', () => {
    /** A real account with both kinds of mark: First answer from words, which stay, and Flaw finder from taps, which are a play result. */
    async function earnedMember() {
      const { roomId } = await seedRoom(world);
      const [ravi] = (await joined(world, roomId, 1)) as [Friend];
      const person = await realMember();
      unwrap(await joinRoom(world, person, roomId));
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, person, roomId, today, 'An answer'));
      for (let found = 0; found < 3; found++) await findFlaw(person, roomId);
      unwrap(await choose(person, roomId, 'flaw_finder'));
      return { roomId, ravi, person, today, words };
    }

    it('takes a mark made of taps with a Clear and keeps one made of words, as the rows they come from are kept', async () => {
      begin();
      const { roomId, ravi, person, today, words } = await earnedMember();
      expect((await flairCard(person, roomId)).earned).toEqual(['first_answer', 'flaw_finder']);
      await clearRecordingPerson(database, boss, person);
      const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
      expect(await flairCard(cleared, roomId)).toMatchObject({ earned: ['first_answer'], choice: 'flaw_finder' });
      // The chosen mark is no longer earned, so nothing shows in its place.
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
      unwrap(await choose(cleared, roomId, 'auto'));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBe('first_answer');
    });

    it('shows none for a person who left or was removed, and none after the account is deleted', async () => {
      begin();
      const { roomId, ravi, person, today, words } = await earnedMember();
      unwrap(await choose(person, roomId, 'first_answer'));
      unwrap(await world.rooms.leave(person.authority, { version, commandId: randomUUID(), roomId }));
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      const stored = await world.db
        .selectFrom('rooms.members')
        .select('flair_choice')
        .where('account_id', '=', person.accountId)
        .execute();
      expect(stored).toEqual([]);
      expect((await messageAs(ravi, roomId, today, words.messageId)).status).toBe('unavailable');
    });

    it('removes a member’s mark with the removal, and keeps their choice so hiding is not undone', async () => {
      begin();
      const { roomId, slug } = await seedRoom(world);
      const [asha, ravi, moderator] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      const today = await todayOf(roomId);
      const words = unwrap(await say(world, asha, roomId, today, 'An answer'));
      unwrap(await choose(asha, roomId, 'none'));
      unwrap(
        await world.rooms.moderate(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          action: { kind: 'remove_member', personId: asha.person.personId },
        }),
      );
      expect(await flairBesideName(ravi, roomId, today, words.messageId)).toBeUndefined();
      const stored = await world.db
        .selectFrom('rooms.members')
        .select('flair_choice')
        .where('account_id', '=', asha.accountId)
        .executeTakeFirstOrThrow();
      expect(stored.flair_choice).toBe('none');
    });

    it('lists the choice in the export, and nothing else about flair', async () => {
      begin();
      const { roomId, person } = await earnedMember();
      unwrap(await choose(person, roomId, 'none'));
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const section = exported.value.sections['rooms'] as { rooms: { flairChoice?: string }[] };
      expect(section.rooms.map((entry) => entry.flairChoice)).toContain('none');
      expect(JSON.stringify(section)).not.toMatch(/first_answer|flaw_finder|good_question|launch_regular/);
    });
  });

  it('writes nothing to a person’s own universe: flair, stars and their moments are room facts, never evidence', async () => {
    begin();
    const { roomId } = await seedRoom(world);
    const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
    const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
    const today = await todayOf(roomId);
    const words = unwrap(await say(world, asha, roomId, today, 'An answer'));
    unwrap(await markUseful(world, ravi, roomId, today, words.messageId));
    await flairCard(asha, roomId);
    unwrap(await choose(asha, roomId, 'none'));
    unwrap(await choose(asha, roomId, 'auto'));
    await skyOf(ravi, roomId);
    await readDiscussion(world, ravi, roomId, today);
    expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
  });
});
