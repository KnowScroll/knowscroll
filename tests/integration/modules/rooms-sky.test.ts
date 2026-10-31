/**
 * Today and the sky (v3 R-5, D-174 to D-176) over real PostgreSQL: what earns a room a star and what does not, the daily
 * cap, a constellation of seven stars and the vote that names it, a debate that closes by vote, Spot the flaw and its one
 * final tap, who can read the sky, and what leaving, a Clear and a deletion take back. CI fixture accounts and fixture
 * ritual rows (labelled, never provider output); no model is called here.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { seedRooms } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  joinRoom,
  joined,
  libraryRoomSeeds,
  markUseful,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPresence,
  startTopic,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, seedFriend, type Friend } from '../support/talk.js';
import { openToEveryone } from '../support/audience.js';
import { seedAuthoredGeography } from '../support/visit-world.js';

const version = 'rooms.v1' as const;
const START = new Date(Date.UTC(2026, 9, 26, 10, 0, 0));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** A labelled fixture of an approved Spot the flaw: three sentences, the second altered. Not provider output. */
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
const FIXTURE_QUESTION = {
  prompt: 'How would you explain this to a friend: why are there seasons?',
  source: { assetId: '0199b000-0000-7000-8000-000000000001', assetRevision: 1 },
};

describe('Today and the sky (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  /** The same database with a roomy cap, for the tests that need seven stars on one day. */
  let roomy: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_sky');
    world = await roomWorld(database, { now: START }, { starsPerDay: 3 });
    roomy = await roomWorld(database, world.clock, { starsPerDay: 20 });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await roomy.close();
    await world.close();
    await database.drop();
  });

  const at = (hours: number) => {
    world.clock.now = new Date(START.getTime() + hours * HOUR);
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

  const skyOf = async (viewer: RoomWorld, person: Friend, roomId: string) =>
    unwrap(await viewer.rooms.sky(person.authority, { version, readId: randomUUID(), roomId }));
  const starTotal = async (roomId: string) =>
    Number(
      (
        await world.db
          .selectFrom('rooms.stars')
          .select((b) => b.fn.countAll<string>().as('n'))
          .where('room_id', '=', roomId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  /** An answer in Today by `author` that `giver` marks Useful: one act that earns a star unless the room refuses it. */
  async function usefulAnswer(
    w: RoomWorld,
    roomId: string,
    author: Friend,
    giver: Friend,
    text = 'Because of the tilt',
  ) {
    const today = await todayOf(roomId);
    const sent = unwrap(await say(w, author, roomId, today, text));
    unwrap(await markUseful(w, giver, roomId, today, sent.messageId));
    return sent.messageId;
  }

  async function fixtureRitual(roomId: string, kind: 'question' | 'flaw', day = dayOf(world.clock.now)) {
    const ritualId = randomUUID();
    await sql`
      insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at,
        decided_at, decided_by)
      values (${ritualId}::uuid, ${roomId}::uuid, ${day}::date, ${kind},
        ${JSON.stringify(kind === 'flaw' ? FIXTURE_FLAW : FIXTURE_QUESTION)}::jsonb, 'ritual.v1', 'approved', 'template',
        ${world.clock.now}, ${world.clock.now}, 'cli:ci')`.execute(world.db);
    return ritualId;
  }

  const readToday = async (person: Friend, roomId: string) =>
    unwrap(await world.rooms.today(person.authority, { version, readId: randomUUID(), roomId }));
  const solve = (person: Friend, roomId: string, ritualId: string, sentence: number, recordingGeneration = 1) =>
    world.rooms.solveFlaw(person.authority, {
      version,
      commandId: randomUUID(),
      roomId,
      ritualId,
      sentence,
      recordingGeneration,
    });

  describe('what earns a star', () => {
    it('gives the room a star for a human answer in Today that someone else found useful, and no more than once', async () => {
      at(0);
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const messageId = await usefulAnswer(world, roomId, asha, ravi);
      expect(await starTotal(roomId)).toBe(1);
      // Another member marking the same answer, and the mark taken back and given again, earn nothing more.
      const today = await todayOf(roomId);
      unwrap(await markUseful(world, kenji, roomId, today, messageId));
      unwrap(await markUseful(world, ravi, roomId, today, messageId, false));
      unwrap(await markUseful(world, ravi, roomId, today, messageId));
      expect(await starTotal(roomId)).toBe(1);
      const view = await skyOf(world, kenji, roomId);
      expect(view.status === 'ready' && view.sky).toMatchObject({ lit: 1, of: 7, state: 'forming', finished: 0 });
      expect(view.status === 'ready' && view.stars).toEqual([
        { act: 'answer_useful', day: dayOf(START), constellation: 1 },
      ]);
    });

    it('never gives one for the author’s own mark, a resident’s words, General chat, or the asker’s own answer', async () => {
      at(1);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const today = await todayOf(roomId);
      const own = unwrap(await say(world, asha, roomId, today, 'My own answer'));
      expect((await markUseful(world, asha, roomId, today, own.messageId)).kind).toBe('refused');
      // A resident's message in Today: inserted as the router would have (fixture row), marked by a person.
      const aiTurn = randomUUID();
      const aiMessage = randomUUID();
      await sql`
        insert into rooms.messages (message_id, discussion_id, sequence, change_sequence, author_kind, inhabitant, ai_kind,
          body_text, recorded_at)
        values (${aiMessage}::uuid, ${today}::uuid, 99, 99, 'ai', 'explainer', 'explanation', 'An explanation',
          ${world.clock.now})`.execute(world.db);
      void aiTurn;
      expect((await markUseful(world, ravi, roomId, today, aiMessage)).kind).toBe('ok');
      // General chat is conversation, not an answer to anything.
      const general = (await memberView(world, asha, roomId)).general.discussionId;
      const chat = unwrap(await say(world, asha, roomId, general, 'Hello everyone'));
      unwrap(await markUseful(world, ravi, roomId, general, chat.messageId));
      // A question topic: the starter's own later words do not earn, another member's do.
      const topic = unwrap(
        await world.rooms.create(asha.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: { kind: 'topic', title: 'Why is the sky dark at night?', tag: 'question' },
        }),
      ).discussionId;
      const starterWords = unwrap(await say(world, asha, roomId, topic, 'I think it is the expansion'));
      unwrap(await markUseful(world, ravi, roomId, topic, starterWords.messageId));
      expect(await starTotal(roomId)).toBe(0);
      const answer = unwrap(await say(world, ravi, roomId, topic, 'Light from far stars has not arrived yet'));
      unwrap(await markUseful(world, asha, roomId, topic, answer.messageId));
      expect(await starTotal(roomId)).toBe(1);
    });

    it('holds the daily cap, forgets the act that met a full day, and earns again the next day', async () => {
      at(2);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const answers: string[] = [];
      for (let index = 0; index < 4; index++)
        answers.push(await usefulAnswer(world, roomId, asha, ravi, `Answer ${String(index)}`));
      expect(await starTotal(roomId)).toBe(3);
      // The fourth answer earned nothing and was not remembered: marked again the next day it earns.
      at(2 + 24);
      const today = await todayOf(roomId);
      unwrap(await markUseful(world, ravi, roomId, today, answers[3]!, false));
      unwrap(await markUseful(world, ravi, roomId, today, answers[3]!));
      expect(await starTotal(roomId)).toBe(4);
      const days = await world.db.selectFrom('rooms.stars').select('earned_on').where('room_id', '=', roomId).execute();
      expect(new Set(days.map((row) => dayOf(new Date(row.earned_on)))).size).toBe(2);
    });

    it('awards exactly once when two members mark the same answer at the same moment', async () => {
      at(3);
      const { roomId } = await seedRoom(roomy);
      const [asha, ravi, kenji] = (await joined(roomy, roomId, 3)) as [Friend, Friend, Friend];
      const today = await todayOf(roomId);
      const sent = unwrap(await say(roomy, asha, roomId, today, 'A good answer'));
      await Promise.all([
        markUseful(roomy, ravi, roomId, today, sent.messageId),
        markUseful(roomy, kenji, roomId, today, sent.messageId),
      ]);
      expect(await starTotal(roomId)).toBe(1);
    });
  });

  describe('a constellation and its name', () => {
    it('finishes at seven stars, offers three names, takes votes, names it after a day by the votes and shows it on the map', async () => {
      at(4);
      const { roomId } = await seedRoom(roomy, { topic: { kind: 'system', id: 'space' }, slug: 'space' });
      const [asha, ravi, kenji, lena] = (await joined(roomy, roomId, 4)) as [Friend, Friend, Friend, Friend];
      for (let index = 0; index < 6; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Answer ${String(index)}`);
      let view = await skyOf(roomy, kenji, roomId);
      expect(view.status === 'ready' && view.sky).toMatchObject({ lit: 6, state: 'forming', finished: 0 });
      expect(view.status === 'ready' && view.naming).toBeUndefined();

      await usefulAnswer(roomy, roomId, kenji, lena, 'The seventh');
      view = await skyOf(roomy, kenji, roomId);
      if (view.status !== 'ready' || view.naming === undefined) throw new Error('expected a name vote');
      expect(view.sky).toMatchObject({ lit: 7, state: 'naming', finished: 1 });
      expect(new Set(view.naming.candidates).size).toBe(3);
      expect(view.naming.yourVote).toBeUndefined();
      expect(view.naming.votes).toBeUndefined();

      // Votes: Ravi and Kenji choose the second name, Lena the third; Ravi may change his mind, and counts show after voting.
      const name = (person: Friend, candidate: number) =>
        roomy.rooms.nameConstellation(person.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          constellation: 1,
          candidate,
        });
      unwrap(await name(ravi, 0));
      unwrap(await name(ravi, 1));
      unwrap(await name(kenji, 1));
      unwrap(await name(lena, 2));
      const voted = await skyOf(roomy, ravi, roomId);
      expect(voted.status === 'ready' && voted.naming).toMatchObject({ yourVote: 1, votes: [0, 2, 1] });
      const candidates = view.naming.candidates;

      // The vote is open for a day: the next member command after it settles the name by the votes.
      at(4 + 25);
      expect((await name(asha, 0)).kind).toBe('refused');
      unwrap(await setPresence(roomy, asha, roomId));
      const after = await skyOf(roomy, kenji, roomId);
      expect(after.status === 'ready' && after.sky).toMatchObject({ state: 'named', constellationName: candidates[1] });
      expect(after.status === 'ready' && after.naming).toBeUndefined();

      // A member's station on their own map carries the sky; the next star starts the next constellation and the name stays.
      await seedAuthoredGeography(roomy.db, ravi);
      await seedAuthoredGeography(roomy.db, lena);
      const stationOf = async (person: Friend) =>
        unwrap(await roomy.rooms.stations(person.authority, { version, readId: randomUUID() })).stations.find(
          (station) => station.room.roomId === roomId,
        );
      expect((await stationOf(ravi))?.sky).toEqual((await stationOf(lena))?.sky);
      expect((await stationOf(lena))?.sky).toMatchObject({ lit: 7, state: 'named', finished: 1 });
      await usefulAnswer(roomy, roomId, asha, kenji, 'Number eight');
      expect((await stationOf(lena))?.sky).toMatchObject({
        lit: 1,
        state: 'forming',
        finished: 1,
        constellationName: candidates[1],
      });
    });

    it('takes the first name when nobody votes, and the earlier name on a tie', async () => {
      at(40);
      const { roomId } = await seedRoom(roomy);
      const [asha, ravi] = (await joined(roomy, roomId, 2)) as [Friend, Friend];
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Answer ${String(index)}`);
      const first = await skyOf(roomy, ravi, roomId);
      if (first.status !== 'ready' || first.naming === undefined) throw new Error('expected a vote');
      const name = (person: Friend, candidate: number) =>
        roomy.rooms.nameConstellation(person.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          constellation: 1,
          candidate,
        });
      unwrap(await name(asha, 2));
      unwrap(await name(ravi, 1));
      at(40 + 25);
      unwrap(await setPresence(roomy, ravi, roomId));
      const tie = await skyOf(roomy, ravi, roomId);
      expect(tie.status === 'ready' && tie.sky.constellationName).toBe(first.naming.candidates[1]);
      // A second constellation with no votes at all takes its first candidate.
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Later ${String(index)}`);
      const second = await skyOf(roomy, ravi, roomId);
      if (second.status !== 'ready' || second.naming === undefined) throw new Error('expected a second vote');
      expect(second.naming.candidates).not.toContain(first.naming.candidates[1]);
      at(40 + 25 + 25);
      unwrap(await setPresence(roomy, asha, roomId));
      const settled = await skyOf(roomy, ravi, roomId);
      expect(settled.status === 'ready' && settled.sky.constellationName).toBe(second.naming.candidates[0]);
    });
  });

  describe('more than one constellation without a name', () => {
    const nameVote = (person: Friend, roomId: string, candidate: number, constellation: number) =>
      roomy.rooms.nameConstellation(person.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        constellation,
        candidate,
      });
    const votesOf = (roomId: string, no: number) =>
      world.db
        .selectFrom('rooms.constellation_votes')
        .select(['candidate', 'account_id'])
        .where('room_id', '=', roomId)
        .where('no', '=', no)
        .execute();
    const constellations = (roomId: string) =>
      world.db
        .selectFrom('rooms.constellations')
        .select(['no', 'name', 'candidates'])
        .where('room_id', '=', roomId)
        .orderBy('no')
        .execute();

    it('names each in turn when the next finishes inside the first day, and votes go to the older until its day ends', async () => {
      at(300);
      const { roomId } = await seedRoom(roomy);
      const [asha, ravi] = (await joined(roomy, roomId, 2)) as [Friend, Friend];
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `First ${String(index)}`);
      at(305);
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Second ${String(index)}`);
      const both = await skyOf(roomy, ravi, roomId);
      if (both.status !== 'ready' || both.naming === undefined) throw new Error('expected a vote');
      expect(both.sky).toMatchObject({ lit: 7, state: 'naming', finished: 2 });
      expect(both.naming.constellation).toBe(1);
      unwrap(await nameVote(ravi, roomId, 2, 1));
      const [first, second] = await constellations(roomId);
      // The first day ends: the next member command names it by its own votes, and the second keeps its day.
      at(300 + 25);
      unwrap(await setPresence(roomy, asha, roomId));
      expect((await constellations(roomId)).map((row) => row.name)).toEqual([first!.candidates[2], null]);
      const next = await skyOf(roomy, ravi, roomId);
      if (next.status !== 'ready' || next.naming === undefined) throw new Error('expected the second vote');
      expect(next.naming.constellation).toBe(2);
      expect(next.sky).toMatchObject({ state: 'naming', constellationName: first!.candidates[2] });
      unwrap(await nameVote(asha, roomId, 1, 2));
      at(305 + 25);
      unwrap(await setPresence(roomy, ravi, roomId));
      // The vote chose the second name, unless the first constellation already holds it: then the next one is taken.
      const secondName =
        second!.candidates[1] === first!.candidates[2]
          ? second!.candidates.find((name) => name !== first!.candidates[2])
          : second!.candidates[1];
      expect((await constellations(roomId)).map((row) => row.name)).toEqual([first!.candidates[2], secondName]);
      const done = await skyOf(roomy, ravi, roomId);
      expect(done.status === 'ready' && done.sky).toMatchObject({ state: 'named', constellationName: secondName });
      expect(done.status === 'ready' && done.naming).toBeUndefined();
    });

    it('refuses a vote for a constellation that is not the one open, and counts it for no other', async () => {
      at(500);
      const { roomId } = await seedRoom(roomy);
      const [asha, ravi] = (await joined(roomy, roomId, 2)) as [Friend, Friend];
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `First ${String(index)}`);
      at(505);
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Second ${String(index)}`);
      const [first, second] = await constellations(roomId);
      // The two lists offer six different names: naming one can never take a name from the other.
      expect(new Set([...first!.candidates, ...second!.candidates]).size).toBe(6);
      // While the first is open, a vote for the second is refused: votes go to the older.
      expect((await nameVote(ravi, roomId, 1, 2)).kind).toBe('refused');
      // The first is named; the second is now the one open. A sheet that still shows the first sends its tap for the first:
      // it is refused and counts for no name of the second.
      at(500 + 25);
      unwrap(await setPresence(roomy, asha, roomId));
      expect((await constellations(roomId)).map((row) => row.name !== null)).toEqual([true, false]);
      expect((await nameVote(ravi, roomId, 1, 1)).kind).toBe('refused');
      expect(await votesOf(roomId, 2)).toEqual([]);
      // The vote for the one open is kept, for that constellation and that name.
      expect(unwrap(await nameVote(ravi, roomId, 1, 2))).toMatchObject({ constellation: 2, candidate: 1 });
      expect(await votesOf(roomId, 2)).toMatchObject([{ candidate: 1 }]);
      expect(await votesOf(roomId, 1)).toEqual([]);
    });

    it('lets the plain vote decide when every offered name is already held, and offers a free name while one is left', async () => {
      at(600);
      const { roomId } = await seedRoom(roomy);
      const [asha, ravi] = (await joined(roomy, roomId, 2)) as [Friend, Friend];
      const day = 24 * HOUR;
      const longAgo = new Date(world.clock.now.getTime() - 10 * day);
      // A labelled fixture of a used-up list: three constellations hold the three names a fourth is offered.
      const held = ['The Lantern', 'The Kite', 'The Loom'] as const;
      for (const [index, name] of held.entries())
        await world.db
          .insertInto('rooms.constellations')
          .values({
            room_id: roomId,
            no: index + 1,
            completed_at: longAgo,
            candidates: [name, `Spare ${String(index)}a`, `Spare ${String(index)}b`],
            vote_closes_at: new Date(longAgo.getTime() + day),
            name,
            named_at: new Date(longAgo.getTime() + day),
          })
          .execute();
      await world.db
        .insertInto('rooms.constellations')
        .values({
          room_id: roomId,
          no: 4,
          completed_at: longAgo,
          candidates: [...held],
          vote_closes_at: new Date(longAgo.getTime() + day),
        })
        .execute();
      for (const person of [asha, ravi])
        await world.db
          .insertInto('rooms.constellation_votes')
          .values({ room_id: roomId, no: 4, account_id: person.accountId, candidate: 2, voted_at: longAgo })
          .execute();
      unwrap(await setPresence(roomy, asha, roomId));
      const named = await constellations(roomId);
      // No candidate was free, so the votes decided: the third name, a repeat, as the list was used up.
      expect(named[3]!.name).toBe('The Loom');
    });

    it('names both in one pass when nobody looked until after both days, oldest first and never by the same name', async () => {
      at(400);
      const { roomId } = await seedRoom(roomy);
      const [asha, ravi] = (await joined(roomy, roomId, 2)) as [Friend, Friend];
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `First ${String(index)}`);
      at(401);
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Second ${String(index)}`);
      at(400 + 60);
      unwrap(await setPresence(roomy, asha, roomId));
      const named = await constellations(roomId);
      expect(named.map((row) => row.name !== null)).toEqual([true, true]);
      expect(named[0]!.name).toBe(named[0]!.candidates[0]);
      expect(new Set(named.map((row) => row.name)).size).toBe(2);
    });
  });

  describe('a debate closed by vote', () => {
    const start = (w: RoomWorld, person: Friend, roomId: string, debate: unknown, tag: string | null = 'debate') =>
      w.rooms.create(person.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        start: {
          kind: 'topic',
          title: 'Dark matter or modified gravity?',
          ...(tag === null ? {} : { tag }),
          ...(debate === undefined ? {} : { debate }),
        },
      });
    const vote = (person: Friend, roomId: string, discussionId: string, side: 'a' | 'b') =>
      world.rooms.voteDebate(person.authority, { version, commandId: randomUUID(), roomId, discussionId, side });
    const debateOf = async (person: Friend, roomId: string, discussionId: string) => {
      const view = await world.rooms.readDiscussion(person.authority, {
        version,
        readId: randomUUID(),
        roomId,
        discussionId,
        limit: 50,
      });
      const ready = unwrap(view);
      return ready.status === 'ready' ? ready.debate : undefined;
    };

    it('needs two sides and a close time for the tag, and refuses them for any other', async () => {
      at(60);
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const sides = { sides: ['Dark matter', 'Modified gravity'], closesInHours: 24 };
      expect((await start(world, asha, roomId, undefined)).kind).toBe('refused');
      expect((await start(world, asha, roomId, sides, 'question')).kind).toBe('refused');
      expect((await start(world, asha, roomId, sides, null)).kind).toBe('refused');
      expect((await start(world, asha, roomId, { sides: ['Same', 'same'], closesInHours: 24 })).kind).toBe('refused');
      expect((await start(world, asha, roomId, sides)).kind).toBe('ok');
    });

    it('holds the tally back until someone votes, lets a vote change until it closes, and closes with a star', async () => {
      at(70);
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const discussionId = unwrap(
        await start(world, asha, roomId, { sides: ['Dark matter', 'Modified gravity'], closesInHours: 24 }),
      ).discussionId;
      expect(await debateOf(ravi, roomId, discussionId)).toMatchObject({
        state: 'open',
        sides: [{ text: 'Dark matter' }, { text: 'Modified gravity' }],
      });
      expect((await debateOf(ravi, roomId, discussionId))?.sides[0].votes).toBeUndefined();
      unwrap(await vote(asha, roomId, discussionId, 'a'));
      unwrap(await vote(ravi, roomId, discussionId, 'b'));
      unwrap(await vote(ravi, roomId, discussionId, 'a'));
      unwrap(await vote(kenji, roomId, discussionId, 'b'));
      expect(await debateOf(ravi, roomId, discussionId)).toMatchObject({
        state: 'open',
        yourVote: 'a',
        sides: [{ votes: 2 }, { votes: 1 }],
      });
      expect(await starTotal(roomId)).toBe(0);
      // Past the close time a vote is refused and the debate reads as closed; the next member command settles the star, once.
      at(70 + 25);
      expect((await vote(kenji, roomId, discussionId, 'a')).kind).toBe('refused');
      expect(await debateOf(kenji, roomId, discussionId)).toMatchObject({ state: 'closed', winner: 'a' });
      await Promise.all([setPresence(world, asha, roomId), setPresence(world, ravi, roomId)]);
      expect(await starTotal(roomId)).toBe(1);
      unwrap(await setPresence(world, kenji, roomId));
      expect(await starTotal(roomId)).toBe(1);
      expect(
        (await world.db.selectFrom('rooms.stars').select('act').where('room_id', '=', roomId).execute()).map(
          (row) => row.act,
        ),
      ).toEqual(['debate_closed']);
    });

    it('closes without a star when fewer than two different people voted, and a tie has no winner', async () => {
      at(100);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const lonely = unwrap(await start(world, asha, roomId, { sides: ['Yes', 'No'], closesInHours: 1 })).discussionId;
      unwrap(await vote(asha, roomId, lonely, 'a'));
      const tied = unwrap(await start(world, asha, roomId, { sides: ['Up', 'Down'], closesInHours: 1 })).discussionId;
      unwrap(await vote(asha, roomId, tied, 'a'));
      unwrap(await vote(ravi, roomId, tied, 'b'));
      at(102);
      unwrap(await setPresence(world, asha, roomId));
      expect(await debateOf(asha, roomId, tied)).toMatchObject({ state: 'closed' });
      expect((await debateOf(asha, roomId, tied))?.winner).toBeUndefined();
      expect(await starTotal(roomId)).toBe(1);
      expect(await debateOf(asha, roomId, lonely)).toMatchObject({ state: 'closed', winner: 'a' });
    });
  });

  describe('Spot the flaw', () => {
    it('shows only approved items, withholds the key until the tap, and makes the tap final', async () => {
      at(120);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      expect((await readToday(asha, roomId)).status === 'ready' && (await readToday(asha, roomId))).toMatchObject({
        status: 'ready',
        day: dayOf(world.clock.now),
        past: [],
      });
      // A draft is shown to no one.
      await world.db
        .insertInto('rooms.rituals')
        .values({
          ritual_id: randomUUID(),
          room_id: roomId,
          day: dayOf(world.clock.now),
          kind: 'flaw',
          payload: JSON.stringify(FIXTURE_FLAW),
          payload_version: 'ritual.v1',
          state: 'draft',
          made_by: 'template',
          created_at: world.clock.now,
        })
        .execute();
      expect((await readToday(asha, roomId)) as object).not.toHaveProperty('flaw');
      await world.db.deleteFrom('rooms.rituals').where('room_id', '=', roomId).execute();

      await fixtureRitual(roomId, 'question');
      const ritualId = await fixtureRitual(roomId, 'flaw');
      const open = await readToday(asha, roomId);
      if (open.status !== 'ready' || open.flaw?.state !== 'open') throw new Error('expected an open flaw');
      expect(open.flaw.sentences).toEqual(FIXTURE_FLAW.sentences);
      expect(JSON.stringify(open.flaw)).not.toContain('January');
      expect(open.flaw.by).toMatchObject({ kind: 'ai', inhabitant: 'skeptic', label: 'AI · Skeptic' });
      expect(open.question).toMatchObject({ prompt: FIXTURE_QUESTION.prompt, messagesToday: 0 });
      expect(open.question?.by).toMatchObject({ kind: 'ai', inhabitant: 'explainer' });

      // A wrong tap: no star, the key shows, a second command answers with the first.
      const wrong = unwrap(await solve(asha, roomId, ritualId, 0));
      expect(wrong).toMatchObject({ correct: false, flawIndex: 1, original: FIXTURE_FLAW.original, star: false });
      expect(unwrap(await solve(asha, roomId, ritualId, 1))).toMatchObject({ correct: false, star: false });
      const done = await readToday(asha, roomId);
      expect(done.status === 'ready' && done.flaw).toMatchObject({
        state: 'done',
        yourPick: 0,
        correct: false,
        found: 0,
      });
      expect((await solve(asha, roomId, ritualId, 9)).kind).toBe('refused');
      // The first right tap of the day earns the room a star; later right taps are found it, not stars.
      expect(unwrap(await solve(ravi, roomId, ritualId, 1))).toMatchObject({ correct: true, star: true });
      expect(await starTotal(roomId)).toBe(1);
      const [kenji] = (await joined(world, roomId, 1)) as [Friend];
      expect(unwrap(await solve(kenji, roomId, ritualId, 1))).toMatchObject({ correct: true, star: false });
      expect(await starTotal(roomId)).toBe(1);
      const after = await readToday(kenji, roomId);
      expect(after.status === 'ready' && after.flaw).toMatchObject({ state: 'done', found: 2 });
    });

    it('answers only for today, only for members, and counts the messages written in Today', async () => {
      at(140);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const yesterday = await fixtureRitual(roomId, 'flaw', dayOf(new Date(world.clock.now.getTime() - DAY)));
      expect((await solve(asha, roomId, yesterday, 1)).kind).toBe('refused');
      await fixtureRitual(roomId, 'question');
      const today = await todayOf(roomId);
      unwrap(await say(world, asha, roomId, today, 'Because of the tilt'));
      unwrap(await say(world, ravi, roomId, today, 'And the Sun is high in summer'));
      const view = await readToday(asha, roomId);
      expect(view.status === 'ready' && view.question?.messagesToday).toBe(2);
      const stranger = await seedFriend(world.db, world.friends);
      expect((await world.rooms.today(stranger.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
      expect((await solve(stranger, roomId, yesterday, 1)).kind).toBe('refused');
      // The questions of earlier days are listed, newest first.
      await fixtureRitual(roomId, 'question', dayOf(new Date(world.clock.now.getTime() - DAY)));
      const withPast = await readToday(asha, roomId);
      expect(withPast.status === 'ready' && withPast.past).toEqual([
        { day: dayOf(new Date(world.clock.now.getTime() - DAY)), prompt: FIXTURE_QUESTION.prompt },
      ]);
    });
  });

  describe('Spot the flaw and recording', () => {
    const setRecording = (person: Friend, on: boolean, generation: number) =>
      world.db
        .updateTable('identity.universes')
        .set({ recording_on: on, recording_generation: generation })
        .where('account_id', '=', person.accountId)
        .execute();

    it('stores no tap while recording is paused and keeps the key, and the same tap can be sent after it is back on', async () => {
      at(210);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const ritualId = await fixtureRitual(roomId, 'flaw');
      await setRecording(ravi, false, 2);
      const paused = unwrap(await solve(ravi, roomId, ritualId, 1, 2));
      expect(paused).toMatchObject({ outcome: 'not_saved', reason: 'recording_paused', ritualId });
      expect(JSON.stringify(paused)).not.toContain('January');
      expect(
        await world.db
          .selectFrom('rooms.ritual_solves')
          .select('ritual_id')
          .where('ritual_id', '=', ritualId)
          .execute(),
      ).toEqual([]);
      expect(await starTotal(roomId)).toBe(0);
      const read = await readToday(ravi, roomId);
      expect(read.status === 'ready' && read.flaw).toMatchObject({ state: 'open' });
      // Back on, but the device still names the old generation: nothing stored either.
      await setRecording(ravi, true, 3);
      expect(unwrap(await solve(ravi, roomId, ritualId, 1, 2))).toMatchObject({
        outcome: 'not_saved',
        reason: 'recording_generation_stale',
      });
      expect(await starTotal(roomId)).toBe(0);
      expect(unwrap(await solve(ravi, roomId, ritualId, 1, 3))).toMatchObject({
        outcome: 'accepted',
        correct: true,
        star: true,
      });
      // Someone whose recording is on is unaffected by another pause.
      expect(unwrap(await solve(asha, roomId, ritualId, 0))).toMatchObject({ outcome: 'accepted', correct: false });
    });

    it('still answers a tap that was accepted, when recording has been paused since', async () => {
      at(220);
      const { roomId } = await seedRoom(world);
      const [, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const ritualId = await fixtureRitual(roomId, 'flaw');
      const commandId = randomUUID();
      const send = (generation: number) =>
        world.rooms.solveFlaw(ravi.authority, {
          version,
          commandId,
          roomId,
          ritualId,
          sentence: 1,
          recordingGeneration: generation,
        });
      expect(unwrap(await send(1))).toMatchObject({ outcome: 'accepted', star: true });
      await setRecording(ravi, false, 2);
      expect(unwrap(await send(1))).toMatchObject({ outcome: 'accepted', replayed: true, star: true });
    });
  });

  describe('who can read the sky', () => {
    it('is for members only: an outsider, a stranger and a person who left read nothing, and a station shows an outsider none', async () => {
      at(160);
      await seedRooms(world.db, libraryRoomSeeds(), world.clock.now);
      const earth = (
        await world.db.selectFrom('rooms.rooms').select('room_id').where('slug', '=', 'earth').executeTakeFirstOrThrow()
      ).room_id;
      const [asha, ravi] = (await joined(world, earth, 2)) as [Friend, Friend];
      await usefulAnswer(world, earth, asha, ravi);
      const outsider = await seedFriend(world.db, world.friends);
      await seedAuthoredGeography(world.db, outsider);
      await seedAuthoredGeography(world.db, ravi);
      expect((await world.rooms.sky(outsider.authority, { version, readId: randomUUID(), roomId: earth })).kind).toBe(
        'refused',
      );
      const preview = unwrap(
        await world.rooms.read(outsider.authority, { version, readId: randomUUID(), roomId: earth }),
      );
      expect(preview).not.toHaveProperty('sky');
      const outsiderStation = unwrap(
        await world.rooms.stations(outsider.authority, { version, readId: randomUUID() }),
      ).stations.find((station) => station.room.roomId === earth);
      expect(outsiderStation?.standing).toBe('none');
      expect(outsiderStation).not.toHaveProperty('sky');
      const memberStation = unwrap(
        await world.rooms.stations(ravi.authority, { version, readId: randomUUID() }),
      ).stations.find((station) => station.room.roomId === earth);
      expect(memberStation?.sky).toMatchObject({ lit: 1, of: 7, state: 'forming' });
      expect((await memberView(world, ravi, earth)).sky).toMatchObject({ lit: 1 });
      // A person who leaves reads nothing more.
      unwrap(await world.rooms.leave(ravi.authority, { version, commandId: randomUUID(), roomId: earth }));
      expect((await world.rooms.sky(ravi.authority, { version, readId: randomUUID(), roomId: earth })).kind).toBe(
        'refused',
      );
    });

    it('names no person, message or title in a star, and reads the same to someone who blocked a member', async () => {
      at(170);
      const { roomId } = await seedRoom(world);
      const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      await usefulAnswer(world, roomId, asha, ravi, 'A distinctive answer to remember');
      unwrap(await friendCommand(world.friends, kenji, asha, 'block'));
      const [seenByBlocker, seenByOther] = await Promise.all([skyOf(world, kenji, roomId), skyOf(world, ravi, roomId)]);
      const { readId: _a, scope: _scopeA, ...blockerView } = seenByBlocker as Record<string, unknown>;
      const { readId: _b, scope: _scopeB, ...otherView } = seenByOther as Record<string, unknown>;
      expect(blockerView).toEqual(otherView);
      const text = JSON.stringify(seenByBlocker);
      for (const secret of [asha.accountId, ravi.accountId, 'distinctive', asha.person.handle])
        expect(text).not.toContain(secret);
    });
  });

  describe('what a person takes back', () => {
    /** A person created by the real operator sign-in (deletion and Clear need the real lifecycle), with a claimed profile. */
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
    const countFor = async (table: string, accountId: string) =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from ${sql.table(table)} where account_id = ${accountId}::uuid`.execute(
            world.db,
          )
        ).rows[0]!.n,
      );

    async function actedMember() {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const person = await realMember();
      unwrap(await joinRoom(world, person, roomId));
      const debate = unwrap(
        await world.rooms.create(asha.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: {
            kind: 'topic',
            title: 'A debate',
            tag: 'debate',
            debate: { sides: ['Yes', 'No'], closesInHours: 48 },
          },
        }),
      ).discussionId;
      unwrap(
        await world.rooms.voteDebate(person.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          discussionId: debate,
          side: 'a',
        }),
      );
      const ritual = await fixtureRitual(roomId, 'flaw');
      unwrap(await solve(person, roomId, ritual, 1));
      for (let index = 0; index < 7; index++) await usefulAnswer(roomy, roomId, asha, ravi, `Fill ${String(index)}`);
      unwrap(
        await roomy.rooms.nameConstellation(person.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          constellation: 1,
          candidate: 1,
        }),
      );
      return { roomId, person, ritual };
    }

    it('deletes votes and taps when they leave, and keeps the stars', async () => {
      at(180);
      const { roomId, person } = await actedMember();
      const stars = await starTotal(roomId);
      expect(stars).toBeGreaterThan(0);
      unwrap(await world.rooms.leave(person.authority, { version, commandId: randomUUID(), roomId }));
      for (const table of ['rooms.debate_votes', 'rooms.constellation_votes', 'rooms.ritual_solves'])
        expect(await countFor(table, person.accountId), table).toBe(0);
      expect(await starTotal(roomId)).toBe(stars);
    });

    it('erases the tap with a Clear, keeps the votes, then deletes everything with the account and exports it first', async () => {
      at(190);
      const { roomId, person } = await actedMember();
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const section = JSON.stringify(exported.value.sections['rooms']);
      expect(section).toContain('spotTheFlawTaps');
      expect(section).toContain('debateVotes');
      expect(section).toContain('constellationNameVotes');

      await clearRecordingPerson(database, boss, person);
      expect(await countFor('rooms.ritual_solves', person.accountId)).toBe(0);
      expect(await countFor('rooms.debate_votes', person.accountId)).toBe(1);
      expect(await countFor('rooms.constellation_votes', person.accountId)).toBe(1);

      const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(cleared.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      for (const table of ['rooms.debate_votes', 'rooms.constellation_votes', 'rooms.ritual_solves'])
        expect(await countFor(table, person.accountId), table).toBe(0);
      expect(await starTotal(roomId)).toBeGreaterThan(0);
    });
  });

  it('writes nothing to a person’s own universe: stars, taps, votes and the sky are room facts, never evidence', async () => {
    at(200);
    const { roomId } = await seedRoom(world);
    const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
    const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
    await usefulAnswer(world, roomId, asha, ravi);
    const ritual = await fixtureRitual(roomId, 'flaw');
    unwrap(await solve(ravi, roomId, ritual, 1));
    await skyOf(world, asha, roomId);
    await readToday(asha, roomId);
    unwrap(await setPresence(world, asha, roomId));
    expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
    void startTopic;
  });
});
