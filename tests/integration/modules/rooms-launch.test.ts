/**
 * The Launch (v3 R-6, D-178 to D-179, D-219 to D-224) over real PostgreSQL: a live five-question quiz that a room plays, on the
 * server's clock. CI fixture accounts, fixture decks (labelled, never library content or provider output) and a fixture clock; no
 * model is involved at all, which the tests prove by what was queued and what was written.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { importEditorialScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { seedRooms } from '@knowscroll/backend/modules/rooms/nest-providers';
import { ANSWER_MS, LOBBY_MS, PLAY_MS, ROUND_MS } from '../../../packages/backend/src/modules/rooms/domain/launch.js';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  joined,
  libraryRoomSeeds,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  roomWorld,
  rowsIn,
  seedRoom,
  setPresence,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { starterSource } from '../support/scroll.js';
import { friendCommand, seedFriend, type Friend } from '../support/talk.js';
import { seedAuthoredGeography } from '../support/visit-world.js';

const version = 'rooms.v1' as const;
const START = new Date(Date.UTC(2026, 10, 1, 21, 0, 0));
const HOUR = 3_600_000;
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The right option of each fixture question, in order. A different place each time, so a guess is not the key. */
const KEY = [1, 0, 2, 1, 0] as const;
const OPTIONS = ['First fixture option', 'Second fixture option', 'Third fixture option'];

describe('the Launch (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;
  /** An admitted library Scroll the fixture decks cite: the start command asks that every cited Scroll is still current. */
  let scrollId: string;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_launch');
    world = await roomWorld(database, { now: START }, { starsPerDay: 3, launchGapMinutes: 120 });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    const source = starterSource() as unknown as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    scrollId = randomUUID();
    source.assetId = scrollId;
    source.publication.explanationUnitId = `ci-launch-${scrollId.slice(0, 8)}`;
    source.draft.title = 'CI fixture Scroll for a Launch';
    expect((await importEditorialScrollUseCase(database.db)(source)).kind).toBe('imported');
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });

  const at = (ms: number, base = START) => {
    world.clock.now = new Date(base.getTime() + ms);
  };
  /** Each test starts at its own hour, so a room's rest between Launches never carries from one test to the next. */
  let hourOfTest = 0;
  const begin = () => {
    hourOfTest += 5;
    at(hourOfTest * HOUR);
    return world.clock.now;
  };

  /** An approved deck of five fixture questions for a room, as an operator's approval leaves it. */
  async function approvedDeck(
    roomId: string,
    over: { state?: 'draft' | 'approved'; day?: string; asset?: string } = {},
  ) {
    const ritualId = randomUUID();
    const payload = {
      questions: KEY.map((answer, index) => ({
        prompt: `Fixture question ${String(index + 1)}: which option is the key?`,
        options: OPTIONS,
        answer,
        explain: `Fixture reason ${String(index + 1)}: the Scroll says so.`,
        source: { assetId: over.asset ?? scrollId, assetRevision: 1, stopId: `s${String(index + 1)}` },
      })),
    };
    const approved = (over.state ?? 'approved') === 'approved';
    await sql`
      insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at,
        decided_at, decided_by)
      values (${ritualId}::uuid, ${roomId}::uuid, ${over.day ?? dayOf(world.clock.now)}::date, 'launch',
        ${JSON.stringify(payload)}::jsonb, 'ritual.v1', ${over.state ?? 'approved'}, 'template', ${world.clock.now},
        ${approved ? world.clock.now : null}, ${approved ? 'cli:ci' : null})`.execute(world.db);
    return ritualId;
  }

  const start = (person: Friend, roomId: string, recordingGeneration = 1) =>
    world.rooms.startLaunch(person.authority, { version, commandId: randomUUID(), roomId, recordingGeneration });
  const join = (person: Friend, roomId: string, launchId: string, recordingGeneration = 1) =>
    world.rooms.joinLaunch(person.authority, {
      version,
      commandId: randomUUID(),
      roomId,
      launchId,
      recordingGeneration,
    });
  const answer = (
    person: Friend,
    roomId: string,
    launchId: string,
    round: number,
    choice: number,
    recordingGeneration = 1,
  ) =>
    world.rooms.answerLaunch(person.authority, {
      version,
      commandId: randomUUID(),
      roomId,
      launchId,
      round,
      choice,
      recordingGeneration,
    });
  const finish = (person: Friend, roomId: string, launchId: string) =>
    world.rooms.finishLaunch(person.authority, { version, commandId: randomUUID(), roomId, launchId });
  const read = async (person: Friend, roomId: string) => {
    const view = unwrap(await world.rooms.launch(person.authority, { version, readId: randomUUID(), roomId }));
    if (view.status !== 'ready') throw new Error('expected a ready view');
    return view;
  };

  /** A room with `count` members, all with the room open, and an approved deck for today. */
  async function readyRoom(count: number) {
    const { roomId } = await seedRoom(world);
    const people = await joined(world, roomId, count);
    for (const person of people) unwrap(await setPresence(world, person, roomId));
    await approvedDeck(roomId);
    return { roomId, people };
  }

  /** Where the first question opens, for a Launch started now. */
  const opensAt = (startedAt: Date) => new Date(startedAt.getTime() + LOBBY_MS);
  const starCount = async (roomId: string) =>
    Number(
      (
        await world.db
          .selectFrom('rooms.stars')
          .select((b) => b.fn.countAll<string>().as('n'))
          .where('room_id', '=', roomId)
          .where('act', '=', 'launch_finished')
          .executeTakeFirstOrThrow()
      ).n,
    );

  describe('starting one', () => {
    it('needs an approved deck, two people with the room open, an open room and a rest since the last Launch, and says which', async () => {
      const t0 = begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      unwrap(await setPresence(world, asha, roomId));
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'no_deck' });
      expect((await memberView(world, asha, roomId)).launch).toBeUndefined();

      // A deck nobody approved is not played.
      await approvedDeck(roomId, { state: 'draft', day: dayOf(new Date(t0.getTime() - 24 * HOUR)) });
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'no_deck' });
      await approvedDeck(roomId);
      expect((await memberView(world, asha, roomId)).launch).toEqual({ state: 'ready' });

      // One person here is not enough; two are.
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'few_here' });
      expect((await start(asha, roomId)).kind).toBe('refused');
      unwrap(await setPresence(world, ravi, roomId));
      expect((await read(asha, roomId)).start).toEqual({ allowed: true });

      // A lease that has lapsed is not someone here.
      at(120_000, t0);
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'few_here' });
      unwrap(await setPresence(world, ravi, roomId));
      unwrap(await setPresence(world, asha, roomId));
      const started = unwrap(await start(asha, roomId));
      expect(started).toMatchObject({ outcome: 'accepted', operation: 'launch.start', startsInMs: LOBBY_MS });
    });

    it('is refused for an old deck, an open Launch, a room that is paused, and a deck whose Scroll is no longer current', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const gone = randomUUID();
      // A deck of three days ago is not tonight's; a deck citing a Scroll the library does not have is not asked.
      await sql`delete from rooms.rituals where room_id = ${roomId}::uuid`.execute(world.db);
      await approvedDeck(roomId, { day: dayOf(new Date(t0.getTime() - 3 * 24 * HOUR)) });
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'no_deck' });
      await approvedDeck(roomId, { asset: gone });
      expect((await start(asha, roomId)).kind).toBe('refused');
      expect(
        await world.db.selectFrom('rooms.launches').select('launch_id').where('room_id', '=', roomId).execute(),
      ).toEqual([]);
      await sql`delete from rooms.rituals where room_id = ${roomId}::uuid`.execute(world.db);
      await approvedDeck(roomId);

      const first = unwrap(await start(asha, roomId));
      if (first.outcome !== 'accepted') throw new Error('expected accepted');
      // Only one Launch at a time, and one deck is played once.
      expect((await start(ravi, roomId)).kind).toBe('refused');
      const second = await read(ravi, roomId);
      expect(second.start).toBeUndefined();
      expect(second.launch?.phase).toBe('lobby');

      const paused = await seedRoom(world);
      const [lena, omar] = (await joined(world, paused.roomId, 2)) as [Friend, Friend];
      for (const person of [lena, omar]) unwrap(await setPresence(world, person, paused.roomId));
      await approvedDeck(paused.roomId);
      await world.db
        .updateTable('rooms.rooms')
        .set({ status: 'paused' })
        .where('room_id', '=', paused.roomId)
        .execute();
      expect((await read(lena, paused.roomId)).start).toEqual({ allowed: false, reason: 'room_paused' });
      expect((await start(lena, paused.roomId)).kind).toBe('refused');
    });

    it('rests between Launches: the room cannot start another inside the gap, and can after it', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      unwrap(await start(asha, roomId));
      at(LOBBY_MS + PLAY_MS, t0);
      unwrap(await finish(ravi, roomId, (await read(ravi, roomId)).launch!.launchId));
      await approvedDeck(roomId, { day: dayOf(new Date(world.clock.now.getTime() - 24 * HOUR)) });
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'resting' });
      expect(await start(asha, roomId)).toEqual({ kind: 'refused', code: 'rate_limited' });
      at(2 * HOUR + 1, t0);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      expect(unwrap(await start(asha, roomId))).toMatchObject({ outcome: 'accepted' });
    });

    it('makes one Launch when two members start at once, and replays the same command', async () => {
      begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi] = people as [Friend, Friend, Friend];
      const results = await Promise.all([start(asha, roomId), start(ravi, roomId)]);
      expect(results.filter((result) => result.kind === 'ok')).toHaveLength(1);
      expect(
        await world.db.selectFrom('rooms.launches').select('launch_id').where('room_id', '=', roomId).execute(),
      ).toHaveLength(1);
      // The same command again is the same answer, not a refusal for a Launch that is already on.
      const mine = await seedRoom(world);
      const [lena, omar] = (await joined(world, mine.roomId, 2)) as [Friend, Friend];
      for (const person of [lena, omar]) unwrap(await setPresence(world, person, mine.roomId));
      await approvedDeck(mine.roomId);
      const body = { version, commandId: randomUUID(), roomId: mine.roomId, recordingGeneration: 1 };
      const first = unwrap(await world.rooms.startLaunch(lena.authority, body));
      expect(unwrap(await world.rooms.startLaunch(lena.authority, body))).toEqual({ ...first, replayed: true });
      expect(
        await world.db.selectFrom('rooms.launches').select('launch_id').where('room_id', '=', mine.roomId).execute(),
      ).toHaveLength(1);
    });
  });

  describe('a game on the server clock', () => {
    it('runs a lobby, five questions, their answers and a podium, and reveals nothing early', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      const queuedBefore =
        world.queued.length + world.castChecks.length + world.castPasses.length + world.summaries.length;
      const aiRowsBefore = await world.db.selectFrom('rooms.ai_turns').select('turn_id').execute();
      const personal = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);

      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const launchId = started.launchId;
      expect((await memberView(world, kenji, roomId)).launch).toEqual({ state: 'lobby' });

      // The lobby: who is in, and when it begins, in time left.
      at(5_000, t0);
      const lobby = (await read(ravi, roomId)).launch;
      expect(lobby).toMatchObject({ phase: 'lobby', startsInMs: LOBBY_MS - 5_000, youIn: false });
      expect(lobby?.phase === 'lobby' && lobby.players.map((face) => face.person.personId)).toEqual([
        asha.person.personId,
      ]);
      unwrap(await join(ravi, roomId, launchId));
      // The same command again changes nothing.
      expect(unwrap(await join(ravi, roomId, launchId))).toMatchObject({ outcome: 'accepted' });
      expect(
        await world.db
          .selectFrom('rooms.launch_players')
          .select('account_id')
          .where('launch_id', '=', launchId)
          .execute(),
      ).toHaveLength(2);
      // Nothing can be answered before the first question opens.
      expect((await answer(asha, roomId, launchId, 1, 1)).kind).toBe('refused');

      const open = opensAt(t0);
      for (let round = 1; round <= 5; round++) {
        const opened = new Date(open.getTime() + (round - 1) * ROUND_MS);
        // The question is open: its words and time left, and nothing that names the key, a count or a person.
        at(opened.getTime() - t0.getTime() + 1_000, t0);
        const live = (await read(kenji, roomId)).launch;
        expect(live).toMatchObject({ phase: 'open', round, of: 5, closesInMs: ANSWER_MS - 1_000, youIn: false });
        const text = JSON.stringify(live);
        for (const secret of [
          'correct',
          'explain',
          'locked',
          'right',
          'calledIt',
          'Fixture reason',
          asha.accountId,
          ravi.accountId,
        ])
          expect(text, `round ${String(round)} leaks ${secret}`).not.toContain(secret);
        expect(live?.phase === 'open' && live.options).toEqual(OPTIONS);

        // Asha is always right and fast; Ravi is right only in the first three, a little slower.
        const key = KEY[round - 1]!;
        const ashaAck = unwrap(await answer(asha, roomId, launchId, round, key));
        expect(ashaAck).toMatchObject({ outcome: 'accepted', round });
        expect(JSON.stringify(ashaAck)).not.toMatch(/correct|right/i);
        at(opened.getTime() - t0.getTime() + 2_000, t0);
        if (round <= 4) unwrap(await answer(ravi, roomId, launchId, round, round <= 3 ? key : (key + 1) % 3));

        // The question has closed: the key, the reason, and who got it right.
        at(opened.getTime() - t0.getTime() + ANSWER_MS, t0);
        const revealed = (await read(ravi, roomId)).launch;
        expect(revealed).toMatchObject({
          phase: 'reveal',
          round,
          correct: key,
          explain: `Fixture reason ${String(round)}: the Scroll says so.`,
          locked: round <= 4 ? 2 : 1,
          right: round <= 3 ? 2 : 1,
          nextInMs: ROUND_MS - ANSWER_MS,
          last: round === 5,
          yourScore: Math.min(round, 3),
        });
        expect(revealed?.phase === 'reveal' && revealed.calledIt.map((face) => face.you)).toEqual(
          round <= 3 ? [true, false] : [false],
        );
        // A person who did not answer, and who never joined, sees the same reveal with nothing of their own.
        expect((await read(kenji, roomId)).launch).toMatchObject({ phase: 'reveal', round, youIn: false });
      }

      // The podium waits for the end, on the server's clock; a device that runs fast cannot end the Launch early.
      at(open.getTime() - t0.getTime() + PLAY_MS - 1, t0);
      expect((await finish(kenji, roomId, launchId)).kind).toBe('refused');
      expect(await starCount(roomId)).toBe(0);
      at(open.getTime() - t0.getTime() + PLAY_MS, t0);
      expect(unwrap(await finish(kenji, roomId, launchId))).toMatchObject({ outcome: 'accepted', launchId });
      const podium = (await read(kenji, roomId)).launch;
      expect(podium).toMatchObject({ phase: 'finished', played: 2, star: true, youIn: false });
      expect(
        podium?.phase === 'finished' &&
          podium.podium.map((entry) => [entry.place, entry.score, entry.person?.personId]),
      ).toEqual([
        [1, 5, asha.person.personId],
        [2, 3, ravi.person.personId],
      ]);
      expect(podium?.phase === 'finished' && podium.you).toBeUndefined();
      const own = (await read(ravi, roomId)).launch;
      expect(own?.phase === 'finished' && own.you).toEqual({
        score: 3,
        squares: [true, true, true, false, false],
        place: 2,
      });
      expect(await starCount(roomId)).toBe(1);
      expect((await memberView(world, asha, roomId)).sky.lit).toBe(1);
      expect((await memberView(world, asha, roomId)).launch).toEqual({ state: 'finished' });

      // Finishing again, in any member's name or at once, settles nothing more and earns nothing more.
      unwrap(await finish(asha, roomId, launchId));
      await Promise.all([finish(ravi, roomId, launchId), finish(kenji, roomId, launchId)]);
      expect(await starCount(roomId)).toBe(1);

      // No model was asked and no AI spoke: nothing queued, no turn, no message by an AI.
      expect(world.queued.length + world.castChecks.length + world.castPasses.length + world.summaries.length).toBe(
        queuedBefore,
      );
      expect(await world.db.selectFrom('rooms.ai_turns').select('turn_id').execute()).toEqual(aiRowsBefore);
      // And nothing reached the person's own universe: a game is not evidence.
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(personal);
    });

    it('breaks a tie of right answers by the total time of the right ones, measured by the server', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      // All three get questions one and two right. Ravi answers a second later than Asha each time, Kenji two seconds before her.
      const plan: readonly [Friend, number][] = [
        [asha, 3_000],
        [ravi, 4_000],
        [kenji, 1_000],
      ];
      for (let round = 1; round <= 2; round++)
        for (const [person, delay] of plan) {
          at(open + (round - 1) * ROUND_MS + delay, t0);
          unwrap(await answer(person, roomId, started.launchId, round, KEY[round - 1]!));
        }
      // Kenji is faster on both, so wins; but he answers question three wrongly, so Asha and Ravi, with two right each, are tied with him.
      at(open + 2 * ROUND_MS + 500, t0);
      unwrap(await answer(kenji, roomId, started.launchId, 3, (KEY[2] + 1) % 3));
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, started.launchId));
      const podium = (await read(asha, roomId)).launch;
      expect(podium?.phase === 'finished' && podium.podium.map((entry) => entry.person?.personId)).toEqual([
        kenji.person.personId,
        asha.person.personId,
        ravi.person.personId,
      ]);
      const rows = await world.db
        .selectFrom('rooms.launch_answers')
        .select(['account_id', 'round', 'elapsed_ms'])
        .where('launch_id', '=', started.launchId)
        .where('round', '=', 1)
        .execute();
      expect(Object.fromEntries(rows.map((row) => [row.account_id, row.elapsed_ms]))).toEqual({
        [asha.accountId]: 3_000,
        [ravi.accountId]: 4_000,
        [kenji.accountId]: 1_000,
      });
    });

    it('accepts an answer only while its question is open, once, and only an option it has', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const { launchId } = started;
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + ANSWER_MS - 1, t0);
      // The last millisecond is in time; the next is not. A round that is not the open one is refused, whatever it says.
      expect((await answer(asha, roomId, launchId, 2, 0)).kind).toBe('refused');
      expect(unwrap(await answer(asha, roomId, launchId, 1, 1))).toMatchObject({ outcome: 'accepted' });
      at(open + ANSWER_MS, t0);
      expect((await answer(ravi, roomId, launchId, 1, 1)).kind).toBe('refused');
      expect((await answer(ravi, roomId, launchId, 1, 1)).kind).toBe('refused');
      // An option the question does not have is invalid, not silently accepted.
      at(open + ROUND_MS + 100, t0);
      expect((await answer(ravi, roomId, launchId, 2, 3)).kind).toBe('refused');
      const body = { version, commandId: randomUUID(), roomId, launchId, round: 2, choice: 0, recordingGeneration: 1 };
      expect(unwrap(await world.rooms.answerLaunch(ravi.authority, body))).toMatchObject({ outcome: 'accepted' });
      // The same command replays, and another command for the same round changes nothing: the first answer stands.
      expect(unwrap(await world.rooms.answerLaunch(ravi.authority, body))).toMatchObject({ replayed: true });
      at(open + ROUND_MS + 900, t0);
      unwrap(await answer(ravi, roomId, launchId, 2, 1));
      const kept = await world.db
        .selectFrom('rooms.launch_answers')
        .select(['choice', 'elapsed_ms'])
        .where('launch_id', '=', launchId)
        .where('account_id', '=', ravi.accountId)
        .execute();
      expect(kept).toEqual([{ choice: 0, elapsed_ms: 100 }]);
      // Answering is joining: Ravi never tapped Join and is a player.
      expect(
        await world.db
          .selectFrom('rooms.launch_players')
          .select('account_id')
          .where('launch_id', '=', launchId)
          .execute(),
      ).toHaveLength(2);
    });

    it('counts an answer accepted just before the end, and settles the Launch from a presence beat with no one asking', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 4 * ROUND_MS + ANSWER_MS - 1, t0);
      unwrap(await answer(asha, roomId, started.launchId, 5, KEY[4]));
      unwrap(await answer(ravi, roomId, started.launchId, 5, KEY[4]));
      expect(await starCount(roomId)).toBe(0);
      // Nobody calls finish: the room's next beat after the end settles it, once.
      at(open + PLAY_MS + 3_000, t0);
      unwrap(await setPresence(world, ravi, roomId));
      unwrap(await setPresence(world, asha, roomId));
      expect(await starCount(roomId)).toBe(1);
      const row = await world.db
        .selectFrom('rooms.launches')
        .select(['state', 'played', 'star'])
        .where('launch_id', '=', started.launchId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: 'finished', played: 2, star: true });
    });
  });

  describe('the star', () => {
    it('is one star for a Launch two people played, none for a Launch one person played, and none from a deck played twice', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const solo = unwrap(await start(asha, roomId));
      if (solo.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 500, t0);
      unwrap(await answer(asha, roomId, solo.launchId, 1, KEY[0]));
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, solo.launchId));
      const view = (await read(asha, roomId)).launch;
      expect(view).toMatchObject({ phase: 'finished', played: 1, star: false });
      expect(await starCount(roomId)).toBe(0);
      expect((await memberView(world, asha, roomId)).sky.lit).toBe(0);
      // The deck is spent: the same deck cannot be played again.
      at(3 * HOUR, t0);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      expect((await read(asha, roomId)).start).toEqual({ allowed: false, reason: 'no_deck' });
      void ravi;
    });

    it('stops at the room’s three stars a day, and an AI never earns one', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const today = dayOf(world.clock.now);
      // The room already earned its three stars today.
      for (let index = 0; index < 3; index++)
        await sql`insert into rooms.stars (star_id, room_id, act, source_key, earned_at, earned_on, constellation_no)
          values (${randomUUID()}::uuid, ${roomId}::uuid, 'answer_useful', ${randomUUID()}::uuid, ${world.clock.now}, ${today}::date, 1)`.execute(
          world.db,
        );
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 500, t0);
      unwrap(await answer(asha, roomId, started.launchId, 1, KEY[0]));
      unwrap(await answer(ravi, roomId, started.launchId, 1, KEY[0]));
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, started.launchId));
      const view = (await read(asha, roomId)).launch;
      expect(view).toMatchObject({ phase: 'finished', played: 2, star: false });
      expect(await starCount(roomId)).toBe(0);
      // A star holds an act and a source and no person.
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_schema = 'rooms' and table_name = 'stars'`.execute(
        world.db,
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain('account_id');
    });
  });

  describe('recording paused (D-083, D-220)', () => {
    const setRecording = (person: Friend, on: boolean, generation: number) =>
      world.db
        .updateTable('identity.universes')
        .set({ recording_on: on, recording_generation: generation })
        .where('account_id', '=', person.accountId)
        .execute();

    it('keeps nothing and writes no receipt while recording is paused or the device is out of date, for start, join and answer', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      await setRecording(kenji, false, 2);
      // A paused person cannot start one: nothing is stored.
      expect(unwrap(await start(kenji, roomId, 2))).toMatchObject({ outcome: 'not_saved', reason: 'recording_paused' });
      expect(
        await world.db.selectFrom('rooms.launches').select('launch_id').where('room_id', '=', roomId).execute(),
      ).toEqual([]);
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const { launchId } = started;
      expect(unwrap(await join(kenji, roomId, launchId, 2))).toMatchObject({
        outcome: 'not_saved',
        reason: 'recording_paused',
      });
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 500, t0);
      const paused = unwrap(await answer(kenji, roomId, launchId, 1, KEY[0], 2));
      expect(paused).toMatchObject({ outcome: 'not_saved', reason: 'recording_paused', roomId });
      expect(JSON.stringify(paused)).not.toMatch(/correct|right|elapsed/i);
      for (const table of ['rooms.launch_players', 'rooms.launch_answers'] as const)
        expect(
          await sql`select 1 from ${sql.table(table)} where account_id = ${kenji.accountId}::uuid`
            .execute(world.db)
            .then((r) => r.rows),
          table,
        ).toEqual([]);
      expect(
        await sql`select 1 from receipts.shared_commands where actor_account_id = ${kenji.accountId}::uuid and operation like 'rooms.launch-%'`
          .execute(world.db)
          .then((r) => r.rows),
      ).toEqual([]);
      // Back on, but the device still names the old generation: nothing stored either; then the new one is accepted.
      await setRecording(kenji, true, 3);
      expect(unwrap(await answer(kenji, roomId, launchId, 1, KEY[0], 2))).toMatchObject({
        outcome: 'not_saved',
        reason: 'recording_generation_stale',
      });
      expect(unwrap(await answer(kenji, roomId, launchId, 1, KEY[0], 3))).toMatchObject({ outcome: 'accepted' });
      // Someone whose recording is on is unaffected by another person's pause.
      expect(unwrap(await answer(ravi, roomId, launchId, 1, KEY[0]))).toMatchObject({ outcome: 'accepted' });
    });
  });

  describe('who can take part', () => {
    it('is for members only: a stranger, an outsider and a person who left read, join and answer nothing', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi, leaver] = people as [Friend, Friend, Friend];
      const outsider = await seedFriend(world.db, world.friends);
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const { launchId } = started;
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 500, t0);
      unwrap(await answer(leaver, roomId, launchId, 1, KEY[0]));
      unwrap(await world.rooms.leave(leaver.authority, { version, commandId: randomUUID(), roomId }));
      const unknown = randomUUID();
      for (const person of [outsider, leaver]) {
        expect((await world.rooms.launch(person.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
          'refused',
        );
        expect((await join(person, roomId, launchId)).kind).toBe('refused');
        expect((await answer(person, roomId, launchId, 1, 0)).kind).toBe('refused');
        expect((await finish(person, roomId, launchId)).kind).toBe('refused');
        expect((await start(person, roomId)).kind).toBe('refused');
      }
      // Every refusal is the same one, for a room that does not exist too.
      const missing = await world.rooms.launch(outsider.authority, { version, readId: randomUUID(), roomId: unknown });
      expect(missing).toEqual(await world.rooms.launch(leaver.authority, { version, readId: randomUUID(), roomId }));
      // A preview does not say a Launch is on.
      expect(
        JSON.stringify(unwrap(await world.rooms.read(outsider.authority, { version, readId: randomUUID(), roomId }))),
      ).not.toContain('"launch"');
      void ravi;
    });

    it('takes back a person’s answers and place when they leave or are removed, and a podium is read without them', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi, leaver] = people as [Friend, Friend, Friend];
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 500, t0);
      for (const person of [asha, ravi, leaver]) unwrap(await answer(person, roomId, started.launchId, 1, KEY[0]));
      const own = (accountId: string, table: 'rooms.launch_answers' | 'rooms.launch_players') =>
        sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)} where account_id = ${accountId}::uuid`
          .execute(world.db)
          .then((r) => Number(r.rows[0]!.n));
      expect(await own(leaver.accountId, 'rooms.launch_answers')).toBe(1);
      unwrap(await world.rooms.leave(leaver.authority, { version, commandId: randomUUID(), roomId }));
      expect(await own(leaver.accountId, 'rooms.launch_answers')).toBe(0);
      expect(await own(leaver.accountId, 'rooms.launch_players')).toBe(0);
      // Ravi is removed by a moderator; his answers go too, and the rest of the game is unchanged.
      await sql`update rooms.members set role = 'moderator' where room_id = ${roomId}::uuid and account_id = ${asha.accountId}::uuid`.execute(
        world.db,
      );
      unwrap(
        await world.rooms.moderate(asha.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          action: { kind: 'remove_member', personId: ravi.person.personId },
        }),
      );
      expect(await own(ravi.accountId, 'rooms.launch_answers')).toBe(0);
      expect(await own(asha.accountId, 'rooms.launch_answers')).toBe(1);
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, started.launchId));
      const view = (await read(asha, roomId)).launch;
      expect(view).toMatchObject({ phase: 'finished', played: 1, star: false });
    });

    it('draws a person the reader blocked as a place without a name on the podium, and leaves them out of the count and the faces', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      // Ravi is fastest, Asha second, Kenji third; all right on question one.
      for (const [person, delay] of [
        [ravi, 500],
        [asha, 1_500],
        [kenji, 2_500],
      ] as const) {
        at(open + delay, t0);
        unwrap(await answer(person, roomId, started.launchId, 1, KEY[0]));
      }
      unwrap(await friendCommand(world.friends, kenji, ravi, 'block'));
      at(open + ANSWER_MS, t0);
      const revealed = (await read(kenji, roomId)).launch;
      expect(revealed).toMatchObject({ phase: 'reveal', locked: 2, right: 2 });
      expect(revealed?.phase === 'reveal' && revealed.calledIt.map((face) => face.person.personId)).not.toContain(
        ravi.person.personId,
      );
      const unblocked = (await read(asha, roomId)).launch;
      expect(unblocked).toMatchObject({ phase: 'reveal', locked: 3, right: 3 });
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, started.launchId));
      const seen = (await read(kenji, roomId)).launch;
      const text = JSON.stringify(seen);
      expect(text).not.toContain(ravi.accountId);
      expect(text).not.toContain(ravi.person.personId);
      expect(text).not.toContain(ravi.person.handle);
      expect(
        seen?.phase === 'finished' && seen.podium.map((entry) => [entry.place, entry.blockedByYou, entry.you]),
      ).toEqual([
        [1, true, false],
        [2, false, false],
        [3, false, true],
      ]);
      // Nobody else sees any difference: the podium names Ravi first for everyone who did not block him.
      const other = (await read(asha, roomId)).launch;
      expect(other?.phase === 'finished' && other.podium.map((entry) => entry.person?.personId)).toEqual([
        ravi.person.personId,
        asha.person.personId,
        kenji.person.personId,
      ]);
    });
  });

  describe('the room’s own view of it', () => {
    it('says on a member’s station that a Launch is on, and on no one else’s, and not once it is over', async () => {
      const t0 = begin();
      await seedRooms(world.db, libraryRoomSeeds(), world.clock.now);
      const earth = (
        await world.db.selectFrom('rooms.rooms').select('room_id').where('slug', '=', 'earth').executeTakeFirstOrThrow()
      ).room_id;
      const [asha, ravi] = (await joined(world, earth, 2)) as [Friend, Friend];
      for (const person of [asha, ravi]) unwrap(await setPresence(world, person, earth));
      await approvedDeck(earth);
      const outsider = await seedFriend(world.db, world.friends);
      for (const person of [asha, outsider]) await seedAuthoredGeography(world.db, person);
      const stationOf = async (person: Friend) =>
        unwrap(await world.rooms.stations(person.authority, { version, readId: randomUUID() })).stations.find(
          (station) => station.room.roomId === earth,
        );
      expect(await stationOf(asha)).not.toHaveProperty('live');
      const started = unwrap(await start(asha, earth));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      expect((await stationOf(asha))?.live).toBe(true);
      expect(await stationOf(outsider)).not.toHaveProperty('live');
      expect((await stationOf(outsider))?.standing).toBe('none');
      at(opensAt(t0).getTime() - t0.getTime() + PLAY_MS, t0);
      expect(await stationOf(asha)).not.toHaveProperty('live');
    });
  });

  describe('what a person can take back', () => {
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
      const readProfile = await world.friends.readProfile(person.authority);
      if (readProfile.kind !== 'ok' || readProfile.value.status !== 'claimed') throw new Error('profile unreadable');
      return { ...person, person: readProfile.value.person };
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

    async function playedMember() {
      const t0 = begin();
      const { roomId } = await seedRoom(world);
      const person = await realMember();
      unwrap(await world.rooms.join(person.authority, { version, commandId: randomUUID(), roomId }));
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      for (const member of [person, asha]) unwrap(await setPresence(world, member, roomId));
      await approvedDeck(roomId);
      const started = unwrap(await start(person, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 700, t0);
      unwrap(await answer(person, roomId, started.launchId, 1, KEY[0]));
      unwrap(await answer(asha, roomId, started.launchId, 1, KEY[0]));
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, started.launchId));
      return { roomId, person, asha, launchId: started.launchId };
    }

    it('erases answers and place with a Clear, keeps the star, then deletes everything with the account and exports it first', async () => {
      const { roomId, person } = await playedMember();
      expect(await starCount(roomId)).toBe(1);
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const section = JSON.stringify(exported.value.sections['rooms']);
      expect(section).toContain('launchesPlayed');
      expect(section).toContain('"questionsRight":1');
      // What the person picked is not in their file, and nobody else is.
      expect(section).not.toContain('"choice"');

      await clearRecordingPerson(database, boss, person);
      expect(await countFor('rooms.launch_answers', person.accountId)).toBe(0);
      expect(await countFor('rooms.launch_players', person.accountId)).toBe(0);
      expect(await starCount(roomId)).toBe(1);

      const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(cleared.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await starCount(roomId)).toBe(1);
    });

    it('deletes the answers with an account that never had a Clear, and lists them first', async () => {
      const { roomId, person, launchId } = await playedMember();
      expect(await countFor('rooms.launch_answers', person.accountId)).toBe(1);
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await countFor('rooms.launch_answers', person.accountId)).toBe(0);
      expect(await countFor('rooms.launch_players', person.accountId)).toBe(0);
      expect(await starCount(roomId)).toBe(1);
      expect(
        await world.db.selectFrom('rooms.launches').select('launch_id').where('launch_id', '=', launchId).execute(),
      ).toHaveLength(1);
    });
  });

  describe('how long a Launch is kept', () => {
    it('reads a podium for a day, and deletes the answers of an old Launch with the room’s next one', async () => {
      const t0 = begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const started = unwrap(await start(asha, roomId));
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      const open = opensAt(t0).getTime() - t0.getTime();
      at(open + 500, t0);
      unwrap(await answer(asha, roomId, started.launchId, 1, KEY[0]));
      unwrap(await answer(ravi, roomId, started.launchId, 1, KEY[0]));
      at(open + PLAY_MS, t0);
      unwrap(await finish(asha, roomId, started.launchId));
      expect((await read(asha, roomId)).launch?.phase).toBe('finished');
      expect((await memberView(world, asha, roomId)).launch).toEqual({ state: 'finished' });
      at(open + PLAY_MS + 24 * HOUR - 1, t0);
      expect((await read(asha, roomId)).launch?.phase).toBe('finished');
      at(open + PLAY_MS + 24 * HOUR, t0);
      expect((await read(asha, roomId)).launch).toBeUndefined();
      expect((await memberView(world, asha, roomId)).launch).toBeUndefined();
      // Eight days later the next Launch of the room deletes the earlier one's answers and places; the Launch row stays.
      at(8 * 24 * HOUR, t0);
      await approvedDeck(roomId);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      unwrap(await start(asha, roomId));
      const count = (table: 'rooms.launch_answers' | 'rooms.launch_players') =>
        sql<{
          n: string;
        }>`select count(*)::text as n from ${sql.table(table)} where launch_id = ${started.launchId}::uuid`
          .execute(world.db)
          .then((r) => Number(r.rows[0]!.n));
      expect(await count('rooms.launch_answers')).toBe(0);
      expect(await count('rooms.launch_players')).toBe(0);
      expect(
        await world.db.selectFrom('rooms.launches').select('launch_id').where('room_id', '=', roomId).execute(),
      ).toHaveLength(2);
    });
  });
});
