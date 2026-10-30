/**
 * The room as a place (v3 R-1, D-062, D-069) over real PostgreSQL and the real use cases: General in every room,
 * who is here (faces always, a number only from three, never an AI, a blocked person masked), the member's own AI
 * level, keep-out switch and notice mark, and the room hints. The asked-turn path runs over the CI fixture model
 * and the real reasoning harness: no provider output.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOM_PRESENCE_LEASE_MS, type RoomView } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { seedRooms } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel, protectedRequestsOf } from '../support/fixture-model.js';
import {
  ask,
  befriend,
  joinRoom,
  joined,
  libraryRoomSeeds,
  makeModerator,
  memberView,
  roomWorld,
  say,
  seedRoom,
  setPreferences,
  setPresence,
  startTopic,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, seedFriend, type Friend } from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';

const version = 'rooms.v1' as const;
type Member = Extract<RoomView, { status: 'member' }>;

describe('the room as a place (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_campfire');
    world = await roomWorld(database);
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const at = (iso: string) => {
    world.clock.now = new Date(iso);
  };
  const start = '2026-10-24T08:00:00Z';
  const refusal = (result: { kind: 'ok' | 'refused'; code?: string }) =>
    result.kind === 'refused' ? result.code : 'ok';

  describe('General', () => {
    it('is in every room as an empty discussion, is where a member lands, and is not one of the topics', async () => {
      at(start);
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const view = await memberView(world, asha!, roomId);
      expect(view.general).toMatchObject({ kind: 'general', title: 'General', pinned: false });
      expect(view.general.startedBy).toBeUndefined();
      expect(view.discussions).toEqual([]);
      // A topic started later is a topic and General stays apart from it.
      const topicId = await startTopic(world, asha!, roomId, 'Does batching help?');
      const after = await memberView(world, asha!, roomId);
      expect(after.discussions.map((discussion) => [discussion.discussionId, discussion.kind])).toEqual([
        [topicId, 'topic'],
      ]);
      expect(after.general.discussionId).toBe(view.general.discussionId);
    });

    it('is restored by seeding for a room that has none, and the schema allows only one', async () => {
      const { roomId, slug } = await seedRoom(world);
      await world.db.deleteFrom('rooms.discussions').where('room_id', '=', roomId).execute();
      await seedRooms(world.db, [{ ...libraryRoomSeeds()[0]!, slug }], world.clock.now);
      const generals = await world.db
        .selectFrom('rooms.discussions')
        .select('discussion_id')
        .where('room_id', '=', roomId)
        .where('kind', '=', 'general')
        .execute();
      expect(generals).toHaveLength(1);
      await expect(
        world.db
          .insertInto('rooms.discussions')
          .values({
            discussion_id: randomUUID(),
            room_id: roomId,
            kind: 'general',
            title: 'General',
            last_activity_at: world.clock.now,
            created_at: world.clock.now,
          })
          .execute(),
      ).rejects.toThrow(/discussions_one_general/);
    });

    it('cannot be pinned: a pin would only hide it behind itself', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const view = await memberView(world, moderator, roomId);
      const pinned = await world.rooms.pin(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        discussionId: view.general.discussionId,
        pinned: true,
      });
      expect(refusal(pinned)).toBe('unavailable');
    });

    it('takes a person’s messages like any discussion', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const view = await memberView(world, asha!, roomId);
      unwrap(await say(world, asha!, roomId, view.general.discussionId, 'Hello General'));
      const after = await memberView(world, asha!, roomId);
      expect(after.lastMessageAt).toBe(world.clock.now.toISOString());
    });
  });

  describe('who is here', () => {
    /** A room with people who have all joined; nobody has opened it yet. */
    async function room(count: number) {
      at(start);
      const { roomId, slug } = await seedRoom(world);
      const people = await joined(world, roomId, count);
      return { roomId, slug, people };
    }
    const facesOf = (view: Member) => view.here.faces.map((face) => face.person.displayName);

    it('shows the reader alone and says nothing about numbers when nobody else has the room open', async () => {
      const { roomId, people } = await room(3);
      const view = await memberView(world, people[0]!, roomId);
      expect(view.here.faces).toHaveLength(1);
      expect(view.here.faces[0]).toMatchObject({ you: true });
      expect(view.here).not.toHaveProperty('count');
      // Three members joined, none has the room open: nothing says they are here.
      expect(view.memberTotal).toBe(3);
    });

    it('shows two people as faces with names and no number, and the number from three', async () => {
      const { roomId, people } = await room(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      unwrap(await setPresence(world, asha, roomId));
      unwrap(await setPresence(world, ravi, roomId));
      const two = await memberView(world, asha, roomId);
      expect(two.here.faces.map((face) => face.person.handle).sort()).toEqual(
        [asha.person.handle, ravi.person.handle].sort(),
      );
      expect(two.here.faces[0]).toMatchObject({ you: true });
      expect(JSON.stringify(two.here)).not.toContain('count');

      unwrap(await setPresence(world, kenji, roomId));
      const three = await memberView(world, asha, roomId);
      expect(three.here.faces).toHaveLength(3);
      expect(three.here.count).toBe(3);
      // The same room, read by someone who is not a face's owner, says the same number.
      expect((await memberView(world, kenji, roomId)).here.count).toBe(3);
    });

    it('lets a face lapse after the lease and never counts a person who has not opened the room', async () => {
      const { roomId, people } = await room(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      for (const person of [asha, ravi, kenji]) unwrap(await setPresence(world, person, roomId));
      expect((await memberView(world, asha, roomId)).here.count).toBe(3);

      at('2026-10-24T08:00:30Z');
      unwrap(await setPresence(world, asha, roomId));
      unwrap(await setPresence(world, ravi, roomId));
      // Kenji's lease is 30 s old: still fresh.
      expect((await memberView(world, asha, roomId)).here.count).toBe(3);

      world.clock.now = new Date(Date.parse(start) + ROOM_PRESENCE_LEASE_MS + 1);
      const later = await memberView(world, asha, roomId);
      // Asha and Ravi renewed 31 s ago; Kenji's lease ended.
      expect(facesOf(later)).toHaveLength(2);
      expect(later.here).not.toHaveProperty('count');

      world.clock.now = new Date(Date.parse(start) + 30_000 + ROOM_PRESENCE_LEASE_MS + 1);
      const quiet = await memberView(world, asha, roomId);
      expect(quiet.here.faces).toHaveLength(1);
      expect(quiet.here.faces[0]).toMatchObject({ you: true });
    });

    it('takes a face away at once when the device closes the room or the member leaves', async () => {
      const { roomId, people } = await room(2);
      const [asha, ravi] = people as [Friend, Friend];
      unwrap(await setPresence(world, asha, roomId));
      unwrap(await setPresence(world, ravi, roomId));
      expect((await memberView(world, asha, roomId)).here.faces).toHaveLength(2);
      unwrap(await setPresence(world, ravi, roomId, 'away'));
      expect((await memberView(world, asha, roomId)).here.faces).toHaveLength(1);
      unwrap(await setPresence(world, ravi, roomId));
      expect((await memberView(world, asha, roomId)).here.faces).toHaveLength(2);
      unwrap(await world.rooms.leave(ravi.authority, { version, commandId: randomUUID(), roomId }));
      expect((await memberView(world, asha, roomId)).here.faces).toHaveLength(1);
      const rows = await world.db
        .selectFrom('rooms.room_presence')
        .select('account_id')
        .where('room_id', '=', roomId)
        .where('account_id', '=', ravi.accountId)
        .execute();
      expect(rows).toEqual([]);
    });

    it('accepts presence only from a current member, and one shape for everyone else', async () => {
      const { roomId, people } = await room(1);
      const stranger = await seedFriend(world.db, world.friends);
      expect(refusal(await setPresence(world, stranger, roomId))).toBe('unavailable');
      expect(refusal(await setPresence(world, stranger, randomUUID()))).toBe('unavailable');
      unwrap(await world.rooms.leave(people[0]!.authority, { version, commandId: randomUUID(), roomId }));
      expect(refusal(await setPresence(world, people[0]!, roomId))).toBe('unavailable');
      const rows = await world.db
        .selectFrom('rooms.room_presence')
        .select('account_id')
        .where('room_id', '=', roomId)
        .execute();
      expect(rows).toEqual([]);
    });

    it('never counts or shows the AI cast, however many inhabitants the room has', async () => {
      const { roomId, people } = await room(2);
      const [asha, ravi] = people as [Friend, Friend];
      unwrap(await setPresence(world, asha, roomId));
      unwrap(await setPresence(world, ravi, roomId));
      const view = await memberView(world, asha, roomId);
      expect(view.inhabitants).toHaveLength(2);
      // Two people and two inhabitants: four would be a count, and there is none.
      expect(view.here).not.toHaveProperty('count');
      expect(view.here.faces.every((face) => face.person.kind === 'person')).toBe(true);
    });

    it('masks a blocked person’s face, and the count, for the person who blocked them only', async () => {
      const { roomId, people } = await room(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      for (const person of [asha, ravi, kenji]) unwrap(await setPresence(world, person, roomId));
      unwrap(await friendCommand(world.friends, asha, ravi, 'block'));

      const blocker = await memberView(world, asha, roomId);
      expect(blocker.here.faces.map((face) => face.person.handle)).not.toContain(ravi.person.handle);
      expect(blocker.here.faces).toHaveLength(2);
      // Three people are here, but the blocker is told about two, so there is no number to give Ravi away.
      expect(blocker.here).not.toHaveProperty('count');
      expect(JSON.stringify(blocker.here)).not.toContain(ravi.person.handle);

      // Everyone else, Ravi included, reads the room as before.
      const other = await memberView(world, kenji, roomId);
      expect(other.here.count).toBe(3);
      expect(other.here.faces.map((face) => face.person.handle)).toContain(ravi.person.handle);
      expect((await memberView(world, ravi, roomId)).here.count).toBe(3);

      unwrap(await friendCommand(world.friends, asha, ravi, 'unblock'));
      expect((await memberView(world, asha, roomId)).here.count).toBe(3);
    });
  });

  describe('room hints', () => {
    it('go out when a lease starts or ends and when something is said, name only the room and never repeat for a steady beat', async () => {
      at(start);
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = await joined(world, roomId, 2);
      const general = (await memberView(world, asha!, roomId)).general.discussionId;

      const listener = new pg.Client({ connectionString: database.settings.url });
      await listener.connect();
      const heard: { scope: { kind: string; id: string }; revision: number }[] = [];
      listener.on('notification', (notice) => {
        if (notice.channel === 'ks_scope_changed' && notice.payload !== undefined) {
          const parsed = JSON.parse(notice.payload) as (typeof heard)[number];
          if (parsed.scope.kind === 'room') heard.push(parsed);
        }
      });
      try {
        await listener.query('listen ks_scope_changed');
        const settle = async (count: number) => {
          // pg_notify arrives after commit, on the listener's own connection.
          for (let attempt = 0; attempt < 50 && heard.length < count; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
          await new Promise((resolve) => setTimeout(resolve, 60));
          expect(heard).toHaveLength(count);
        };
        unwrap(await setPresence(world, asha!, roomId));
        await settle(1);
        // A beat inside the lease changes nothing for anyone: no hint.
        world.clock.now = new Date(Date.parse(start) + 25_000);
        unwrap(await setPresence(world, asha!, roomId));
        await settle(1);
        unwrap(await say(world, ravi!, roomId, general, 'Something is said'));
        await settle(2);
        unwrap(await setPresence(world, asha!, roomId, 'away'));
        await settle(3);
        // Closing a room that was not open says nothing.
        unwrap(await setPresence(world, asha!, roomId, 'away'));
        await settle(3);
        expect(heard.every((hint) => hint.scope.id === roomId && Number.isInteger(hint.revision))).toBe(true);
        expect(JSON.stringify(heard)).not.toContain('Something is said');
      } finally {
        await listener.end();
      }
    });
  });

  describe('a member’s own settings', () => {
    it('start at Lively with the AI notice unread, and the notice is read once', async () => {
      at(start);
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      expect((await memberView(world, asha!, roomId)).you).toEqual({ aiLevel: 'lively', keepOut: false });

      const first = unwrap(await setPreferences(world, asha!, roomId, { noticeSeen: true }));
      expect(first.you).toEqual({ aiLevel: 'lively', keepOut: false, noticeSeenAt: world.clock.now.toISOString() });
      // Reading it again later does not move the time it was first read.
      at('2026-10-24T09:00:00Z');
      unwrap(await setPreferences(world, asha!, roomId, { noticeSeen: true }));
      expect((await memberView(world, asha!, roomId)).you.noticeSeenAt).toBe('2026-10-24T08:00:00.000Z');
      at(start);
    });

    it('keep the level and the keep-out choice across leaving and joining again', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      unwrap(await setPreferences(world, asha!, roomId, { aiLevel: 'quieter' }));
      unwrap(await setPreferences(world, asha!, roomId, { keepOut: true, noticeSeen: true }));
      expect((await memberView(world, asha!, roomId)).you).toMatchObject({ aiLevel: 'quieter', keepOut: true });
      unwrap(await world.rooms.leave(asha!.authority, { version, commandId: randomUUID(), roomId }));
      unwrap(await joinRoom(world, asha!, roomId));
      expect((await memberView(world, asha!, roomId)).you).toMatchObject({
        aiLevel: 'quieter',
        keepOut: true,
        noticeSeenAt: expect.any(String) as string,
      });
      unwrap(await setPreferences(world, asha!, roomId, { aiLevel: 'off', keepOut: false }));
      expect((await memberView(world, asha!, roomId)).you).toMatchObject({ aiLevel: 'off', keepOut: false });
    });

    it('are idempotent: a replay answers the first time, the same value again is accepted, another body under the same ID is refused', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const commandId = randomUUID();
      const command = { version, commandId, roomId, aiLevel: 'off' as const };
      const first = unwrap(await world.rooms.setPreferences(asha!.authority, command));
      expect(first.replayed).toBe(false);
      expect(unwrap(await world.rooms.setPreferences(asha!.authority, command))).toMatchObject({ replayed: true });
      expect(unwrap(await setPreferences(world, asha!, roomId, { aiLevel: 'off' })).you.aiLevel).toBe('off');
      const reused = await world.rooms.setPreferences(asha!.authority, { ...command, aiLevel: 'lively' });
      expect(refusal(reused)).toBe('command_key_reused');
      expect((await memberView(world, asha!, roomId)).you.aiLevel).toBe('off');
    });

    it('refuse an empty change, a stranger and a person who left', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const empty = await world.rooms.setPreferences(asha!.authority, { version, commandId: randomUUID(), roomId });
      expect(refusal(empty)).toBe('invalid_input');
      const stranger = await seedFriend(world.db, world.friends);
      expect(refusal(await setPreferences(world, stranger, roomId, { aiLevel: 'off' }))).toBe('unavailable');
      unwrap(await world.rooms.leave(asha!.authority, { version, commandId: randomUUID(), roomId }));
      expect(refusal(await setPreferences(world, asha!, roomId, { keepOut: true }))).toBe('unavailable');
    });

    it('start at Quieter in a room that is not open to everyone', async () => {
      const { roomId, slug } = await seedRoom(world, { joinRule: 'friends_of_members' });
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const friend = await seedFriend(world.db, world.friends);
      await befriend(world.friends, moderator, friend);
      unwrap(await joinRoom(world, friend, roomId));
      expect((await memberView(world, friend, roomId)).you.aiLevel).toBe('quieter');
    });
  });

  describe('keeping messages out of what AI reads', () => {
    const answer = JSON.stringify({ kind: 'explanation', text: 'Batching groups requests so hardware stays busy.' });

    async function conversation() {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const discussionId = await startTopic(world, asha, roomId, 'Does batching always help?');
      return { roomId, asha, ravi, discussionId };
    }

    async function askAndRun(person: Friend, roomId: string, discussionId: string) {
      const model = fixtureModel(() => ({ kind: 'success', text: answer }), { label: 'rooms-keep-out' });
      const { harness } = fixtureHarness(database.db, { model });
      const before = world.queued.length;
      unwrap(await ask(world, person, roomId, discussionId, 'explainer'));
      await world.contribute(harness)(world.queued[before]!);
      return model;
    }

    it('never sends a keep-out member’s words to the model, nor stores them in the request, and still sends everyone else’s', async () => {
      const { roomId, asha, ravi, discussionId } = await conversation();
      unwrap(await say(world, asha, roomId, discussionId, 'ASHA-WORDS-VISIBLE batching helps throughput'));
      unwrap(await say(world, ravi, roomId, discussionId, 'RAVI-SECRET-WORDS my own numbers'));
      unwrap(await setPreferences(world, ravi, roomId, { keepOut: true }));

      const model = await askAndRun(asha, roomId, discussionId);
      const sent = model.calls[0]!.request.user;
      expect(sent).not.toContain('RAVI-SECRET-WORDS');
      expect(sent).toContain('ASHA-WORDS-VISIBLE');
      expect(sent).toContain("[a member's message]");
      // The stored request is the bytes the harness kept for the call: the same holds there.
      const stored = (await protectedRequestsOf(world.db, asha.universeId)).map((row) =>
        Buffer.from(row.body).toString(),
      );
      expect(stored.length).toBeGreaterThan(0);
      for (const body of stored) {
        expect(body).not.toContain('RAVI-SECRET-WORDS');
        expect(body).toContain("[a member's message]");
      }
    });

    it('keeps a member’s own words out when they are the one who asks, and brings them back when they turn it off', async () => {
      const { roomId, asha, ravi, discussionId } = await conversation();
      unwrap(await say(world, asha, roomId, discussionId, 'ASHA-OWN-WORDS asked about batching'));
      unwrap(await setPreferences(world, asha, roomId, { keepOut: true }));
      const kept = await askAndRun(asha, roomId, discussionId);
      expect(kept.calls[0]!.request.user).not.toContain('ASHA-OWN-WORDS');

      unwrap(await setPreferences(world, asha, roomId, { keepOut: false }));
      const shown = await askAndRun(ravi, roomId, discussionId);
      expect(shown.calls[0]!.request.user).toContain('ASHA-OWN-WORDS');
    });

    it('hides what a keep-out member shared too: the card’s title and their note are not read', async () => {
      const { roomId, asha, ravi, discussionId } = await conversation();
      const reel = await seedReel(world.db, { title: 'KEPT-OUT-REEL-TITLE' });
      unwrap(
        await world.rooms.send(ravi.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          discussionId,
          body: {
            kind: 'content',
            target: { assetId: reel.assetId, assetRevision: 1 },
            note: 'RAVI-NOTE-ON-CARD',
          },
        }),
      );
      unwrap(await setPreferences(world, ravi, roomId, { keepOut: true }));
      const model = await askAndRun(asha, roomId, discussionId);
      const sent = model.calls[0]!.request.user;
      expect(sent).not.toContain('KEPT-OUT-REEL-TITLE');
      expect(sent).not.toContain('RAVI-NOTE-ON-CARD');
    });
  });
});
