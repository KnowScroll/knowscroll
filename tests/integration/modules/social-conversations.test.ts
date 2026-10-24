/** Direct conversations over real PostgreSQL: delivery, access, idempotency, live hints and erasure. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETED_ACCOUNT_LABEL, type DirectConversationRef } from '@knowscroll/contracts';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { eraseCurrentAccount, personalStores } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import {
  afterInboxRows,
  befriend,
  consumptionRows,
  friendCommand,
  pairRevision,
  seedContent,
  seedFriend,
  seedFriends,
  talkCases,
  withdraw,
  type Friend,
  type Friends,
  type Talk,
} from '../support/talk.js';

const version = 'direct-conversation.v1' as const;
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('direct conversations (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let clock: { now: Date };
  let talkOf: Talk['conversations'];
  let friendsOf: Friends;
  let cases: ReturnType<typeof talkCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_conversations');
    cases = talkCases(database.db);
    clock = cases.clock;
    talkOf = cases.talk.conversations;
    friendsOf = cases.friends;
  });
  afterAll(async () => {
    await database.drop();
  });

  /** A text message committed directly into the tables, as a separate transaction (no use case, no locks). */
  async function commitMessage(conversationId: string, authorAccountId: string, body: string): Promise<void> {
    await database.db.transaction().execute(async (trx) => {
      const counters = await trx
        .updateTable('social.conversations')
        .set({ last_sequence: sql`last_sequence + 1`, last_change_sequence: sql`last_change_sequence + 1` })
        .where('conversation_id', '=', conversationId)
        .returning(['last_sequence', 'last_change_sequence'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('social.messages')
        .values({
          conversation_id: conversationId,
          sequence: counters.last_sequence,
          change_sequence: counters.last_change_sequence,
          message_id: randomUUID(),
          command_id: randomUUID(),
          author_account_id: authorAccountId,
          recorded_at: clock.now,
          body_text: body,
        })
        .execute();
    });
  }

  /** Both friends start; they get one conversation, each with their own membership reference. */
  async function begin(a: Friend, b: Friend) {
    const startFor = async (actor: Friend, peer: Friend) =>
      unwrap(
        await talkOf.start(actor.authority, {
          version,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision: await pairRevision(friendsOf, actor, peer),
        }),
      ).conversation;
    return { aRef: await startFor(a, b), bRef: await startFor(b, a) };
  }

  const send = (actor: Friend, conversation: DirectConversationRef, body: object, commandId = randomUUID()) =>
    talkOf.send(actor.authority, { version, commandId, conversation, body });
  const text = (value: string) => ({ kind: 'text', text: value });
  const read = (actor: Friend, conversation: DirectConversationRef, limit = 50) =>
    talkOf.read(actor.authority, { version, readId: randomUUID(), conversation, limit });
  const inbox = (actor: Friend, limit = 50, cursor?: string) =>
    talkOf.inbox(actor.authority, { version, readId: randomUUID(), limit, ...(cursor ? { cursor } : {}) });
  const changes = (actor: Friend, conversation: DirectConversationRef, cursor: string, limit = 50) =>
    talkOf.changes(actor.authority, { version, readId: randomUUID(), conversation, limit, cursor });
  const history = (actor: Friend, conversation: DirectConversationRef, cursor: string, limit = 50) =>
    talkOf.history(actor.authority, { version, readId: randomUUID(), conversation, limit, cursor });

  async function ready(actor: Friend, conversation: DirectConversationRef, limit = 50) {
    const snapshot = unwrap(await read(actor, conversation, limit));
    if (snapshot.status !== 'ready') throw new Error('CI snapshot unavailable');
    return snapshot;
  }

  describe('delivery', () => {
    it('gives both friends one conversation, delivers a text message, and retries are idempotent', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      expect(aRef.conversationId).toBe(bRef.conversationId);
      expect(aRef.membershipId).not.toBe(bRef.membershipId);

      const commandId = randomUUID();
      const first = unwrap(await send(a, aRef, text('Hello Ravi'), commandId));
      expect(first).toMatchObject({ messageSequence: 1, replayed: false, sent: { kind: 'text' } });
      const retry = unwrap(await send(a, aRef, text('Hello Ravi'), commandId));
      expect(retry).toMatchObject({ messageId: first.messageId, messageSequence: 1, replayed: true });
      expect(await send(a, aRef, text('A different body'), commandId)).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });

      const snapshot = await ready(b, bRef);
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]).toMatchObject({
        status: 'available',
        sequence: 1,
        author: { personId: a.person.personId },
        body: { kind: 'text', text: 'Hello Ravi' },
      });
      expect(snapshot.own).toEqual({ readThroughSequence: 0, muted: false });
      expect(snapshot.latestMessageSequence).toBe(1);
    });

    it('lists a conversation in both inboxes only once it has a message, newest activity first', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const c = await seedFriend(database.db, friendsOf);
      await befriend(friendsOf, a, c);
      const ab = await begin(a, b);
      const ac = await begin(a, c);
      expect(unwrap(await inbox(a))).toMatchObject({ status: 'ready', items: [] });

      unwrap(await send(a, ab.aRef, text('to b')));
      clock.now = new Date(clock.now.getTime() + 1000);
      unwrap(await send(c, ac.bRef, text('from c')));

      const mine = unwrap(await inbox(a));
      if (mine.status !== 'ready') throw new Error('CI inbox');
      expect(mine.items.map((item) => item.peer.personId)).toEqual([c.person.personId, b.person.personId]);
      expect(mine.items[0]?.lastMessage).toMatchObject({ body: { kind: 'text', text: 'from c' } });
      const theirs = unwrap(await inbox(b));
      if (theirs.status !== 'ready') throw new Error('CI inbox');
      expect(theirs.items).toHaveLength(1);
      expect(theirs.items[0]).toMatchObject({
        latestMessageSequence: 1,
        own: { readThroughSequence: 0, muted: false },
      });

      // Pages are keyset pages; a malformed cursor asks for a fresh start.
      const firstPage = unwrap(await inbox(a, 1));
      if (firstPage.status !== 'ready' || firstPage.continuation.kind !== 'more') throw new Error('CI page');
      expect(firstPage.items).toHaveLength(1);
      const secondPage = unwrap(await inbox(a, 1, firstPage.continuation.cursor));
      if (secondPage.status !== 'ready') throw new Error('CI page');
      expect(secondPage.items[0]?.peer.personId).toBe(b.person.personId);
      expect(secondPage.continuation).toEqual({ kind: 'end' });
      expect(unwrap(await inbox(a, 1, 'kci1_not-a-position-at-all-x')).status).toBe('refresh_required');
    });

    it('lists one consistent last message even when a message commits between the inbox statements', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef } = await begin(a, b);
      unwrap(await send(a, aRef, text('first')));
      // Through the API a send cannot interleave (the reader holds its own account row), so the
      // second message is committed straight into the tables, on another connection, right after
      // the inbox's first statement. The read must not depend on that lock.
      const reader = talkCases(
        database.db.withPlugin(afterInboxRows(() => commitMessage(aRef.conversationId, a.accountId, 'second'))),
        clock,
      ).talk.conversations;

      const during = unwrap(await reader.inbox(b.authority, { version, readId: randomUUID(), limit: 50 }));
      if (during.status !== 'ready') throw new Error('CI inbox');
      expect(during.items[0]).toMatchObject({
        latestMessageSequence: 1,
        lastMessage: { sequence: 1, body: { kind: 'text', text: 'first' } },
      });

      const next = unwrap(await inbox(b));
      if (next.status !== 'ready') throw new Error('CI inbox');
      expect(next.items[0]).toMatchObject({
        latestMessageSequence: 2,
        lastMessage: { sequence: 2, body: { kind: 'text', text: 'second' } },
      });
    });

    it('asks for a fresh start when an inbox cursor holds a time no date can hold', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef } = await begin(a, b);
      unwrap(await send(a, aRef, text('hello')));
      // kci1_ + base64url(version 1, 8-byte time in ms, conversation UUID): a forged time past the Date range.
      const forged = Buffer.alloc(25);
      forged[0] = 1;
      forged.writeBigUInt64BE(8_640_000_000_000_001n, 1);
      Buffer.from(aRef.conversationId.replaceAll('-', ''), 'hex').copy(forged, 9);
      expect(unwrap(await inbox(a, 1, `kci1_${forged.toString('base64url')}`)).status).toBe('refresh_required');
    });

    it('pages history oldest-last, stays gapless under concurrent sends, and catches up after a hint', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      // Twenty sends from both people at once: the pair lock hands out one gapless sequence.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          index % 2 === 0 ? send(a, aRef, text(`a${String(index)}`)) : send(b, bRef, text(`b${String(index)}`)),
        ),
      );
      expect(results.map((result) => unwrap(result).messageSequence).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );

      const latest = await ready(a, aRef, 8);
      expect(latest.messages.map((message) => message.sequence)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
      let continuation = latest.history;
      const older: number[] = [];
      while (continuation.kind === 'more') {
        const page = unwrap(await history(a, aRef, continuation.cursor, 8));
        if (page.status !== 'ready') throw new Error('CI history');
        older.unshift(...page.messages.map((message) => message.sequence));
        continuation = page.continuation;
      }
      expect(older).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

      // Catch up from the snapshot's cursor, in pages of three.
      unwrap(await send(b, bRef, text('after snapshot 1')));
      unwrap(await send(b, bRef, text('after snapshot 2')));
      unwrap(await send(b, bRef, text('after snapshot 3')));
      unwrap(await send(b, bRef, text('after snapshot 4')));
      const first = unwrap(await changes(a, aRef, latest.catchUpCursor, 3));
      if (first.status !== 'ready' || first.continuation.kind !== 'more') throw new Error('CI changes');
      expect(first.changes.map((change) => change.message.sequence)).toEqual([21, 22, 23]);
      const second = unwrap(await changes(a, aRef, first.continuation.cursor, 3));
      if (second.status !== 'ready') throw new Error('CI changes');
      expect(second.changes.map((change) => change.message.sequence)).toEqual([24]);
      expect(second.continuation.kind).toBe('caught_up');
      const none = unwrap(await changes(a, aRef, second.continuation.cursor, 3));
      if (none.status !== 'ready') throw new Error('CI changes');
      expect(none.changes).toEqual([]);

      // A cursor of another conversation or from the future is stale, never a substituted page.
      const other = await seedFriends(database.db, friendsOf);
      const otherRefs = await begin(other.a, other.b);
      const foreign = await ready(other.a, otherRefs.aRef);
      expect(unwrap(await changes(a, aRef, foreign.catchUpCursor)).status).toBe('refresh_required');
      expect(unwrap(await history(a, aRef, foreign.catchUpCursor.replace('kcc1', 'kch1'))).status).toBe(
        'refresh_required',
      );
    });

    it('keeps each person’s read position and mute private, and never moves a position back', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      for (let index = 0; index < 4; index++) unwrap(await send(a, aRef, text(`m${String(index)}`)));
      const markRead = (through: number) =>
        talkOf.markRead(b.authority, {
          version,
          commandId: randomUUID(),
          conversation: bRef,
          throughSequence: through,
        });
      expect(unwrap(await markRead(3))).toMatchObject({ requestedThroughSequence: 3, acceptedThroughSequence: 3 });
      expect(unwrap(await markRead(2))).toMatchObject({ requestedThroughSequence: 2, acceptedThroughSequence: 3 });
      expect(await markRead(9)).toEqual({ kind: 'refused', code: 'invalid_input' });
      unwrap(await talkOf.mute(b.authority, { version, commandId: randomUUID(), conversation: bRef, muted: true }));
      expect((await ready(b, bRef)).own).toEqual({ readThroughSequence: 3, muted: true });
      expect((await ready(a, aRef)).own).toEqual({ readThroughSequence: 0, muted: false });
    });

    it('creates no consumption evidence for anyone', async () => {
      const before = await consumptionRows(database.db);
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const content = await seedContent(database.db);
      unwrap(await send(a, aRef, { kind: 'content', target: { assetId: content.assetId, assetRevision: 1 } }));
      await ready(b, bRef);
      await inbox(b);
      expect(await consumptionRows(database.db)).toBe(before);
    });
  });

  describe('content cards', () => {
    it('shows an exact revision, a corrected one with the new revision named, and a withdrawn one as unavailable', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const content = await seedContent(database.db, { title: 'Why the sky is blue', revisions: 2 });
      const target = { assetId: content.assetId, assetRevision: 1 };
      unwrap(await send(a, aRef, { kind: 'content', target, note: 'Look at this' }));
      const snapshot = await ready(b, bRef);
      expect(snapshot.messages[0]).toMatchObject({
        body: {
          kind: 'content',
          note: 'Look at this',
          content: {
            status: 'corrected',
            target,
            current: { assetId: content.assetId, assetRevision: 2, metadata: { kind: 'reel' } },
          },
        },
      });
      // Only public metadata crosses: no document, source or producer fields.
      expect(JSON.stringify(snapshot.messages[0])).not.toMatch(/document|provenance|sha256|reading_facts/);

      const current = await seedContent(database.db, { kind: 'scroll', title: 'Tides' });
      const exact = { assetId: current.assetId, assetRevision: 1 };
      unwrap(await send(a, aRef, { kind: 'content', target: exact }));
      let latest = (await ready(b, bRef)).messages.at(-1);
      expect(latest).toMatchObject({
        body: { content: { status: 'available', target: exact, metadata: { kind: 'scroll', title: 'Tides' } } },
      });
      await withdraw(database.db, current.assetId);
      latest = (await ready(b, bRef)).messages.at(-1);
      expect(latest).toMatchObject({ body: { content: { status: 'unavailable', target: exact } } });
    });

    it('refuses to send withdrawn, unknown or text-only-invalid content and stores nothing', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef } = await begin(a, b);
      const content = await seedContent(database.db);
      await withdraw(database.db, content.assetId);
      for (const target of [
        { assetId: content.assetId, assetRevision: 1 },
        { assetId: randomUUID(), assetRevision: 1 },
      ])
        expect(await send(a, aRef, { kind: 'content', target })).toEqual({ kind: 'refused', code: 'unavailable' });
      expect((await ready(a, aRef)).latestMessageSequence).toBe(0);
    });
  });

  describe('access', () => {
    it('shows a stranger and a stale membership reference nothing, identically', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef } = await begin(a, b);
      unwrap(await send(a, aRef, text('private')));
      const stranger = await seedFriend(database.db, friendsOf);
      const strangerSnapshot = unwrap(await read(stranger, aRef));
      expect(strangerSnapshot.status).toBe('unavailable');
      expect(JSON.stringify(strangerSnapshot)).not.toContain('private');
      expect(await send(stranger, aRef, text('hi'))).toEqual({ kind: 'refused', code: 'unavailable' });
      const staleRef = { ...aRef, membershipId: randomUUID() };
      expect(unwrap(await read(a, staleRef)).status).toBe('unavailable');
      expect(await send(a, { ...aRef, membershipRevision: 2 }, text('x'))).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
    });

    it('closes the conversation for both when either blocks, and unblocking or re-friending does not revive it', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      unwrap(await send(a, aRef, text('before')));
      unwrap(await friendCommand(friendsOf, b, a, 'block'));
      // Neither side can read or send, and the answers do not say who blocked.
      for (const [actor, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const) {
        expect(unwrap(await read(actor, ref)).status).toBe('unavailable');
        expect(await send(actor, ref, text('after'))).toEqual({ kind: 'refused', code: 'unavailable' });
        const list = unwrap(await inbox(actor));
        expect(list.status === 'ready' && list.items).toEqual([]);
      }
      unwrap(await friendCommand(friendsOf, b, a, 'unblock'));
      expect(unwrap(await read(a, aRef)).status).toBe('unavailable');
      // Friends again under a new request (after the old request window): the old conversation
      // stays closed, a new one starts empty.
      clock.now = new Date(clock.now.getTime() + 8 * 24 * 60 * 60 * 1000);
      await befriend(friendsOf, a, b);
      expect(unwrap(await read(a, aRef)).status).toBe('unavailable');
      const fresh = await begin(a, b);
      expect(fresh.aRef.conversationId).not.toBe(aRef.conversationId);
      expect((await ready(a, fresh.aRef)).latestMessageSequence).toBe(0);
    });

    it('lets one person leave: the other keeps the history, cannot send, and a new start makes a new conversation', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      unwrap(await send(a, aRef, text('one')));
      unwrap(await send(b, bRef, text('two')));
      unwrap(await talkOf.leave(a.authority, { version, commandId: randomUUID(), conversation: aRef }));
      expect(unwrap(await read(a, aRef)).status).toBe('unavailable');
      const left = await ready(b, bRef);
      expect(left.ended).toBe(true);
      expect(left.messages).toHaveLength(2);
      expect(await send(b, bRef, text('anyone?'))).toEqual({ kind: 'refused', code: 'unavailable' });
      const listed = unwrap(await inbox(b));
      expect(listed.status === 'ready' && listed.items[0]?.ended).toBe(true);
      const fresh = await begin(b, a);
      expect(fresh.aRef.conversationId).not.toBe(bRef.conversationId);
    });

    it('refuses a start without a current friendship or with a stale pair revision', async () => {
      const a = await seedFriend(database.db, friendsOf);
      const b = await seedFriend(database.db, friendsOf);
      const start = (actor: Friend, peer: Friend, expectedPairRevision: number) =>
        talkOf.start(actor.authority, {
          version,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision,
        });
      expect(await start(a, b, 1)).toEqual({ kind: 'refused', code: 'unavailable' });
      await befriend(friendsOf, a, b);
      expect(await start(a, b, 99)).toEqual({ kind: 'refused', code: 'stale_revision' });
      expect(await start(a, a, 1)).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('answers an unknown send from the caller’s own stored message, never from another person’s', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const commandId = randomUUID();
      const sent = unwrap(await send(a, aRef, text('did it arrive?'), commandId));
      const own = unwrap(
        await talkOf.readOwnSend(a.authority, {
          version,
          readId: randomUUID(),
          conversation: aRef,
          selector: { kind: 'command', commandId },
        }),
      );
      expect(own).toMatchObject({ status: 'accepted', messageId: sent.messageId, messageSequence: 1 });
      for (const [actor, ref] of [
        [b, bRef],
        [a, aRef],
      ] as const) {
        const result = unwrap(
          await talkOf.readOwnSend(actor.authority, {
            version,
            readId: randomUUID(),
            conversation: ref,
            selector: { kind: 'command', commandId: actor === a ? randomUUID() : commandId },
          }),
        );
        expect(result.status).toBe('unavailable');
      }
    });

    it('keeps conversations through a privacy epoch change and refuses the old epoch', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef } = await begin(a, b);
      unwrap(await send(a, aRef, text('kept')));
      await database.db
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', a.universeId)
        .execute();
      const oldEpoch = await talkOf.send(a.authority, {
        version,
        commandId: randomUUID(),
        conversation: aRef,
        body: text('stale'),
      });
      expect(oldEpoch).toEqual({ kind: 'refused', code: 'unavailable' });
      const newer = { ...a.authority, privacyEpoch: 2 };
      const list = unwrap(await talkOf.inbox(newer, { version, readId: randomUUID(), limit: 10 }));
      expect(list.status === 'ready' && list.items).toHaveLength(1);
    });
  });

  describe('live hints', () => {
    it('sends one hint per member after commit, with ids and a revision only, and none for a refused send', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const listener = new pg.Client({ connectionString: database.settings.url });
      await listener.connect();
      const notices: { scope: { kind: string; id: string }; revision: number; eventId: string }[] = [];
      listener.on('notification', (message) => {
        if (message.payload) notices.push(JSON.parse(message.payload) as (typeof notices)[number]);
      });
      await listener.query('listen ks_scope_changed');
      try {
        unwrap(await send(a, aRef, text('a secret message body')));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const forA = notices.find((notice) => notice.scope.id === a.universeId);
        const forB = notices.find((notice) => notice.scope.id === b.universeId);
        expect(forA?.scope.kind).toBe('inbox');
        expect(forB?.scope.kind).toBe('inbox');
        expect(forB?.revision).toBeGreaterThan(0);
        expect(JSON.stringify(notices)).not.toContain('secret');
        expect(Object.keys(forB!).sort()).toEqual(['eventId', 'revision', 'scope', 'v']);

        unwrap(await send(b, bRef, text('reply')));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const revisions = notices.filter((notice) => notice.scope.id === a.universeId).map((n) => n.revision);
        expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
        expect(new Set(revisions).size).toBe(revisions.length);

        // A peer's reading never moves your revision; your own does.
        const before = notices.length;
        unwrap(
          await talkOf.markRead(b.authority, {
            version,
            commandId: randomUUID(),
            conversation: bRef,
            throughSequence: 1,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const fresh = notices.slice(before);
        expect(fresh.map((notice) => notice.scope.id)).toEqual([b.universeId]);

        // A refused send changes nothing and announces nothing.
        await talkOf.leave(a.authority, { version, commandId: randomUUID(), conversation: aRef });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const afterLeave = notices.length;
        expect(await send(b, bRef, text('nobody is there'))).toEqual({ kind: 'refused', code: 'unavailable' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(notices).toHaveLength(afterLeave);
      } finally {
        await listener.end();
      }
    });

    it('reads the inbox revision a subscriber is told, and it grows with committed changes only', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef } = await begin(a, b);
      const readRevision = async () => {
        const list = unwrap(await inbox(a));
        if (list.status !== 'ready') throw new Error('CI inbox');
        return list.viewRevision;
      };
      const start = await readRevision();
      unwrap(await send(a, aRef, text('one')));
      unwrap(await send(a, aRef, text('two')));
      expect(await readRevision()).toBe(start + 2);
      await ready(a, aRef);
      expect(await readRevision()).toBe(start + 2);
    });
  });

  describe('erasure', () => {
    it('after one account is deleted the other keeps a closed, readable thread with "Deleted account" in its place', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const content = await seedContent(database.db);
      unwrap(await send(a, aRef, text('mine one')));
      unwrap(await send(b, bRef, text('theirs')));
      unwrap(
        await send(a, aRef, {
          kind: 'content',
          target: { assetId: content.assetId, assetRevision: 1 },
          note: 'mine two',
        }),
      );
      const snapshot = await ready(b, bRef);
      const beforeInbox = unwrap(await inbox(b));
      expect(beforeInbox.status === 'ready' && beforeInbox.items[0]?.peer.personId).toBe(a.person.personId);
      const link = unwrap(
        await cases.talk.shares.create(a.authority, {
          version: 'content-share.v1',
          commandId: randomUUID(),
          target: { assetId: content.assetId, assetRevision: 1 },
          audience: { kind: 'public_metadata' },
        }),
      );
      if (link.delivery.status !== 'available') throw new Error('CI token');

      const listener = new pg.Client({ connectionString: database.settings.url });
      await listener.connect();
      const hints: { scope: { id: string } }[] = [];
      listener.on('notification', (message) => {
        if (message.payload) hints.push(JSON.parse(message.payload) as { scope: { id: string } });
      });
      await listener.query('listen ks_scope_changed');
      const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const deleting = deleteAccountFor(database.db, boss, {
          eraseAccountData: eraseCurrentAccount,
          lockTimeoutMs: 5_000,
        });
        const receiptId = randomUUID();
        expect((await deleting.request(a.authority, { receiptId })).kind).toBe('accepted');
        expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(hints.some((hint) => hint.scope.id === b.universeId)).toBe(true);
      } finally {
        await boss.stop({ graceful: false });
        await listener.end();
      }

      // Their link is gone; nothing of theirs is readable; the other person's words are intact.
      expect(
        unwrap(
          await cases.talk.shares.previewPublic({
            version: 'content-share.v1',
            readId: randomUUID(),
            token: link.delivery.token,
          }),
        ),
      ).toMatchObject({ status: 'unavailable' });
      const after = await ready(b, bRef);
      expect(after.ended).toBe(true);
      expect(after.peer).toMatchObject({ displayName: DELETED_ACCOUNT_LABEL });
      expect(after.peer.personId).not.toBe(a.person.personId);
      expect(after.messages.map((message) => message.status)).toEqual(['unavailable', 'available', 'unavailable']);
      expect(after.messages[1]).toMatchObject({ body: { text: 'theirs' } });
      expect(JSON.stringify(after)).not.toMatch(/mine one|mine two/);
      expect(JSON.stringify(after)).not.toContain(a.person.handle);
      expect(JSON.stringify(after)).not.toContain(a.person.personId);
      const caughtUp = unwrap(await changes(b, bRef, snapshot.catchUpCursor));
      if (caughtUp.status !== 'ready') throw new Error('CI changes');
      expect(caughtUp.ended).toBe(true);
      expect(caughtUp.changes.map((change) => [change.message.sequence, change.message.status])).toEqual([
        [1, 'unavailable'],
        [3, 'unavailable'],
      ]);
      const changeNumbers = caughtUp.changes.map((change) => change.changeSequence);
      expect(changeNumbers[0]).toBeGreaterThan(3);
      expect(changeNumbers[1]).toBeGreaterThan(changeNumbers[0]!);

      // The thread is listed with the placeholder, and can still be read, muted and left, but not written to.
      const list = unwrap(await inbox(b));
      if (list.status !== 'ready') throw new Error('CI inbox');
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ ended: true, peer: { displayName: DELETED_ACCOUNT_LABEL } });
      expect(await send(b, bRef, text('anyone?'))).toEqual({ kind: 'refused', code: 'unavailable' });
      const markRead = { version, commandId: randomUUID(), conversation: bRef, throughSequence: 3 };
      expect(unwrap(await talkOf.markRead(b.authority, markRead))).toMatchObject({
        acceptedThroughSequence: 3,
        replayed: false,
      });
      expect(unwrap(await talkOf.markRead(b.authority, markRead))).toMatchObject({ replayed: true });
      unwrap(await talkOf.mute(b.authority, { version, commandId: randomUUID(), conversation: bRef, muted: true }));
      expect((await ready(b, bRef)).own).toEqual({ readThroughSequence: 3, muted: true });
      unwrap(await talkOf.leave(b.authority, { version, commandId: randomUUID(), conversation: bRef }));
      const emptied = unwrap(await inbox(b));
      expect(emptied.status === 'ready' && emptied.items).toEqual([]);
      expect(unwrap(await read(b, bRef)).status).toBe('unavailable');
    });

    it('exports only what the person wrote and the links they made, with nothing of the other person', async () => {
      const { a, b } = await seedFriends(database.db, friendsOf);
      const { aRef, bRef } = await begin(a, b);
      const content = await seedContent(database.db);
      unwrap(await send(a, aRef, text('what asha wrote')));
      unwrap(await send(b, bRef, text('what ravi wrote')));
      unwrap(
        await send(a, aRef, { kind: 'content', target: { assetId: content.assetId, assetRevision: 1 }, note: 'look' }),
      );
      const link = unwrap(
        await cases.talk.shares.create(a.authority, {
          version: 'content-share.v1',
          commandId: randomUUID(),
          target: { assetId: content.assetId, assetRevision: 1 },
          audience: { kind: 'public_metadata' },
        }),
      );
      if (link.delivery.status !== 'available') throw new Error('CI token');
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const outcome = await withScope(a.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: a.accountId, reach: (ids) => Promise.resolve(new Set(ids)) }),
      );
      if (outcome.kind !== 'entered') throw new Error('CI export');
      const file = JSON.stringify(outcome.value);
      expect(outcome.value['conversations']).toMatchObject({ count: 1, messagesWritten: 2, truncated: false });
      expect(file).toContain('what asha wrote');
      expect(file).toContain('look');
      expect(file).not.toContain('what ravi wrote');
      expect(file).not.toContain(b.person.handle);
      expect(file).not.toContain(b.person.personId);
      expect(file).not.toContain(link.delivery.token);
      expect(outcome.value['sharedLinks']).toEqual([
        expect.objectContaining({ stopped: false, audience: 'anyone with the link' }),
      ]);
    });

    it('is declared by every new Social store with a Clear disposition', async () => {
      const stores = [
        'social.conversations',
        'social.conversation_members',
        'social.messages',
        'social.inbox_heads',
        'social.content_shares',
      ];
      for (const store of stores) {
        expect(socialErasure.accountTables?.map((table) => `${table.schema}.${table.table}`)).toContain(store);
        expect(socialErasure.clearExploration?.dispositions[store]).toBe('preserve');
      }
      // A person who never used Talk has nothing to erase.
      const loner = await seedPerson(database.db);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const outcome = await withScope(loner.authority, (scope) => socialErasure.erase(scope));
      expect(outcome).toMatchObject({ kind: 'entered', value: { removed: 0 } });
    });
  });
});
