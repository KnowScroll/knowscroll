/** Router/worker fixtures over real PostgreSQL. Model words below are labelled CI fixtures, never live observations. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { holdCast } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings } from '../support/fixture-model.js';
import {
  joined,
  memberView,
  readDiscussion,
  roomScope,
  roomWorld,
  say,
  seedRoom,
  setPreferences,
  setPresence,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import type { Friend } from '../support/talk.js';

const START = new Date();
const HOUR = 3_600_000;
const starterText =
  'Batching requests raises throughput but can add latency. Which side of that tradeoff would you like to explore?';

describe('one opportunity to start a quiet General', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('room_conversation');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  async function greeting() {
    world.clock.now = START;
    const { roomId } = await seedRoom(world);
    const [person, other] = (await joined(world, roomId, 2)) as [Friend, Friend];
    const general = (await memberView(world, person, roomId)).general.discussionId;
    unwrap(await setPresence(world, person, roomId));
    const before = world.castChecks.length;
    // Opening, reloading and renewing presence never queue starters.
    await memberView(world, person, roomId);
    unwrap(await setPresence(world, person, roomId));
    expect(world.castChecks).toHaveLength(before);
    unwrap(await say(world, person, roomId, general, 'yooo'));
    const check = world.castChecks.at(-1)!;
    expect(check.job.trigger).toBe('conversation_starter');
    return { roomId, person, other, general, check };
  }
  type Room = Awaited<ReturnType<typeof greeting>>;
  const turns = (room: Room) =>
    world.db.selectFrom('rooms.ai_turns').selectAll().where('room_id', '=', room.roomId).execute();
  const aiMessages = async (room: Room, person = room.person) => {
    const read = await readDiscussion(world, person, room.roomId, room.general);
    if (read.status !== 'ready') throw new Error('expected ready');
    return read.messages.filter((message) => message.status === 'available' && message.author.kind === 'ai');
  };
  const model = () =>
    fixtureModel(
      () => ({ kind: 'success', text: JSON.stringify({ kind: 'explanation', text: starterText, cites: ['e1'] }) }),
      { label: 'CI starter fixture' },
    );
  async function due(room: Room) {
    world.clock.now = room.check.startAfter!;
    await world.decide()(room.check.job);
  }

  it('deduplicates the existing job, checks the answer, persists it and applies Off/Quieter', async () => {
    const room = await greeting();
    await due(room);
    const before = world.castPasses.length;
    await world.decide()(room.check.job);
    expect(world.castPasses).toHaveLength(before);
    const fixture = model();
    const { harness, withScope } = roomScope(world.db, fixture);
    const job = world.castPasses.at(-1)!.job;
    await world.pass(harness, withScope)(job);
    await world.pass(harness, withScope)(job);
    expect(fixture.calls).toHaveLength(1); // The support adapter is a separate labelled fixture in this suite.
    expect(await turns(room)).toMatchObject([
      { trigger: 'conversation_starter', state: 'completed', answer_support: { result: 'cleared' } },
    ]);
    expect(await aiMessages(room)).toHaveLength(1);
    unwrap(await setPreferences(world, room.person, room.roomId, { aiLevel: 'quieter' }));
    expect(await aiMessages(room)).toMatchObject([{ folded: true }]);
    unwrap(await setPreferences(world, room.person, room.roomId, { aiLevel: 'off' }));
    expect(await aiMessages(room)).toEqual([]);
    // Twelve quiet hours are enough to consider it, but not to earn another opportunity within 24 hours.
    world.clock.now = new Date(START.getTime() + 13 * HOUR);
    unwrap(await say(world, room.other, room.roomId, room.general, 'hello'));
    const next = world.castChecks.at(-1)!;
    world.clock.now = next.startAfter!;
    await world.decide()(next.job);
    expect((await turns(room)).at(-1)).toMatchObject({ state: 'refused', decided_by: 'room_day' });
  });

  it.each(['before routing', 'while queued', 'while generating'] as const)(
    'suppresses an obsolete starter when a human answers %s',
    async (when) => {
      const room = await greeting();
      if (when !== 'before routing') await due(room);
      const fixture =
        when === 'while generating'
          ? fixtureModel(
              async () => {
                unwrap(await say(world, room.other, room.roomId, room.general, 'Welcome! What are you curious about?'));
                return {
                  kind: 'success',
                  text: JSON.stringify({ kind: 'explanation', text: starterText, cites: ['e1'] }),
                };
              },
              { label: 'CI human answers during provider wait' },
            )
          : model();
      if (when !== 'while generating') unwrap(await say(world, room.other, room.roomId, room.general, 'Welcome!'));
      if (when === 'before routing') await due(room);
      else {
        const { harness, withScope } = roomScope(world.db, fixture);
        await world.pass(harness, withScope)(world.castPasses.at(-1)!.job);
      }
      expect(await aiMessages(room)).toEqual([]);
      expect(fixture.calls).toHaveLength(when === 'while generating' ? 1 : 0);
    },
  );

  it.each(['keep-out', 'all off', 'budget unavailable'] as const)('stays quiet with %s', async (reason) => {
    const room = await greeting();
    if (reason === 'keep-out') unwrap(await setPreferences(world, room.person, room.roomId, { keepOut: true }));
    if (reason === 'all off')
      for (const person of [room.person, room.other])
        unwrap(await setPreferences(world, person, room.roomId, { aiLevel: 'off' }));
    const before = world.castPasses.length;
    await due(room);
    const fixture = model();
    if (world.castPasses.length > before) {
      const settings = {
        ...fixtureSettings,
        caps: { ...fixtureSettings.caps, scope: { requestsPerDay: 0, tokensPerDay: 0 } },
      };
      const { harness, withScope } = roomScope(world.db, fixture, settings);
      await world.pass(harness, withScope)(world.castPasses.at(-1)!.job);
    }
    expect(fixture.calls).toHaveLength(0);
    expect(await aiMessages(room)).toEqual([]);
  });

  it('stays quiet when a person is still typing after the bounded holds', async () => {
    const room = await greeting();
    await due(room);
    const fixture = model();
    const { harness, withScope } = roomScope(world.db, fixture);
    const original = world.castPasses.at(-1)!.job;
    for (let round = 0; round <= 3; round++) {
      await holdCast(
        world.db,
        () => world.clock.now,
      )({ accountId: room.person.accountId, roomId: room.roomId, discussionId: room.general });
      await world.pass(harness, withScope)({ ...original, round });
    }
    expect(fixture.calls).toHaveLength(1);
    expect(await aiMessages(room)).toEqual([]);
    expect(await turns(room)).toMatchObject([{ state: 'failed', dispatched: true }]);
  });
});
