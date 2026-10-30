/**
 * "While you were away" (v3 R-3, D-169) over real PostgreSQL and the real reasoning harness with a CI fixture model (never
 * provider output): a member who comes back after a long absence to enough new messages is owed one summary written by a
 * resident; the room is charged one call per 12-hour window however many members return; what a member keeps out of what
 * AI reads and what a moderator removed never reaches the model; and a summary that read what was later removed, kept
 * out or deleted is erased.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, gate } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  dismissAway,
  hideMessage,
  joined,
  makeModerator,
  memberView,
  roomScope,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPreferences,
  setPresence,
  startTopicFrom,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { seedFriend, type Friend } from '../support/talk.js';

const today = new Date();
const START = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 6, 0, 0));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NO_UNPROMPTED = ['experience', 'geography', 'composer', 'planning'];

const summary = (text: string): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind: 'summary', text }),
});
const NOTHING: FixtureScenario = { kind: 'success', text: JSON.stringify({ kind: 'nothing_to_add', text: '' }) };
const TEXT =
  'Two people compared the Moon and the Sun as causes of tides.\nOne question about spring tides is still open.';

describe('while you were away (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_away');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const at = (hours: number, minutes = 0) => {
    world.clock.now = new Date(START.getTime() + hours * HOUR + minutes * MINUTE);
  };

  /** A room where two people (the returners) have opened it, then two others talk while they are away. */
  async function room() {
    at(0);
    const { roomId, slug } = await seedRoom(world);
    const [asha, ravi, writerOne, writerTwo, kept] = (await joined(world, roomId, 5)) as [
      Friend,
      Friend,
      Friend,
      Friend,
      Friend,
    ];
    const moderator = await seedFriend(world.db, world.friends);
    await makeModerator(world, slug, moderator);
    unwrap(await setPreferences(world, kept, roomId, { keepOut: true }));
    const general = (await memberView(world, asha, roomId)).general.discussionId;
    for (const person of [asha, ravi, writerOne, writerTwo, kept]) unwrap(await setPresence(world, person, roomId));
    return { roomId, slug, general, asha, ravi, writerOne, writerTwo, kept, moderator };
  }
  type Room = Awaited<ReturnType<typeof room>>;

  /** `count` plain messages from the two writers, a minute apart, starting `hours` after the start. */
  async function talk(r: Room, count: number, hours: number) {
    for (let index = 0; index < count; index++) {
      at(hours, index);
      unwrap(
        await say(
          world,
          index % 2 === 0 ? r.writerOne : r.writerTwo,
          r.roomId,
          r.general,
          `Interesting point about orbits number ${String(index + 1)}`,
        ),
      );
    }
  }

  const summariesOf = (roomId: string) =>
    world.db.selectFrom('rooms.summaries').selectAll().where('room_id', '=', roomId).orderBy('window_no').execute();

  const position = (roomId: string, person: Friend) =>
    world.db
      .selectFrom('rooms.read_positions')
      .selectAll()
      .where('room_id', '=', roomId)
      .where('account_id', '=', person.accountId)
      .executeTakeFirst();

  /** Runs the summary job that is queued last, over a rooms-scope harness playing `script`. */
  function runner(script: (sequence: number) => FixtureScenario | Promise<FixtureScenario>) {
    const model = fixtureModel(script, { label: 'rooms-away' });
    const { harness, withScope } = roomScope(world.db, model);
    return { model, run: () => world.summarise(harness, withScope)(world.summaries.at(-1)!) };
  }

  const awayOf = async (person: Friend, roomId: string) => (await memberView(world, person, roomId)).away;

  describe('a return that is owed one', () => {
    it('is written once by the resident: kept-out members and removed messages never reach the model, and the card is the member’s own', async () => {
      const r = await room();
      await talk(r, 16, 13);
      // A message of a member who keeps theirs out of what AI reads, and a topic that began from a message a moderator
      // then removed: the topic is titled with that message's words, which must not be read through the title either.
      at(13, 30);
      unwrap(await say(world, r.kept, r.roomId, r.general, 'KEPT-OUT-WORDS about the lunar orbit'));
      const removed = unwrap(await say(world, r.writerOne, r.roomId, r.general, 'REMOVED-WORDS about something else'));
      at(13, 40);
      const topic = unwrap(
        await startTopicFrom(world, r.writerTwo, r.roomId, { discussionId: r.general, messageId: removed.messageId }),
      );
      unwrap(await say(world, r.writerOne, r.roomId, topic.discussionId, 'A reply inside the topic about neap tides'));
      unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, removed.messageId));

      // She comes back: a job is queued in the same transaction, and her card says it is being written.
      at(14);
      const queued = world.summaries.length;
      const spentBefore = await rowsIn(world.db, NO_UNPROMPTED);
      unwrap(await setPresence(world, r.asha, r.roomId));
      expect(world.summaries).toHaveLength(queued + 1);
      expect(await awayOf(r.asha, r.roomId)).toMatchObject({
        state: 'preparing',
        since: START.toISOString(),
        resident: { kind: 'ai', inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic' },
      });
      // Someone who was not away is owed nothing.
      expect(await awayOf(r.writerOne, r.roomId)).toBeUndefined();

      const { model, run } = runner(() => summary(TEXT));
      await run();
      expect(model.calls).toHaveLength(1);
      const sent = model.calls[0]!.request.user;
      expect(sent).toContain('Interesting point about orbits number 1');
      expect(sent).not.toContain('KEPT-OUT-WORDS');
      expect(sent).not.toContain('REMOVED-WORDS');
      expect(sent).not.toContain("[a member's message]");
      // The reply inside the topic is read, under a title that is withheld because its first message was removed.
      expect(sent).toContain('A reply inside the topic about neap tides');
      expect(sent).toContain("Topic: [a member's topic]");

      const ready = await awayOf(r.asha, r.roomId);
      expect(ready).toMatchObject({ state: 'ready', text: TEXT, resident: { name: 'Halley' } });
      expect(ready!.coversFrom).toBeDefined();
      expect(ready).not.toHaveProperty('folded');

      // It is the resident's own ledger row, paid by the room scope as an ambient role; no asked or unprompted turn is written.
      const [row] = await summariesOf(r.roomId);
      expect(row).toMatchObject({
        state: 'ready',
        trigger: 'member_returned',
        decided_by: 'window_open',
        resident: 'skeptic',
        role_version: 'away.1',
        dispatched: true,
        body: TEXT,
      });
      expect(row!.attempt_id).not.toBeNull();
      expect(await world.db.selectFrom('rooms.ai_turns').selectAll().where('room_id', '=', r.roomId).execute()).toEqual(
        [],
      );
      const receipts = await sql<{ ambient: boolean }>`
        select ambient from reasoning.usage_receipts where role_id = 'rooms.ambient-away'`.execute(world.db);
      expect(receipts.rows.length).toBeGreaterThan(0);
      expect(receipts.rows.every((receipt) => receipt.ambient)).toBe(true);
      // Nothing of it is evidence or part of anyone's universe.
      expect(await rowsIn(world.db, NO_UNPROMPTED)).toBe(spentBefore);
    });

    it('is one call for the window however many members come back, and another call in the next window', async () => {
      const r = await room();
      await talk(r, 16, 13);
      at(14);
      const queued = world.summaries.length;
      // Two members come back at the same moment: one summary is claimed and one job queued.
      await Promise.all([setPresence(world, r.asha, r.roomId), setPresence(world, r.ravi, r.roomId)]);
      expect(world.summaries).toHaveLength(queued + 1);
      expect(await summariesOf(r.roomId)).toHaveLength(1);
      const { model, run } = runner(() => summary(TEXT));
      await run();
      const first = await awayOf(r.asha, r.roomId);
      const second = await awayOf(r.ravi, r.roomId);
      expect(first).toMatchObject({ state: 'ready', text: TEXT });
      expect(second).toMatchObject({ state: 'ready', text: TEXT });
      expect(model.calls).toHaveLength(1);

      // A later return in the same window asks for nothing more, and reads the same words.
      at(14, 30);
      unwrap(await setPresence(world, r.kept, r.roomId));
      expect(world.summaries).toHaveLength(queued + 1);
      expect(await awayOf(r.kept, r.roomId)).toMatchObject({ state: 'ready', text: TEXT });

      // A day on, with more said meanwhile, the next window is claimed once.
      await talk(r, 16, 28);
      at(30);
      unwrap(await setPresence(world, r.asha, r.roomId));
      expect(world.summaries).toHaveLength(queued + 2);
      expect(await summariesOf(r.roomId)).toHaveLength(2);
      const next = runner(() => summary('A new topic began, and a question about orbits is still open.'));
      await next.run();
      expect(next.model.calls).toHaveLength(1);
      expect(await awayOf(r.asha, r.roomId)).toMatchObject({
        text: 'A new topic began, and a question about orbits is still open.',
      });
    });

    it('is shown folded to a Quieter member, in full to a Lively one, and not at all to a member whose AI is Off', async () => {
      const r = await room();
      unwrap(await setPreferences(world, r.asha, r.roomId, { aiLevel: 'quieter' }));
      unwrap(await setPreferences(world, r.ravi, r.roomId, { aiLevel: 'off' }));
      await talk(r, 16, 13);
      at(14);
      const queued = world.summaries.length;
      unwrap(await setPresence(world, r.ravi, r.roomId));
      // Nobody who listens has come back, so nothing is queued and nothing is spent.
      expect(world.summaries).toHaveLength(queued);
      unwrap(await setPresence(world, r.asha, r.roomId));
      expect(world.summaries).toHaveLength(queued + 1);
      await runner(() => summary(TEXT)).run();
      expect(await awayOf(r.asha, r.roomId)).toMatchObject({ state: 'ready', folded: true });
      expect(await awayOf(r.ravi, r.roomId)).toBeUndefined();
    });

    it('is cleared by the member’s "Got it", and the same command again is harmless', async () => {
      const r = await room();
      await talk(r, 16, 13);
      at(14);
      unwrap(await setPresence(world, r.asha, r.roomId));
      await runner(() => summary(TEXT)).run();
      expect(await awayOf(r.asha, r.roomId)).toBeDefined();
      unwrap(await dismissAway(world, r.asha, r.roomId));
      unwrap(await dismissAway(world, r.asha, r.roomId));
      expect(await awayOf(r.asha, r.roomId)).toBeUndefined();
      // Her place is hers: nothing of it is in what anyone else reads.
      expect(JSON.stringify(await memberView(world, r.ravi, r.roomId))).not.toContain(r.asha.accountId);
    });
  });

  describe('a return that is not owed one', () => {
    it.each([
      ['after less than twelve hours', 11, 59, 20],
      ['to fewer than fifteen new messages', 13, 0, 14],
    ])('is not %s', async (_words, hours, minutes, count) => {
      const r = await room();
      await talk(r, count, 1);
      at(hours, minutes);
      const queued = world.summaries.length;
      unwrap(await setPresence(world, r.asha, r.roomId));
      expect(world.summaries).toHaveLength(queued);
      expect(await summariesOf(r.roomId)).toEqual([]);
      expect(await awayOf(r.asha, r.roomId)).toBeUndefined();
    });

    it('counts exactly twelve hours and exactly fifteen messages as enough', async () => {
      const r = await room();
      await talk(r, 15, 1);
      at(12);
      const queued = world.summaries.length;
      unwrap(await setPresence(world, r.asha, r.roomId));
      expect(world.summaries).toHaveLength(queued + 1);
    });

    it('is not owed to a member who had never opened the room, and a member who left starts again without a place', async () => {
      const r = await room();
      await talk(r, 16, 1);
      at(14);
      const [newcomer] = (await joined(world, r.roomId, 1)) as [Friend];
      const queued = world.summaries.length;
      unwrap(await setPresence(world, newcomer, r.roomId));
      expect(world.summaries).toHaveLength(queued);

      expect(await position(r.roomId, r.asha)).toBeDefined();
      unwrap(
        await world.rooms.leave(r.asha.authority, {
          version: 'rooms.v1',
          commandId: randomUUID(),
          roomId: r.roomId,
        }),
      );
      expect(await position(r.roomId, r.asha)).toBeUndefined();
    });

    it('queues nothing in a world that has not turned residents on, and writes no row', async () => {
      const quiet = await roomWorld(database, { now: START }, { residentsEnabled: false });
      try {
        at(0);
        const { roomId } = await seedRoom(quiet);
        const [asha, writer] = (await joined(quiet, roomId, 2)) as [Friend, Friend];
        const general = (await memberView(quiet, asha, roomId)).general.discussionId;
        unwrap(await setPresence(quiet, asha, roomId));
        for (let index = 0; index < 16; index++) {
          at(13, index);
          unwrap(await say(quiet, writer, roomId, general, `Interesting point about orbits number ${String(index)}`));
        }
        at(14);
        unwrap(await setPresence(quiet, asha, roomId));
        expect(quiet.summaries).toEqual([]);
        expect(
          await quiet.db.selectFrom('rooms.summaries').selectAll().where('room_id', '=', roomId).execute(),
        ).toEqual([]);
      } finally {
        await quiet.close();
      }
    });
  });

  describe('what happens to a summary that read something that is later removed', () => {
    async function ready(r: Room) {
      await talk(r, 16, 13);
      at(14);
      unwrap(await setPresence(world, r.asha, r.roomId));
      await runner(() => summary(TEXT)).run();
      expect(await awayOf(r.asha, r.roomId)).toMatchObject({ state: 'ready' });
    }

    it('is erased when a moderator removes a message it read, and is not written again in that window', async () => {
      const r = await room();
      await ready(r);
      const [row] = await summariesOf(r.roomId);
      const read = await world.db
        .selectFrom('rooms.messages')
        .select('message_id')
        .where('discussion_id', '=', r.general)
        .where('recorded_at', '>', row!.covers_from)
        .where('recorded_at', '<=', row!.covers_through)
        .where('author_kind', '=', 'person')
        .executeTakeFirstOrThrow();
      unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, read.message_id));
      expect(await summariesOf(r.roomId)).toMatchObject([{ state: 'stale', body: null }]);
      expect(await awayOf(r.asha, r.roomId)).toBeUndefined();
      // Another member returning in the same window finds nothing and costs nothing.
      const queued = world.summaries.length;
      unwrap(await setPresence(world, r.ravi, r.roomId));
      expect(world.summaries).toHaveLength(queued);
    });

    it('is erased when a member who wrote in it turns keep-out on', async () => {
      const r = await room();
      await ready(r);
      unwrap(await setPreferences(world, r.writerOne, r.roomId, { keepOut: true }));
      expect(await summariesOf(r.roomId)).toMatchObject([{ state: 'stale', body: null }]);
      expect(await awayOf(r.asha, r.roomId)).toBeUndefined();
    });

    it('is not erased when someone who wrote nothing in it turns keep-out on', async () => {
      const r = await room();
      await ready(r);
      unwrap(await setPreferences(world, r.ravi, r.roomId, { keepOut: true }));
      expect(await summariesOf(r.roomId)).toMatchObject([{ state: 'ready' }]);
    });

    it('is not written at all when it was made stale before the worker took it, and its words are never stored when it is made stale during the call', async () => {
      const r = await room();
      await talk(r, 16, 13);
      at(14);
      unwrap(await setPresence(world, r.asha, r.roomId));
      unwrap(await setPreferences(world, r.writerOne, r.roomId, { keepOut: true }));
      const none = runner(() => summary(TEXT));
      await none.run();
      expect(none.model.calls).toHaveLength(0);
      expect((await summariesOf(r.roomId))[0]).toMatchObject({ state: 'stale', body: null });

      const other = await room();
      await talk(other, 16, 13);
      at(14);
      unwrap(await setPresence(world, other.asha, other.roomId));
      const hold = gate<FixtureScenario>();
      const { model, run } = runner(() => ({ kind: 'hold', until: hold.promise }));
      const running = run();
      while (model.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      unwrap(await setPreferences(world, other.writerTwo, other.roomId, { keepOut: true }));
      hold.open(summary(TEXT));
      await running;
      const [row] = await summariesOf(other.roomId);
      expect(row).toMatchObject({ state: 'stale', body: null, dispatched: true });
      expect(await awayOf(other.asha, other.roomId)).toBeUndefined();
    });
  });

  describe('when the resident has nothing to say or cannot', () => {
    it('shows nothing and does not try again in the window when it answers that nothing is worth telling', async () => {
      const r = await room();
      await talk(r, 16, 13);
      at(14);
      unwrap(await setPresence(world, r.asha, r.roomId));
      const { model, run } = runner(() => NOTHING);
      await run();
      expect(model.calls).toHaveLength(1);
      expect((await summariesOf(r.roomId))[0]).toMatchObject({ state: 'declined', body: null, dispatched: true });
      expect(await awayOf(r.asha, r.roomId)).toBeUndefined();
    });

    it('ends the summary as failed, counted, when the provider fails, and shows nothing', async () => {
      const r = await room();
      await talk(r, 16, 13);
      at(14);
      unwrap(await setPresence(world, r.asha, r.roomId));
      await runner(() => ({ kind: 'server_error', status: 500 })).run();
      expect((await summariesOf(r.roomId))[0]).toMatchObject({ state: 'failed', dispatched: true });
      expect(await awayOf(r.asha, r.roomId)).toBeUndefined();
    });

    it('makes no call when too little is left to read after the kept-out and the removed are set aside', async () => {
      const r = await room();
      unwrap(await setPreferences(world, r.writerOne, r.roomId, { keepOut: true }));
      unwrap(await setPreferences(world, r.writerTwo, r.roomId, { keepOut: true }));
      await talk(r, 16, 13);
      at(14);
      unwrap(await setPresence(world, r.asha, r.roomId));
      const { model, run } = runner(() => summary(TEXT));
      await run();
      expect(model.calls).toHaveLength(0);
      expect((await summariesOf(r.roomId))[0]).toMatchObject({ state: 'failed', dispatched: false });
    });
  });
});
