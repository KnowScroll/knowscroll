/**
 * "Challenge a friend" (D-244, D-245) over real PostgreSQL: a card in a direct conversation that asks the friend to call one
 * of a Scroll's questions. Each person locks their own pick; nobody sees the other's pick or the right answer before they
 * have locked, and a pick is a play result that reaches nothing else. Evidence label: fixture people and labelled CI
 * Scrolls, the real Social adapters, no HTTP, no provider and no model call.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChallengeCard, ConversationMessage, DirectConversationRef } from '@knowscroll/contracts';
import { eraseCurrentAccount, eraseCurrentExploration, personalStores } from '@knowscroll/backend/erasure-registry';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { clearExplorationFor, deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { callsOfRevision } from '../support/play.js';
import { consumptionRows, friendCommand, pairRevision, seedFriends, talkCases, type Friend } from '../support/talk.js';
import { TIDES_CALL, seedCallScroll, type SeededCallScroll } from '../support/thread-calls.js';

const direct = 'direct-conversation.v1' as const;
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('Challenge a friend (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;
  const talk = () => cases.talk.conversations;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_challenges');
    cases = talkCases(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** Asha and Ravi are friends with an open conversation, and Asha holds a Scroll whose first Call it is the tides question. */
  async function pair() {
    const { a, b } = await seedFriends(database.db, cases.friends);
    const startFor = async (actor: Friend, peer: Friend) =>
      unwrap(
        await talk().start(actor.authority, {
          version: direct,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision: await pairRevision(cases.friends, actor, peer),
        }),
      ).conversation;
    const scroll = await seedCallScroll(database.db);
    const call = (await callsOfRevision(database, { assetId: scroll.assetId, revision: 1 })).find(
      (stop) => stop.kind === 'call_it',
    )!;
    return { a, b, aRef: await startFor(a, b), bRef: await startFor(b, a), scroll, stopId: call.id };
  }

  const challenge = (
    actor: Friend,
    conversation: DirectConversationRef,
    scroll: SeededCallScroll,
    stopId: string,
    id = randomUUID(),
  ) =>
    talk().send(actor.authority, {
      version: direct,
      commandId: id,
      conversation,
      body: { kind: 'content', target: { assetId: scroll.assetId, assetRevision: 1 }, challenge: { stopId } },
    });
  const lock = (
    actor: Friend,
    conversation: DirectConversationRef,
    messageId: string,
    option: number,
    generation = 1,
  ) =>
    talk().lockChallenge(actor.authority, {
      version: direct,
      conversation,
      messageId,
      option,
      recordingGeneration: generation,
    });
  async function messagesOf(actor: Friend, conversation: DirectConversationRef): Promise<ConversationMessage[]> {
    const found = unwrap(
      await talk().read(actor.authority, { version: direct, readId: randomUUID(), conversation, limit: 50 }),
    );
    if (found.status !== 'ready') throw new Error('CI snapshot unavailable');
    return found.messages;
  }
  /** The challenge card of one message as `actor` sees it, or undefined when the message carries none. */
  async function cardOf(
    actor: Friend,
    conversation: DirectConversationRef,
    messageId: string,
  ): Promise<ChallengeCard | undefined> {
    const message = (await messagesOf(actor, conversation)).find((candidate) => candidate.messageId === messageId);
    if (message?.status !== 'available' || message.body.kind !== 'content') return undefined;
    return message.body.challenge;
  }
  const picksOf = () => database.db.selectFrom('social.thread_calls').selectAll().execute();
  const pause = (person: Friend, generation = 2) =>
    sql`update identity.universes set recording_on = false, recording_generation = ${generation} where id = ${person.universeId}::uuid`.execute(
      database.db,
    );

  describe('sending a challenge', () => {
    it('puts a card with the question and the options in both people’s conversation, and no pick and no answer', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      for (const [person, ref] of [
        [a, aRef],
        [b, bRef],
      ] as const) {
        const card = await cardOf(person, ref, sent.messageId);
        expect(card).toEqual({
          stage: 'open',
          stopId,
          prompt: TIDES_CALL.prompt,
          options: TIDES_CALL.options,
        });
      }
      expect(await picksOf()).toEqual([]);
      const json = JSON.stringify(await messagesOf(b, bRef));
      expect(json).not.toContain(TIDES_CALL.explain);
      expect(json).not.toContain(TIDES_CALL.twist);
    });

    it('refuses a stop that is not a call of the revision, and a card for content that is not there', async () => {
      const { a, aRef, scroll } = await pair();
      expect(await challenge(a, aRef, scroll, 'no-such-stop')).toEqual({ kind: 'refused', code: 'invalid_input' });
      const ghost = { ...scroll, assetId: randomUUID() };
      expect(await challenge(a, aRef, ghost, 'any-stop')).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await messagesOf(a, aRef)).toEqual([]);
    });

    it('is not consumption evidence for either person', async () => {
      const before = await consumptionRows(database.db);
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 0));
      unwrap(await lock(b, bRef, sent.messageId, 1));
      expect(await consumptionRows(database.db)).toBe(before);
    });
  });

  describe('hidden until both have called', () => {
    it('shows a person who locked first only their own pick, and the friend an open card', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      expect(unwrap(await lock(a, aRef, sent.messageId, 1))).toMatchObject({
        operation: 'challenge.lock',
        recorded: true,
        result: 'locked',
      });
      const mine = await cardOf(a, aRef, sent.messageId);
      expect(mine).toEqual({
        stage: 'locked',
        stopId,
        prompt: TIDES_CALL.prompt,
        options: TIDES_CALL.options,
        option: 1,
      });
      // The friend has not called: their card says nothing of Asha's pick, or even that she has called.
      const theirs = await cardOf(b, bRef, sent.messageId);
      expect(theirs).toEqual({ stage: 'open', stopId, prompt: TIDES_CALL.prompt, options: TIDES_CALL.options });
      expect(JSON.stringify(await messagesOf(b, bRef))).not.toContain('"option"');
      expect(JSON.stringify(mine)).not.toMatch(/answer|explain|twist|theirs/);
    });

    it('reveals both picks, the answer and why to both once the second person has called', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      unwrap(await lock(b, bRef, sent.messageId, 0));
      expect(await cardOf(b, bRef, sent.messageId)).toMatchObject({
        stage: 'revealed',
        option: 0,
        theirs: 1,
        answer: TIDES_CALL.answer,
        explain: TIDES_CALL.explain,
        right: true,
        theirsRight: false,
      });
      const first = await cardOf(a, aRef, sent.messageId);
      expect(first).toMatchObject({
        stage: 'revealed',
        option: 1,
        theirs: 0,
        right: false,
        theirsRight: true,
        twist: TIDES_CALL.twist,
      });
    });

    it('lets the first pick stand: another pick changes nothing and a pick outside the options is invalid', async () => {
      const { a, aRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 2));
      expect(unwrap(await lock(a, aRef, sent.messageId, 0))).toMatchObject({ recorded: true, result: 'stands' });
      expect(await cardOf(a, aRef, sent.messageId)).toMatchObject({ stage: 'locked', option: 2 });
      expect(await lock(a, aRef, sent.messageId, 3)).toEqual({ kind: 'refused', code: 'invalid_input' });
    });

    it('keeps no receipt and no time of a pick, and stores the option and the day alone', async () => {
      const { a, aRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      const rows = (await picksOf()).filter((row) => row.account_id === a.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.thread_id).toBe(aRef.conversationId);
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'account_id',
        'asset_id',
        'day',
        'option',
        'revision',
        'stop_id',
        'thread_id',
      ]);
      const receipts = await sql<{ operation: string }>`
        select operation from receipts.shared_commands where operation like '%challenge%'
        union all select operation from receipts.personal_commands where operation like '%challenge%'`.execute(
        database.db,
      );
      expect(receipts.rows).toEqual([]);
    });

    it('moves the message in the changes feed when a pick lands, so the friend’s open card refreshes', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      const snapshot = unwrap(
        await talk().read(b.authority, { version: direct, readId: randomUUID(), conversation: bRef, limit: 50 }),
      );
      if (snapshot.status !== 'ready') throw new Error('CI snapshot unavailable');
      const cursor = snapshot.catchUpCursor;
      unwrap(await lock(b, bRef, sent.messageId, 0));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      const page = unwrap(
        await talk().changes(b.authority, {
          version: direct,
          readId: randomUUID(),
          conversation: bRef,
          limit: 50,
          cursor,
        }),
      );
      if (page.status !== 'ready') throw new Error('CI changes unavailable');
      const changed = page.changes.find((change) => change.message.messageId === sent.messageId)?.message;
      expect(
        changed?.status === 'available' && changed.body.kind === 'content' ? changed.body.challenge?.stage : '',
      ).toBe('revealed');
    });
  });

  describe('who may lock', () => {
    it('refuses a message that is not a challenge, a stranger and the wrong conversation, all as unavailable', async () => {
      const { a, aRef, scroll, stopId } = await pair();
      const plain = unwrap(
        await talk().send(a.authority, {
          version: direct,
          commandId: randomUUID(),
          conversation: aRef,
          body: { kind: 'content', target: { assetId: scroll.assetId, assetRevision: 1 } },
        }),
      );
      expect(await lock(a, aRef, plain.messageId, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      const other = await pair();
      expect(await lock(other.a, other.aRef, sent.messageId, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await lock(other.a, aRef, sent.messageId, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('is closed to both people once either blocks the other, and nothing leaks in either direction', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      unwrap(await friendCommand(cases.friends, b, a, 'block'));
      // The blocked person and the one who blocked both lose the conversation, so neither can lock or read the card.
      expect(await lock(b, bRef, sent.messageId, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await lock(a, aRef, sent.messageId, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
      const read = unwrap(
        await talk().read(b.authority, { version: direct, readId: randomUUID(), conversation: bRef, limit: 50 }),
      );
      expect(read.status).toBe('unavailable');
      expect((await picksOf()).filter((row) => row.account_id === b.accountId)).toEqual([]);
    });
  });

  describe('recording paused (D-083)', () => {
    it('stores nothing and says why, then stores the pick once recording is on again', async () => {
      const { a, aRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      await pause(a);
      expect(unwrap(await lock(a, aRef, sent.messageId, 1, 2))).toMatchObject({
        recorded: false,
        reason: 'recording_paused',
      });
      // Recording is on again, but this device still holds the old generation: the pick is refused until it reads the new one.
      await sql`update identity.universes set recording_on = true, recording_generation = 3 where id = ${a.universeId}::uuid`.execute(
        database.db,
      );
      expect(unwrap(await lock(a, aRef, sent.messageId, 2))).toMatchObject({
        recorded: false,
        reason: 'recording_generation_stale',
      });
      expect((await picksOf()).filter((row) => row.account_id === a.accountId)).toEqual([]);
      expect(await cardOf(a, aRef, sent.messageId)).toMatchObject({ stage: 'open' });
      expect(unwrap(await lock(a, aRef, sent.messageId, 1, 3))).toMatchObject({ recorded: true, result: 'locked' });
    });

    it('still shows the card while recording is paused: reading a challenge records nothing', async () => {
      const { a, aRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      await pause(a);
      expect(await cardOf(a, aRef, sent.messageId)).toMatchObject({ stage: 'open' });
    });
  });

  describe('removal and export', () => {
    async function clearExploration(person: Friend) {
      const boss = createBoss(database.settings, 'install', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        await applyQueueDeclarations(boss, [clearExplorationQueue, recoverClearOperationsQueue]);
        const use = clearExplorationFor(database.db, boss, {
          reasoning: clearReasoning,
          eraseCore: eraseCurrentExploration,
        });
        const commandId = randomUUID();
        expect(
          await use.start(
            { accountId: person.accountId, universeId: person.universeId, privacyEpoch: 1 },
            {
              version: 'clear-exploration.v1',
              commandId,
              expectedPrivacyEpoch: 1,
              confirmation: 'clear-exploration-preserve-keep-and-social',
            },
          ),
        ).toMatchObject({ kind: 'entered', value: { kind: 'ok' } });
        await use.process({ v: 1, accountId: person.accountId, commandId });
      } finally {
        await boss.stop({ graceful: false });
      }
    }
    async function deleteAccount(person: Friend) {
      const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const deleting = deleteAccountFor(database.db, boss, {
          eraseAccountData: eraseCurrentAccount,
          lockTimeoutMs: 5_000,
        });
        const receiptId = randomUUID();
        expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
        expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      } finally {
        await boss.stop({ graceful: false });
      }
    }

    it('lists the person’s own pick in words and nothing of the friend’s or whether it was right', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      unwrap(await lock(b, bRef, sent.messageId, 2));
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const outcome = await withScope(b.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: b.accountId, reach: (ids) => Promise.resolve(new Set(ids)) }),
      );
      if (outcome.kind !== 'entered') throw new Error('CI export');
      const mine = outcome.value as { threads: { callsMade: Record<string, unknown>[] } };
      expect(mine.threads.callsMade).toEqual([
        {
          challengeFromConversation: true,
          question: TIDES_CALL.prompt,
          picked: TIDES_CALL.options[2],
          day: '2026-10-24',
        },
      ]);
      const json = JSON.stringify(mine);
      expect(json).not.toContain(TIDES_CALL.options[1]);
      expect(json).not.toMatch(/right|correct|answer/i);
    });

    it('erases the person’s picks when they Clear their exploration history', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      unwrap(await lock(b, bRef, sent.messageId, 0));
      await clearExploration(b);
      const left = await picksOf();
      expect(left.filter((row) => row.account_id === b.accountId)).toEqual([]);
      expect(left.filter((row) => row.account_id === a.accountId)).toHaveLength(1);
    });

    it('leaves the friend a locked card and tombstones the message when the sender deletes their account', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(b, bRef, sent.messageId, 0));
      await deleteAccount(a);
      const row = await database.db
        .selectFrom('social.messages')
        .selectAll()
        .where('message_id', '=', sent.messageId)
        .executeTakeFirstOrThrow();
      expect(row.challenge_stop).toBeNull();
      expect(row.author_account_id).toBeNull();
      const message = (await messagesOf(b, bRef)).find((candidate) => candidate.messageId === sent.messageId);
      expect(message?.status).toBe('unavailable');
      expect((await picksOf()).filter((pick) => pick.account_id === a.accountId)).toEqual([]);
    });

    it('erases a deleted friend’s pick, so the other person’s card falls back to locked', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 1));
      unwrap(await lock(b, bRef, sent.messageId, 0));
      await deleteAccount(b);
      expect(await cardOf(a, aRef, sent.messageId)).toMatchObject({ stage: 'locked', option: 1 });
    });
  });

  describe('the play wall (D-063)', () => {
    /**
     * A fingerprint of every table except Social's own, the receipts and pg-boss's queue tables: what a challenge and a
     * pick must never change anywhere else.
     */
    async function elsewhere(): Promise<Record<string, string>> {
      const tables = await sql<{ schema: string; name: string }>`
        select table_schema as schema, table_name as name from information_schema.tables
        where table_type = 'BASE TABLE'
          and table_schema not in ('social', 'receipts', 'pg_catalog', 'information_schema', 'pgboss', 'migrator', 'public')
        order by 1, 2`.execute(database.db);
      const result: Record<string, string> = {};
      for (const { schema, name } of tables.rows) {
        const row = await sql<{ digest: string }>`
          select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
          from ${sql.table(`${schema}.${name}`)} t`.execute(database.db);
        result[`${schema}.${name}`] = row.rows[0]!.digest;
      }
      return result;
    }

    it('sending, locking, revealing, reading and exporting a challenge change no table outside Social', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const before = await elsewhere();
      expect(Object.keys(before).length).toBeGreaterThan(50);
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      // A right pick and a wrong one, revealed and read by both.
      unwrap(await lock(a, aRef, sent.messageId, 0));
      unwrap(await lock(b, bRef, sent.messageId, 1));
      await cardOf(a, aRef, sent.messageId);
      await cardOf(b, bRef, sent.messageId);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      await withScope(b.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: b.accountId, reach: (ids) => Promise.resolve(new Set(ids)) }),
      );
      expect(await elsewhere()).toEqual(before);
    });

    it('can fail: a plain play lock outside Social does change what lies outside it', async () => {
      const before = await elsewhere();
      await seedCallScroll(database.db);
      expect(await elsewhere()).not.toEqual(before);
    });

    it('gives a right pick and a wrong one the same everything else: the row says what was picked, never whether it was right', async () => {
      const { a, b, aRef, bRef, scroll, stopId } = await pair();
      const sent = unwrap(await challenge(a, aRef, scroll, stopId));
      unwrap(await lock(a, aRef, sent.messageId, 0));
      unwrap(await lock(b, bRef, sent.messageId, 1));
      const rows = (await picksOf()).filter((row) => row.thread_id === aRef.conversationId);
      expect(rows.map((row) => row.option).sort()).toEqual([0, 1]);
      expect(JSON.stringify(rows)).not.toMatch(/correct|right/i);
    });
  });
});
