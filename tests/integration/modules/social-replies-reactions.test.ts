/** Replies and reactions (T3 Talk) over real PostgreSQL, in direct conversations and in content threads. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef, DirectConversationRef, MessageReactionKind } from '@knowscroll/contracts';
import { eraseCurrentAccount, personalStores } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  befriend,
  consumptionRows,
  friendCommand,
  seedFriend,
  seedFriends,
  talkCases,
  type Friend,
  type Friends,
  type Talk,
  type Threads,
  pairRevision,
} from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';

const direct = 'direct-conversation.v1' as const;
const threadVersion = 'content-thread.v1' as const;
const text = (value: string) => ({ kind: 'text' as const, text: value });
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('replies and reactions (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let friendsOf: Friends;
  let talkOf: Talk['conversations'];
  let threads: Threads;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_replies_reactions');
    const cases = talkCases(database.db);
    friendsOf = cases.friends;
    talkOf = cases.talk.conversations;
    threads = cases.threads;
  });
  afterAll(async () => {
    await database.drop();
  });

  // ---- direct conversations ----

  async function begin(a: Friend, b: Friend) {
    const startFor = async (actor: Friend, peer: Friend) =>
      unwrap(
        await talkOf.start(actor.authority, {
          version: direct,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision: await pairRevision(friendsOf, actor, peer),
        }),
      ).conversation;
    return { aRef: await startFor(a, b), bRef: await startFor(b, a) };
  }
  const send = (
    actor: Friend,
    conversation: DirectConversationRef,
    body: object,
    replyTo?: string,
    id = randomUUID(),
  ) =>
    talkOf.send(actor.authority, {
      version: direct,
      commandId: id,
      conversation,
      body,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  const react = (
    actor: Friend,
    conversation: DirectConversationRef,
    messageId: string,
    kind: MessageReactionKind,
    present: boolean,
    commandId = randomUUID(),
  ) => talkOf.react(actor.authority, { version: direct, commandId, conversation, messageId, kind, present });
  async function snapshot(actor: Friend, conversation: DirectConversationRef) {
    const found = unwrap(
      await talkOf.read(actor.authority, { version: direct, readId: randomUUID(), conversation, limit: 50 }),
    );
    if (found.status !== 'ready') throw new Error('CI snapshot unavailable');
    return found;
  }
  const changes = async (actor: Friend, conversation: DirectConversationRef, cursor: string) => {
    const page = unwrap(
      await talkOf.changes(actor.authority, { version: direct, readId: randomUUID(), conversation, limit: 50, cursor }),
    );
    if (page.status !== 'ready') throw new Error('CI changes unavailable');
    return page;
  };
  const messageRows = (conversationId: string) =>
    database.db.selectFrom('social.messages').selectAll().where('conversation_id', '=', conversationId).execute();
  const reactionRows = (conversationId: string) =>
    database.db
      .selectFrom('social.message_reactions')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .execute();

  describe('replies in a direct conversation', () => {
    it('stores a reply with the quote of its original, and a retry makes one message', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const original = unwrap(await send(a, aRef, text('Part 1 solid hai')));
      const commandId = randomUUID();
      const first = unwrap(await send(b, bRef, text('who is on part 2?'), original.messageId, commandId));
      const again = unwrap(await send(b, bRef, text('who is on part 2?'), original.messageId, commandId));
      expect(again).toMatchObject({ messageId: first.messageId, replayed: true });
      // The same command naming another original is another request.
      expect(await send(b, bRef, text('who is on part 2?'), first.messageId, commandId)).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
      expect(await messageRows(aRef.conversationId)).toHaveLength(2);

      const seen = await snapshot(a, aRef);
      expect(seen.messages[1]).toMatchObject({
        status: 'available',
        body: { text: 'who is on part 2?' },
        replyTo: {
          messageId: original.messageId,
          sequence: 1,
          original: { status: 'available', author: { personId: a.person.personId }, preview: 'Part 1 solid hai' },
        },
      });
      expect(seen.messages[0]).not.toHaveProperty('replyTo');
    });

    it('refuses a reply to another conversation, to an unknown message and to a removed one, and stores nothing', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const c = await seedFriend(database.db, friendsOf);
      await befriend(friendsOf, a, c);
      const ab = await begin(a, b);
      const ac = await begin(a, c);
      const inAb = unwrap(await send(a, ab.aRef, text('in the first conversation')));
      const inAc = unwrap(await send(a, ac.aRef, text('in the second conversation')));
      const before = (await messageRows(ab.aRef.conversationId)).length;

      for (const replyTo of [inAc.messageId, randomUUID()])
        expect(await send(a, ab.aRef, text('wrong place'), replyTo)).toEqual({ kind: 'refused', code: 'unavailable' });
      // A tombstone (the original's author left) cannot be answered either.
      await database.db
        .updateTable('social.messages')
        .set({ author_account_id: null, command_id: null, body_text: null })
        .where('message_id', '=', inAb.messageId)
        .execute();
      expect(await send(b, ab.bRef, text('too late'), inAb.messageId)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await messageRows(ab.aRef.conversationId)).toHaveLength(before);
    });

    it('reads a quote of a removed original as unavailable', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const original = unwrap(await send(a, aRef, text('soon removed')));
      unwrap(await send(b, bRef, text('an answer'), original.messageId));
      await database.db
        .updateTable('social.messages')
        .set({ author_account_id: null, command_id: null, body_text: null })
        .where('message_id', '=', original.messageId)
        .execute();
      const seen = await snapshot(b, bRef);
      expect(seen.messages[1]).toMatchObject({ replyTo: { original: { status: 'unavailable' } } });
      expect(JSON.stringify(seen)).not.toContain('soon removed');
    });
  });

  describe('reactions in a direct conversation', () => {
    it('adds and removes a reaction; a replay and a repeat under another command change nothing', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const message = unwrap(await send(a, aRef, text('moon ka bulge')));
      const consumed = await consumptionRows(database.db);

      const commandId = randomUUID();
      const added = unwrap(await react(b, bRef, message.messageId, 'spark', true, commandId));
      expect(added).toMatchObject({ changed: true, present: true, kind: 'spark', replayed: false });
      expect(unwrap(await react(b, bRef, message.messageId, 'spark', true, commandId))).toMatchObject({
        changed: true,
        replayed: true,
      });
      // The same command with another wanted state is not a replay.
      expect(await react(b, bRef, message.messageId, 'spark', false, commandId)).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
      const afterAdd = await snapshot(a, aRef);
      const cursorAfterAdd = afterAdd.catchUpCursor;
      // Another command that asks for the state already held is accepted and changes nothing, not even the feed.
      expect(unwrap(await react(b, bRef, message.messageId, 'spark', true))).toMatchObject({ changed: false });
      expect((await changes(a, aRef, cursorAfterAdd)).changes).toEqual([]);
      expect(await reactionRows(aRef.conversationId)).toHaveLength(1);

      expect(unwrap(await react(b, bRef, message.messageId, 'spark', false))).toMatchObject({ changed: true });
      expect(unwrap(await react(b, bRef, message.messageId, 'spark', false))).toMatchObject({ changed: false });
      expect(await reactionRows(aRef.conversationId)).toEqual([]);
      expect(await consumptionRows(database.db)).toBe(consumed);
    });

    it('keeps one reaction per person and kind, and shows each kind once with who and whether it is mine', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const message = unwrap(await send(a, aRef, text('the far side bulges too')));
      unwrap(await react(a, aRef, message.messageId, 'heart', true));
      unwrap(await react(b, bRef, message.messageId, 'heart', true));
      unwrap(await react(b, bRef, message.messageId, 'mind_blown', true));
      unwrap(await react(b, bRef, message.messageId, 'heart', true));

      const rows = await reactionRows(aRef.conversationId);
      expect(rows.map((row) => `${row.account_id === a.accountId ? 'a' : 'b'}:${row.kind}`).sort()).toEqual([
        'a:heart',
        'b:heart',
        'b:mind_blown',
      ]);
      // The table itself refuses a second row for one person, kind and message.
      await expect(
        database.db
          .insertInto('social.message_reactions')
          .values({
            conversation_id: aRef.conversationId,
            message_sequence: '1',
            account_id: b.accountId,
            kind: 'heart',
            reacted_at: new Date(),
          })
          .execute(),
      ).rejects.toThrow();

      const forA = (await snapshot(a, aRef)).messages[0];
      const forB = (await snapshot(b, bRef)).messages[0];
      if (forA?.status !== 'available' || forB?.status !== 'available') throw new Error('CI message');
      expect(forA.reactions?.map((reaction) => [reaction.kind, reaction.mine, reaction.people.length])).toEqual([
        ['mind_blown', false, 1],
        ['heart', true, 2],
      ]);
      expect(forB.reactions?.map((reaction) => [reaction.kind, reaction.mine])).toEqual([
        ['mind_blown', true],
        ['heart', true],
      ]);
      expect(forA.reactions?.[1]?.people.map((person) => person.personId).sort()).toEqual(
        [a.person.personId, b.person.personId].sort(),
      );
    });

    it('carries a reaction in the changes feed in order, and tells the other person’s inbox', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const one = unwrap(await send(a, aRef, text('one')));
      const two = unwrap(await send(a, aRef, text('two')));
      const start = (await snapshot(b, bRef)).catchUpCursor;
      const headBefore = await database.db
        .selectFrom('social.inbox_heads')
        .select('revision')
        .where('account_id', '=', a.accountId)
        .executeTakeFirstOrThrow();

      unwrap(await react(b, bRef, two.messageId, 'ha', true));
      unwrap(await react(b, bRef, one.messageId, 'question', true));
      const page = await changes(a, aRef, start);
      // The message reacted to last comes last, whatever its place in the conversation.
      expect(page.changes.map((change) => change.message.sequence)).toEqual([2, 1]);
      expect(page.changes[0]?.message).toMatchObject({ reactions: [{ kind: 'ha', mine: false }] });
      expect(page.changes[1]?.message).toMatchObject({ reactions: [{ kind: 'question', mine: false }] });
      expect(page.changes[0]!.changeSequence).toBeLessThan(page.changes[1]!.changeSequence);
      const headAfter = await database.db
        .selectFrom('social.inbox_heads')
        .select('revision')
        .where('account_id', '=', a.accountId)
        .executeTakeFirstOrThrow();
      expect(Number(headAfter.revision)).toBeGreaterThan(Number(headBefore.revision));
      // A reaction is not a message: the conversation's length and last message are unchanged.
      const inbox = unwrap(await talkOf.inbox(a.authority, { version: direct, readId: randomUUID(), limit: 10 }));
      expect(inbox.status === 'ready' && inbox.items[0]?.latestMessageSequence).toBe(2);
    });

    it('refuses a reaction from a stranger, on another conversation’s message, on a removed message and after the end', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const stranger = await seedFriend(database.db, friendsOf);
      const c = await seedFriend(database.db, friendsOf);
      await befriend(friendsOf, a, c);
      const { aRef, bRef } = await begin(a, b);
      const other = await begin(a, c);
      const message = unwrap(await send(a, aRef, text('hello')));
      const elsewhere = unwrap(await send(a, other.aRef, text('elsewhere')));

      expect(await react(stranger, bRef, message.messageId, 'spark', true)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await react(b, bRef, elsewhere.messageId, 'spark', true)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await react(b, bRef, randomUUID(), 'spark', true)).toEqual({ kind: 'refused', code: 'unavailable' });
      await database.db
        .updateTable('social.messages')
        .set({ author_account_id: null, command_id: null, body_text: null })
        .where('message_id', '=', message.messageId)
        .execute();
      expect(await react(b, bRef, message.messageId, 'spark', true)).toEqual({ kind: 'refused', code: 'unavailable' });
      const live = unwrap(await send(b, bRef, text('still here')));
      unwrap(await talkOf.leave(a.authority, { version: direct, commandId: randomUUID(), conversation: aRef }));
      expect(await react(b, bRef, live.messageId, 'spark', true)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await reactionRows(aRef.conversationId)).toEqual([]);
    });
  });

  // ---- content threads ----

  async function threadOfThree() {
    const [a, b, c] = [
      await seedFriend(database.db, friendsOf),
      await seedFriend(database.db, friendsOf),
      await seedFriend(database.db, friendsOf),
    ] as [Friend, Friend, Friend];
    await befriend(friendsOf, a, b);
    await befriend(friendsOf, a, c);
    await befriend(friendsOf, b, c);
    const reel = await seedReel(database.db);
    const started = unwrap(
      await threads.create(a.authority, {
        version: threadVersion,
        commandId: randomUUID(),
        root: { assetId: reel.assetId, assetRevision: 1 },
        friendPersonIds: [b.person.personId, c.person.personId],
      }),
    );
    const join = async (person: Friend): Promise<ContentThreadRef> => {
      const inbox = unwrap(
        await threads.inbox(person.authority, { version: threadVersion, readId: randomUUID(), limit: 10 }),
      );
      const ref = inbox.items[0]!.thread;
      unwrap(
        await threads.respond(person.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread: ref,
          response: 'join',
        }),
      );
      return ref;
    };
    return { a, b, c, aRef: started.thread, bRef: await join(b), cRef: await join(c) };
  }
  const threadSend = (actor: Friend, thread: ContentThreadRef, body: object, replyTo?: string) =>
    threads.send(actor.authority, {
      version: threadVersion,
      commandId: randomUUID(),
      thread,
      body,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  const threadReact = (
    actor: Friend,
    thread: ContentThreadRef,
    messageId: string,
    kind: MessageReactionKind,
    present: boolean,
    commandId = randomUUID(),
  ) => threads.react(actor.authority, { version: threadVersion, commandId, thread, messageId, kind, present });
  async function threadView(actor: Friend, thread: ContentThreadRef) {
    const found = unwrap(
      await threads.read(actor.authority, { version: threadVersion, readId: randomUUID(), thread, limit: 50 }),
    );
    if (found.status !== 'ready') throw new Error('CI thread unavailable');
    return found;
  }

  describe('content threads', () => {
    it('replies within the thread only, reacts idempotently, and carries both to every member', async () => {
      const { a, b, c, aRef, bRef, cRef } = await threadOfThree();
      const original = unwrap(await threadSend(a, aRef, text('the far side bulges too')));
      const reply = unwrap(await threadSend(b, bRef, text('wait, really?'), original.messageId));
      const other = await threadOfThree();
      const foreign = unwrap(await threadSend(other.a, other.aRef, text('another thread')));
      expect(await threadSend(c, cRef, text('wrong thread'), foreign.messageId)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });

      const commandId = randomUUID();
      expect(unwrap(await threadReact(c, cRef, original.messageId, 'mind_blown', true, commandId))).toMatchObject({
        changed: true,
        operation: 'thread.react',
      });
      expect(unwrap(await threadReact(c, cRef, original.messageId, 'mind_blown', true, commandId))).toMatchObject({
        replayed: true,
      });
      expect(unwrap(await threadReact(c, cRef, original.messageId, 'mind_blown', true))).toMatchObject({
        changed: false,
      });
      expect(unwrap(await threadReact(b, bRef, original.messageId, 'mind_blown', true))).toMatchObject({
        changed: true,
      });

      const seen = await threadView(a, aRef);
      expect(seen.messages[1]).toMatchObject({
        replyTo: { messageId: original.messageId, original: { status: 'available' } },
      });
      expect(seen.messages[0]).toMatchObject({ reactions: [{ kind: 'mind_blown', mine: false }] });
      const first = seen.messages[0];
      expect(first?.status === 'available' && first.reactions?.[0]?.people).toHaveLength(2);
      expect(reply.messageSequence).toBe(2);
      // A person who never joined, and one who is outside, cannot react.
      expect(await threadReact(other.c, cRef, original.messageId, 'spark', true)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
    });

    it('leaves out the reaction of a person the reader blocked, for that reader only', async () => {
      const { a, b, c, aRef, bRef, cRef } = await threadOfThree();
      const message = unwrap(await threadSend(a, aRef, text('a thing to react to')));
      unwrap(await threadReact(b, bRef, message.messageId, 'ha', true));
      unwrap(await threadReact(c, cRef, message.messageId, 'ha', true));
      expect(unwrap(await friendCommand(friendsOf, c, b, 'block')).replayed).toBe(false);

      const reactionsSeenBy = async (actor: Friend, ref: ContentThreadRef) => {
        const first = (await threadView(actor, ref)).messages[0];
        return first?.status === 'available' ? first.reactions : undefined;
      };
      const ofC = await reactionsSeenBy(c, cRef);
      expect(ofC).toHaveLength(1);
      expect(ofC?.[0]?.people.map((person) => person.personId)).toEqual([c.person.personId]);
      expect(ofC?.[0]?.mine).toBe(true);
      // Everyone else, the blocked person included, sees both, so nothing tells b they were blocked.
      expect((await reactionsSeenBy(a, aRef))?.[0]?.people).toHaveLength(2);
      expect((await reactionsSeenBy(b, bRef))?.[0]?.people).toHaveLength(2);
    });
  });

  describe('the order of the people behind a reaction', () => {
    it('is by name and then person ID, whenever each of them reacted, so no order of reacting is carried', async () => {
      const { a, b, c, aRef, bRef, cRef } = await threadOfThree();
      // b and c share a name, so the tie falls to the person ID.
      for (const [person, name] of [
        [a, 'Zed'],
        [b, 'Amy'],
        [c, 'Amy'],
      ] as const)
        await database.db
          .updateTable('social.profiles')
          .set({ display_name: name })
          .where('account_id', '=', person.accountId)
          .execute();
      const first = unwrap(await threadSend(a, aRef, text('one')));
      const second = unwrap(await threadSend(a, aRef, text('two')));
      const refs = new Map([
        [a.accountId, aRef],
        [b.accountId, bRef],
        [c.accountId, cRef],
      ]);
      // The same three people react to both messages, in opposite orders and with real, different times.
      const react = async (message: { messageId: string; messageSequence: number }, order: readonly Friend[]) => {
        for (const [index, person] of order.entries()) {
          unwrap(await threadReact(person, refs.get(person.accountId)!, message.messageId, 'heart', true));
          await database.db
            .updateTable('social.message_reactions')
            .set({ reacted_at: new Date(Date.UTC(2026, 9, 1, 10, index)) })
            .where('account_id', '=', person.accountId)
            .where('message_sequence', '=', String(message.messageSequence))
            .execute();
        }
      };
      await react(first, [a, b, c]);
      await react(second, [c, b, a]);

      const byId = [b, c].sort((x, y) => (x.person.personId < y.person.personId ? -1 : 1));
      const expected = [...byId.map((person) => person.person.personId), a.person.personId];
      for (const [viewer, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const) {
        const seen = await threadView(viewer, ref);
        for (const message of seen.messages) {
          if (message.status !== 'available') throw new Error('CI message');
          expect(message.reactions?.[0]?.people.map((person) => person.personId)).toEqual(expected);
        }
      }
    });
  });

  // ---- erasure and export ----

  describe('erasure and export', () => {
    it('deleting an account removes its reactions and replaces what it reacted to in the other person’s catch-up', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const mine = unwrap(await send(a, aRef, text('a message by the person who stays')));
      const theirs = unwrap(await send(b, bRef, text('an answer by the person who leaves'), mine.messageId));
      unwrap(await react(b, bRef, mine.messageId, 'heart', true));
      unwrap(await react(a, aRef, theirs.messageId, 'spark', true));
      const cursor = (await snapshot(a, aRef)).catchUpCursor;

      const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const deleting = deleteAccountFor(database.db, boss, {
          eraseAccountData: eraseCurrentAccount,
          lockTimeoutMs: 5_000,
        });
        const receiptId = randomUUID();
        expect((await deleting.request(b.authority, { receiptId })).kind).toBe('accepted');
        expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      } finally {
        await boss.stop({ graceful: false });
      }

      // No reaction survives: the leaver's own, and the one on the message they wrote.
      expect(await reactionRows(aRef.conversationId)).toEqual([]);
      const page = await changes(a, aRef, cursor);
      const bySequence = new Map(page.changes.map((change) => [change.message.sequence, change.message]));
      // The surviving message lost the leaver's heart and is sent again; the leaver's message is a tombstone.
      expect(bySequence.get(1)).toMatchObject({ status: 'available' });
      expect(bySequence.get(1)).not.toHaveProperty('reactions');
      expect(bySequence.get(2)).toMatchObject({ status: 'unavailable' });
      const rows = await messageRows(aRef.conversationId);
      expect(rows.find((row) => row.sequence === '2')).toMatchObject({
        author_account_id: null,
        reply_to_sequence: null,
      });
      // Change numbers stay unique within the conversation.
      const numbers = rows.map((row) => row.change_sequence);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('exports a person’s own reactions and nothing of the other person', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const mine = unwrap(await send(a, aRef, text('written by asha')));
      const theirs = unwrap(await send(b, bRef, text('written by ravi'), mine.messageId));
      unwrap(await react(a, aRef, theirs.messageId, 'question', true));
      unwrap(await react(b, bRef, mine.messageId, 'heart', true));

      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const outcome = await withScope(a.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: a.accountId, reach: (ids) => Promise.resolve(new Set(ids)) }),
      );
      if (outcome.kind !== 'entered') throw new Error('CI export');
      const file = JSON.stringify(outcome.value);
      expect(outcome.value['conversations']).toMatchObject({
        reactionsGiven: 1,
        reactionsTruncated: false,
        yourReactions: [{ kind: 'question', on: 'a message from someone else' }],
      });
      expect(file).not.toContain('written by ravi');
      expect(file).not.toContain('heart');
      const reply = await withScope(b.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: b.accountId, reach: (ids) => Promise.resolve(new Set(ids)) }),
      );
      if (reply.kind !== 'entered') throw new Error('CI export');
      expect(JSON.stringify(reply.value)).toContain('wasAReply');
    });

    it('declares the new store with a Clear disposition, and Clear keeps reactions', () => {
      expect(socialErasure.accountTables?.map((table) => `${table.schema}.${table.table}`)).toContain(
        'social.message_reactions',
      );
      expect(socialErasure.clearExploration?.dispositions['social.message_reactions']).toBe('preserve');
    });
  });
});
