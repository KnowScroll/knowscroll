/** Idea rooms over real PostgreSQL: membership and access, discussions, moderation, isolation from friend threads. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscussionView, RoomView } from '@knowscroll/contracts';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { seedRooms, setRoomModerator } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  ask,
  befriend,
  joinRoom,
  joined,
  libraryRoomSeeds,
  makeModerator,
  readDiscussion,
  roomWorld,
  say,
  seedRoom,
  startTopic,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { consumptionRows, friendCommand, seedContent, seedFriend, withdraw, type Friend } from '../support/talk.js';
import { seedPerson } from '../support/fixtures.js';
import { addReelRevision, seedReel } from '../support/thread-fixtures.js';

const version = 'rooms.v1' as const;

describe('idea rooms (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms');
    world = await roomWorld(database);
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const readRoom = async (person: { authority: Friend['authority'] }, roomId: string): Promise<RoomView> =>
    unwrap(await world.rooms.read(person.authority, { version, readId: randomUUID(), roomId }));

  const send = (person: Friend, roomId: string, discussionId: string, body: object) =>
    world.rooms.send(person.authority, { version, commandId: randomUUID(), roomId, discussionId, body });

  describe('the seeded rooms', () => {
    it('are one room for each library system, with nobody in them and nothing said', async () => {
      const seeds = libraryRoomSeeds();
      const systems = CONCEPTS.filter((concept) => concept.parent === null).map((concept) => concept.id);
      expect(seeds.map((seed) => seed.topic.id).sort()).toEqual([...systems].sort());
      const first = await seedRooms(world.db, seeds, world.clock.now);
      expect(first.created).toHaveLength(seeds.length);
      expect((await seedRooms(world.db, seeds, world.clock.now)).created).toEqual([]);

      const seeded = await world.db
        .selectFrom('rooms.rooms')
        .select('room_id')
        .where(
          'slug',
          'in',
          seeds.map((seed) => seed.slug),
        )
        .execute();
      expect(seeded).toHaveLength(seeds.length);
      const roomIds = seeded.map((row) => row.room_id);
      for (const table of ['members', 'invitations', 'ai_turns'] as const) {
        const rows = await world.db
          .selectFrom(`rooms.${table}`)
          .select('room_id')
          .where('room_id', 'in', roomIds)
          .execute();
        expect(rows, table).toEqual([]);
      }
      // The only thing a seeded room holds besides itself is an empty General with no starter.
      const discussions = await world.db
        .selectFrom('rooms.discussions')
        .select(['discussion_id', 'kind', 'title', 'started_by_account_id', 'last_sequence'])
        .where('room_id', 'in', roomIds)
        .execute();
      expect(discussions).toHaveLength(seeds.length);
      for (const discussion of discussions)
        expect(discussion).toMatchObject({ kind: 'general', title: 'General', started_by_account_id: null });
      expect(discussions.map((discussion) => Number(discussion.last_sequence))).toEqual(discussions.map(() => 0));
    });

    it('label their AI inhabitants and give a visitor no member, activity or online count', async () => {
      const { roomId } = await seedRoom(world);
      const stranger = await seedFriend(world.db, world.friends);
      const view = await readRoom(stranger, roomId);
      if (view.status !== 'preview') throw new Error('expected a preview');
      expect(view.inhabitants).toEqual([
        { inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' },
        { inhabitant: 'skeptic', name: 'Halley', label: 'AI · Skeptic', blurb: 'Pushes back on claims' },
      ]);
      expect(view.hasModerator).toBe(false);
      expect(JSON.stringify(view)).not.toMatch(/memberCount|"members"|online|activity/i);
      expect(view.join).toEqual({ allowed: true });
    });
  });

  describe('membership and access', () => {
    it('lets a person join an open room, read it, and leave it again', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const member = await readRoom(asha!, roomId);
      expect(member).toMatchObject({ status: 'member', role: 'member', canPost: true, discussions: [] });
      const left = await world.rooms.leave(asha!.authority, { version, commandId: randomUUID(), roomId });
      expect(left.kind).toBe('ok');
      expect((await readRoom(asha!, roomId)).status).toBe('preview');
      // Joining again is allowed when the rule allows it.
      expect((await joinRoom(world, asha!, roomId)).kind).toBe('ok');
    });

    it('replays a join with the same command, so a lost answer costs nothing', async () => {
      const { roomId } = await seedRoom(world);
      const person = await seedFriend(world.db, world.friends);
      const commandId = randomUUID();
      const joinedOnce = unwrap(await world.rooms.join(person.authority, { version, commandId, roomId }));
      const again = unwrap(await world.rooms.join(person.authority, { version, commandId, roomId }));
      expect(again).toMatchObject({ replayed: true, roomId });
      expect(again.recordedAt).toBe(joinedOnce.recordedAt);
      // A new command by someone who is already in is refused, not applied twice.
      expect((await joinRoom(world, person, roomId)).kind).toBe('refused');
    });

    it('answers a stranger, a missing room and a left member with the same shapes', async () => {
      const { roomId } = await seedRoom(world);
      const [member, other] = await joined(world, roomId, 2);
      const discussionId = await startTopic(world, member!, roomId);
      const outsider = await seedFriend(world.db, world.friends);
      const read = async (person: Friend) =>
        unwrap(
          await world.rooms.readDiscussion(person.authority, {
            version,
            readId: randomUUID(),
            roomId,
            discussionId,
            limit: 20,
          }),
        );
      expect((await read(outsider)).status).toBe('unavailable');
      expect((await send(outsider, roomId, discussionId, { kind: 'text', text: 'hello' })).kind).toBe('refused');
      expect((await readRoom(outsider, randomUUID())).status).toBe('unavailable');
      await world.rooms.leave(other!.authority, { version, commandId: randomUUID(), roomId });
      expect((await read(other!)).status).toBe('unavailable');
    });

    it('needs a sharing profile to join, and says so', async () => {
      const { roomId } = await seedRoom(world);
      const unnamed = await seedPerson(world.db);
      const view = await readRoom(unnamed, roomId);
      expect(view).toMatchObject({ status: 'preview', join: { allowed: false, reason: 'profile_needed' } });
      expect((await world.rooms.join(unnamed.authority, { version, commandId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
    });

    it('lets a member invite a friend into an invite-only room, and nobody else in', async () => {
      const { roomId, slug } = await seedRoom(world, { joinRule: 'invite_only' });
      const founder = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, founder);
      const friend = await seedFriend(world.db, world.friends);
      const stranger = await seedFriend(world.db, world.friends);
      await befriend(world.friends, founder, friend);

      expect(await readRoom(friend, roomId)).toMatchObject({
        status: 'preview',
        join: { allowed: false, reason: 'invite_only' },
      });
      const strangerInvite = await world.rooms.invite(founder.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        friendPersonId: stranger.person.personId,
      });
      expect(strangerInvite.kind).toBe('refused');
      unwrap(
        await world.rooms.invite(founder.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          friendPersonId: friend.person.personId,
        }),
      );
      expect(await readRoom(friend, roomId)).toMatchObject({
        status: 'preview',
        invited: true,
        join: { allowed: true },
      });
      const list = unwrap(await world.rooms.list(friend.authority, { version, readId: randomUUID() }));
      expect(list.items).toMatchObject([{ standing: 'invited', room: { roomId } }]);
      unwrap(await joinRoom(world, friend, roomId));
      expect((await readRoom(friend, roomId)).status).toBe('member');
      expect((await joinRoom(world, stranger, roomId)).kind).toBe('refused');
    });

    it('opens a friends-of-members room to a friend of a member only', async () => {
      const { roomId, slug } = await seedRoom(world, { joinRule: 'friends_of_members' });
      const founder = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, founder);
      const friend = await seedFriend(world.db, world.friends);
      const stranger = await seedFriend(world.db, world.friends);
      await befriend(world.friends, founder, friend);
      expect(await readRoom(stranger, roomId)).toMatchObject({
        join: { allowed: false, reason: 'friend_of_member_needed' },
      });
      expect(await readRoom(friend, roomId)).toMatchObject({ join: { allowed: true } });
      expect((await joinRoom(world, stranger, roomId)).kind).toBe('refused');
      expect((await joinRoom(world, friend, roomId)).kind).toBe('ok');
    });

    it('pauses and resumes a room for a moderator only: members read, nobody posts, nobody joins', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const [member] = await joined(world, roomId, 1);
      const discussionId = await startTopic(world, member!, roomId);
      const outsider = await seedFriend(world.db, world.friends);
      const moderate = (person: Friend, kind: 'pause' | 'resume') =>
        world.rooms.moderate(person.authority, { version, commandId: randomUUID(), roomId, action: { kind } });

      expect((await moderate(member!, 'pause')).kind).toBe('refused');
      unwrap(await moderate(moderator, 'pause'));
      expect(await readRoom(member!, roomId)).toMatchObject({ status: 'member', canPost: false });
      expect((await say(world, member!, roomId, discussionId, 'still there?')).kind).toBe('refused');
      expect((await ask(world, member!, roomId, discussionId)).kind).toBe('refused');
      expect(await readRoom(outsider, roomId)).toMatchObject({ join: { allowed: false, reason: 'paused' } });
      expect((await moderate(moderator, 'pause')).kind).toBe('refused');
      unwrap(await moderate(moderator, 'resume'));
      expect((await say(world, member!, roomId, discussionId, 'back')).kind).toBe('ok');
    });

    it('lets a moderator remove an ordinary member, who cannot read or join again', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const [member, other] = await joined(world, roomId, 2);
      const remove = (actor: Friend, target: Friend) =>
        world.rooms.moderate(actor.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          action: { kind: 'remove_member', personId: target.person.personId },
        });
      expect((await remove(other!, member!)).kind).toBe('refused');
      expect((await remove(moderator, moderator)).kind).toBe('refused');
      unwrap(await remove(moderator, member!));
      expect(await readRoom(member!, roomId)).toMatchObject({ status: 'preview', join: { reason: 'removed' } });
      expect((await joinRoom(world, member!, roomId)).kind).toBe('refused');
    });

    it('lets members read a closed room but not post, and takes no one new', async () => {
      const { roomId } = await seedRoom(world);
      const [member] = await joined(world, roomId, 1);
      const discussionId = await startTopic(world, member!, roomId);
      await world.db.updateTable('rooms.rooms').set({ status: 'closed' }).where('room_id', '=', roomId).execute();
      expect(await readRoom(member!, roomId)).toMatchObject({ status: 'member', canPost: false });
      expect((await say(world, member!, roomId, discussionId, 'hello')).kind).toBe('refused');
      const outsider = await seedFriend(world.db, world.friends);
      expect(await readRoom(outsider, roomId)).toMatchObject({ join: { allowed: false, reason: 'closed' } });
    });
  });

  describe('discussions and messages', () => {
    it('starts a plain discussion, lets members talk, and pages through history and changes', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = await joined(world, roomId, 2);
      const discussionId = await startTopic(world, asha!, roomId, 'When does batching stop helping?');
      for (let index = 1; index <= 5; index++)
        unwrap(await say(world, index % 2 === 0 ? asha! : ravi!, roomId, discussionId, `message ${String(index)}`));

      const view = await readDiscussion(world, ravi!, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(view.discussion.title).toBe('When does batching stop helping?');
      expect(view.content).toBeUndefined();

      const small = unwrap(
        await world.rooms.readDiscussion(ravi!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId,
          limit: 2,
        }),
      );
      if (small.status !== 'ready' || small.history.kind !== 'more') throw new Error('expected more history');
      expect(small.messages.map((message) => message.sequence)).toEqual([4, 5]);
      const older = unwrap(
        await world.rooms.history(ravi!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId,
          limit: 10,
          cursor: small.history.cursor,
        }),
      );
      if (older.status !== 'ready') throw new Error('expected a page');
      expect(older.messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
      expect(older.continuation.kind).toBe('end');

      unwrap(await say(world, asha!, roomId, discussionId, 'one more'));
      const changes = unwrap(
        await world.rooms.changes(ravi!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId,
          limit: 10,
          cursor: view.catchUpCursor,
        }),
      );
      if (changes.status !== 'ready') throw new Error('expected changes');
      expect(changes.changes.map((change) => change.message.sequence)).toEqual([6]);
      expect(changes.continuation.kind).toBe('caught_up');
    });

    it('treats a cursor of another discussion as stale and never substitutes a first page', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const first = await startTopic(world, asha!, roomId, 'First');
      const second = await startTopic(world, asha!, roomId, 'Second');
      const view = await readDiscussion(world, asha!, roomId, first);
      if (view.status !== 'ready') throw new Error('expected ready');
      const stale = unwrap(
        await world.rooms.changes(asha!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId: second,
          limit: 10,
          cursor: view.catchUpCursor,
        }),
      );
      expect(stale.status).toBe('refresh_required');
    });

    it('retries a send safely: the same command is one message, another body under it is refused', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const discussionId = await startTopic(world, asha!, roomId);
      const commandId = randomUUID();
      const body = { kind: 'text', text: 'once' };
      const command = { version, commandId, roomId, discussionId, body };
      const first = unwrap(await world.rooms.send(asha!.authority, command));
      const second = unwrap(await world.rooms.send(asha!.authority, command));
      expect(second).toMatchObject({ replayed: true, messageId: first.messageId });
      const changed = await world.rooms.send(asha!.authority, {
        ...command,
        body: { kind: 'text', text: 'twice' },
      });
      expect(changed.kind === 'refused' ? changed.code : 'ok').toBe('command_key_reused');
      const view = await readDiscussion(world, asha!, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages).toHaveLength(1);
    });

    it('starts a content thread from shared content and from a card in a discussion, and adds no evidence', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = await joined(world, roomId, 2);
      const reel = await seedReel(world.db, { durationMs: 40_000, title: 'What one answer costs' });
      const before = await consumptionRows(world.db);

      const content = unwrap(
        await world.rooms.create(asha!.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: { kind: 'content', root: { assetId: reel.assetId, assetRevision: 1 } },
        }),
      );
      const rooted = await readDiscussion(world, ravi!, roomId, content.discussionId);
      if (rooted.status !== 'ready' || rooted.content === undefined) throw new Error('expected a content thread');
      expect(rooted.discussion.title).toBe('What one answer costs');
      expect(rooted.content.root).toMatchObject({ status: 'available', target: { assetId: reel.assetId } });
      expect(rooted.content.episodes).toMatchObject([{ assetId: reel.assetId, state: 'ready', visited: false }]);

      const talk = await startTopic(world, ravi!, roomId, 'Cards');
      const card = unwrap(
        await send(ravi!, roomId, talk, {
          kind: 'content',
          target: { assetId: reel.assetId, assetRevision: 1 },
          note: 'look',
        }),
      );
      const fromCard = unwrap(
        await world.rooms.create(asha!.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: { kind: 'message', discussionId: talk, messageId: card.messageId, title: 'This one' },
        }),
      );
      const thread = await readDiscussion(world, asha!, roomId, fromCard.discussionId);
      if (thread.status !== 'ready') throw new Error('expected ready');
      expect(thread.discussion.title).toBe('This one');
      expect(thread.content?.root).toMatchObject({ target: { assetId: reel.assetId } });
      // Starting a thread, sharing a card and talking about it are conversation, never consumption.
      expect(await consumptionRows(world.db)).toBe(before);
    });

    it('refuses a root that is not the current admitted revision', async () => {
      const { roomId } = await seedRoom(world);
      const [asha] = await joined(world, roomId, 1);
      const withdrawn = await seedContent(world.db, { title: 'Gone' });
      await withdraw(world.db, withdrawn.assetId);
      const refused = await world.rooms.create(asha!.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        start: { kind: 'content', root: { assetId: withdrawn.assetId, assetRevision: 1 } },
      });
      expect(refused.kind).toBe('refused');
    });

    it('shares a Reel moment inside a content thread and opens it, and refuses a moment of other content', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = await joined(world, roomId, 2);
      const reel = await seedReel(world.db, { durationMs: 40_000, title: 'Tokens' });
      const other = await seedReel(world.db, { durationMs: 40_000, title: 'Elsewhere' });
      const started = unwrap(
        await world.rooms.create(asha!.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: { kind: 'content', root: { assetId: reel.assetId, assetRevision: 1 } },
        }),
      );
      const moment = (target: string, startMs: number, endMs: number) => ({
        kind: 'snippet',
        target: { assetId: target, assetRevision: 1 },
        anchor: { kind: 'reel_range', startMs, endMs },
        note: 'this bit',
      });
      const sent = unwrap(await send(asha!, roomId, started.discussionId, moment(reel.assetId, 12_000, 24_000)));
      expect((await send(asha!, roomId, started.discussionId, moment(reel.assetId, 30_000, 50_000))).kind).toBe(
        'refused',
      );
      expect((await send(asha!, roomId, started.discussionId, moment(other.assetId, 1_000, 5_000))).kind).toBe(
        'refused',
      );
      const view = await readDiscussion(world, ravi!, roomId, started.discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages[0]).toMatchObject({
        body: { kind: 'snippet', snippet: { kind: 'reel_range', startMs: 12_000, endMs: 24_000 } },
      });
      const open = unwrap(
        await world.rooms.openSnippet(ravi!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId: started.discussionId,
          messageId: sent.messageId,
        }),
      );
      expect(open).toMatchObject({ status: 'ready', anchor: { kind: 'reel_range', startMs: 12_000, endMs: 24_000 } });
      // A corrected Reel is never played at the old range.
      await addReelRevision(world.db, reel.assetId, 2, { durationMs: 40_000, title: 'Tokens v2' });
      const changed = unwrap(
        await world.rooms.openSnippet(ravi!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId: started.discussionId,
          messageId: sent.messageId,
        }),
      );
      expect(changed.status).toBe('changed');
    });

    it('marks only the reader’s own visited episodes', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = await joined(world, roomId, 2);
      const reel = await seedReel(world.db, { title: 'Visited' });
      const started = unwrap(
        await world.rooms.create(asha!.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: { kind: 'content', root: { assetId: reel.assetId, assetRevision: 1 } },
        }),
      );
      const { activateFor } = await import('../support/thread-fixtures.js');
      await activateFor(world.db, asha!, reel.assetId, 'reel');
      const episodes = async (person: Friend): Promise<DiscussionView> =>
        readDiscussion(world, person, roomId, started.discussionId);
      const ashaView = await episodes(asha!);
      const raviView = await episodes(ravi!);
      if (ashaView.status !== 'ready' || raviView.status !== 'ready') throw new Error('expected ready');
      expect(ashaView.content?.episodes[0]?.visited).toBe(true);
      expect(raviView.content?.episodes[0]?.visited).toBe(false);
    });
  });

  describe('moderation', () => {
    it('lets only a moderator pin, shows a pinned discussion first, and changes nobody’s universe', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const [member] = await joined(world, roomId, 1);
      const quiet = await startTopic(world, member!, roomId, 'Quiet');
      const wanted = await startTopic(world, member!, roomId, 'Pin me');
      await startTopic(world, member!, roomId, 'Newest');
      const pin = (person: Friend, pinned: boolean) =>
        world.rooms.pin(person.authority, { version, commandId: randomUUID(), roomId, discussionId: wanted, pinned });
      const before = await consumptionRows(world.db);

      expect((await pin(member!, true)).kind).toBe('refused');
      unwrap(await pin(moderator, true));
      const view = await readRoom(member!, roomId);
      if (view.status !== 'member') throw new Error('expected member');
      expect(view.discussions[0]).toMatchObject({ discussionId: wanted, pinned: true });
      expect(view.hasModerator).toBe(true);
      const outsider = await seedFriend(world.db, world.friends);
      expect(await readRoom(outsider, roomId)).toMatchObject({ pinned: 'Pin me' });
      unwrap(await pin(moderator, false));
      const after = await readRoom(member!, roomId);
      if (after.status !== 'member') throw new Error('expected member');
      expect(after.discussions.map((discussion) => discussion.discussionId)).toContain(quiet);
      expect(after.discussions.every((discussion) => !discussion.pinned)).toBe(true);
      expect(await consumptionRows(world.db)).toBe(before);
    });

    it('hides a message with its place kept, shows it to catch-up as removed, and can restore it', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const [member, reader] = await joined(world, roomId, 2);
      const discussionId = await startTopic(world, member!, roomId);
      unwrap(await say(world, member!, roomId, discussionId, 'fine'));
      const bad = unwrap(await say(world, member!, roomId, discussionId, 'not fine'));
      const view = await readDiscussion(world, reader!, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      const hide = (person: Friend, hidden: boolean) =>
        world.rooms.hideMessage(person.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          discussionId,
          messageId: bad.messageId,
          hidden,
        });

      expect((await hide(reader!, true)).kind).toBe('refused');
      unwrap(await hide(moderator, true));
      const changes = unwrap(
        await world.rooms.changes(reader!.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId,
          limit: 10,
          cursor: view.catchUpCursor,
        }),
      );
      if (changes.status !== 'ready') throw new Error('expected changes');
      expect(changes.changes).toMatchObject([
        { message: { status: 'removed', messageId: bad.messageId, sequence: 2 } },
      ]);
      const hidden = await readDiscussion(world, reader!, roomId, discussionId);
      if (hidden.status !== 'ready') throw new Error('expected ready');
      expect(hidden.messages.map((message) => message.status)).toEqual(['available', 'removed']);
      expect(JSON.stringify(hidden)).not.toContain('not fine');
      unwrap(await hide(moderator, false));
      const restored = await readDiscussion(world, reader!, roomId, discussionId);
      if (restored.status !== 'ready') throw new Error('expected ready');
      expect(restored.messages.map((message) => message.status)).toEqual(['available', 'available']);
    });
  });

  describe('isolation from friend threads', () => {
    it('never mixes a friend thread into a room, or a room discussion into a friend thread', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = await joined(world, roomId, 2);
      await befriend(world.friends, asha!, ravi!);
      const reel = await seedReel(world.db, { title: 'Shared privately' });
      const privateThread = unwrap(
        await world.threads.create(asha!.authority, {
          version: 'content-thread.v1',
          commandId: randomUUID(),
          root: { assetId: reel.assetId, assetRevision: 1 },
          friendPersonIds: [ravi!.person.personId],
        }),
      );
      unwrap(
        await world.threads.send(asha!.authority, {
          version: 'content-thread.v1',
          commandId: randomUUID(),
          thread: privateThread.thread,
          body: { kind: 'text', text: 'PRIVATE-FRIEND-WORDS' },
        }),
      );

      const discussionId = await startTopic(world, asha!, roomId);
      unwrap(await say(world, asha!, roomId, discussionId, 'public room words'));
      // The friend thread's ID is nothing to the room, and a room discussion ID is nothing to the friend thread.
      const asDiscussion = await readDiscussion(world, ravi!, roomId, privateThread.thread.threadId);
      expect(asDiscussion.status).toBe('unavailable');
      const asThread = unwrap(
        await world.threads.read(asha!.authority, {
          version: 'content-thread.v1',
          readId: randomUUID(),
          thread: { threadId: discussionId, membershipId: randomUUID(), membershipRevision: 1 },
          limit: 10,
        }),
      );
      expect(asThread.status).toBe('unavailable');
      const room = await readRoom(ravi!, roomId);
      expect(JSON.stringify(room)).not.toContain('PRIVATE-FRIEND-WORDS');
      const view = await readDiscussion(world, ravi!, roomId, discussionId);
      expect(JSON.stringify(view)).not.toContain('PRIVATE-FRIEND-WORDS');
    });
  });
  describe('the moderator role and the operator’s control', () => {
    const roleOf = async (roomId: string, person: Friend) =>
      world.db
        .selectFrom('rooms.members')
        .select(['role', 'ended_at', 'ended_by'])
        .where('room_id', '=', roomId)
        .where('account_id', '=', person.accountId)
        .executeTakeFirstOrThrow();

    it('does not keep the role when a moderator leaves and comes back: it is the operator’s to give again', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      unwrap(await joinRoom(world, moderator, roomId));
      await makeModerator(world, slug, moderator);
      unwrap(await world.rooms.leave(moderator.authority, { version, commandId: randomUUID(), roomId }));
      expect(await roleOf(roomId, moderator)).toMatchObject({ role: 'member', ended_by: 'left' });
      expect(unwrap(await joinRoom(world, moderator, roomId)).role).toBe('member');
      expect(await readRoom(moderator, roomId)).toMatchObject({ status: 'member', role: 'member' });
      await makeModerator(world, slug, moderator);
      expect(await readRoom(moderator, roomId)).toMatchObject({ role: 'moderator' });
    });

    it('takes the role back only from a current member, and never brings back someone who left', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      unwrap(await joinRoom(world, moderator, roomId));
      await makeModerator(world, slug, moderator);
      const take = () =>
        setRoomModerator(world.db, { slug, accountId: moderator.accountId, moderator: false, now: world.clock.now });
      unwrap(await world.rooms.leave(moderator.authority, { version, commandId: randomUUID(), roomId }));
      expect(await take()).toBe('not_a_member');
      expect(await roleOf(roomId, moderator)).toMatchObject({ ended_by: 'left' });
      expect(await readRoom(moderator, roomId)).toMatchObject({ status: 'preview' });

      unwrap(await joinRoom(world, moderator, roomId));
      await makeModerator(world, slug, moderator);
      expect(await take()).toBe('removed');
      expect(await roleOf(roomId, moderator)).toMatchObject({ role: 'member', ended_at: null });
    });

    it('names only a person with a claimed profile, and does not undo a moderator’s removal', async () => {
      const { roomId, slug } = await seedRoom(world);
      const unnamed = await seedPerson(world.db);
      const name = (accountId: string) =>
        setRoomModerator(world.db, { slug, accountId, moderator: true, now: world.clock.now });
      expect(await name(unnamed.accountId)).toBe('profile_needed');
      expect(
        await world.db.selectFrom('rooms.members').select('role').where('account_id', '=', unnamed.accountId).execute(),
      ).toEqual([]);

      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const removed = await seedFriend(world.db, world.friends);
      unwrap(await joinRoom(world, removed, roomId));
      unwrap(
        await world.rooms.moderate(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          action: { kind: 'remove_member', personId: removed.person.personId },
        }),
      );
      expect(await name(removed.accountId)).toBe('removed_from_room');
      expect(await roleOf(roomId, removed)).toMatchObject({ ended_by: 'removed' });
      expect(await name(randomUUID())).toBe('unknown_account');
      expect(
        await setRoomModerator(world.db, {
          slug: 'no-such-room',
          accountId: moderator.accountId,
          moderator: true,
          now: world.clock.now,
        }),
      ).toBe('unknown_room');
    });
  });

  describe('blocks between members', () => {
    it('collapses a blocked person’s words for the person who blocked them, and for no one else', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const discussionId = await startTopic(world, asha, roomId, 'A topic');
      unwrap(await say(world, asha, roomId, discussionId, 'words of Asha'));
      const first = await readDiscussion(world, asha, roomId, discussionId);
      if (first.status !== 'ready') throw new Error('expected ready');
      unwrap(await say(world, ravi, roomId, discussionId, 'BLOCKED-WORDS before'));
      expect(JSON.stringify(await readDiscussion(world, asha, roomId, discussionId))).toContain('BLOCKED-WORDS before');

      unwrap(await friendCommand(world.friends, asha, ravi, 'block'));
      unwrap(await say(world, ravi, roomId, discussionId, 'BLOCKED-WORDS after'));

      const blocker = await readDiscussion(world, asha, roomId, discussionId);
      if (blocker.status !== 'ready') throw new Error('expected ready');
      expect(blocker.messages.map((message) => message.status)).toEqual(['available', 'blocked', 'blocked']);
      expect(JSON.stringify(blocker)).not.toContain('BLOCKED-WORDS');
      expect(JSON.stringify(blocker)).not.toContain(ravi.person.handle);
      // Catch-up shows the same marker, never the words.
      const changes = unwrap(
        await world.rooms.changes(asha.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId,
          limit: 10,
          cursor: first.catchUpCursor,
        }),
      );
      if (changes.status !== 'ready') throw new Error('expected changes');
      expect(changes.changes.map((change) => change.message.status)).toEqual(['blocked', 'blocked']);
      expect(JSON.stringify(changes)).not.toContain('BLOCKED-WORDS');

      // The blocked person and everyone else read the room as before: nothing tells Ravi he was blocked.
      for (const reader of [ravi, moderator]) {
        const view = await readDiscussion(world, reader, roomId, discussionId);
        if (view.status !== 'ready') throw new Error('expected ready');
        expect(view.messages.map((message) => message.status)).toEqual(['available', 'available', 'available']);
      }
      // Unblocking restores the words: a block is a reader's choice, not a change to the room.
      unwrap(await friendCommand(world.friends, asha, ravi, 'unblock'));
      expect(JSON.stringify(await readDiscussion(world, asha, roomId, discussionId))).toContain('BLOCKED-WORDS after');
    });

    it('lets a moderator who blocked an author still moderate them: the words arrive flagged, and can be removed', async () => {
      const { roomId, slug } = await seedRoom(world);
      const moderator = await seedFriend(world.db, world.friends);
      unwrap(await joinRoom(world, moderator, roomId));
      await makeModerator(world, slug, moderator);
      const [member] = (await joined(world, roomId, 1)) as [Friend];
      const discussionId = await startTopic(world, member, roomId, 'A topic');
      const said = unwrap(await say(world, member, roomId, discussionId, 'WORDS TO MODERATE'));
      unwrap(await friendCommand(world.friends, moderator, member, 'block'));

      // A member who blocked them gets a marker; the moderator gets the words, flagged, to review and act on.
      const asModerator = await readDiscussion(world, moderator, roomId, discussionId);
      if (asModerator.status !== 'ready') throw new Error('expected ready');
      expect(asModerator.messages[0]).toMatchObject({
        status: 'available',
        blockedByYou: true,
        body: { text: 'WORDS TO MODERATE' },
      });
      const other = (await joined(world, roomId, 1))[0]!;
      unwrap(await friendCommand(world.friends, other, member, 'block'));
      const asMember = await readDiscussion(world, other, roomId, discussionId);
      if (asMember.status !== 'ready') throw new Error('expected ready');
      expect(asMember.messages[0]).toMatchObject({ status: 'blocked' });
      expect(JSON.stringify(asMember)).not.toContain('WORDS TO MODERATE');
      // Unblocked readers see no flag at all.
      const stranger = (await joined(world, roomId, 1))[0]!;
      expect(JSON.stringify(await readDiscussion(world, stranger, roomId, discussionId))).not.toContain('blockedByYou');

      unwrap(
        await world.rooms.hideMessage(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          discussionId,
          messageId: said.messageId,
          hidden: true,
        }),
      );
      const after = await readDiscussion(world, moderator, roomId, discussionId);
      if (after.status !== 'ready') throw new Error('expected ready');
      expect(after.messages[0]).toMatchObject({ status: 'removed' });
    });

    it('does not open a moment a blocked person shared', async () => {
      const { roomId } = await seedRoom(world);
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const reel = await seedReel(world.db, { durationMs: 40_000, title: 'Tokens' });
      const started = unwrap(
        await world.rooms.create(asha.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          start: { kind: 'content', root: { assetId: reel.assetId, assetRevision: 1 } },
        }),
      );
      const sent = unwrap(
        await send(ravi, roomId, started.discussionId, {
          kind: 'snippet',
          target: { assetId: reel.assetId, assetRevision: 1 },
          anchor: { kind: 'reel_range', startMs: 5_000, endMs: 15_000 },
        }),
      );
      const open = () =>
        world.rooms.openSnippet(asha.authority, {
          version,
          readId: randomUUID(),
          roomId,
          discussionId: started.discussionId,
          messageId: sent.messageId,
        });
      expect(unwrap(await open())).toMatchObject({ status: 'ready' });
      unwrap(await friendCommand(world.friends, asha, ravi, 'block'));
      expect(unwrap(await open())).toMatchObject({ status: 'unavailable' });
    });
  });
});
