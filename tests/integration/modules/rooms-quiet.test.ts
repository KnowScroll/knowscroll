/**
 * The quiet room (v3 R-7, D-241 to D-243) over real PostgreSQL: the replay of a finished Launch against the answers the people who
 * played it gave, and a question left for people. CI fixture accounts, fixture decks and a fixture model (labelled, never library
 * content or provider output) and a fixture clock. The replay stores nothing and calls no model; a left question calls a resident
 * only when its asker asks, within the asked bounds, and never starts the unprompted router.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { importEditorialScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import {
  ANSWER_MS,
  LOBBY_MS,
  PLAY_MS,
  RESULTS_KEPT_DAYS,
  ROUND_MS,
} from '../../../packages/backend/src/modules/rooms/domain/launch.js';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  hideMessage,
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
  setPreferences,
  setPresence,
  topicsOf,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { starterSource } from '../support/scroll.js';
import { friendCommand, type Friend } from '../support/talk.js';

const version = 'rooms.v1' as const;
const START = new Date(Date.UTC(2026, 10, 1, 21, 0, 0));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The right option of each fixture question, in order. */
const KEY = [1, 0, 2, 1, 0] as const;
const OPTIONS = ['First fixture option', 'Second fixture option', 'Third fixture option'];
/** A pick that is wrong for round `round` (one-based). */
const wrong = (round: number) => (KEY[round - 1]! + 1) % 3;

describe('the quiet room (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let scrollId: string;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_quiet');
    world = await roomWorld(
      database,
      { now: START },
      { residentsEnabled: true, starsPerDay: 3, launchGapMinutes: 120 },
    );
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    const source = starterSource() as unknown as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    scrollId = randomUUID();
    source.assetId = scrollId;
    source.publication.explanationUnitId = `ci-quiet-${scrollId.slice(0, 8)}`;
    source.draft.title = 'CI fixture Scroll for a replay';
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
  /** Each test starts at its own day, so a room's rest between Launches and the day's stars never carry over. */
  let dayOfTest = 0;
  const begin = () => {
    dayOfTest += 20;
    at(dayOfTest * DAY);
    return world.clock.now;
  };
  /** Every model call and every job a room could have queued: an idle or replaying room adds none. */
  const queuedWork = () =>
    world.queued.length + world.castChecks.length + world.castPasses.length + world.summaries.length;
  const roomRows = () => rowsIn(world.db, ['rooms', 'receipts']);

  // --- a finished Launch to replay --------------------------------------------------------------

  async function approvedDeck(roomId: string) {
    const payload = {
      questions: KEY.map((answer, index) => ({
        prompt: `Fixture question ${String(index + 1)}: which option is the key?`,
        options: OPTIONS,
        answer,
        explain: `Fixture reason ${String(index + 1)}: the Scroll says so.`,
        source: { assetId: scrollId, assetRevision: 1, stopId: `s${String(index + 1)}` },
      })),
    };
    await sql`
      insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at,
        decided_at, decided_by)
      values (${randomUUID()}::uuid, ${roomId}::uuid, ${dayOf(world.clock.now)}::date, 'launch',
        ${JSON.stringify(payload)}::jsonb, 'ritual.v1', 'approved', 'template', ${world.clock.now},
        ${world.clock.now}, 'cli:ci')`.execute(world.db);
  }

  /** What one player did: a pick for each round (none to skip it), and how long after each question opened. */
  interface Play {
    readonly person: Friend;
    readonly picks: readonly (number | undefined)[];
    readonly delayMs: number;
  }

  /**
   * A room with a Launch that has been played to the end by `plays`, its play time over, plus `others` members who did not play. The
   * clock stands at the end of the play time. Nothing is settled: the replay does not wait for it. `delayFor` gives the delay of the
   * player whose person ID is the `rank`th lowest (0 is the lowest), so a test can make the lowest ID the quickest or the slowest.
   */
  async function aftermath(
    plays: readonly Omit<Play, 'person'>[],
    others: number,
    delayFor?: (rank: number) => number,
  ) {
    const t0 = begin();
    const { roomId, slug } = await seedRoom(world);
    const people = await joined(world, roomId, plays.length + others);
    const players = people.slice(0, plays.length);
    const watchers = people.slice(plays.length);
    const byPersonId = players.toSorted((a, b) => a.person.personId.localeCompare(b.person.personId));
    for (const person of people) unwrap(await setPresence(world, person, roomId));
    await approvedDeck(roomId);
    const started = unwrap(
      await world.rooms.startLaunch(players[0]!.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        recordingGeneration: 1,
      }),
    );
    if (started.outcome !== 'accepted') throw new Error('expected accepted');
    for (let round = 1; round <= 5; round++)
      for (const [index, play] of plays.entries()) {
        const pick = play.picks[round - 1];
        if (pick === undefined) continue;
        const delay = delayFor === undefined ? play.delayMs : delayFor(byPersonId.indexOf(players[index]!));
        at(LOBBY_MS + (round - 1) * ROUND_MS + delay, t0);
        unwrap(
          await world.rooms.answerLaunch(players[index]!.authority, {
            version,
            commandId: randomUUID(),
            roomId,
            launchId: started.launchId,
            round,
            choice: pick,
            recordingGeneration: 1,
          }),
        );
      }
    const ended = new Date(t0.getTime() + LOBBY_MS + PLAY_MS);
    world.clock.now = ended;
    return { roomId, slug, launchId: started.launchId, players, watchers, ended };
  }

  const replay = async (person: Friend, roomId: string) => {
    const read = unwrap(await world.rooms.replay(person.authority, { version, readId: randomUUID(), roomId }));
    if (read.status !== 'ready') throw new Error('expected a ready read');
    return read;
  };
  const round = (person: Friend, roomId: string, launchId: string, number: number) =>
    world.rooms.replayRound(person.authority, { version, readId: randomUUID(), roomId, launchId, round: number });
  const shown = async (person: Friend, roomId: string, launchId: string, number: number) => {
    const result = unwrap(await round(person, roomId, launchId, number));
    if (result.status !== 'ready') throw new Error('expected a ready answer');
    return result;
  };

  /** Two players: Ana right on every round, quick; Ben right on the first two, slower, wrong on the third, absent on the rest. */
  const TWO: readonly Omit<Play, 'person'>[] = [
    { picks: KEY, delayMs: 2_000 },
    { picks: [KEY[0], KEY[1], wrong(3), undefined, undefined], delayMs: 4_000 },
  ];

  describe('the replay of a finished Launch', () => {
    it('is offered to a member who did not play, labelled as a replay, with the day and how many played, and the questions without a key', async () => {
      const { roomId, launchId, watchers, ended } = await aftermath(TWO, 1);
      const [cho] = watchers as [Friend];
      const strip = (await memberView(world, cho, roomId)).replay;
      expect(strip).toEqual({ day: dayOf(ended) });
      const read = await replay(cho, roomId);
      expect(read.host).toEqual({ name: 'Pixel', label: 'AI · Quizmaster' });
      expect(read.replay).toMatchObject({ launchId, day: dayOf(ended), played: 2, answerSeconds: 8 });
      expect(read.replay?.questions).toHaveLength(5);
      expect(read.replay?.questions[0]).toEqual({
        round: 1,
        prompt: 'Fixture question 1: which option is the key?',
        options: OPTIONS,
      });
      // No key, reason, pick or person leaves with the questions.
      const text = JSON.stringify(read);
      for (const leak of ['Fixture reason', '"answer"', '"correct"', '"explain"', 'personId'])
        expect(text, leak).not.toContain(leak);
    });

    it('is not offered when no Launch was played, when the Launch is still on, or to a person who played it', async () => {
      const t0 = begin();
      const { roomId } = await seedRoom(world);
      const [first, second] = (await joined(world, roomId, 2)) as [Friend, Friend];
      expect((await memberView(world, first, roomId)).replay).toBeUndefined();
      expect((await replay(first, roomId)).replay).toBeUndefined();

      // A Launch that is still being played is not a replay.
      for (const person of [first, second]) unwrap(await setPresence(world, person, roomId));
      await approvedDeck(roomId);
      const started = unwrap(
        await world.rooms.startLaunch(first.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          recordingGeneration: 1,
        }),
      );
      if (started.outcome !== 'accepted') throw new Error('expected accepted');
      at(LOBBY_MS + 3 * ROUND_MS, t0);
      expect((await replay(second, roomId)).replay).toBeUndefined();

      // A person who answered has seen it; somebody who only watched has not.
      at(LOBBY_MS + ANSWER_MS - 1_000, t0);
      unwrap(
        await world.rooms.answerLaunch(first.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          launchId: started.launchId,
          round: 1,
          choice: KEY[0],
          recordingGeneration: 1,
        }),
      );
      at(LOBBY_MS + PLAY_MS, t0);
      expect((await memberView(world, first, roomId)).replay).toBeUndefined();
      expect((await replay(first, roomId)).replay).toBeUndefined();
      expect((await replay(second, roomId)).replay).toMatchObject({ launchId: started.launchId, played: 1 });
    });

    it('shows a question with the key, the reason, how many got it right and who, and nobody named as wrong', async () => {
      const { roomId, launchId, players, watchers } = await aftermath(TWO, 1);
      const [ana, ben] = players as [Friend, Friend];
      const [cho] = watchers as [Friend];
      // Question 3: Ana right, Ben wrong.
      const third = await shown(cho, roomId, launchId, 3);
      expect(third).toMatchObject({ round: 3, correct: KEY[2], locked: 2, right: 1 });
      expect(third.explain).toBe('Fixture reason 3: the Scroll says so.');
      expect(third.calledIt.map((face) => face.person.personId)).toEqual([ana.person.personId]);
      expect(JSON.stringify(third)).not.toContain(ben.person.personId);
      // Question 1: both right.
      expect(await shown(cho, roomId, launchId, 1)).toMatchObject({ correct: KEY[0], locked: 2, right: 2 });
      expect(await shown(cho, roomId, launchId, 2)).toMatchObject({ correct: KEY[1], locked: 2, right: 2 });
      // Only Ana answered rounds four and five: the figures say one, not a crowd.
      expect(await shown(cho, roomId, launchId, 4)).toMatchObject({ locked: 1, right: 1 });
      expect(await shown(cho, roomId, launchId, 5)).toMatchObject({ locked: 1, right: 1 });
    });

    it('carries nothing that comes from a time, and has no input to sweep: a read takes the question and nothing else', async () => {
      const { roomId, launchId, watchers } = await aftermath(TWO, 1);
      const [cho] = watchers as [Friend];
      const answer = await shown(cho, roomId, launchId, 1);
      expect(Object.keys(answer).toSorted()).toEqual([
        'calledIt',
        'correct',
        'explain',
        'launchId',
        'locked',
        'readId',
        'right',
        'round',
        'scope',
        'status',
        'version',
      ]);
      // A read that offers a time or a choice is refused, so there is nothing to vary: the same read gives the same answer every time.
      for (const extra of [{ elapsedMs: 3_000 }, { choice: 1 }, { choice: 1, elapsedMs: 3_000 }]) {
        const refused = await world.rooms.replayRound(cho.authority, {
          version,
          readId: randomUUID(),
          roomId,
          launchId,
          round: 1,
          ...extra,
        });
        expect(refused, JSON.stringify(extra)).toEqual({ kind: 'refused', code: 'invalid_input' });
      }
      const again = await shown(cho, roomId, launchId, 1);
      expect({ ...again, readId: '' }).toEqual({ ...answer, readId: '' });
    });

    it.each([
      ['the lowest person ID is the quickest', (rank: number) => 1_000 + rank * 500],
      ['the lowest person ID is the slowest', (rank: number) => 6_000 - rank * 500],
    ] as const)('draws the faces by person ID, whoever was quicker: %s', async (_case, delayFor) => {
      const { roomId, launchId, players, watchers } = await aftermath(
        [
          { picks: KEY, delayMs: 0 },
          { picks: KEY, delayMs: 0 },
          { picks: KEY, delayMs: 0 },
        ],
        1,
        delayFor,
      );
      const [cho] = watchers as [Friend];
      const byId = players.map((player) => player.person.personId).toSorted((a, b) => a.localeCompare(b));
      for (let number = 1; number <= 5; number++) {
        const answer = await shown(cho, roomId, launchId, number);
        expect(answer.calledIt.map((face) => face.person.personId)).toEqual(byId);
      }
    });

    it('takes the cut at twelve faces in person order, not in speed order', async () => {
      // Fourteen people are right on every question and the lowest person ID is the slowest: a cut by speed would keep the
      // quickest twelve, and so leave out the two lowest IDs.
      const many = Array.from({ length: 14 }, () => ({ picks: KEY, delayMs: 0 }));
      const { roomId, launchId, players, watchers } = await aftermath(many, 1, (rank) => 7_000 - rank * 400);
      const [cho] = watchers as [Friend];
      const byId = players.map((player) => player.person.personId).toSorted((a, b) => a.localeCompare(b));
      const answer = await shown(cho, roomId, launchId, 1);
      expect(answer).toMatchObject({ locked: 14, right: 14 });
      expect(answer.calledIt.map((face) => face.person.personId)).toEqual(byId.slice(0, 12));
    });

    it('refuses a Launch that is not the one to replay, and a person who is not a member', async () => {
      const { roomId, launchId, watchers } = await aftermath(TWO, 1);
      const [cho] = watchers as [Friend];
      expect((await round(cho, roomId, randomUUID(), 1)).kind).toBe('refused');
      expect(await round(cho, roomId, launchId, 1)).toMatchObject({ kind: 'ok' });
      const [stranger] = (await joined(world, (await seedRoom(world)).roomId, 1)) as [Friend];
      expect((await round(stranger, roomId, launchId, 1)).kind).toBe('refused');
      expect((await world.rooms.replay(stranger.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
    });

    it('opens when the play time ends and is gone seven days after, before anyone has deleted the answers', async () => {
      const { roomId, launchId, watchers, ended } = await aftermath(TWO, 1);
      const [cho] = watchers as [Friend];
      // One second before the end the Launch is still being played.
      at(-1_000, ended);
      expect((await replay(cho, roomId)).replay).toBeUndefined();
      at(0, ended);
      expect((await replay(cho, roomId)).replay).toMatchObject({ launchId });
      at(RESULTS_KEPT_DAYS * DAY, ended);
      expect((await replay(cho, roomId)).replay).toMatchObject({ launchId });
      at(RESULTS_KEPT_DAYS * DAY + 1_000, ended);
      expect((await replay(cho, roomId)).replay).toBeUndefined();
      expect((await memberView(world, cho, roomId)).replay).toBeUndefined();
      // The rows are still there until a member command deletes them (D-220): the read does not wait for it.
      expect(
        await world.db
          .selectFrom('rooms.launch_answers')
          .select('account_id')
          .where('launch_id', '=', launchId)
          .execute(),
      ).not.toHaveLength(0);
      unwrap(await setPresence(world, cho, roomId));
      expect(
        await world.db
          .selectFrom('rooms.launch_answers')
          .select('account_id')
          .where('launch_id', '=', launchId)
          .execute(),
      ).toHaveLength(0);
    });

    it('shrinks with the answers it reads: a player who leaves is no longer counted, and with nobody left there is nothing to replay', async () => {
      const { roomId, players, watchers } = await aftermath(TWO, 1);
      const [ana, ben] = players as [Friend, Friend];
      const [cho] = watchers as [Friend];
      expect((await replay(cho, roomId)).replay?.played).toBe(2);
      unwrap(await world.rooms.leave(ben.authority, { version, commandId: randomUUID(), roomId }));
      expect((await replay(cho, roomId)).replay?.played).toBe(1);
      unwrap(await world.rooms.leave(ana.authority, { version, commandId: randomUUID(), roomId }));
      expect((await replay(cho, roomId)).replay).toBeUndefined();
      expect((await memberView(world, cho, roomId)).replay).toBeUndefined();
    });

    it('leaves a person the reader blocked out of the count and the faces, and offers nothing when only blocked people played', async () => {
      const { roomId, launchId, players, watchers } = await aftermath(TWO, 2);
      const [ana, ben] = players as [Friend, Friend];
      const [cho, dee] = watchers as [Friend, Friend];
      unwrap(await friendCommand(world.friends, cho, ana, 'block'));
      const seen = await replay(cho, roomId);
      expect(seen.replay?.played).toBe(1);
      const first = await shown(cho, roomId, launchId, 1);
      expect(first).toMatchObject({ locked: 1, right: 1 });
      const faces = JSON.stringify(first);
      for (const hidden of [ana.accountId, ana.person.personId, ana.person.handle])
        expect(faces, hidden).not.toContain(hidden);
      expect(faces).toContain(ben.person.personId);
      unwrap(await friendCommand(world.friends, cho, ben, 'block'));
      expect((await replay(cho, roomId)).replay).toBeUndefined();
      expect((await memberView(world, cho, roomId)).replay).toBeUndefined();
      // Nobody else sees any difference.
      expect((await replay(dee, roomId)).replay?.played).toBe(2);
    });

    it('is not offered when a Scroll of its questions has been withdrawn since', async () => {
      const { roomId, launchId, watchers } = await aftermath(TWO, 1);
      const [cho] = watchers as [Friend];
      expect((await replay(cho, roomId)).replay).toMatchObject({ launchId });
      const stored = await world.db
        .selectFrom('rooms.launches')
        .select('questions')
        .where('launch_id', '=', launchId)
        .executeTakeFirstOrThrow();
      const gone = (stored.questions as { source: { assetId: string } }[]).map((question) => ({
        ...question,
        source: { ...question.source, assetId: randomUUID() },
      }));
      await world.db
        .updateTable('rooms.launches')
        .set({ questions: JSON.stringify(gone) })
        .where('launch_id', '=', launchId)
        .execute();
      expect((await replay(cho, roomId)).replay).toBeUndefined();
      expect((await round(cho, roomId, launchId, 1)).kind).toBe('refused');
    });

    it('stores nothing, earns no star, queues no job and writes nothing to a person’s own universe, whether the Launch is settled or not', async () => {
      const { roomId, launchId, watchers } = await aftermath(TWO, 1);
      const [cho] = watchers as [Friend];
      const personal = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const rooms = await roomRows();
      const work = queuedWork();
      const stars = await world.db.selectFrom('rooms.stars').select('star_id').execute();
      const aiTurns = await world.db.selectFrom('rooms.ai_turns').select('turn_id').execute();

      await replay(cho, roomId);
      for (let number = 1; number <= 5; number++) await shown(cho, roomId, launchId, number);
      await memberView(world, cho, roomId);
      expect(await roomRows()).toBe(rooms);
      expect(queuedWork()).toBe(work);
      expect(await world.db.selectFrom('rooms.stars').select('star_id').execute()).toEqual(stars);
      expect(await world.db.selectFrom('rooms.ai_turns').select('turn_id').execute()).toEqual(aiTurns);
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(personal);

      // A replay carries no recording generation and writes no row, so there is no command for a paused recording to refuse (D-241).
      // Once the Launch is settled (the star it earned two players is its own) the replay is the same and still earns none.
      unwrap(await setPresence(world, cho, roomId));
      const settled = await world.db.selectFrom('rooms.stars').select('star_id').execute();
      expect(settled).toHaveLength(stars.length + 1);
      for (let number = 1; number <= 5; number++) await shown(cho, roomId, launchId, number);
      expect(await world.db.selectFrom('rooms.stars').select('star_id').execute()).toEqual(settled);
    });
  });

  // --- a question left for people ----------------------------------------------------------------

  const leave = (person: Friend, roomId: string, over: { text?: string; askNow?: boolean; notify?: boolean } = {}) =>
    world.rooms.leaveQuestion(person.authority, {
      version,
      commandId: randomUUID(),
      roomId,
      text: over.text ?? 'How do astronomers know how far away a star is?',
      askNow: over.askNow ?? true,
      notify: over.notify ?? true,
    });
  const notice = (person: Friend, roomId: string, discussionId: string, over: { notify?: boolean; noticed?: true }) =>
    world.rooms.questionNotice(person.authority, { version, commandId: randomUUID(), roomId, discussionId, ...over });
  const explanation = (text: string): FixtureScenario => ({
    kind: 'success',
    text: JSON.stringify({ kind: 'explanation', text }),
  });

  describe('a question left for people', () => {
    it('makes a question topic with the words, a card in General, and one asked turn for the Explainer when its asker asks', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const work = queuedWork();
      const left = unwrap(await leave(asha, roomId));
      expect(left).toMatchObject({ operation: 'question.leave', asked: 'queued', replayed: false });

      const topic = await world.db
        .selectFrom('rooms.discussions')
        .selectAll()
        .where('discussion_id', '=', left.discussionId)
        .executeTakeFirstOrThrow();
      expect(topic).toMatchObject({
        kind: 'topic',
        tag: 'question',
        title: 'How do astronomers know how far away a star is?',
        title_derived: true,
        started_by_account_id: asha.accountId,
        notify_answer: true,
        answer_noticed_at: null,
      });
      const first = await readDiscussion(world, ravi, roomId, left.discussionId);
      if (first.status !== 'ready') throw new Error('expected ready');
      expect(first.messages).toHaveLength(1);
      expect(first.messages[0]).toMatchObject({
        status: 'available',
        author: { kind: 'person', personId: asha.person.personId },
        body: { kind: 'text', text: 'How do astronomers know how far away a star is?' },
      });
      // The card is in General, where the room talks.
      const general = (await memberView(world, ravi, roomId)).general.discussionId;
      const stream = await readDiscussion(world, ravi, roomId, general);
      if (stream.status !== 'ready') throw new Error('expected ready');
      expect(stream.messages.at(-1)).toMatchObject({
        body: { kind: 'topic', topic: { discussionId: left.discussionId, tag: 'question' } },
      });
      // Exactly one asked turn, of kind `about`, for the Explainer, on the question's own words; nothing unprompted.
      expect(queuedWork()).toBe(work + 1);
      expect(world.castChecks).toHaveLength(0);
      const [turn] = await world.db
        .selectFrom('rooms.ai_turns')
        .selectAll()
        .where('discussion_id', '=', left.discussionId)
        .execute();
      expect(turn).toMatchObject({
        trigger: 'asked',
        ask_kind: 'about',
        inhabitant: 'explainer',
        requested_by_account_id: asha.accountId,
        state: 'queued',
      });
      expect(turn?.cause_message_id).toBe(first.messages[0]?.messageId);
    });

    it('asks no resident unless its asker asks, and never starts the unprompted router, so a quiet room makes no call', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      unwrap(await setPresence(world, ravi, roomId));
      const work = queuedWork();
      const left = unwrap(await leave(asha, roomId, { askNow: false }));
      expect(left.asked).toBe('not_asked');
      // Long after the wait a resident would have answered a question nobody answered: nothing is queued.
      at(10 * 60_000, world.clock.now);
      await memberView(world, ravi, roomId);
      unwrap(await setPresence(world, ravi, roomId));
      expect(queuedWork()).toBe(work);
      expect(
        await world.db
          .selectFrom('rooms.ai_turns')
          .select('turn_id')
          .where('discussion_id', '=', left.discussionId)
          .execute(),
      ).toEqual([]);

      // An idle room reads, previews and replays at no cost at all.
      await replay(asha, roomId);
      await memberView(world, asha, roomId);
      expect(queuedWork()).toBe(work);
    });

    it('is left even when the resident cannot answer: a full day of asks says resting, a member who keeps messages out says so', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      unwrap(await setPreferences(world, ravi, roomId, { keepOut: true }));
      const work = queuedWork();
      const kept = unwrap(await leave(ravi, roomId));
      expect(kept.asked).toBe('kept_out');
      expect(queuedWork()).toBe(work);
      expect(await memberView(world, asha, roomId)).toMatchObject({ questions: { waiting: 1, replies: [] } });
      // The tenth ask of the hour is over the bound (D-068): the question is still left, for people.
      for (let n = 0; n < 10; n++) unwrap(await leave(asha, roomId, { text: `Fixture question number ${String(n)}?` }));
      const resting = unwrap(await leave(asha, roomId, { text: 'One more question than the hour allows?' }));
      expect(resting.asked).toBe('resting');
      expect(await memberView(world, ravi, roomId)).toMatchObject({ questions: { waiting: 12 } });
    });

    it('replays the same command as one question', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const commandId = randomUUID();
      const body = { version, commandId, roomId, text: 'Why is the night sky dark?', askNow: true, notify: true };
      const first = unwrap(await world.rooms.leaveQuestion(asha.authority, body));
      const again = unwrap(await world.rooms.leaveQuestion(asha.authority, body));
      expect(again).toMatchObject({ replayed: true, discussionId: first.discussionId });
      expect(
        await world.db
          .selectFrom('rooms.discussions')
          .select('discussion_id')
          .where('tag', '=', 'question')
          .where('room_id', '=', roomId)
          .execute(),
      ).toHaveLength(1);
      expect(world.queued.filter((job) => job.universeId === asha.universeId)).toHaveLength(1);
    });

    it('stays open for people after a resident answers: the resident is not a person, and the asker is not told', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const left = unwrap(await leave(asha, roomId));
      const model = fixtureModel(() => explanation('Nearby stars shift against far ones as Earth moves: parallax.'), {
        label: 'rooms-quiet',
      });
      const { harness } = fixtureHarness(database.db, { model });
      await world.contribute(harness)(world.queued.at(-1)!);
      expect(model.calls).toHaveLength(1);
      // The resident reads the question once: its first message is the topic's origin and is also in the newest messages, and its title is
      // those same words.
      const sent = model.calls[0]!.request.user;
      expect(sent.split('How do astronomers know how far away a star is?')).toHaveLength(2);
      const read = await readDiscussion(world, ravi, roomId, left.discussionId);
      if (read.status !== 'ready') throw new Error('expected ready');
      expect(read.messages.at(-1)).toMatchObject({ author: { kind: 'ai', inhabitant: 'explainer' } });

      // Still waiting: on the topic's summary, in the room's count and nowhere in the asker's notices.
      const view = await memberView(world, ravi, roomId);
      expect(view.discussions.find((item) => item.discussionId === left.discussionId)).toMatchObject({
        tag: 'question',
        waiting: true,
        lastReplyBy: { ai: true },
      });
      expect(view.questions).toEqual({ waiting: 1, replies: [] });
      expect((await memberView(world, asha, roomId)).questions).toEqual({ waiting: 1, replies: [] });
    });

    it('tells its asker when a person answers, once, with the person’s name, and not when the asker blocked them', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, lena, omar] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const left = unwrap(await leave(asha, roomId, { askNow: false }));
      unwrap(await say(world, lena, roomId, left.discussionId, 'Parallax again, but from space: the Gaia satellite.'));
      const answer = await memberView(world, asha, roomId);
      expect(answer.questions?.waiting).toBe(0);
      expect(answer.questions?.replies).toHaveLength(1);
      const [reply] = answer.questions!.replies;
      expect(reply).toMatchObject({
        discussionId: left.discussionId,
        title: 'How do astronomers know how far away a star is?',
        askedAt: world.clock.now.toISOString(),
        at: world.clock.now.toISOString(),
      });
      expect(reply?.by.personId).toBe(lena.person.personId);
      // Nobody else is told: the room says nothing is waiting any more, and Lena's own view has no notice.
      expect((await memberView(world, omar, roomId)).questions).toBeUndefined();
      expect((await memberView(world, lena, roomId)).questions).toBeUndefined();
      // The question no longer reads as waiting.
      expect(answer.discussions.find((item) => item.discussionId === left.discussionId)?.waiting).toBeUndefined();

      // Noticing it, or turning the switch off, takes the notice away; a stranger's switch is refused.
      expect((await notice(lena, roomId, left.discussionId, { noticed: true })).kind).toBe('refused');
      expect((await notice(omar, roomId, left.discussionId, { notify: false })).kind).toBe('refused');
      expect(unwrap(await notice(asha, roomId, left.discussionId, { noticed: true }))).toMatchObject({
        operation: 'question.notice',
        notify: true,
      });
      expect((await memberView(world, asha, roomId)).questions).toBeUndefined();
    });

    it('lets the asker turn the notice off before an answer, and a block hides the answerer from the asker alone', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, lena, omar] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      const quiet = unwrap(await leave(asha, roomId, { askNow: false, notify: false }));
      unwrap(await say(world, lena, roomId, quiet.discussionId, 'Parallax.'));
      expect((await memberView(world, asha, roomId)).questions).toBeUndefined();
      // Turning it on later shows the answer that is there.
      expect(unwrap(await notice(asha, roomId, quiet.discussionId, { notify: true })).notify).toBe(true);
      expect((await memberView(world, asha, roomId)).questions?.replies).toHaveLength(1);

      const blocked = unwrap(await leave(asha, roomId, { askNow: false, text: 'What is a light-year, exactly?' }));
      unwrap(await friendCommand(world.friends, asha, lena, 'block'));
      unwrap(await say(world, lena, roomId, blocked.discussionId, 'A year of light travel.'));
      const view = await memberView(world, asha, roomId);
      expect((view.questions?.replies ?? []).map((reply) => reply.discussionId)).not.toContain(blocked.discussionId);
      expect(JSON.stringify(view.questions ?? {})).not.toContain(lena.person.personId);
      // A different person answering is told as usual.
      unwrap(await say(world, omar, roomId, blocked.discussionId, 'The distance light covers in a year.'));
      expect((await memberView(world, asha, roomId)).questions?.replies.map((reply) => reply.by.personId)).toContain(
        omar.person.personId,
      );
    });

    it('takes the notice back when a moderator removes the answer, and counts the question as waiting again', async () => {
      begin();
      const { roomId, slug } = await seedRoom(world);
      const [asha, lena, mod] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
      await makeModerator(world, slug, mod);
      const left = unwrap(await leave(asha, roomId, { askNow: false }));
      const said = unwrap(await say(world, lena, roomId, left.discussionId, 'Parallax, I think.'));
      expect((await memberView(world, asha, roomId)).questions?.replies).toHaveLength(1);
      unwrap(await hideMessage(world, mod, roomId, left.discussionId, said.messageId));
      expect((await memberView(world, asha, roomId)).questions).toEqual({ waiting: 1, replies: [] });
      expect((await memberView(world, lena, roomId)).questions).toEqual({ waiting: 1, replies: [] });
    });

    it('lets a person’s answer earn the room a star when somebody other than its author finds it Useful, and never a resident’s', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, lena] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const left = unwrap(await leave(asha, roomId));
      const model = fixtureModel(() => explanation('Parallax: a nearby star shifts against far ones.'), {
        label: 'rooms-quiet',
      });
      const { harness } = fixtureHarness(database.db, { model });
      await world.contribute(harness)(world.queued.at(-1)!);
      const afterAi = await readDiscussion(world, lena, roomId, left.discussionId);
      if (afterAi.status !== 'ready') throw new Error('expected ready');
      const resident = afterAi.messages.at(-1)!;
      // A resident's answer can be marked, and earns nothing.
      unwrap(await markUseful(world, asha, roomId, left.discussionId, resident.messageId));
      expect(
        await world.db.selectFrom('rooms.stars').select('star_id').where('room_id', '=', roomId).execute(),
      ).toEqual([]);

      const said = unwrap(await say(world, lena, roomId, left.discussionId, 'Parallax again, but from space.'));
      // The author's own mark is refused; the asker's is a different person's and earns the star.
      expect((await markUseful(world, lena, roomId, left.discussionId, said.messageId)).kind).toBe('refused');
      unwrap(await markUseful(world, asha, roomId, left.discussionId, said.messageId));
      const stars = await world.db.selectFrom('rooms.stars').select(['act']).where('room_id', '=', roomId).execute();
      expect(stars).toEqual([{ act: 'answer_useful' }]);
    });

    it('is refused for a person who is not a member, in a paused room, and once its asker has left', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      const [stranger] = (await joined(world, (await seedRoom(world)).roomId, 1)) as [Friend];
      expect((await leave(stranger, roomId)).kind).toBe('refused');
      const left = unwrap(await leave(asha, roomId, { askNow: false }));
      await world.db.updateTable('rooms.rooms').set({ status: 'paused' }).where('room_id', '=', roomId).execute();
      expect((await leave(asha, roomId)).kind).toBe('refused');
      await world.db.updateTable('rooms.rooms').set({ status: 'open' }).where('room_id', '=', roomId).execute();
      unwrap(await world.rooms.leave(asha.authority, { version, commandId: randomUUID(), roomId }));
      expect((await notice(asha, roomId, left.discussionId, { notify: false })).kind).toBe('refused');
      expect((await leave(asha, roomId)).kind).toBe('refused');
    });

    it('writes nothing to a person’s own universe', async () => {
      begin();
      const { roomId } = await seedRoom(world);
      const [asha, lena] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const personal = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const left = unwrap(await leave(asha, roomId));
      unwrap(await say(world, lena, roomId, left.discussionId, 'Parallax.'));
      unwrap(await notice(asha, roomId, left.discussionId, { noticed: true }));
      await memberView(world, asha, roomId);
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(personal);
    });
  });

  describe('the words of a left question', () => {
    const NEUTRAL = 'A topic from a message';
    const WORDS = 'QUESTION-WORDS how do astronomers weigh a faraway star?';

    /** Every place the title is read: the room's list, the topics list, the discussion itself and the card in General. */
    async function titlesSeenBy(person: Friend, roomId: string, discussionId: string): Promise<string[]> {
      const view = await memberView(world, person, roomId);
      const stream = await readDiscussion(world, person, roomId, view.general.discussionId);
      if (stream.status !== 'ready') throw new Error('expected ready');
      const own = await readDiscussion(world, person, roomId, discussionId);
      if (own.status !== 'ready') throw new Error('expected ready');
      const cards = stream.messages.flatMap((message) =>
        message.status === 'available' &&
        message.body.kind === 'topic' &&
        message.body.topic.discussionId === discussionId
          ? [message.body.topic.title]
          : [],
      );
      return [
        view.discussions.find((item) => item.discussionId === discussionId)?.title ?? '(absent)',
        (await topicsOf(world, person, roomId, 'new', 'question')).find((item) => item.discussionId === discussionId)
          ?.title ?? '(absent)',
        own.discussion.title,
        ...cards,
      ];
    }
    const everywhere = (title: string) => [title, title, title, title];

    async function leftQuestion() {
      const t0 = begin();
      const { roomId, slug } = await seedRoom(world);
      const [asha, ravi, omar, mod] = (await joined(world, roomId, 4)) as [Friend, Friend, Friend, Friend];
      await makeModerator(world, slug, mod);
      const left = unwrap(await leave(asha, roomId, { text: WORDS, askNow: false }));
      return { t0, roomId, asha, ravi, omar, mod, discussionId: left.discussionId };
    }

    it('is a title made from its first message, as any topic begun from a message is', async () => {
      const { discussionId, asha, roomId } = await leftQuestion();
      const row = await world.db
        .selectFrom('rooms.discussions')
        .select(['title', 'title_derived', 'origin_message_id'])
        .where('discussion_id', '=', discussionId)
        .executeTakeFirstOrThrow();
      const first = await world.db
        .selectFrom('rooms.messages')
        .select('message_id')
        .where('discussion_id', '=', discussionId)
        .where('sequence', '=', '1')
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ title: WORDS, title_derived: true, origin_message_id: first.message_id });
      // Its asker reads their own words, and so does anyone who may read the message.
      expect(await titlesSeenBy(asha, roomId, discussionId)).toEqual(everywhere(WORDS));
    });

    it('reads as the neutral title for everyone while a moderator has removed its first message, and the words return when it is restored', async () => {
      const { roomId, asha, ravi, mod, discussionId } = await leftQuestion();
      const first = await world.db
        .selectFrom('rooms.messages')
        .select('message_id')
        .where('discussion_id', '=', discussionId)
        .where('sequence', '=', '1')
        .executeTakeFirstOrThrow();
      unwrap(await hideMessage(world, mod, roomId, discussionId, first.message_id));
      for (const person of [asha, ravi, mod])
        expect(await titlesSeenBy(person, roomId, discussionId), 'removed').toEqual(everywhere(NEUTRAL));
      unwrap(await hideMessage(world, mod, roomId, discussionId, first.message_id, false));
      expect(await titlesSeenBy(ravi, roomId, discussionId)).toEqual(everywhere(WORDS));
    });

    it('reads as the neutral title for a reader who blocked the asker, and as the words for everyone else', async () => {
      const { roomId, asha, ravi, omar, discussionId } = await leftQuestion();
      unwrap(await friendCommand(world.friends, ravi, asha, 'block'));
      // The blocked asker's card in General is collapsed for the blocker, so it is not a place the title is read.
      expect(await titlesSeenBy(ravi, roomId, discussionId)).toEqual([NEUTRAL, NEUTRAL, NEUTRAL]);
      expect(await titlesSeenBy(omar, roomId, discussionId)).toEqual(everywhere(WORDS));
      expect(await titlesSeenBy(asha, roomId, discussionId)).toEqual(everywhere(WORDS));
    });

    it('is the neutral title, stored, once its asker deletes their account, and the asker’s own file held the words until then', async () => {
      const { roomId, asha, ravi, discussionId } = await leftQuestion();
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(asha.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: asha.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      expect(JSON.stringify(exported.value.sections['rooms'])).toContain('QUESTION-WORDS');

      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(asha.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');

      // The words are gone from the stored title and from every message, not merely hidden when served.
      expect(
        (
          await world.db
            .selectFrom('rooms.discussions')
            .select('title')
            .where('discussion_id', '=', discussionId)
            .executeTakeFirstOrThrow()
        ).title,
      ).toBe(NEUTRAL);
      expect(
        (
          await sql<{ n: string }>`
            select (select count(*) from rooms.discussions where room_id = ${roomId}::uuid and title like '%QUESTION-WORDS%')
              + (select count(*) from rooms.messages message join rooms.discussions discussion using (discussion_id)
                  where discussion.room_id = ${roomId}::uuid and message.body_text like '%QUESTION-WORDS%') as n`.execute(
            world.db,
          )
        ).rows[0]!.n,
      ).toBe('0');
      // The card the asker left in General went with their account; the topic stays, under the neutral title.
      expect(await titlesSeenBy(ravi, roomId, discussionId)).toEqual([NEUTRAL, NEUTRAL, NEUTRAL]);
      // A question whose asker is gone waits for no one: the room's count and the topic's flag say the same.
      const after = await memberView(world, ravi, roomId);
      expect(after.questions).toBeUndefined();
      expect(after.discussions.find((item) => item.discussionId === discussionId)?.waiting).toBeUndefined();
    });
  });

  describe('the quiet pill', () => {
    it('counts a person’s words and never a resident’s, so an AI answer cannot make an empty room look busy', async () => {
      const t0 = begin();
      const { roomId } = await seedRoom(world);
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      expect((await memberView(world, asha, roomId)).lastMessageAt).toBeUndefined();
      const left = unwrap(await leave(asha, roomId));
      expect((await memberView(world, asha, roomId)).lastMessageAt).toBe(t0.toISOString());
      // Three hours later a resident answers: the room's last message is still the person's.
      at(3 * HOUR, t0);
      const model = fixtureModel(() => explanation('Parallax: a nearby star shifts against far ones.'), {
        label: 'rooms-quiet',
      });
      const { harness } = fixtureHarness(database.db, { model });
      await world.contribute(harness)(world.queued.at(-1)!);
      const read = await readDiscussion(world, asha, roomId, left.discussionId);
      if (read.status !== 'ready') throw new Error('expected ready');
      expect(read.messages.at(-1)).toMatchObject({ author: { kind: 'ai' }, recordedAt: world.clock.now.toISOString() });
      expect((await memberView(world, asha, roomId)).lastMessageAt).toBe(t0.toISOString());
    });
  });
});
