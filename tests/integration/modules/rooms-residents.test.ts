/**
 * Residents who speak unprompted (v3 R-2, D-162 to D-165) over real PostgreSQL and the real reasoning harness with a
 * CI fixture model (never provider output): a question nobody answers is answered at the timer, labelled and with
 * a reason; a strong claim draws one rebuttal; the caps are exact and refuse quietly; a person who keeps messages
 * out is not read; an idle room makes no call; asked turns never depend on the room scope; nothing here writes to
 * the personal universe.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { holdCast } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel, fixtureSettings } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  ask,
  joined,
  memberView,
  readDiscussion,
  roomScope,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPresence,
  setPreferences,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import type { Friend } from '../support/talk.js';

// Ten o'clock UTC on the day the test runs: the job port refuses a start more than a day ahead of the real clock, and the
// daily caps count from midnight UTC.
const today = new Date();
const START = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10, 0, 0));
const MINUTE = 60_000;

const answer = (kind: string, text: string): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind, text }),
});
const explains = (text = 'Seasons come from the tilt of the Earth, which changes how directly sunlight lands.') =>
  answer('explanation', text);
const pushesBack = (text = 'Does that assume the Moon is the only thing pulling on the oceans?') =>
  answer('assumption', text);

describe('residents speak on their own (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_residents');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  /** Moves the shared clock to `minutes` after the start of the story. */
  const at = (minutes: number) => {
    world.clock.now = new Date(START.getTime() + minutes * MINUTE);
  };

  /** A room of three people who have each spoken once (so nobody is a newcomer) and all have it open. */
  async function gathering() {
    at(0);
    const { roomId } = await seedRoom(world);
    const [asha, ravi, kenji] = (await joined(world, roomId, 3)) as [Friend, Friend, Friend];
    const general = (await memberView(world, asha, roomId)).general.discussionId;
    for (const person of [asha, ravi, kenji]) {
      unwrap(await setPresence(world, person, roomId));
      unwrap(await say(world, person, roomId, general, 'Hello, glad to be here'));
    }
    return { roomId, general, asha, ravi, kenji };
  }

  type Gathering = Awaited<ReturnType<typeof gathering>>;

  /** Everyone in the room renews their lease now, so the room has three faces at this moment. */
  async function everyoneHere(room: Gathering) {
    for (const person of [room.asha, room.ravi, room.kenji]) unwrap(await setPresence(world, person, room.roomId));
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

  /** The check queued by the newest message that set one off. */
  const lastCheck = () => world.castChecks.at(-1)!;
  const decide = (job: Parameters<ReturnType<RoomWorld['decide']>>[0]) => world.decide()(job);

  const turnsOf = (roomId: string) =>
    world.db.selectFrom('rooms.ai_turns').selectAll().where('room_id', '=', roomId).orderBy('created_at').execute();

  const view = async (person: Friend, room: Gathering) => {
    const read = await readDiscussion(world, person, room.roomId, room.general);
    if (read.status !== 'ready') throw new Error('expected ready');
    return read;
  };

  const spokenBy = (messages: Awaited<ReturnType<typeof view>>['messages']) =>
    messages.flatMap((message) =>
      message.status === 'available' && message.author.kind === 'ai' ? [message.author.name] : [],
    );

  /** Posts three plain messages by different people a moment later, so the room's ratio of people to residents is met again. */
  async function chatter(room: Gathering) {
    world.clock.now = new Date(world.clock.now.getTime() + 1_000);
    for (const person of [room.asha, room.ravi, room.kenji])
      unwrap(await say(world, person, room.roomId, room.general, 'Interesting, keep going'));
  }

  /** Runs the check that is due, then the model call it queued, over a fixture model playing `scenario`. */
  async function runTurn(
    room: Gathering,
    scenario: FixtureScenario,
    options: { minutesAfter?: number; settings?: typeof fixtureSettings } = {},
  ) {
    const check = lastCheck();
    world.clock.now = new Date(check.startAfter!.getTime() + (options.minutesAfter ?? 0) * MINUTE);
    const before = world.castPasses.length;
    await decide(check.job);
    const model = fixtureModel(() => scenario, { label: 'rooms-residents' });
    const { harness, withScope } = roomScope(world.db, model, options.settings);
    if (world.castPasses.length > before) await world.pass(harness, withScope)(world.castPasses.at(-1)!.job);
    return { model };
  }

  describe('the quiet room', () => {
    it('makes no call, queues nothing and writes no turn when nobody asks anything, however long it is left alone', async () => {
      const room = await gathering();
      const model = fixtureModel(() => explains(), { label: 'idle' });
      unwrap(await say(world, room.asha, room.roomId, room.general, 'thanks, that helps a lot'));
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'I think the tilt matters more than distance'));
      at(60);
      expect(world.castChecks.filter((check) => check.job.roomId === room.roomId)).toEqual([]);
      expect(await turnsOf(room.roomId)).toEqual([]);
      expect(model.calls).toHaveLength(0);
    });

    it('queues nothing in a world that has not turned residents on', async () => {
      at(0);
      const quiet = await roomWorld(database, { now: START }, { residentsEnabled: false });
      try {
        const { roomId } = await seedRoom(quiet);
        const [person] = (await joined(quiet, roomId, 1)) as [Friend];
        const general = (await memberView(quiet, person, roomId)).general.discussionId;
        unwrap(await say(quiet, person, roomId, general, 'Why do we have seasons at all?'));
        expect(quiet.castChecks).toEqual([]);
      } finally {
        await quiet.close();
      }
    });
  });

  describe('a question nobody answers', () => {
    it('is answered at the timer, labelled, with its reason and a ledger row naming the trigger and the caps', async () => {
      const room = await gathering();
      at(1);
      await everyoneHere(room);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      const check = lastCheck();
      // Three people have the room open: four minutes.
      expect(check.job).toMatchObject({ trigger: 'unanswered_question', roomId: room.roomId, round: 0 });
      expect(check.startAfter!.getTime()).toBe(START.getTime() + 5 * MINUTE);

      const { model } = await runTurn(room, explains());
      expect(model.calls).toHaveLength(1);

      const [turn] = await turnsOf(room.roomId);
      expect(turn).toMatchObject({
        trigger: 'unanswered_question',
        state: 'completed',
        decided_by: 'caps_clear',
        inhabitant: 'explainer',
        requested_by_account_id: null,
        dispatched: true,
        role_version: 'resident.1',
      });
      expect(turn!.caps).toMatchObject({ roomLastHour: 0, roomToday: 0, residentLastHour: 0, personLastHour: 0 });
      expect(turn!.attempt_id).not.toBeNull();

      const read = await view(room.asha, room);
      const spoken = read.messages.at(-1);
      expect(spoken).toMatchObject({
        status: 'available',
        author: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' },
        trigger: 'unanswered_question',
        suggestion: 'explanation',
      });
      // It is paid by the rooms scope, as an ambient role, never by a person.
      const receipt = await world.db
        .selectFrom('reasoning.usage_receipts')
        .select(['role_id', 'background', 'ambient'])
        .where('attempt_id', '=', turn!.attempt_id!)
        .executeTakeFirstOrThrow();
      expect(receipt).toEqual({ role_id: 'rooms.ambient-explainer', background: false, ambient: true });
      const attempt = await world.db
        .selectFrom('reasoning.production_attempts')
        .select('scope_id')
        .where('id', '=', turn!.attempt_id!)
        .executeTakeFirstOrThrow();
      expect(attempt.scope_id).toBe('rooms');
      // A resident is never a face: with three people here the count is three, not five.
      await everyoneHere(room);
      expect((await memberView(world, room.asha, room.roomId)).here.count).toBe(3);
    });

    it('waits ninety seconds when only the author is here, and looks again when others arrive', async () => {
      const room = await gathering();
      at(1);
      unwrap(await setPresence(world, room.ravi, room.roomId));
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'What makes the tides rise twice a day?'));
      expect(lastCheck().startAfter!.getTime()).toBe(START.getTime() + MINUTE + 90_000);

      // The wait is measured against who is here when it is over: Asha came back, so four minutes are owed.
      at(2);
      unwrap(await setPresence(world, room.asha, room.roomId));
      const check = lastCheck();
      world.clock.now = check.startAfter!;
      const queuedBefore = world.castChecks.length;
      await decide(check.job);
      expect(await turnsOf(room.roomId)).toEqual([]);
      expect(world.castChecks).toHaveLength(queuedBefore + 1);
      expect(lastCheck().job.round).toBe(1);
      expect(lastCheck().startAfter!.getTime()).toBeGreaterThanOrEqual(START.getTime() + 5 * MINUTE);
    });

    it('is not answered when a person answers first, or when an AI already has', async () => {
      const room = await gathering();
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'How do tides work exactly?'));
      const check = lastCheck();
      at(3);
      unwrap(await say(world, room.kenji, room.roomId, room.general, 'The Moon pulls on the oceans'));
      world.clock.now = check.startAfter!;
      const model = fixtureModel(() => explains(), { label: 'no-call' });
      await decide(check.job);
      expect(await turnsOf(room.roomId)).toEqual([]);
      expect(model.calls).toHaveLength(0);
      expect(world.castPasses.filter((pass) => pass.job.roomId === room.roomId)).toEqual([]);
    });

    it('does nothing for a message it was asked about twice, and never answers the same message a second time', async () => {
      const room = await gathering();
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why is the sky blue in the daytime?'));
      await runTurn(
        room,
        explains('Air scatters blue light more than red, so blue reaches your eyes from every side.'),
      );
      const first = await turnsOf(room.roomId);
      expect(first).toHaveLength(1);
      // The same job delivered again, and a later look at the same message, change nothing.
      await decide(lastCheck().job);
      await decide({ ...lastCheck().job, round: 1 });
      expect(await turnsOf(room.roomId)).toHaveLength(1);
      expect(spokenBy((await view(room.asha, room)).messages)).toEqual(['Nova']);
    });

    it('drops an answer a person beat it to while the model ran, and puts one off while someone types, at no second cost', async () => {
      // Someone answers while the model is working: the words are dropped, the call stays counted.
      const beaten = await gathering();
      at(1);
      unwrap(await say(world, beaten.ravi, beaten.roomId, beaten.general, 'Why do we have seasons at all?'));
      world.clock.now = lastCheck().startAfter!;
      await decide(lastCheck().job);
      let release: (scenario: FixtureScenario) => void = () => undefined;
      const held = new Promise<FixtureScenario>((resolve) => (release = resolve));
      const slow = fixtureModel(() => ({ kind: 'hold', until: held }), { label: 'rooms-beaten' });
      const first = roomScope(world.db, slow);
      const running = world.pass(first.harness, first.withScope)(world.castPasses.at(-1)!.job);
      await expect.poll(() => slow.calls.length).toBe(1);
      unwrap(await say(world, beaten.kenji, beaten.roomId, beaten.general, 'The tilt of the Earth does it'));
      release(explains());
      await running;
      expect(await turnsOf(beaten.roomId)).toMatchObject([{ state: 'failed', dispatched: true }]);
      expect(spokenBy((await view(beaten.asha, beaten)).messages)).toEqual([]);

      // Someone is typing when the answer comes back: posting is put off, the turn stays queued and the run open.
      const typing = await gathering();
      at(1);
      unwrap(await say(world, typing.ravi, typing.roomId, typing.general, 'How do tides work exactly?'));
      world.clock.now = lastCheck().startAfter!;
      await decide(lastCheck().job);
      const passJob = world.castPasses.at(-1)!.job;
      let letGo: (scenario: FixtureScenario) => void = () => undefined;
      const waiting = new Promise<FixtureScenario>((resolve) => (letGo = resolve));
      const model = fixtureModel(() => ({ kind: 'hold', until: waiting }), { label: 'rooms-typing' });
      const second = roomScope(world.db, model);
      const pending = world.pass(second.harness, second.withScope)(passJob);
      await expect.poll(() => model.calls.length).toBe(1);
      await holdCast(
        world.db,
        () => world.clock.now,
      )({
        accountId: typing.kenji.accountId,
        roomId: typing.roomId,
        discussionId: typing.general,
      });
      letGo(explains());
      await pending;
      const putOff = world.castPasses.at(-1)!;
      expect(putOff.job).toMatchObject({ turnId: passJob.turnId, round: 1 });
      expect(putOff.startAfter!.getTime()).toBeGreaterThan(world.clock.now.getTime());
      expect(await turnsOf(typing.roomId)).toMatchObject([{ state: 'queued' }]);
      expect(spokenBy((await view(typing.asha, typing)).messages)).toEqual([]);

      // The hold lapses; the redelivered job posts the stored answer without calling the model again.
      world.clock.now = putOff.startAfter!;
      const again = fixtureModel(() => explains('must not be asked'), { label: 'rooms-typing' });
      const third = roomScope(world.db, again);
      await world.pass(third.harness, third.withScope)(putOff.job);
      expect(again.calls).toHaveLength(0);
      expect(spokenBy((await view(typing.asha, typing)).messages)).toEqual(['Nova']);
      expect(await turnsOf(typing.roomId)).toMatchObject([{ state: 'completed' }]);
    });

    it('does not answer a person who keeps their messages out, and never reads them', async () => {
      const room = await gathering();
      unwrap(await setPreferences(world, room.ravi, room.roomId, { keepOut: true }));
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      const { model } = await runTurn(room, explains());
      expect(await turnsOf(room.roomId)).toEqual([]);
      expect(model.calls).toHaveLength(0);
    });

    it('does not read a kept-out member’s words: the stored request bytes carry the placeholder only', async () => {
      const room = await gathering();
      unwrap(await setPreferences(world, room.kenji, room.roomId, { keepOut: true }));
      at(1);
      unwrap(await say(world, room.kenji, room.roomId, room.general, 'KENJI-PRIVATE-WORDS about the Moon'));
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      const { model } = await runTurn(room, explains());
      expect(model.calls).toHaveLength(1);
      const sent = model.calls[0]!.request.user;
      expect(sent).toContain("[a member's message]");
      expect(sent).not.toContain('KENJI-PRIVATE-WORDS');
      const stored = await sql<{ text: string }>`
        select convert_from(requests.body, 'UTF8') as text
        from reasoning.production_requests requests
        join reasoning.production_attempts attempt on attempt.id = requests.attempt_id and attempt.scope_id = requests.scope_id
        join rooms.ai_turns turn on turn.attempt_id = attempt.id
        where turn.room_id = ${room.roomId}::uuid`.execute(world.db);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]!.text).toContain("[a member's message]");
      expect(stored.rows[0]!.text).not.toContain('KENJI-PRIVATE-WORDS');
    });
  });

  describe('a strong claim', () => {
    it('draws exactly one rebuttal, never to a newcomer’s first message, and may be answered with nothing to add', async () => {
      const room = await gathering();
      at(1);
      await everyoneHere(room);
      unwrap(
        await say(world, room.kenji, room.roomId, room.general, "so we've proven it, the Moon causes the tides alone"),
      );
      expect(lastCheck().job.trigger).toBe('overstated_claim');
      expect(lastCheck().startAfter!.getTime()).toBe(START.getTime() + 3 * MINUTE);
      const { model } = await runTurn(room, pushesBack());
      expect(model.calls).toHaveLength(1);
      // Delivered again: still one.
      await decide(lastCheck().job);
      const turns = await turnsOf(room.roomId);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ trigger: 'overstated_claim', inhabitant: 'skeptic', state: 'completed' });
      expect((await view(room.asha, room)).messages.at(-1)).toMatchObject({
        author: { kind: 'ai', inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic' },
        trigger: 'overstated_claim',
      });

      // The Skeptic’s own “nothing to add” posts nothing but still counts as a spent call.
      const quiet = await gathering();
      at(1);
      unwrap(
        await say(world, quiet.kenji, quiet.roomId, quiet.general, 'That is 100% how the seasons work, obviously'),
      );
      await runTurn(quiet, answer('nothing_to_add', ''));
      expect(await turnsOf(quiet.roomId)).toMatchObject([
        { trigger: 'overstated_claim', state: 'declined', dispatched: true },
      ]);
      expect(spokenBy((await view(quiet.asha, quiet)).messages)).toEqual([]);

      // A newcomer’s first message is never challenged.
      const fresh = await gathering();
      const newcomer = (await joined(world, fresh.roomId, 1))[0]!;
      unwrap(await setPresence(world, newcomer, fresh.roomId));
      at(1);
      unwrap(await say(world, newcomer, fresh.roomId, fresh.general, 'Everyone knows the seasons come from distance'));
      const { model: none } = await runTurn(fresh, pushesBack());
      expect(none.calls).toHaveLength(0);
      expect(await turnsOf(fresh.roomId)).toEqual([]);
    });

    it('lets one Skeptic reply follow an Explainer that overstated, and nothing after it until a person speaks', async () => {
      const room = await gathering();
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      await runTurn(room, explains('It is always the tilt, obviously, and the distance never matters at all.'));
      const reply = lastCheck();
      expect(reply.job.trigger).toBe('answer_overstated');
      expect(reply.startAfter!.getTime()).toBe(world.clock.now.getTime() + MINUTE);

      await runTurn(room, pushesBack('Does the distance really never matter, even a little?'));
      expect(spokenBy((await view(room.asha, room)).messages)).toEqual(['Nova', 'Halley']);
      // The reply to a reply is never scheduled, and the question cannot be answered a third time.
      expect(lastCheck().job.trigger).toBe('answer_overstated');
      const checksAfter = world.castChecks.length;
      await decide({ ...reply.job, round: 1 });
      expect(world.castChecks).toHaveLength(checksAfter);
      expect(await turnsOf(room.roomId)).toHaveLength(2);

      // And if a person spoke in between, the reply is dropped.
      const other = await gathering();
      at(1);
      unwrap(await say(world, other.ravi, other.roomId, other.general, 'Why do we have seasons at all?'));
      await runTurn(other, explains('It is always the tilt, obviously, and the distance never matters at all.'));
      const pending = lastCheck();
      unwrap(await say(world, other.kenji, other.roomId, other.general, 'Hm, not sure about that'));
      world.clock.now = pending.startAfter!;
      await decide(pending.job);
      expect(await turnsOf(other.roomId)).toHaveLength(1);
    });
  });

  describe('the caps', () => {
    it('allows one unprompted turn per three human messages, and refuses the rest quietly', async () => {
      const room = await gathering();
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      await runTurn(room, explains());

      // A second question at once: only one human message since the last turn.
      at(10);
      unwrap(await say(world, room.kenji, room.roomId, room.general, 'What causes the tides in the sea?'));
      const model = fixtureModel(() => explains(), { label: 'ratio' });
      const passes = world.castPasses.length;
      const messagesBefore = (await view(room.asha, room)).messages.length;
      world.clock.now = lastCheck().startAfter!;
      await decide(lastCheck().job);
      const turns = await turnsOf(room.roomId);
      expect(turns).toHaveLength(2);
      expect(turns[1]).toMatchObject({
        state: 'refused',
        decided_by: 'ratio',
        dispatched: false,
      });
      expect(turns[1]!.settled_at).toBeInstanceOf(Date);
      expect(turns[1]!.caps).toMatchObject({ humanSinceLastTurn: 1 });
      // A refusal posts nothing, shows nothing and queues no call.
      expect(world.castPasses).toHaveLength(passes);
      expect(model.calls).toHaveLength(0);
      const read = await view(room.asha, room);
      expect(read.messages).toHaveLength(messagesBefore);
      expect(read.inhabitants.map((entry) => entry.ask)).toEqual(['available', 'available']);

      // Two more people-messages, and the next question is allowed again.
      at(20);
      unwrap(await say(world, room.asha, room.roomId, room.general, 'Good question'));
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'I wondered that too'));
      unwrap(await say(world, room.kenji, room.roomId, room.general, 'How does the Sun fit into the tides?'));
      await runTurn(
        room,
        explains(
          'The Sun pulls too, about half as strongly as the Moon, so it sometimes helps and sometimes works against it.',
        ),
      );
      expect((await turnsOf(room.roomId)).at(-1)).toMatchObject({ state: 'completed', trigger: 'unanswered_question' });
    });

    it('holds the Explainer to four an hour and the Skeptic to one per person', async () => {
      const room = await gathering();
      const questions = [
        'Why do we have seasons at all?',
        'How do tides work exactly?',
        'What makes the sky look blue?',
        'Why does the Moon change shape?',
        'How far away is the Sun from us?',
      ];
      let minute = 1;
      for (const question of questions) {
        at(minute);
        unwrap(await say(world, room.ravi, room.roomId, room.general, question));
        await runTurn(room, explains(`A short answer to: ${question}`));
        await chatter(room);
        minute += 5;
      }
      const turns = await turnsOf(room.roomId);
      expect(turns.filter((turn) => turn.state === 'completed')).toHaveLength(4);
      expect(turns.at(-1)).toMatchObject({ state: 'refused', decided_by: 'resident_hour' });

      // The Skeptic speaks to one person at most once an hour.
      const skeptics = await gathering();
      at(1);
      unwrap(
        await say(
          world,
          skeptics.kenji,
          skeptics.roomId,
          skeptics.general,
          "so we've proven it, the Moon alone makes the tides",
        ),
      );
      await runTurn(skeptics, pushesBack());
      await chatter(skeptics);
      at(8);
      unwrap(
        await say(
          world,
          skeptics.kenji,
          skeptics.roomId,
          skeptics.general,
          'It is obviously the Sun that makes the seasons',
        ),
      );
      await runTurn(skeptics, pushesBack('Is it not the tilt rather than the Sun’s distance?'));
      expect((await turnsOf(skeptics.roomId)).at(-1)).toMatchObject({ state: 'refused', decided_by: 'person_hour' });
    });

    it('holds a room to forty unprompted turns a UTC day', async () => {
      const room = await gathering();
      at(1);
      // Forty turns already spent earlier today, in another discussion, as a busy room would have.
      await sql`
        with earlier as (
          insert into rooms.discussions (discussion_id, room_id, title, last_activity_at, created_at)
          values (gen_random_uuid(), ${room.roomId}::uuid, 'Earlier today', ${START}, ${START})
          returning discussion_id),
        causes as (
          insert into rooms.messages (discussion_id, sequence, message_id, change_sequence, command_id, author_kind,
            author_account_id, recorded_at, body_text)
          select earlier.discussion_id, n, gen_random_uuid(), n, gen_random_uuid(), 'person',
            ${room.asha.accountId}::uuid, ${START}, 'Earlier today'
          from earlier cross join generate_series(1, 40) as n
          returning discussion_id, message_id)
        insert into rooms.ai_turns (turn_id, room_id, discussion_id, inhabitant, state, created_at, settled_at, dispatched,
          trigger, cause_message_id, decided_by)
        select gen_random_uuid(), ${room.roomId}::uuid, discussion_id, 'explainer', 'declined',
          ${START}::timestamptz - interval '3 hours', ${START}::timestamptz - interval '3 hours', true,
          'unanswered_question', message_id, 'caps_clear'
        from causes`.execute(world.db);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      await runTurn(room, explains());
      expect((await turnsOf(room.roomId)).at(-1)).toMatchObject({ state: 'refused', decided_by: 'room_day' });
    });
  });

  describe('levels', () => {
    it('shows an unprompted turn folded for Quieter, hides it for Off, and shows asked turns to everyone', async () => {
      const room = await gathering();
      unwrap(await setPreferences(world, room.kenji, room.roomId, { aiLevel: 'off' }));
      unwrap(await setPreferences(world, room.asha, room.roomId, { aiLevel: 'quieter' }));
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      await runTurn(room, explains());

      const lively = (await view(room.ravi, room)).messages.at(-1);
      const quieter = (await view(room.asha, room)).messages.at(-1);
      const off = (await view(room.kenji, room)).messages.at(-1);
      expect(lively).toMatchObject({ status: 'available', trigger: 'unanswered_question' });
      // Quieter receives the words with the reason, marked folded; the screen shows one line.
      expect(quieter).toMatchObject({ status: 'available', trigger: 'unanswered_question', folded: true });
      expect(lively).not.toHaveProperty('folded');
      // Off receives nothing of what a resident said on its own, only its place.
      expect(off).toEqual({
        messageId: (lively as { messageId: string }).messageId,
        sequence: lively!.sequence,
        status: 'muted',
      });

      // Asked turns always show, whatever the level.
      const asked = fixtureHarness(world.db, { model: fixtureModel(() => pushesBack(), { label: 'asked' }) }).harness;
      unwrap(await ask(world, room.kenji, room.roomId, room.general, 'skeptic'));
      await world.contribute(asked)(world.queued.at(-1)!);
      expect((await view(room.kenji, room)).messages.at(-1)).toMatchObject({
        status: 'available',
        author: { kind: 'ai', inhabitant: 'skeptic' },
      });
    });

    it('speaks to nobody when every member has turned the AI off', async () => {
      const room = await gathering();
      for (const person of [room.asha, room.ravi, room.kenji])
        unwrap(await setPreferences(world, person, room.roomId, { aiLevel: 'off' }));
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      const { model } = await runTurn(room, explains());
      expect(model.calls).toHaveLength(0);
      expect(await turnsOf(room.roomId)).toEqual([]);
    });
  });

  describe('typing', () => {
    it('holds back a turn while someone types, then lets it speak, and records no person', async () => {
      const room = await gathering();
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      const check = lastCheck();
      world.clock.now = new Date(check.startAfter!.getTime() - 5_000);
      await holdCast(
        world.db,
        () => world.clock.now,
      )({
        accountId: room.kenji.accountId,
        roomId: room.roomId,
        discussionId: room.general,
      });
      world.clock.now = check.startAfter!;
      const checksBefore = world.castChecks.length;
      await decide(check.job);
      expect(await turnsOf(room.roomId)).toEqual([]);
      expect(world.castChecks).toHaveLength(checksBefore + 1);
      expect(lastCheck().job.round).toBe(1);
      // The hold lapses by itself and the turn goes ahead.
      const { model } = await runTurn(room, explains());
      expect(model.calls).toHaveLength(1);
      expect(await turnsOf(room.roomId)).toMatchObject([{ state: 'completed' }]);
    });

    it('stores a discussion and a time, never a person, and ignores a hint from someone who is not a member', async () => {
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_schema = 'rooms' and table_name = 'typing_holds' order by column_name`.execute(world.db);
      expect(columns.rows.map((row) => row.column_name)).toEqual(['discussion_id', 'held_until']);
      const persistence = await sql<{ relpersistence: string }>`
        select relpersistence from pg_class where oid = 'rooms.typing_holds'::regclass`.execute(world.db);
      expect(persistence.rows[0]!.relpersistence).toBe('u');

      const room = await gathering();
      const outsider = (await joined(world, (await seedRoom(world)).roomId, 1))[0]!;
      const before = await sql<{ n: string }>`select count(*)::text as n from rooms.typing_holds`.execute(world.db);
      await holdCast(
        world.db,
        () => world.clock.now,
      )({
        accountId: outsider.accountId,
        roomId: room.roomId,
        discussionId: room.general,
      });
      const after = await sql<{ n: string }>`select count(*)::text as n from rooms.typing_holds`.execute(world.db);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });
  });

  describe('the budget', () => {
    it('lets asked turns work when the room scope is spent, and posts nothing for a refused resident', async () => {
      const room = await gathering();
      // The room scope has room for exactly one more request today.
      const tight = {
        ...fixtureSettings,
        caps: {
          ...fixtureSettings.caps,
          scope: { requestsPerDay: (await roomScopeSpent()) + 1, tokensPerDay: 100_000_000 },
        },
      };
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      await runTurn(room, explains(), { settings: tight });
      await chatter(room);
      at(12);
      unwrap(await say(world, room.kenji, room.roomId, room.general, 'What causes the tides in the sea?'));
      const spent = await runTurn(room, explains('unused'), { settings: tight });
      // The router allowed it; the room scope had nothing left, so nothing was sent and the turn was handed back.
      expect(spent.model.calls).toHaveLength(0);
      expect((await turnsOf(room.roomId)).at(-1)).toMatchObject({ state: 'failed', dispatched: false });
      expect(spokenBy((await view(room.asha, room)).messages)).toEqual(['Nova']);

      // A person asking is on their own scope and works as ever.
      const model = fixtureModel(() => pushesBack(), { label: 'asked-still-works' });
      unwrap(await ask(world, room.ravi, room.roomId, room.general, 'skeptic'));
      await world.contribute(fixtureHarness(world.db, { model }).harness)(world.queued.at(-1)!);
      expect(model.calls).toHaveLength(1);
      expect(spokenBy((await view(room.asha, room)).messages)).toEqual(['Nova', 'Halley']);
    });

    it('keeps ambient spend to its share of the global cap so nothing a person asked for is ever taken', async () => {
      const room = await gathering();
      const noShare = { ...fixtureSettings, ambientSharePercent: 0 };
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      const { model } = await runTurn(room, explains(), { settings: noShare });
      expect(model.calls).toHaveLength(0);
      expect((await turnsOf(room.roomId)).at(-1)).toMatchObject({ state: 'failed', dispatched: false });
      // The same day, an ask still goes through.
      const asked = fixtureModel(() => pushesBack(), { label: 'asked' });
      unwrap(await ask(world, room.kenji, room.roomId, room.general, 'skeptic'));
      await world.contribute(fixtureHarness(world.db, { model: asked }).harness)(world.queued.at(-1)!);
      expect(asked.calls).toHaveLength(1);
    });
  });

  describe('the cast', () => {
    it('gives every seeded room a named Explainer and Skeptic, labelled as AI', async () => {
      const room = await gathering();
      const cast = await world.db
        .selectFrom('rooms.room_cast')
        .select(['inhabitant', 'name', 'position'])
        .where('room_id', '=', room.roomId)
        .orderBy('position')
        .execute();
      expect(cast).toEqual([
        { inhabitant: 'explainer', name: 'Nova', position: 1 },
        { inhabitant: 'skeptic', name: 'Halley', position: 2 },
      ]);
      expect((await memberView(world, room.asha, room.roomId)).inhabitants).toEqual([
        { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
        { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
      ]);
    });
  });

  describe('the personal universe', () => {
    it('is written to by nothing a resident does: no row in experience, geography, composer or planner changes', async () => {
      const schemas = ['experience', 'geography', 'composer', 'planner', 'evidence', 'personal_context'];
      const room = await gathering();
      const before = await rowsIn(world.db, schemas);
      at(1);
      unwrap(await say(world, room.ravi, room.roomId, room.general, 'Why do we have seasons at all?'));
      await runTurn(room, explains('It is always the tilt, obviously, and the distance never matters at all.'));
      await runTurn(room, pushesBack());
      unwrap(await ask(world, room.kenji, room.roomId, room.general, 'explainer'));
      expect(spokenBy((await view(room.asha, room)).messages)).toEqual(['Nova', 'Halley']);
      expect(await rowsIn(world.db, schemas)).toBe(before);
    });
  });

  it('has a turn row for every AI message there is, and the message says why only when it was unprompted', async () => {
    const orphans = await sql<{ n: string }>`
      select count(*)::text as n from rooms.messages message
      where message.author_kind = 'ai'
        and not exists (select 1 from rooms.ai_turns turn where turn.message_id = message.message_id)`.execute(
      world.db,
    );
    expect(orphans.rows[0]!.n).toBe('0');
    const unnamed = await sql<{ n: string }>`
      select count(*)::text as n from rooms.messages message
      join rooms.ai_turns turn on turn.message_id = message.message_id
      where message.trigger is distinct from (case when turn.trigger = 'asked' then null else turn.trigger end)`.execute(
      world.db,
    );
    expect(unnamed.rows[0]!.n).toBe('0');
  });
});
