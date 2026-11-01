/**
 * Asks, challenges, topics and Useful (v3 R-3, D-167, D-168) over real PostgreSQL and the real reasoning harness with a
 * CI fixture model (never provider output): a member can challenge a message, ask for the other side, ask about it or
 * name a resident; each is an asked turn with its own ledger row naming the kind and the message, never counted against
 * the unprompted caps; a topic can begin from any message and is listed with tags; Useful is one mark per member,
 * never on one's own message, and counted only on a topic; the welcome is a template and costs no call.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel, receiptClassesOf } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  ask,
  askAbout,
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
  startTopic,
  startTopicFrom,
  topicsOf,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, seedFriend, type Friend } from '../support/talk.js';

const today = new Date();
const START = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10, 0, 0));
const MINUTE = 60_000;

const answer = (kind: string, text: string): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind, text }),
});

describe('asked turns, topics and Useful (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_asks');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const at = (minutes: number) => {
    world.clock.now = new Date(START.getTime() + minutes * MINUTE);
  };

  /** A room with three talking members and a few messages in General. */
  async function gathering() {
    at(0);
    const { roomId, slug } = await seedRoom(world);
    const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
    const general = (await memberView(world, asha, roomId)).general.discussionId;
    const claim = unwrap(
      await say(world, ravi, roomId, general, 'So the Moon alone explains why the tides swing so far every month'),
    );
    return { roomId, slug, general, asha, ravi, kenji, claim };
  }

  /** How many requests the rooms scope has spent today (the budget window is the database's day). */
  const roomScopeSpent = async () =>
    Number(
      (
        await sql<{ n: string }>`
          select count(*)::text as n from reasoning.production_attempts
          where scope_id = 'rooms' and budget_window = current_date`.execute(world.db)
      ).rows[0]!.n,
    );

  const ledger = (roomId: string) =>
    world.db.selectFrom('rooms.ai_turns').selectAll().where('room_id', '=', roomId).orderBy('created_at').execute();

  const modelFor = (script: (sequence: number) => FixtureScenario) => {
    const model = fixtureModel(script, { label: 'rooms-asks' });
    const { harness } = fixtureHarness(database.db, { model });
    return { model, contribute: world.contribute(harness) };
  };

  const view = async (person: Friend, roomId: string, discussionId: string) => {
    const read = await readDiscussion(world, person, roomId, discussionId);
    if (read.status !== 'ready') throw new Error('expected ready');
    return read;
  };

  describe('a question about one message', () => {
    it.each([
      ['challenge', 'skeptic', 'assumption'],
      ['other_side', 'skeptic', 'perspective'],
      ['about', 'explainer', 'explanation'],
    ] as const)(
      'turns %s into an asked turn for the %s whose ledger row names the kind and the message it is about',
      async (kind, resident, contribution) => {
        const room = await gathering();
        const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
        const queued = world.queued.length;
        unwrap(await askAbout(world, room.asha, room.roomId, room.general, kind, room.claim.messageId));
        expect(world.queued).toHaveLength(queued + 1);
        const [turn] = await ledger(room.roomId);
        expect(turn).toMatchObject({
          trigger: 'asked',
          ask_kind: kind,
          cause_message_id: room.claim.messageId,
          inhabitant: resident,
          requested_by_account_id: room.asha.accountId,
          decided_by: 'asked_bounds',
          state: 'queued',
        });

        const { model, contribute } = modelFor(() => answer(contribution, 'Check whether the Sun matters too.'));
        await contribute(world.queued.at(-1)!);
        expect(model.calls).toHaveLength(1);
        // The model is told which message to answer, and reads its words.
        const sent = model.calls[0]!.request.user;
        expect(sent).toContain('Respond to message:');
        expect(sent).toContain('So the Moon alone explains');

        const read = await view(room.kenji, room.roomId, room.general);
        const spoken = read.messages.at(-1)!;
        expect(spoken).toMatchObject({
          status: 'available',
          author: { kind: 'ai', inhabitant: resident },
          suggestion: contribution,
          ask: { kind, about: room.claim.messageId, by: { personId: room.asha.person.personId } },
        });
        // A resident that answers an ask has no unprompted reason.
        expect(spoken).not.toHaveProperty('trigger');
        expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
      },
    );

    it('lets a member challenge a resident’s own answer, and names the asker only to those who have not blocked them', async () => {
      const room = await gathering();
      unwrap(await ask(world, room.asha, room.roomId, room.general, 'explainer'));
      const { contribute } = modelFor(() => answer('explanation', 'The Sun pulls on the oceans too.'));
      await contribute(world.queued.at(-1)!);
      const nova = (await view(room.asha, room.roomId, room.general)).messages.at(-1)!;
      unwrap(await askAbout(world, room.ravi, room.roomId, room.general, 'challenge', nova.messageId));
      await modelFor(() => answer('counterexample', 'Spring tides depend on the Sun too.')).contribute(
        world.queued.at(-1)!,
      );
      // Kenji blocked Ravi: Halley's answer still reads, without "asked by Ravi".
      unwrap(await friendCommand(world.friends, room.kenji, room.ravi, 'block'));
      const seen = (await view(room.kenji, room.roomId, room.general)).messages.at(-1)!;
      expect(seen).toMatchObject({ status: 'available', ask: { kind: 'challenge', about: nova.messageId } });
      expect(JSON.stringify(seen)).not.toContain(room.ravi.person.handle);
      const unblocked = (await view(room.asha, room.roomId, room.general)).messages.at(-1)!;
      expect(unblocked).toMatchObject({ ask: { by: { personId: room.ravi.person.personId } } });
    });

    it('refuses a message that is removed, in another discussion, or written by someone the asker blocked, and a request that names both', async () => {
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      const other = await startTopic(world, room.asha, room.roomId, 'Somewhere else');
      const elsewhere = unwrap(await say(world, room.asha, room.roomId, other, 'a message in another discussion'));
      const hidden = unwrap(await say(world, room.ravi, room.roomId, room.general, 'something I will regret'));
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, hidden.messageId));

      const code = async (result: ReturnType<typeof askAbout>) => {
        const found = await result;
        return found.kind === 'refused' ? found.code : 'ok';
      };
      expect(await code(askAbout(world, room.asha, room.roomId, room.general, 'challenge', hidden.messageId))).toBe(
        'unavailable',
      );
      expect(await code(askAbout(world, room.asha, room.roomId, room.general, 'challenge', elsewhere.messageId))).toBe(
        'unavailable',
      );
      unwrap(await friendCommand(world.friends, room.asha, room.ravi, 'block'));
      expect(await code(askAbout(world, room.asha, room.roomId, room.general, 'about', room.claim.messageId))).toBe(
        'unavailable',
      );
      const both = await world.rooms.ask(room.kenji.authority, {
        version: 'rooms.v1',
        commandId: randomUUID(),
        roomId: room.roomId,
        discussionId: room.general,
        inhabitant: 'skeptic',
        about: { kind: 'challenge', messageId: room.claim.messageId },
      });
      expect(both).toMatchObject({ kind: 'refused', code: 'invalid_input' });
      expect(await ledger(room.roomId)).toEqual([]);
    });

    it('reads nothing of a message whose author keeps their messages out: the ask ends with no call and is not counted', async () => {
      const room = await gathering();
      unwrap(await setPreferences(world, room.ravi, room.roomId, { keepOut: true }));
      unwrap(await askAbout(world, room.asha, room.roomId, room.general, 'challenge', room.claim.messageId));
      const { model, contribute } = modelFor(() => answer('assumption', 'anything'));
      await contribute(world.queued.at(-1)!);
      expect(model.calls).toHaveLength(0);
      const [turn] = await ledger(room.roomId);
      expect(turn).toMatchObject({ state: 'failed', dispatched: false });
      // The asker can ask again at once: a call that was never made is handed back.
      expect((await askAbout(world, room.asha, room.roomId, room.general, 'about', room.claim.messageId)).kind).toBe(
        'ok',
      );
    });

    it('answers a message older than the newest twenty: it is read by id, with one call, and the ledger names it', async () => {
      const room = await gathering();
      // More than a context window of talk follows the claim.
      for (let index = 0; index < 25; index++) {
        at(index + 1);
        const speaker = [room.asha, room.kenji][index % 2]!;
        unwrap(await say(world, speaker, room.roomId, room.general, `a later message, number ${String(index + 1)}`));
      }
      at(30);
      unwrap(await askAbout(world, room.asha, room.roomId, room.general, 'challenge', room.claim.messageId));
      const job = world.queued.at(-1)!;
      const { model, contribute } = modelFor(() => answer('assumption', 'The Sun pulls on the oceans too.'));
      await contribute(job);
      expect(model.calls).toHaveLength(1);
      const sent = model.calls[0]!.request.user;
      expect(sent).toContain('So the Moon alone explains');
      expect(sent).toContain('Respond to message:1.');
      // The newest messages are still there, and the claim is not read twice.
      expect(sent).toContain('a later message, number 25');
      expect(sent.split('So the Moon alone explains').length).toBe(2);
      const [turn] = await ledger(room.roomId);
      expect(turn).toMatchObject({
        state: 'completed',
        ask_kind: 'challenge',
        cause_message_id: room.claim.messageId,
        dispatched: true,
      });
    });

    it('still reads nothing of an old message once its author keeps their messages out', async () => {
      const room = await gathering();
      for (let index = 0; index < 25; index++) {
        at(index + 1);
        unwrap(await say(world, room.kenji, room.roomId, room.general, `a later message, number ${String(index + 1)}`));
      }
      unwrap(await askAbout(world, room.asha, room.roomId, room.general, 'about', room.claim.messageId));
      unwrap(await setPreferences(world, room.ravi, room.roomId, { keepOut: true }));
      const { model, contribute } = modelFor(() => answer('explanation', 'anything'));
      await contribute(world.queued.at(-1)!);
      expect(model.calls).toHaveLength(0);
      expect((await ledger(room.roomId))[0]).toMatchObject({ state: 'failed', dispatched: false });
    });

    it('ends without a call when the message it pointed at was removed meanwhile', async () => {
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      unwrap(await askAbout(world, room.asha, room.roomId, room.general, 'other_side', room.claim.messageId));
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, room.claim.messageId));
      const { model, contribute } = modelFor(() => answer('perspective', 'anything'));
      await contribute(world.queued.at(-1)!);
      expect(model.calls).toHaveLength(0);
      expect((await ledger(room.roomId))[0]).toMatchObject({ state: 'failed', dispatched: false });
    });
  });

  describe('naming a resident in a message', () => {
    it('asks the resident named, once, with the message as its cause, and no resident also decides on its own', async () => {
      const room = await gathering();
      at(1);
      const checks = world.castChecks.length;
      const message = unwrap(await say(world, room.asha, room.roomId, room.general, '@Nova what is a spring tide?'));
      const [turn] = await ledger(room.roomId);
      expect(turn).toMatchObject({
        trigger: 'asked',
        ask_kind: 'mention',
        cause_message_id: message.messageId,
        inhabitant: 'explainer',
        requested_by_account_id: room.asha.accountId,
      });
      // A question that names a resident is addressed to it: the router has nothing to decide.
      expect(world.castChecks).toHaveLength(checks);
      const { model, contribute } = modelFor(() => answer('explanation', 'A spring tide is the biggest tide.'));
      await contribute(world.queued.at(-1)!);
      expect(model.calls[0]!.request.user).toContain('@Nova what is a spring tide?');
      expect((await view(room.ravi, room.roomId, room.general)).messages.at(-1)).toMatchObject({
        author: { kind: 'ai', inhabitant: 'explainer', name: 'Nova' },
        ask: { kind: 'mention', about: message.messageId, by: { personId: room.asha.person.personId } },
      });
    });

    it('answers the message that named the resident even when more than a window of talk landed before the job ran', async () => {
      const room = await gathering();
      at(1);
      const message = unwrap(await say(world, room.asha, room.roomId, room.general, '@Nova what is a spring tide?'));
      const job = world.queued.at(-1)!;
      for (let index = 0; index < 25; index++) {
        at(index + 2);
        unwrap(
          await say(world, room.kenji, room.roomId, room.general, `talk while waiting, number ${String(index + 1)}`),
        );
      }
      const { model, contribute } = modelFor(() => answer('explanation', 'A spring tide is the biggest tide.'));
      await contribute(job);
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]!.request.user).toContain('@Nova what is a spring tide?');
      expect((await ledger(room.roomId))[0]).toMatchObject({
        state: 'completed',
        ask_kind: 'mention',
        cause_message_id: message.messageId,
      });
    });

    it('asks nobody for an address, another name or no @, and a second message while one is prepared is only a message', async () => {
      const room = await gathering();
      unwrap(await say(world, room.asha, room.roomId, room.general, 'write to asha@nova.example about it'));
      unwrap(await say(world, room.asha, room.roomId, room.general, '@Pixel start the quiz'));
      unwrap(await say(world, room.asha, room.roomId, room.general, 'Halley without an at sign'));
      expect(await ledger(room.roomId)).toEqual([]);
      unwrap(await say(world, room.asha, room.roomId, room.general, '@Halley is that so?'));
      const second = await say(world, room.ravi, room.roomId, room.general, '@Nova and what about the Sun?');
      expect(second.kind).toBe('ok');
      expect(await ledger(room.roomId)).toHaveLength(1);
    });

    it('is paid by the person who asked, as an interactive call, and never by the room scope', async () => {
      const room = await gathering();
      unwrap(await say(world, room.asha, room.roomId, room.general, '@Halley is that so?'));
      const model = fixtureModel(() => answer('assumption', 'Is the Sun’s pull small enough to ignore?'), {
        label: 'rooms-asks-personal',
      });
      const { harness } = fixtureHarness(database.db, { model });
      const spentBefore = await roomScopeSpent();
      await world.contribute(harness)(world.queued.at(-1)!);
      expect(model.calls).toHaveLength(1);
      expect(await roomScopeSpent()).toBe(spentBefore);
      expect(await receiptClassesOf(world.db, room.asha.universeId)).toEqual([
        { role_id: 'rooms.skeptic', background: false },
      ]);
    });
  });

  describe('asked turns and the unprompted caps', () => {
    it('do not count: an unprompted turn after several asks sees empty cap counters and a ratio nobody has started', async () => {
      const room = await gathering();
      for (const kind of ['challenge', 'other_side', 'about'] as const) {
        unwrap(await askAbout(world, room.asha, room.roomId, room.general, kind, room.claim.messageId));
        await modelFor(() => answer(kind === 'about' ? 'explanation' : 'perspective', 'Another view.')).contribute(
          world.queued.at(-1)!,
        );
      }
      expect((await ledger(room.roomId)).every((turn) => turn.trigger === 'asked')).toBe(true);
      // Everyone is here, so the question below waits four minutes before the router looks at it.
      at(1);
      for (const person of [room.asha, room.ravi, room.kenji]) unwrap(await setPresence(world, person, room.roomId));
      unwrap(await say(world, room.kenji, room.roomId, room.general, 'Why do we have seasons at all?'));
      const check = world.castChecks.at(-1)!;
      world.clock.now = new Date(check.startAfter!.getTime());
      const before = world.castPasses.length;
      await world.decide()(check.job);
      expect(world.castPasses).toHaveLength(before + 1);
      const unprompted = (await ledger(room.roomId)).find((turn) => turn.trigger !== 'asked')!;
      expect(unprompted).toMatchObject({ decided_by: 'caps_clear', ask_kind: null });
      expect(unprompted.caps).toMatchObject({ roomLastHour: 0, roomToday: 0, residentLastHour: 0, personLastHour: 0 });
      expect(unprompted.caps).not.toHaveProperty('humanSinceLastTurn');
    });

    it('have their own bounds, and the room menu states them from the same numbers the rules use', async () => {
      const room = await gathering();
      const menu = await memberView(world, room.asha, room.roomId);
      expect(menu.limits).toEqual({
        asked: { perPersonPerHour: 10, perRoomPerDay: 80 },
        unprompted: { humanMessagesPerTurn: 3, perHour: 8, perDay: 40, explainerPerHour: 4, skepticPerHour: 3 },
        feed: { postsPerDay: 3, restHours: 6 },
      });
      // Ten asks of one person in an hour are allowed; the eleventh is resting, and the ledger says why in its count.
      for (let index = 0; index < 10; index++) {
        const asked = await askAbout(world, room.asha, room.roomId, room.general, 'about', room.claim.messageId);
        expect(asked.kind).toBe('ok');
        await modelFor(() => answer('explanation', 'It is about the tides.')).contribute(world.queued.at(-1)!);
      }
      const eleventh = await askAbout(world, room.asha, room.roomId, room.general, 'about', room.claim.messageId);
      expect(eleventh).toMatchObject({ kind: 'refused', code: 'rate_limited' });
      // Someone else is not held back by it.
      expect((await askAbout(world, room.kenji, room.roomId, room.general, 'about', room.claim.messageId)).kind).toBe(
        'ok',
      );
    });
  });

  describe('a topic from any message', () => {
    it('begins with that message, leaves a card where it was and is read with the message first', async () => {
      const room = await gathering();
      at(2);
      const created = unwrap(
        await startTopicFrom(
          world,
          room.kenji,
          room.roomId,
          { discussionId: room.general, messageId: room.claim.messageId },
          {
            tag: 'debate',
          },
        ),
      );
      const [row] = await world.db
        .selectFrom('rooms.discussions')
        .selectAll()
        .where('discussion_id', '=', created.discussionId)
        .execute();
      expect(row).toMatchObject({
        kind: 'topic',
        tag: 'debate',
        origin_message_id: room.claim.messageId,
        started_by_account_id: room.kenji.accountId,
      });
      expect(row!.title).toBe('So the Moon alone explains why the tides swing so far every month');

      const general = await view(room.asha, room.roomId, room.general);
      // The original stays, and the card follows it, started by the person who made the topic.
      expect(general.messages.map((message) => message.status)).toEqual(['available', 'available']);
      expect(general.messages[0]).toMatchObject({ body: { kind: 'text' } });
      expect(general.messages[1]).toMatchObject({
        author: { personId: room.kenji.person.personId },
        body: { kind: 'topic', topic: { discussionId: created.discussionId, tag: 'debate' } },
      });

      const topic = await view(room.asha, room.roomId, created.discussionId);
      expect(topic.discussion).toMatchObject({ tag: 'debate', title: row!.title });
      expect(topic.origin).toMatchObject({
        status: 'available',
        author: { personId: room.ravi.person.personId },
        body: { kind: 'text', text: 'So the Moon alone explains why the tides swing so far every month' },
      });
    });

    it('lists topics with tags, replies and who spoke last, and sorts Hot, New and Unanswered with pinned first', async () => {
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      at(3);
      const first = await startTopic(world, room.asha, room.roomId, 'Quiet one');
      at(4);
      const busy = unwrap(
        await startTopicFrom(
          world,
          room.kenji,
          room.roomId,
          { discussionId: room.general, messageId: room.claim.messageId },
          {
            tag: 'question',
          },
        ),
      ).discussionId;
      unwrap(await say(world, room.ravi, room.roomId, busy, 'Not only the Moon, I think'));
      unwrap(await say(world, room.asha, room.roomId, busy, 'The Sun matters too'));
      at(5);
      const pinnedTopic = await startTopic(world, room.ravi, room.roomId, 'Pinned one');
      unwrap(
        await world.rooms.pin(moderator.authority, {
          version: 'rooms.v1',
          commandId: randomUUID(),
          roomId: room.roomId,
          discussionId: pinnedTopic,
          pinned: true,
        }),
      );
      at(6);

      const hot = await topicsOf(world, room.asha, room.roomId, 'hot');
      expect(hot.map((topic) => topic.discussionId)).toEqual([pinnedTopic, busy, first]);
      const fresh = await topicsOf(world, room.asha, room.roomId, 'new');
      expect(fresh.map((topic) => topic.discussionId)).toEqual([pinnedTopic, busy, first]);
      expect(fresh.find((topic) => topic.discussionId === busy)).toMatchObject({
        tag: 'question',
        replyCount: 2,
        answered: true,
        usefulCount: 0,
        lastReplyBy: { name: room.asha.person.displayName, ai: false },
      });
      // Nobody but the starter has spoken in the others.
      const open = await topicsOf(world, room.asha, room.roomId, 'unanswered');
      expect(open.map((topic) => topic.discussionId)).toEqual([pinnedTopic, first]);
      expect(
        (await topicsOf(world, room.asha, room.roomId, 'new', 'question')).map((topic) => topic.discussionId),
      ).toEqual([busy]);
      expect(await topicsOf(world, room.asha, room.roomId, 'new', 'share')).toEqual([]);
    });

    it('counts the replies a discussion shows from its counter: a removed message and a topic card are not replies', async () => {
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      const said = [];
      for (let index = 0; index < 3; index++)
        said.push(
          unwrap(await say(world, room.kenji, room.roomId, room.general, `another point, number ${String(index)}`)),
        );
      const shown = async (discussionId: string) =>
        Number(
          (
            await sql<{ n: string }>`
              select count(*)::text as n from rooms.messages
              where discussion_id = ${discussionId}::uuid and hidden_at is null and topic_discussion_id is null`.execute(
              world.db,
            )
          ).rows[0]!.n,
        );
      const generalFigure = async () => (await memberView(world, room.asha, room.roomId)).general.replyCount;
      expect(await generalFigure()).toBe(4);

      // A topic card in General is a message, but not a reply; the topic's own replies are counted in the topic.
      const topic = unwrap(
        await startTopicFrom(world, room.kenji, room.roomId, {
          discussionId: room.general,
          messageId: room.claim.messageId,
        }),
      ).discussionId;
      unwrap(await say(world, room.asha, room.roomId, topic, 'a reply in the topic'));
      expect(await generalFigure()).toBe(4);
      expect(
        (await topicsOf(world, room.asha, room.roomId)).find((entry) => entry.discussionId === topic),
      ).toMatchObject({ replyCount: 1 });

      unwrap(await hideMessage(world, moderator, room.roomId, room.general, said[0]!.messageId));
      expect(await generalFigure()).toBe(3);
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, said[0]!.messageId, false));
      expect(await generalFigure()).toBe(4);
      expect(await generalFigure()).toBe(await shown(room.general));
    });

    it('reads the topic’s first message to an AI that is asked in it, and the placeholder when its author keeps messages out', async () => {
      const room = await gathering();
      const topic = unwrap(
        await startTopicFrom(world, room.kenji, room.roomId, {
          discussionId: room.general,
          messageId: room.claim.messageId,
        }),
      ).discussionId;
      unwrap(await ask(world, room.asha, room.roomId, topic, 'explainer'));
      const first = modelFor(() => answer('explanation', 'The tides have more than one cause.'));
      await first.contribute(world.queued.at(-1)!);
      expect(first.model.calls[0]!.request.user).toContain('Member 1: So the Moon alone explains');

      unwrap(await setPreferences(world, room.ravi, room.roomId, { keepOut: true }));
      unwrap(await say(world, room.kenji, room.roomId, topic, 'and what about the Sun?'));
      unwrap(await ask(world, room.kenji, room.roomId, topic, 'explainer'));
      const second = modelFor(() => answer('explanation', 'The Sun matters too.'));
      await second.contribute(world.queued.at(-1)!);
      expect(second.model.calls[0]!.request.user).not.toContain('So the Moon alone explains');
      expect(second.model.calls[0]!.request.user).toContain("[a member's message]");
    });

    it('names a topic from a message only for readers who may read it: removed and blocked words give the neutral title, a typed one stays', async () => {
      const NEUTRAL = 'A topic from a message';
      const WORDS = 'So the Moon alone explains why the tides swing so far every month';
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      const second = unwrap(
        await say(world, room.ravi, room.roomId, room.general, 'A second claim about neap tides and the quarter Moon'),
      );
      at(2);
      const derived = unwrap(
        await startTopicFrom(world, room.asha, room.roomId, {
          discussionId: room.general,
          messageId: room.claim.messageId,
        }),
      ).discussionId;
      // Giving the very words as the title is the same as leaving them: they are still the message's.
      const sameWords = unwrap(
        await startTopicFrom(
          world,
          room.asha,
          room.roomId,
          { discussionId: room.general, messageId: room.claim.messageId },
          { title: WORDS },
        ),
      ).discussionId;
      const typed = unwrap(
        await startTopicFrom(
          world,
          room.asha,
          room.roomId,
          { discussionId: room.general, messageId: second.messageId },
          { title: 'Neap tides, in my own words' },
        ),
      ).discussionId;
      const stored = await world.db
        .selectFrom('rooms.discussions')
        .select(['discussion_id', 'title', 'title_derived'])
        .where('discussion_id', 'in', [derived, sameWords, typed])
        .execute();
      expect(Object.fromEntries(stored.map((row) => [row.discussion_id, row.title_derived]))).toEqual({
        [derived]: true,
        [sameWords]: true,
        [typed]: false,
      });
      unwrap(
        await world.rooms.pin(moderator.authority, {
          version: 'rooms.v1',
          commandId: randomUUID(),
          roomId: room.roomId,
          discussionId: derived,
          pinned: true,
        }),
      );
      const outsider = await seedFriend(world.db, world.friends);

      /** Every place a title is served to a reader: the topics list, the room view, the topic card, the header, the preview. */
      const titlesSeenBy = async (person: Friend) => {
        const list = await topicsOf(world, person, room.roomId, 'new');
        const roomView = await memberView(world, person, room.roomId);
        const cards = (await view(person, room.roomId, room.general)).messages.flatMap((message) =>
          message.status === 'available' && message.body.kind === 'topic'
            ? [[message.body.topic.discussionId, message.body.topic.title] as const]
            : [],
        );
        return {
          list: Object.fromEntries(list.map((topic) => [topic.discussionId, topic.title])),
          roomView: Object.fromEntries(roomView.discussions.map((topic) => [topic.discussionId, topic.title])),
          cards: Object.fromEntries(cards),
          header: (await view(person, room.roomId, derived)).discussion.title,
        };
      };
      const previewPinned = async () => {
        const preview = unwrap(
          await world.rooms.read(outsider.authority, {
            version: 'rooms.v1',
            readId: randomUUID(),
            roomId: room.roomId,
          }),
        );
        if (preview.status !== 'preview') throw new Error('expected a preview');
        return preview.pinned;
      };
      const expectTitles = (seen: Awaited<ReturnType<typeof titlesSeenBy>>, words: string) => {
        for (const place of [seen.list, seen.roomView, seen.cards]) {
          expect(place[derived]).toBe(words);
          expect(place[sameWords]).toBe(words);
          expect(place[typed]).toBe('Neap tides, in my own words');
        }
        expect(seen.header).toBe(words);
      };

      expectTitles(await titlesSeenBy(room.asha), WORDS);
      expect(await previewPinned()).toBe(WORDS);

      // Kenji blocks the author: for Kenji the words are not readable, for Asha they still are.
      unwrap(await friendCommand(world.friends, room.kenji, room.ravi, 'block'));
      expectTitles(await titlesSeenBy(room.kenji), NEUTRAL);
      expectTitles(await titlesSeenBy(room.asha), WORDS);
      unwrap(await friendCommand(world.friends, room.kenji, room.ravi, 'unblock'));
      expectTitles(await titlesSeenBy(room.kenji), WORDS);

      // A moderator removes the message: nobody reads its words through a title, and the typed title is untouched.
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, room.claim.messageId));
      expectTitles(await titlesSeenBy(room.asha), NEUTRAL);
      expectTitles(await titlesSeenBy(room.kenji), NEUTRAL);
      expect(await previewPinned()).toBe(NEUTRAL);
      // The words are still stored, so restoring the message restores the title.
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, room.claim.messageId, false));
      expectTitles(await titlesSeenBy(room.asha), WORDS);
      expect(await previewPinned()).toBe(WORDS);
    });

    it('refuses a removed message, a topic card, a message of someone the starter blocked and another room’s message', async () => {
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      const gone = unwrap(await say(world, room.asha, room.roomId, room.general, 'I take this back'));
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, gone.messageId));
      const code = async (from: { discussionId: string; messageId: string }, person: Friend, roomId = room.roomId) => {
        const result = await startTopicFrom(world, person, roomId, from);
        return result.kind === 'refused' ? result.code : 'ok';
      };
      expect(await code({ discussionId: room.general, messageId: gone.messageId }, room.kenji)).toBe('unavailable');
      const created = unwrap(
        await startTopicFrom(world, room.kenji, room.roomId, {
          discussionId: room.general,
          messageId: room.claim.messageId,
        }),
      );
      const card = (await view(room.asha, room.roomId, room.general)).messages.at(-1)!;
      expect(await code({ discussionId: room.general, messageId: card.messageId }, room.kenji)).toBe('unavailable');
      unwrap(await friendCommand(world.friends, room.asha, room.ravi, 'block'));
      expect(await code({ discussionId: room.general, messageId: room.claim.messageId }, room.asha)).toBe(
        'unavailable',
      );
      const stranger = await seedRoom(world);
      expect(
        await code({ discussionId: room.general, messageId: room.claim.messageId }, room.kenji, stranger.roomId),
      ).toBe('unavailable');
      expect(created.discussionId).toBeTruthy();
    });
  });

  describe('Useful', () => {
    it('is one mark per member, shown to its maker and counted only on the topic', async () => {
      const room = await gathering();
      const topic = unwrap(
        await startTopicFrom(world, room.kenji, room.roomId, {
          discussionId: room.general,
          messageId: room.claim.messageId,
        }),
      ).discussionId;
      const reply = unwrap(await say(world, room.asha, room.roomId, topic, 'The Sun matters too'));
      const mark = (person: Friend, useful = true) =>
        markUseful(world, person, room.roomId, topic, reply.messageId, useful);
      unwrap(await mark(room.ravi));
      // The same person again is the same single mark.
      const again = unwrap(await mark(room.ravi));
      expect(again).toMatchObject({ operation: 'message.useful', useful: true });
      unwrap(await mark(room.kenji));
      const count = (await topicsOf(world, room.asha, room.roomId))[0]!.usefulCount;
      expect(count).toBe(2);
      const rows = await world.db.selectFrom('rooms.message_useful').selectAll().execute();
      expect(rows.filter((row) => row.message_id === reply.messageId)).toHaveLength(2);

      // Only the person who marked it is told: the author sees no mark and no count on the message.
      const own = (await view(room.asha, room.roomId, topic)).messages.at(-1)!;
      const marked = (await view(room.ravi, room.roomId, topic)).messages.at(-1)!;
      expect(marked).toMatchObject({ usefulByYou: true });
      expect(own).not.toHaveProperty('usefulByYou');
      expect(JSON.stringify(own)).not.toMatch(/useful/i);

      // Taking it back removes it, and taking back what was never made is harmless.
      unwrap(await mark(room.ravi, false));
      unwrap(await mark(room.ravi, false));
      expect((await topicsOf(world, room.asha, room.roomId))[0]!.usefulCount).toBe(1);
    });

    it('is refused on one’s own message, a removed one or a stranger’s room, and there is no negative mark', async () => {
      const room = await gathering();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, room.slug, moderator);
      const own = unwrap(await say(world, room.asha, room.roomId, room.general, 'my own words'));
      const marksBefore = (await world.db.selectFrom('rooms.message_useful').selectAll().execute()).length;
      const code = async (result: ReturnType<typeof markUseful>) => {
        const found = await result;
        return found.kind === 'refused' ? found.code : 'ok';
      };
      expect(await code(markUseful(world, room.asha, room.roomId, room.general, own.messageId))).toBe('invalid_input');
      unwrap(await hideMessage(world, moderator, room.roomId, room.general, room.claim.messageId));
      expect(await code(markUseful(world, room.kenji, room.roomId, room.general, room.claim.messageId))).toBe(
        'unavailable',
      );
      const outsider = await seedFriend(world.db, world.friends);
      expect(await code(markUseful(world, outsider, room.roomId, room.general, own.messageId))).toBe('unavailable');
      expect(await world.db.selectFrom('rooms.message_useful').selectAll().execute()).toHaveLength(marksBefore);
      // The contract has no way to say "not useful" except taking a mark back.
      const downvote = await world.rooms.markUseful(room.kenji.authority, {
        version: 'rooms.v1',
        commandId: randomUUID(),
        roomId: room.roomId,
        discussionId: room.general,
        messageId: own.messageId,
        useful: -1,
      });
      expect(downvote).toMatchObject({ kind: 'refused', code: 'invalid_input' });
    });

    it('may mark a resident’s answer, and a message whose author the member blocked is refused', async () => {
      const room = await gathering();
      unwrap(await ask(world, room.asha, room.roomId, room.general, 'explainer'));
      await modelFor(() => answer('explanation', 'The tides have more than one cause.')).contribute(
        world.queued.at(-1)!,
      );
      const nova = (await view(room.asha, room.roomId, room.general)).messages.at(-1)!;
      unwrap(await markUseful(world, room.asha, room.roomId, room.general, nova.messageId));
      expect((await view(room.asha, room.roomId, room.general)).messages.at(-1)).toMatchObject({ usefulByYou: true });
      unwrap(await friendCommand(world.friends, room.kenji, room.ravi, 'block'));
      const refused = await markUseful(world, room.kenji, room.roomId, room.general, room.claim.messageId);
      expect(refused).toMatchObject({ kind: 'refused', code: 'unavailable' });
    });
  });

  describe('the welcome', () => {
    it('is a template read from the room until the notice is read, and no model is asked', async () => {
      at(0);
      const { roomId } = await seedRoom(world, { name: 'Machine learning' });
      const rowsOf = async (table: string) =>
        Number(
          (await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(world.db)).rows[0]!.n,
        );
      // Everything a model call leaves behind: its runs, attempts and receipts, the ledgers of asks and summaries, and any
      // work queued for a worker. Joining and reading the room must change none of it.
      const callTraces = async () => ({
        reasoning: await rowsIn(world.db, ['reasoning']),
        asks: await rowsOf('rooms.ai_turns'),
        summaries: await rowsOf('rooms.summaries'),
        asksQueued: world.queued.length,
        checksQueued: world.castChecks.length,
        passesQueued: world.castPasses.length,
        summariesQueued: world.summaries.length,
      });
      const before = await callTraces();
      const [newcomer] = (await joined(world, roomId, 1)) as [Friend];
      const first = await memberView(world, newcomer, roomId);
      expect(first.welcome).toMatchObject({
        resident: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' },
      });
      expect(first.welcome!.text).toMatch(
        /^Welcome to Machine learning\. .+ Ask me anything here, or just say hello in General\.$/,
      );
      // Joining, reading and reading again make no call and write no turn.
      await memberView(world, newcomer, roomId);
      expect(await ledger(roomId)).toEqual([]);
      expect(await callTraces()).toEqual(before);

      unwrap(await setPreferences(world, newcomer, roomId, { noticeSeen: true }));
      expect((await memberView(world, newcomer, roomId)).welcome).toBeUndefined();
    });
  });

  it('writes nothing to the personal universe: every ask, topic, mark and removal is conversation', async () => {
    const room = await gathering();
    const moderator = await seedFriend(world.db, world.friends);
    await makeModerator(world, room.slug, moderator);
    // Counted after the people and the room exist: only what the commands below do is measured.
    const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
    for (const kind of ['challenge', 'other_side', 'about'] as const) {
      unwrap(await askAbout(world, room.asha, room.roomId, room.general, kind, room.claim.messageId));
      await modelFor(() => answer(kind === 'about' ? 'explanation' : 'assumption', 'Is that so?')).contribute(
        world.queued.at(-1)!,
      );
    }
    unwrap(await say(world, room.kenji, room.roomId, room.general, '@Nova what is a spring tide?'));
    await modelFor(() => answer('explanation', 'The biggest tide.')).contribute(world.queued.at(-1)!);
    const topic = unwrap(
      await startTopicFrom(world, room.kenji, room.roomId, {
        discussionId: room.general,
        messageId: room.claim.messageId,
      }),
    ).discussionId;
    unwrap(await markUseful(world, room.asha, room.roomId, room.general, room.claim.messageId));
    unwrap(await markUseful(world, room.asha, room.roomId, room.general, room.claim.messageId, false));
    unwrap(await setPresence(world, room.asha, room.roomId));
    unwrap(await setPreferences(world, room.asha, room.roomId, { keepOut: true }));
    unwrap(await hideMessage(world, moderator, room.roomId, room.general, room.claim.messageId));
    await topicsOf(world, room.asha, room.roomId);
    await memberView(world, room.asha, room.roomId);
    await view(room.kenji, room.roomId, topic);
    expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
  });
});
