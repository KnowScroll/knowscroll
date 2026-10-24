/** Content threads over real PostgreSQL: creation, invitations, messages, access and the thread list. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef, ContentThreadView } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  befriend,
  consumptionRows,
  friendCommand,
  pairRevision,
  seedFriend,
  talkCases,
  withdraw,
  type Friend,
  type Friends,
  type Threads,
} from '../support/talk.js';
import { addReelRevision, seedReel } from '../support/thread-fixtures.js';

const version = 'content-thread.v1' as const;
const text = (value: string) => ({ kind: 'text' as const, text: value });

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('content threads (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let friendsOf: Friends;
  let threads: Threads;
  let cases: ReturnType<typeof talkCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_threads');
    cases = talkCases(database.db);
    friendsOf = cases.friends;
    threads = cases.threads;
  });
  afterAll(async () => {
    await database.drop();
  });

  /** Asha is friends with Ravi and Meera; Ravi and Meera need not know each other. */
  async function trio() {
    const [a, b, c] = [
      await seedFriend(database.db, friendsOf),
      await seedFriend(database.db, friendsOf),
      await seedFriend(database.db, friendsOf),
    ] as [Friend, Friend, Friend];
    await befriend(friendsOf, a, b);
    await befriend(friendsOf, a, c);
    return { a, b, c };
  }

  const create = (actor: Friend, root: object, people: readonly Friend[], commandId = randomUUID(), name?: string) =>
    threads.create(actor.authority, {
      version,
      commandId,
      root,
      friendPersonIds: people.map((person) => person.person.personId),
      ...(name === undefined ? {} : { name }),
    });
  const view = (actor: Friend, thread: ContentThreadRef, limit = 50) =>
    threads.read(actor.authority, { version, readId: randomUUID(), thread, limit });
  async function ready(actor: Friend, thread: ContentThreadRef, limit = 50) {
    const found = unwrap(await view(actor, thread, limit));
    if (found.status !== 'ready') throw new Error(`CI thread is ${found.status}`);
    return found;
  }
  const countThreads = async () =>
    (
      await database.db
        .selectFrom('social.conversations')
        .select('conversation_id')
        .where('kind', '=', 'thread')
        .execute()
    ).length;
  const send = (actor: Friend, thread: ContentThreadRef, body: object, commandId = randomUUID()) =>
    threads.send(actor.authority, { version, commandId, thread, body });
  const respond = (
    actor: Friend,
    thread: ContentThreadRef,
    response: 'join' | 'decline',
    commandId: string = randomUUID(),
  ) => threads.respond(actor.authority, { version, commandId, thread, response });
  const inbox = async (actor: Friend) => {
    const found = unwrap(await threads.inbox(actor.authority, { version, readId: randomUUID(), limit: 50 }));
    return found.items;
  };

  /** A thread on a fresh Reel: Asha started it with Ravi and Meera. */
  async function begun() {
    const { a, b, c } = await trio();
    const reel = await seedReel(database.db);
    const root = { assetId: reel.assetId, assetRevision: 1 };
    const started = unwrap(await create(a, root, [b, c], randomUUID(), 'Black holes'));
    const invitation = async (person: Friend): Promise<ContentThreadRef> => {
      const [item] = await inbox(person);
      if (!item) throw new Error('CI invitation missing');
      return item.thread;
    };
    return { a, b, c, reel, root, aRef: started.thread, bRef: await invitation(b), cRef: await invitation(c) };
  }

  describe('creating a thread', () => {
    it('starts one thread with invitations, and a retry returns the same thread', async () => {
      const { a, b, c } = await trio();
      const reel = await seedReel(database.db);
      const root = { assetId: reel.assetId, assetRevision: 1 };
      const commandId = randomUUID();

      const first = unwrap(await create(a, root, [b, c], commandId, 'Black holes'));
      expect(first).toMatchObject({ operation: 'thread.create', replayed: false });
      const again = unwrap(await create(a, root, [b, c], commandId, 'Black holes'));
      expect(again).toMatchObject({ replayed: true, thread: first.thread });
      expect(await create(a, root, [b], commandId, 'Black holes')).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
      // Another command is another thread.
      const other = unwrap(await create(a, root, [b, c]));
      expect(other.thread.threadId).not.toBe(first.thread.threadId);

      const asha = await ready(a, first.thread);
      expect(asha).toMatchObject({ name: 'Black holes', own: { readThroughSequence: 0, muted: false } });
      expect(asha.root).toMatchObject({ status: 'available', target: root });
      expect(asha.sequence).toEqual({ kind: 'single' });
      expect(asha.episodes).toHaveLength(1);
      expect(
        asha.participants.map((participant) => [participant.person.handle, participant.role, participant.joined]),
      ).toEqual(
        [a, b, c]
          .map((person) => [person.person.handle, person.person.personId === a.person.personId])
          .sort()
          .map(([handle, starter]) => [handle, starter ? 'starter' : 'member', starter]),
      );
      expect(asha.participants.filter((participant) => participant.you)).toHaveLength(1);
    });

    it('refuses the whole command, without saying why, when anyone is not a current friend', async () => {
      const { a, b, c } = await trio();
      const stranger = await seedFriend(database.db, friendsOf);
      const reel = await seedReel(database.db);
      const root = { assetId: reel.assetId, assetRevision: 1 };
      const unavailable = { kind: 'refused', code: 'unavailable' };

      const threadsBefore = await countThreads();
      expect(await create(a, root, [b, stranger])).toEqual(unavailable);
      // Removed and blocked friends are strangers again.
      await friendCommand(friendsOf, a, c, 'remove');
      expect(await create(a, root, [b, c])).toEqual(unavailable);
      const d = await seedFriend(database.db, friendsOf);
      await befriend(friendsOf, a, d);
      await friendCommand(friendsOf, d, a, 'block');
      expect(await create(a, root, [d])).toEqual(unavailable);
      // Someone who is not a person at all looks the same.
      expect(
        await threads.create(a.authority, {
          version,
          commandId: randomUUID(),
          root,
          friendPersonIds: [randomUUID()],
        }),
      ).toEqual(unavailable);
      expect(await countThreads(), 'a refused command leaves no thread behind').toBe(threadsBefore);
    });

    it('refuses a root that is withdrawn, corrected or missing', async () => {
      const { a, b } = await trio();
      const withdrawn = await seedReel(database.db);
      await withdraw(database.db, withdrawn.assetId);
      const corrected = await seedReel(database.db);
      await addReelRevision(database.db, corrected.assetId, 2);
      const unavailable = { kind: 'refused', code: 'unavailable' };
      expect(await create(a, { assetId: withdrawn.assetId, assetRevision: 1 }, [b])).toEqual(unavailable);
      expect(await create(a, { assetId: corrected.assetId, assetRevision: 1 }, [b])).toEqual(unavailable);
      expect(await create(a, { assetId: randomUUID(), assetRevision: 1 }, [b])).toEqual(unavailable);
    });

    it('rejects malformed requests before any effect', async () => {
      const { a, b } = await trio();
      const reel = await seedReel(database.db);
      const root = { assetId: reel.assetId, assetRevision: 1 };
      const bad = { kind: 'refused', code: 'invalid_input' };
      expect(await create(a, root, [])).toEqual(bad);
      expect(await create(a, root, [b, b])).toEqual(bad);
      expect(
        await create(
          a,
          root,
          Array.from({ length: 9 }, () => b),
        ),
      ).toEqual(bad);
      expect(await create(a, root, [b], randomUUID(), '  ')).toEqual(bad);
      expect(await threads.create(a.authority, { version, commandId: randomUUID(), root })).toEqual(bad);
    });

    it('serialises two identical commands that arrive together', async () => {
      const { a, b } = await trio();
      const reel = await seedReel(database.db);
      const root = { assetId: reel.assetId, assetRevision: 1 };
      const commandId = randomUUID();
      const [one, two] = await Promise.all([create(a, root, [b], commandId), create(a, root, [b], commandId)]);
      expect(unwrap(one).thread).toEqual(unwrap(two).thread);
      expect([unwrap(one).replayed, unwrap(two).replayed].sort()).toEqual([false, true]);
    });
  });

  describe('invitations', () => {
    it('shows an invitation, not the conversation, until the friend joins', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await send(a, aRef, text('before you joined')));
      const invitation = unwrap(await view(b, bRef));
      expect(invitation).toMatchObject({
        status: 'invitation',
        name: 'Black holes',
        invitedBy: { handle: a.person.handle },
        participantCount: 3,
      });
      expect(JSON.stringify(invitation)).not.toContain('before you joined');
      // Nothing of the conversation is reachable yet.
      expect(await send(b, bRef, text('hello'))).toEqual({ kind: 'refused', code: 'unavailable' });
      const cursor = (await ready(a, aRef)).catchUpCursor;
      expect(
        unwrap(await threads.changes(b.authority, { version, readId: randomUUID(), thread: bRef, limit: 10, cursor })),
      ).toMatchObject({ status: 'unavailable' });
      expect(await inbox(b)).toMatchObject([
        { state: 'invited', latestMessageSequence: 0, people: [{ handle: a.person.handle }] },
      ]);
      expect((await inbox(b))[0]).not.toHaveProperty('lastMessage');

      const joined = unwrap(await respond(b, bRef, 'join'));
      expect(joined).toMatchObject({ operation: 'thread.respond', response: 'join', thread: bRef });
      const ravi = await ready(b, bRef);
      expect(ravi.messages.map((message) => message.status === 'available' && message.body)).toEqual([
        text('before you joined'),
      ]);
      expect(ravi.participants.find((participant) => participant.you)).toMatchObject({ joined: true });
      // A retry of the answer replays it.
      expect(unwrap(await respond(b, bRef, 'join', joined.commandId))).toMatchObject({ replayed: true });
      // An answer is given once: another one is refused.
      expect(await respond(b, bRef, 'decline')).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('lets a friend decline: they see nothing more and the others no longer list them', async () => {
      const { a, c, aRef, cRef } = await begun();
      unwrap(await respond(c, cRef, 'decline'));
      expect(unwrap(await view(c, cRef))).toMatchObject({ status: 'unavailable' });
      expect(await inbox(c)).toEqual([]);
      const asha = await ready(a, aRef);
      expect(asha.participants.map((participant) => participant.person.handle)).not.toContain(c.person.handle);
    });

    it('answers a stranger and a stale reference exactly like a missing thread', async () => {
      const { b, aRef, bRef } = await begun();
      const stranger = await seedFriend(database.db, friendsOf);
      const unknown = { threadId: randomUUID(), membershipId: randomUUID(), membershipRevision: 1 };
      const answers = [
        unwrap(await view(stranger, aRef)),
        unwrap(await view(stranger, unknown)),
        unwrap(await view(b, { ...bRef, membershipRevision: 2 })),
        unwrap(await view(b, { ...bRef, membershipId: aRef.membershipId })),
      ];
      for (const answer of answers)
        expect(Object.keys(answer).sort()).toEqual(['readId', 'scope', 'status', 'version']);
      for (const answer of answers) expect(answer.status).toBe('unavailable');
    });
  });

  describe('messages', () => {
    it('delivers in order to joined members, replays a retry and refuses a changed body', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      const commandId = randomUUID();
      const first = unwrap(await send(a, aRef, text('Look at this one'), commandId));
      expect(first).toMatchObject({ messageSequence: 1, sent: { kind: 'text' }, replayed: false });
      expect(unwrap(await send(a, aRef, text('Look at this one'), commandId))).toMatchObject({
        messageSequence: 1,
        replayed: true,
      });
      expect(await send(a, aRef, text('Something else'), commandId)).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
      expect(unwrap(await send(b, bRef, text('Same here')))).toMatchObject({ messageSequence: 2 });

      const snapshot = await ready(b, bRef);
      expect(snapshot.latestMessageSequence).toBe(2);
      expect(snapshot.messages.map((message) => message.sequence)).toEqual([1, 2]);
      expect(snapshot.messages[0]).toMatchObject({
        author: { handle: a.person.handle },
        body: text('Look at this one'),
      });
    });

    it('lets people catch up from a cursor and page back through older messages', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      for (let n = 1; n <= 5; n++) unwrap(await send(a, aRef, text(`message ${String(n)}`)));
      const first = await ready(b, bRef, 3);
      expect(first.messages.map((message) => message.sequence)).toEqual([3, 4, 5]);
      expect(first.history.kind).toBe('more');
      if (first.history.kind !== 'more') return;
      const older = unwrap(
        await threads.history(b.authority, {
          version,
          readId: randomUUID(),
          thread: bRef,
          limit: 3,
          cursor: first.history.cursor,
        }),
      );
      if (older.status !== 'ready') throw new Error('CI history');
      expect(older.messages.map((message) => message.sequence)).toEqual([1, 2]);
      expect(older.continuation).toEqual({ kind: 'end' });

      unwrap(await send(a, aRef, text('message 6')));
      const caughtUp = unwrap(
        await threads.changes(b.authority, {
          version,
          readId: randomUUID(),
          thread: bRef,
          limit: 50,
          cursor: first.catchUpCursor,
        }),
      );
      if (caughtUp.status !== 'ready') throw new Error('CI changes');
      expect(caughtUp.changes.map((change) => change.message.sequence)).toEqual([6]);
      expect(caughtUp.continuation.kind).toBe('caught_up');
      // A position of another thread is stale, never a silently substituted first page.
      const other = unwrap(await create(a, { assetId: first.root.target.assetId, assetRevision: 1 }, [b]));
      expect(
        unwrap(
          await threads.changes(a.authority, {
            version,
            readId: randomUUID(),
            thread: other.thread,
            limit: 50,
            cursor: first.catchUpCursor,
          }),
        ),
      ).toMatchObject({ status: 'refresh_required' });
    });

    it('keeps each reading position private, forward-only and never past the newest message', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      unwrap(await send(a, aRef, text('one')));
      unwrap(await send(a, aRef, text('two')));
      const mark = (actor: Friend, thread: ContentThreadRef, throughSequence: number) =>
        threads.markRead(actor.authority, { version, commandId: randomUUID(), thread, throughSequence });
      expect(unwrap(await mark(b, bRef, 2))).toMatchObject({ acceptedThroughSequence: 2 });
      expect(unwrap(await mark(b, bRef, 1))).toMatchObject({ requestedThroughSequence: 1, acceptedThroughSequence: 2 });
      expect(await mark(b, bRef, 3)).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect((await ready(b, bRef)).own.readThroughSequence).toBe(2);
      expect((await ready(a, aRef)).own.readThroughSequence).toBe(0);
    });

    it('serialises messages sent at the same moment into one gapless order', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, n) =>
          n % 2 === 0 ? send(a, aRef, text(`from a ${String(n)}`)) : send(b, bRef, text(`from b ${String(n)}`)),
        ),
      );
      expect(results.map((result) => unwrap(result).messageSequence).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('never puts anyone else’s position, current episode or seen marker in an answer', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      unwrap(await send(a, aRef, text('hello')));
      const mark = { version, commandId: randomUUID(), thread: bRef, throughSequence: 1 };
      unwrap(await threads.markRead(b.authority, mark));
      const answers: unknown[] = [await ready(a, aRef), await ready(b, bRef), await inbox(a), await inbox(b)];
      for (const answer of answers) {
        const json = JSON.stringify(answer);
        expect(json).not.toMatch(/position|playhead|currentEpisode|currentItem|seenBy|readBy|lastSeen|presence/i);
      }
      // Asha's answer holds only her own reading position: Ravi's two read, hers zero.
      expect(JSON.stringify(answers[0]).match(/readThroughSequence/g)).toHaveLength(1);
      expect((answers[0] as ContentThreadView & { status: 'ready' }).own.readThroughSequence).toBe(0);
    });

    it('creates no consumption evidence for anyone', async () => {
      const before = await consumptionRows(database.db);
      const { a, b, aRef, bRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      unwrap(await send(a, aRef, text('hello')));
      await ready(b, bRef);
      await inbox(b);
      expect(await consumptionRows(database.db)).toBe(before);
    });
  });

  describe('who keeps access', () => {
    it('ends a friend’s place when the friendship that invited them ends, and does not revive it', async () => {
      const { a, b, c, aRef, bRef, cRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      unwrap(await respond(c, cRef, 'join'));
      unwrap(await send(b, bRef, text('from ravi')));

      unwrap(await friendCommand(friendsOf, a, b, 'remove'));
      expect(await send(b, bRef, text('still here?'))).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(unwrap(await view(b, bRef))).toMatchObject({ status: 'unavailable' });
      expect(await inbox(b)).toEqual([]);
      const asha = await ready(a, aRef);
      expect(asha.participants.map((participant) => participant.person.handle)).not.toContain(b.person.handle);
      expect(asha.messages).toHaveLength(1);
      // Meera is unaffected, and Asha can still write.
      unwrap(await send(a, aRef, text('just us')));
      expect((await ready(c, cRef)).messages).toHaveLength(2);

      // Becoming friends again (after the request cooldown) is a new friendship: the old place does not come back.
      cases.clock.now = new Date(cases.clock.now.getTime() + 8 * 24 * 60 * 60 * 1000);
      await befriend(friendsOf, a, b);
      expect(unwrap(await view(b, bRef))).toMatchObject({ status: 'unavailable' });
    });

    it('ends a place when either person blocks, without telling the other', async () => {
      const { a, b, c, aRef, bRef, cRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      unwrap(await respond(c, cRef, 'join'));
      unwrap(await friendCommand(friendsOf, b, a, 'block'));
      expect(unwrap(await view(b, bRef))).toMatchObject({ status: 'unavailable' });
      unwrap(await friendCommand(friendsOf, a, c, 'block'));
      expect(unwrap(await view(c, cRef))).toMatchObject({ status: 'unavailable' });
      expect((await ready(a, aRef)).participants).toHaveLength(1);
      // Unblocking restores nothing.
      unwrap(await friendCommand(friendsOf, a, c, 'unblock'));
      expect(unwrap(await view(c, cRef))).toMatchObject({ status: 'unavailable' });
    });

    it('lets the thread go on when the person who started it leaves', async () => {
      const { a, b, c, aRef, bRef, cRef } = await begun();
      unwrap(await respond(b, bRef, 'join'));
      unwrap(await respond(c, cRef, 'join'));
      unwrap(await send(a, aRef, text('my last word')));
      unwrap(await threads.leave(a.authority, { version, commandId: randomUUID(), thread: aRef }));
      expect(unwrap(await view(a, aRef))).toMatchObject({ status: 'unavailable' });

      // Ravi and Meera stand on their membership now: ending the friendship with Asha changes nothing.
      unwrap(await friendCommand(friendsOf, a, b, 'remove'));
      const ravi = await ready(b, bRef);
      expect(ravi.participants.map((participant) => participant.person.handle).sort()).toEqual(
        [b, c].map((person) => person.person.handle).sort(),
      );
      expect(ravi.messages).toHaveLength(1);
      unwrap(await send(b, bRef, text('carrying on')));
      expect((await ready(c, cRef)).messages).toHaveLength(2);
    });

    it('does not give back a place that had ended when the person who invited them leaves', async () => {
      const { a, b, c } = await trio();
      const d = await seedFriend(database.db, friendsOf);
      await befriend(friendsOf, a, d);
      const reel = await seedReel(database.db);
      const started = unwrap(await create(a, { assetId: reel.assetId, assetRevision: 1 }, [b, c, d]));
      const refs = {
        a: started.thread,
        b: (await inbox(b))[0]!.thread,
        c: (await inbox(c))[0]!.thread,
        d: (await inbox(d))[0]!.thread,
      };
      unwrap(await respond(b, refs.b, 'join'));
      unwrap(await respond(d, refs.d, 'join'));
      // Ravi is blocked after joining; Meera's friendship ends before she answers; Dev stays a friend.
      unwrap(await friendCommand(friendsOf, a, b, 'block'));
      unwrap(await friendCommand(friendsOf, a, c, 'remove'));
      expect(unwrap(await view(b, refs.b))).toMatchObject({ status: 'unavailable' });
      expect(unwrap(await view(c, refs.c))).toMatchObject({ status: 'unavailable' });
      unwrap(await send(d, refs.d, text('after the block')));

      unwrap(await threads.leave(a.authority, { version, commandId: randomUUID(), thread: refs.a }));

      for (const [person, ref] of [
        [b, refs.b],
        [c, refs.c],
      ] as const) {
        expect(unwrap(await view(person, ref))).toMatchObject({ status: 'unavailable' });
        expect(await send(person, ref, text('let me back in'))).toEqual({ kind: 'refused', code: 'unavailable' });
        expect(await inbox(person)).toEqual([]);
      }
      expect((await ready(d, refs.d)).messages).toHaveLength(1);
      // Dev stands on their own membership now: losing the friendship with Asha changes nothing.
      unwrap(await friendCommand(friendsOf, a, d, 'remove'));
      expect((await ready(d, refs.d)).messages).toHaveLength(1);
      const rows = await database.db
        .selectFrom('social.conversation_members')
        .select(['account_id', 'left_at', 'invited_by_account_id'])
        .where('conversation_id', '=', started.thread.threadId)
        .where('account_id', 'in', [b.accountId, c.accountId, d.accountId])
        .execute();
      expect(rows.every((row) => row.invited_by_account_id === null)).toBe(true);
      expect(
        rows
          .filter((row) => row.left_at !== null)
          .map((row) => row.account_id)
          .sort(),
      ).toEqual([b.accountId, c.accountId].sort());
    });

    it('lists threads for the person: invitations with no messages, joined threads with the last one', async () => {
      const { a, b, aRef, bRef } = await begun();
      unwrap(await send(a, aRef, text('a first thought')));
      expect(await inbox(b)).toMatchObject([{ state: 'invited', latestMessageSequence: 0 }]);
      unwrap(await respond(b, bRef, 'join'));
      const [item] = await inbox(b);
      expect(item).toMatchObject({
        state: 'joined',
        name: 'Black holes',
        latestMessageSequence: 1,
        own: { readThroughSequence: 0 },
        lastMessage: { body: text('a first thought') },
      });
      expect(item?.people.map((person) => person.handle)).toContain(a.person.handle);
      expect(await inbox(a)).toHaveLength(1);
      // A different, unrelated person sees nothing.
      expect(await inbox(await seedFriend(database.db, friendsOf))).toEqual([]);
    });

    it('dates an invitation by when the thread began, so what the others say later cannot be told from it', async () => {
      const { a, b, c } = await trio();
      const reel = await seedReel(database.db);
      const root = { assetId: reel.assetId, assetRevision: 1 };
      const first = unwrap(await create(a, root, [b, c]));
      cases.clock.now = new Date(cases.clock.now.getTime() + 10 * 60 * 1000);
      const second = unwrap(await create(a, root, [b]));
      const cFirst = (await inbox(c))[0]!.thread;
      unwrap(await respond(c, cFirst, 'join'));
      const before = await inbox(b);
      expect(before.map((item) => item.thread.threadId)).toEqual([second.thread.threadId, first.thread.threadId]);

      cases.clock.now = new Date(cases.clock.now.getTime() + 60 * 60 * 1000);
      unwrap(await send(a, first.thread, text('an hour later')));
      unwrap(await send(c, cFirst, text('and another')));
      // The invitee's rows, order and times are exactly as before; the people who joined see the activity.
      expect(await inbox(b)).toEqual(before);
      expect((await inbox(a)).map((item) => item.thread.threadId)).toEqual([
        first.thread.threadId,
        second.thread.threadId,
      ]);
      expect((await inbox(c))[0]).toMatchObject({ state: 'joined', latestMessageSequence: 2 });
    });

    it('shows a withdrawn root as unavailable while the conversation stays readable', async () => {
      const { a, aRef, root } = await begun();
      unwrap(await send(a, aRef, text('still talking')));
      await withdraw(database.db, root.assetId);
      const asha = await ready(a, aRef);
      expect(asha.root).toMatchObject({ status: 'unavailable', target: root });
      expect(asha.episodes[0]).toMatchObject({ state: 'unavailable', title: 'No longer available' });
      expect(asha.messages).toHaveLength(1);
    });
  });

  it('keeps direct conversations and threads on the same friendship apart', async () => {
    const { a, b, aRef, bRef } = await begun();
    unwrap(await respond(b, bRef, 'join'));
    unwrap(await send(a, aRef, text('in the thread')));
    const directInbox = async (actor: Friend) => {
      const found = unwrap(
        await cases.talk.conversations.inbox(actor.authority, {
          version: 'direct-conversation.v1',
          readId: randomUUID(),
          limit: 50,
        }),
      );
      return found.status === 'ready' ? found.items : [];
    };
    expect(await directInbox(a)).toEqual([]);
    expect(await directInbox(b)).toEqual([]);

    const direct = unwrap(
      await cases.talk.conversations.start(a.authority, {
        version: 'direct-conversation.v1',
        commandId: randomUUID(),
        peerPersonId: b.person.personId,
        expectedPairRevision: await pairRevisionOf(a, b),
      }),
    ).conversation;
    unwrap(
      await cases.talk.conversations.send(a.authority, {
        version: 'direct-conversation.v1',
        commandId: randomUUID(),
        conversation: direct,
        body: { kind: 'text', text: 'in private' },
      }),
    );
    expect(await directInbox(a)).toHaveLength(1);
    expect((await inbox(a)).map((item) => item.thread.threadId)).toEqual([aRef.threadId]);
    // A direct conversation reference opens no thread, and a thread reference opens no conversation.
    const asThread = { threadId: direct.conversationId, membershipId: direct.membershipId, membershipRevision: 1 };
    expect(unwrap(await view(a, asThread))).toMatchObject({ status: 'unavailable' });
    const crossRead = unwrap(
      await cases.talk.conversations.read(a.authority, {
        version: 'direct-conversation.v1',
        readId: randomUUID(),
        conversation: { conversationId: aRef.threadId, membershipId: aRef.membershipId, membershipRevision: 1 },
        limit: 10,
      }),
    );
    expect(crossRead.status).toBe('unavailable');
  });

  const pairRevisionOf = (actor: Friend, peer: Friend) => pairRevision(friendsOf, actor, peer);
});
