/**
 * SEEN in direct conversations (D-066, D-150) over real PostgreSQL: a mutual switch, on by default, that only
 * decides what a conversation read returns. Evidence label: fixture people, the real Social adapters, no HTTP,
 * no provider and no model call.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef, DirectConversationRef } from '@knowscroll/contracts';
import { eraseCurrentAccount, personalStores } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { loadMigrations } from '@knowscroll/migrations';
import {
  createDatabase,
  makeWithPersonalScope,
  migrateToLatest,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { databaseUrl, quoteIdentifier, withAdmin } from '../support/admin.js';
import { seedPerson } from '../support/fixtures.js';
import {
  befriend,
  consumptionRows,
  friendCommand,
  pairRevision,
  seedFriend,
  talkCases,
  type Friend,
} from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';
import { visitCases } from '../support/visit-world.js';

const direct = 'direct-conversation.v1' as const;
const threadVersion = 'content-thread.v1' as const;
const text = (value: string) => ({ kind: 'text' as const, text: value });
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('SEEN in direct conversations (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;
  let settings: ReturnType<typeof visitCases>['visibility'];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_seen');
    cases = talkCases(database.db);
    settings = visitCases(database.db).visibility;
  });
  afterAll(async () => {
    await database.drop();
  });

  const talk = () => cases.talk.conversations;

  /** Two friends with a conversation between them and one message each way. */
  async function pair() {
    const a = await seedFriend(database.db, cases.friends);
    const b = await seedFriend(database.db, cases.friends);
    await befriend(cases.friends, a, b);
    const startFor = async (actor: Friend, peer: Friend) =>
      unwrap(
        await talk().start(actor.authority, {
          version: direct,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision: await pairRevision(cases.friends, actor, peer),
        }),
      ).conversation;
    const aRef = await startFor(a, b);
    const bRef = await startFor(b, a);
    return { a, b, aRef, bRef };
  }

  const send = async (actor: Friend, conversation: DirectConversationRef, body: string) =>
    unwrap(
      await talk().send(actor.authority, { version: direct, commandId: randomUUID(), conversation, body: text(body) }),
    );
  const markRead = async (actor: Friend, conversation: DirectConversationRef, throughSequence: number) =>
    unwrap(
      await talk().markRead(actor.authority, {
        version: direct,
        commandId: randomUUID(),
        conversation,
        throughSequence,
      }),
    );
  const snapshotOf = async (actor: Friend, conversation: DirectConversationRef) => {
    const found = unwrap(
      await talk().read(actor.authority, { version: direct, readId: randomUUID(), conversation, limit: 50 }),
    );
    if (found.status !== 'ready') throw new Error(`CI conversation is ${found.status}`);
    return found;
  };
  const changesOf = async (actor: Friend, conversation: DirectConversationRef) => {
    const cursor = (await snapshotOf(actor, conversation)).catchUpCursor;
    const page = unwrap(
      await talk().changes(actor.authority, { version: direct, readId: randomUUID(), conversation, limit: 50, cursor }),
    );
    if (page.status !== 'ready') throw new Error(`CI changes are ${page.status}`);
    return page;
  };
  /** What the person is told about the other's reading, from the snapshot and from catch-up (they must agree). */
  async function seen(actor: Friend, conversation: DirectConversationRef) {
    const fromSnapshot = (await snapshotOf(actor, conversation)).peerRead;
    const fromChanges = (await changesOf(actor, conversation)).peerRead;
    expect(fromChanges).toEqual(fromSnapshot);
    return fromSnapshot;
  }
  /** Turns the caller's own SEEN switch on or off, from the revision the server holds. */
  async function setSeen(person: Friend, shared: boolean) {
    const own = unwrap(await settings.readOwnReadReceipts(person.authority));
    return unwrap(
      await settings.setReadReceipts(person.authority, {
        version: 'sharing.v1',
        commandId: randomUUID(),
        expectedReadReceiptsRevision: own.readReceiptsRevision,
        shared,
      }),
    );
  }
  const inboxRevision = async (person: Friend) => {
    const list = unwrap(await talk().inbox(person.authority, { version: direct, readId: randomUUID(), limit: 10 }));
    if (list.status !== 'ready') throw new Error('CI inbox');
    return list.viewRevision;
  };

  /** The two positions stored for a person's membership: how far they read, and how far they read while sharing. */
  async function positionsOf(person: Friend) {
    const row = await database.db
      .selectFrom('social.conversation_members as m')
      .innerJoin('social.conversations as c', 'c.conversation_id', 'm.conversation_id')
      .select(['m.read_through_sequence as read', 'm.shared_read_through_sequence as shared'])
      .where('m.account_id', '=', person.accountId)
      .where('c.kind', '=', 'direct')
      .executeTakeFirstOrThrow();
    return { read: String(row.read), shared: String(row.shared) };
  }

  describe('the switch', () => {
    it('is on by default, and a person who never touched it has no row', async () => {
      const person = await seedFriend(database.db, cases.friends);
      expect(unwrap(await settings.readOwnReadReceipts(person.authority))).toMatchObject({
        shared: true,
        readReceiptsRevision: 1,
      });
      const rows = await database.db
        .selectFrom('social.visibility_settings')
        .select('account_id')
        .where('account_id', '=', person.accountId)
        .execute();
      expect(rows).toEqual([]);
    });

    it('turns off and on with its own revision; a repeat and a replay change nothing', async () => {
      const person = await seedFriend(database.db, cases.friends);
      const first = await setSeen(person, false);
      expect(first).toMatchObject({ baseReadReceiptsRevision: 1, acceptedReadReceiptsRevision: 2, replayed: false });
      expect(unwrap(await settings.readOwnReadReceipts(person.authority))).toMatchObject({
        shared: false,
        readReceiptsRevision: 2,
      });
      // Off again: the wanted state already holds, so the revision does not move.
      expect(await setSeen(person, false)).toMatchObject({
        baseReadReceiptsRevision: 2,
        acceptedReadReceiptsRevision: 2,
      });
      // The same command and body replays its first answer, even after the state moved on.
      const commandId = randomUUID();
      const body = { version: 'sharing.v1' as const, commandId, expectedReadReceiptsRevision: 2, shared: true };
      const accepted = unwrap(await settings.setReadReceipts(person.authority, body));
      expect(accepted).toMatchObject({ acceptedReadReceiptsRevision: 3, replayed: false });
      await setSeen(person, false);
      expect(unwrap(await settings.setReadReceipts(person.authority, body))).toMatchObject({
        acceptedReadReceiptsRevision: 3,
        replayed: true,
      });
      expect(await settings.setReadReceipts(person.authority, { ...body, shared: false })).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
    });

    it('refuses a stale revision and leaves the other settings alone', async () => {
      const person = await seedFriend(database.db, cases.friends);
      const before = unwrap(await settings.readPresencePreference(person.authority));
      expect(
        await settings.setReadReceipts(person.authority, {
          version: 'sharing.v1',
          commandId: randomUUID(),
          expectedReadReceiptsRevision: 5,
          shared: false,
        }),
      ).toEqual({ kind: 'refused', code: 'stale_revision' });
      await setSeen(person, false);
      expect(unwrap(await settings.readPresencePreference(person.authority))).toEqual(before);
      expect((await settings.readVisibility(person.authority)).kind).toBe('ok');
      // Changing the availability choice does not move the SEEN revision.
      await settings.setPresencePreference(person.authority, {
        version: 'sharing.v1',
        commandId: randomUUID(),
        expectedPresencePreferenceRevision: before.presencePreferenceRevision,
        preference: 'online',
      });
      expect(unwrap(await settings.readOwnReadReceipts(person.authority))).toMatchObject({
        shared: false,
        readReceiptsRevision: 2,
      });
    });
  });

  describe('what a conversation says', () => {
    it('shows each person how far the other has read while both share (the default)', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await send(a, aRef, 'two');
      await send(b, bRef, 'three');
      expect(await seen(a, aRef)).toEqual({ throughSequence: 0 });
      await markRead(b, bRef, 2);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 2 });
      expect(await seen(b, bRef)).toEqual({ throughSequence: 0 });
      await markRead(a, aRef, 3);
      expect(await seen(b, bRef)).toEqual({ throughSequence: 3 });
      // Never back, never past the newest.
      await markRead(b, bRef, 1);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 2 });
    });

    it('is mutual: when either person hides theirs, neither sees the other’s, and it returns when they show it again', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await send(b, bRef, 'two');
      await markRead(a, aRef, 2);
      await markRead(b, bRef, 2);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 2 });
      expect(await seen(b, bRef)).toEqual({ throughSequence: 2 });

      // A hides: A does not see B's, and B does not see A's.
      await setSeen(a, false);
      expect(await seen(a, aRef)).toBeUndefined();
      expect(await seen(b, bRef)).toBeUndefined();
      await setSeen(a, true);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 2 });
      expect(await seen(b, bRef)).toEqual({ throughSequence: 2 });

      // B hides: the same, the other way round.
      await setSeen(b, false);
      expect(await seen(a, aRef)).toBeUndefined();
      expect(await seen(b, bRef)).toBeUndefined();
      // Both hide: still nothing.
      await setSeen(a, false);
      expect(await seen(a, aRef)).toBeUndefined();
      expect(await seen(b, bRef)).toBeUndefined();
      await setSeen(a, true);
      await setSeen(b, true);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 2 });
    });

    it('gives no reason when it says nothing: the field is absent, with no flag about who hid theirs', async () => {
      const { a, b, aRef } = await pair();
      await send(a, aRef, 'one');
      await setSeen(b, false);
      const snapshot = await snapshotOf(a, aRef);
      expect(snapshot).not.toHaveProperty('peerRead');
      expect(JSON.stringify(snapshot)).not.toMatch(/shared|receipt|seen|hidden/i);
      expect(JSON.stringify(await changesOf(a, aRef))).not.toMatch(/shared|receipt|seen|hidden/i);
    });

    it('never shows what was read while the switch was off, even after it is turned on again', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await send(a, aRef, 'two');
      await send(a, aRef, 'three');
      // Read while sharing: shown.
      await markRead(b, bRef, 1);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 1 });

      // B hides, reads to the end, and shows again: A is told nothing new about it.
      await setSeen(b, false);
      await markRead(b, bRef, 3);
      expect(await positionsOf(b)).toEqual({ read: '3', shared: '1' });
      expect(await seen(a, aRef)).toBeUndefined();
      await setSeen(b, true);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 1 });
      expect((await snapshotOf(b, bRef)).own.readThroughSequence).toBe(3);
      // Asking to read what B already read changes nothing: nothing new was read while sharing.
      await markRead(b, bRef, 3);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 1 });

      // A newer message, read while sharing: shown up to there.
      await send(a, aRef, 'four');
      await markRead(b, bRef, 4);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 4 });
      expect(await positionsOf(b)).toEqual({ read: '4', shared: '4' });
    });

    it('shows nothing from a person who hid theirs before reading anything, until they read again while sharing', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await setSeen(b, false);
      await markRead(b, bRef, 1);
      await setSeen(b, true);
      // Shared, with nothing read while sharing: position 0, which the app draws as Sent.
      expect(await seen(a, aRef)).toEqual({ throughSequence: 0 });
      await send(a, aRef, 'two');
      await markRead(b, bRef, 2);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 2 });
    });

    it('still records a hidden reader’s own position for their own unread dot, and writes nothing more on a read', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await send(a, aRef, 'two');
      await setSeen(b, false);
      await markRead(b, bRef, 2);
      expect((await snapshotOf(b, bRef)).own.readThroughSequence).toBe(2);
      // The position that may be shown did not move while it was hidden.
      expect(await positionsOf(b)).toEqual({ read: '2', shared: '0' });

      // Reading a snapshot or catching up writes no row anywhere in Social: only a read command moves a position.
      const tables = ['conversation_members', 'messages', 'inbox_heads', 'visibility_settings', 'message_reactions'];
      const counts = async () => {
        const result: Record<string, string> = {};
        for (const table of tables) {
          const rows = await sql<{
            digest: string;
          }>`select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as digest
            from ${sql.table(`social.${table}`)} as t`.execute(database.db);
          result[table] = rows.rows[0]!.digest;
        }
        return result;
      };
      const before = await counts();
      await seen(a, aRef);
      await seen(b, bRef);
      expect(await counts()).toEqual(before);
    });

    it('creates no consumption evidence', async () => {
      const before = await consumptionRows(database.db);
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await markRead(b, bRef, 1);
      await seen(a, aRef);
      await setSeen(a, false);
      expect(await consumptionRows(database.db)).toBe(before);
    });
  });

  describe('the hint', () => {
    it('tells the other person’s inbox when a read moves while both share, and only the reader’s when either hides', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await send(a, aRef, 'two');
      await send(a, aRef, 'three');

      const aBefore = await inboxRevision(a);
      await markRead(b, bRef, 1);
      expect(await inboxRevision(a)).toBe(aBefore + 1);

      // A hides theirs: B's next read moves only B's own revision.
      await setSeen(a, false);
      const aHidden = await inboxRevision(a);
      const bHidden = await inboxRevision(b);
      await markRead(b, bRef, 2);
      expect(await inboxRevision(a)).toBe(aHidden);
      expect(await inboxRevision(b)).toBe(bHidden + 1);

      // B hides theirs, A shows: the reader B hides, so A is still not told.
      await setSeen(a, true);
      await setSeen(b, false);
      const aShown = await inboxRevision(a);
      await markRead(b, bRef, 3);
      expect(await inboxRevision(a)).toBe(aShown);

      // A repeated read that moves nothing tells nobody.
      await setSeen(b, true);
      const settled = [await inboxRevision(a), await inboxRevision(b)];
      await markRead(b, bRef, 3);
      expect([await inboxRevision(a), await inboxRevision(b)]).toEqual(settled);
    });
  });

  describe('the hint after the other person is gone', () => {
    it('tells only the reader’s inbox once the other person left', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      unwrap(await talk().leave(b.authority, { version: direct, commandId: randomUUID(), conversation: bRef }));
      const aBefore = await inboxRevision(a);
      const bBefore = await inboxRevision(b);
      await markRead(a, aRef, 1);
      expect(await inboxRevision(a)).toBe(aBefore + 1);
      expect(await inboxRevision(b)).toBe(bBefore);
    });

    it('tells only the reader’s inbox once the other person’s account is deleted, and creates nothing for them', async () => {
      const { a, b, aRef } = await pair();
      await send(a, aRef, 'one');
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
      const aBefore = await inboxRevision(a);
      expect(await markRead(a, aRef, 1)).toMatchObject({ acceptedThroughSequence: 1 });
      expect(await inboxRevision(a)).toBe(aBefore + 1);
      const heads = await database.db
        .selectFrom('social.inbox_heads')
        .select('account_id')
        .where('account_id', '=', b.accountId)
        .execute();
      expect(heads).toEqual([]);
    });
  });

  describe('where it never shows', () => {
    it('shows nothing once the other person left, and nothing to a blocked person', async () => {
      const left = await pair();
      await send(left.a, left.aRef, 'one');
      await markRead(left.b, left.bRef, 1);
      expect(await seen(left.a, left.aRef)).toEqual({ throughSequence: 1 });
      unwrap(
        await talk().leave(left.b.authority, { version: direct, commandId: randomUUID(), conversation: left.bRef }),
      );
      const ended = await snapshotOf(left.a, left.aRef);
      expect(ended.ended).toBe(true);
      expect(ended).not.toHaveProperty('peerRead');
      expect(await changesOf(left.a, left.aRef)).not.toHaveProperty('peerRead');

      const blocked = await pair();
      await send(blocked.a, blocked.aRef, 'one');
      await markRead(blocked.b, blocked.bRef, 1);
      expect((await friendCommand(cases.friends, blocked.a, blocked.b, 'block')).kind).toBe('ok');
      for (const [actor, conversation] of [
        [blocked.a, blocked.aRef],
        [blocked.b, blocked.bRef],
      ] as const)
        expect(
          unwrap(
            await talk().read(actor.authority, { version: direct, readId: randomUUID(), conversation, limit: 50 }),
          ),
        ).toMatchObject({ status: 'unavailable' });
    });

    it('shows nothing once the other person’s account is gone', async () => {
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await markRead(b, bRef, 1);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 1 });
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
      const gone = await snapshotOf(a, aRef);
      expect(gone.ended).toBe(true);
      expect(gone).not.toHaveProperty('peerRead');
    });

    it('is never in a content thread: no member’s reading position reaches another', async () => {
      const a = await seedFriend(database.db, cases.friends);
      const b = await seedFriend(database.db, cases.friends);
      await befriend(cases.friends, a, b);
      const reel = await seedReel(database.db);
      const started = unwrap(
        await cases.threads.create(a.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          root: { assetId: reel.assetId, assetRevision: 1 },
          friendPersonIds: [b.person.personId],
          name: 'Black holes',
        }),
      );
      const invitation = unwrap(
        await cases.threads.inbox(b.authority, { version: threadVersion, readId: randomUUID(), limit: 50 }),
      ).items[0]!;
      const thread: ContentThreadRef = invitation.thread;
      unwrap(
        await cases.threads.respond(b.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread,
          response: 'join',
        }),
      );
      unwrap(
        await cases.threads.send(a.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread: started.thread,
          body: text('hello'),
        }),
      );
      unwrap(
        await cases.threads.markRead(b.authority, {
          version: threadVersion,
          commandId: randomUUID(),
          thread,
          throughSequence: 1,
        }),
      );
      const answer = unwrap(
        await cases.threads.read(a.authority, {
          version: threadVersion,
          readId: randomUUID(),
          thread: started.thread,
          limit: 50,
        }),
      );
      expect(answer.status).toBe('ready');
      expect(JSON.stringify(answer)).not.toMatch(/peerRead|seen|readBy/i);
      // Asha's own position is hers alone: Ravi's read of the message does not show in her answer.
      expect(answer.status === 'ready' && answer.own.readThroughSequence).toBe(0);
    });
  });

  describe('migration 0078', () => {
    it('starts every direct conversation with the shared position equal to the read position, and a thread member at 0', async () => {
      const name = `ks_it_seen_backfill_${randomUUID().replaceAll('-', '')}`;
      await withAdmin((client) => client.query(`create database ${quoteIdentifier(name)} template template0`));
      const handle = createDatabase(
        { ...database.settings, url: databaseUrl(name) },
        { onIdleClientError: () => undefined },
      );
      try {
        const migrations = loadMigrations();
        const index = migrations.findIndex((migration) => migration.name === '0078_read_receipts');
        expect(index).toBeGreaterThan(0);
        expect((await migrateToLatest(handle.db, migrations.slice(0, index))).kind).toBe('migrated');
        const typed = handle.db as unknown as Kysely<Database>;
        const [first, second] = [await seedPerson(typed), await seedPerson(typed)];
        const now = new Date('2026-10-30T08:00:00Z');
        const [direct, thread] = [randomUUID(), randomUUID()];
        await typed
          .insertInto('social.conversations')
          .values([
            { conversation_id: direct, lineage: randomUUID(), last_activity_at: now, created_at: now, closed_at: now },
            {
              conversation_id: thread,
              lineage: randomUUID(),
              last_activity_at: now,
              created_at: now,
              closed_at: now,
              kind: 'thread',
            },
          ])
          .execute();
        await typed
          .insertInto('social.conversation_members')
          .values([
            {
              conversation_id: direct,
              account_id: first.accountId,
              membership_id: randomUUID(),
              read_through_sequence: 5,
            },
            {
              conversation_id: direct,
              account_id: second.accountId,
              membership_id: randomUUID(),
              read_through_sequence: 0,
            },
            {
              conversation_id: thread,
              account_id: first.accountId,
              membership_id: randomUUID(),
              read_through_sequence: 7,
            },
          ])
          .execute();

        expect((await migrateToLatest(handle.db, migrations.slice(0, index + 1))).kind).toBe('migrated');
        const rows = await typed
          .selectFrom('social.conversation_members')
          .select(['conversation_id', 'account_id', 'read_through_sequence', 'shared_read_through_sequence'])
          .execute();
        const positionOf = (conversation: string, account: string) => {
          const row = rows.find(
            (candidate) => candidate.conversation_id === conversation && candidate.account_id === account,
          );
          return [String(row?.read_through_sequence), String(row?.shared_read_through_sequence)];
        };
        expect(positionOf(direct, first.accountId)).toEqual(['5', '5']);
        expect(positionOf(direct, second.accountId)).toEqual(['0', '0']);
        // A thread never tells a member where another has read.
        expect(positionOf(thread, first.accountId)).toEqual(['7', '0']);
        // The shared position can never be ahead of the read position.
        await expect(
          sql`update social.conversation_members set shared_read_through_sequence = read_through_sequence + 1
            where conversation_id = ${direct}::uuid and account_id = ${first.accountId}::uuid`.execute(handle.db),
        ).rejects.toThrow();
      } finally {
        await handle.close();
        await withAdmin((client) => client.query(`drop database ${quoteIdentifier(name)} with (force)`));
      }
      // Migrating a database from nothing is slow on a busy machine.
    }, 180_000);
  });

  describe('erasure and export', () => {
    it('exports the switch in words, for the person alone', async () => {
      const { a, b } = await pair();
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const exportOf = async (person: Friend) => {
        const outcome = await withScope(person.authority, (scope) =>
          socialErasure.export!.read(scope, {
            accountId: person.accountId,
            reach: (ids) => Promise.resolve(new Set(ids)),
          }),
        );
        if (outcome.kind !== 'entered') throw new Error('CI export');
        return outcome.value as { sharing: { seenInDirectConversations: string } };
      };
      expect((await exportOf(a)).sharing.seenInDirectConversations).toMatch(/^on:/);
      await setSeen(a, false);
      expect((await exportOf(a)).sharing.seenInDirectConversations).toMatch(/^off:/);
      // Ravi's file does not carry Asha's choice.
      expect((await exportOf(b)).sharing.seenInDirectConversations).toMatch(/^on:/);
    });

    it('keeps the switch and what was shared through Clear, and removes the switch with the account', async () => {
      expect(socialErasure.clearExploration?.dispositions['social.visibility_settings']).toBe('preserve');
      const { a, b, aRef, bRef } = await pair();
      await send(a, aRef, 'one');
      await markRead(b, bRef, 1);
      await setSeen(b, false);
      // Clear runs Social's erase for each person's universe (the published copy); conversations and choices stay.
      const clearing = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      for (const person of [a, b])
        expect(await clearing(person.authority, (scope) => socialErasure.erase(scope))).toMatchObject({
          kind: 'entered',
          value: { status: 'completed' },
        });
      expect(unwrap(await settings.readOwnReadReceipts(b.authority))).toMatchObject({ shared: false });
      expect(unwrap(await settings.readOwnReadReceipts(a.authority))).toMatchObject({ shared: true });
      expect(await positionsOf(b)).toEqual({ read: '1', shared: '1' });
      await setSeen(b, true);
      expect(await seen(a, aRef)).toEqual({ throughSequence: 1 });
      await setSeen(b, false);
      const row = () =>
        database.db
          .selectFrom('social.visibility_settings')
          .select('share_read_state')
          .where('account_id', '=', b.accountId)
          .executeTakeFirst();
      expect(await row()).toEqual({ share_read_state: false });
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
      expect(await row()).toBeUndefined();
    });
  });
});
