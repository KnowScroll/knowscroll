/**
 * "Call it together" in content threads (D-155 to D-157) over real PostgreSQL: each member locks a pick on the call of a
 * part before they start it, nobody sees another's pick until they have locked and the party has finished the part, and
 * a pick is a play result that reaches nothing else. Evidence label: fixture people and labelled CI Scrolls, the real
 * Social adapters, no HTTP, no provider and no model call.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef, ThreadCall } from '@knowscroll/contracts';
import { eraseCurrentAccount, eraseCurrentExploration, personalStores } from '@knowscroll/backend/erasure-registry';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { clearExplorationFor, deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { befriend, friendCommand, seedFriend, talkCases, type Friend } from '../support/talk.js';
import {
  GUESS_SOURCE,
  TIDES_CALL,
  seedCallRevision,
  seedCallScroll,
  type CallFixture,
} from '../support/thread-calls.js';
import { activateFor, declareSeries, seedReel } from '../support/thread-fixtures.js';

const version = 'content-thread.v1' as const;
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

/** The first of the series whose part number is given, or a failure that names it. */
function callOf(calls: readonly ThreadCall[], part: number): ThreadCall {
  const call = calls.find((candidate) => candidate.part === part);
  if (call === undefined) throw new Error(`CI expected a call for part ${String(part)}`);
  return call;
}

describe('Call it together (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_calls');
    cases = talkCases(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const threads = () => cases.threads;

  /**
   * Asha started a thread on a series of three: two Scrolls that each have an authored call (the right answer is
   * option 0) and a Reel, which has none. Ravi and Kenji both joined.
   */
  async function party(options: { readonly part2?: CallFixture; readonly rootPart?: 1 | 2 } = {}) {
    const [a, b, c] = [
      await seedFriend(database.db, cases.friends),
      await seedFriend(database.db, cases.friends),
      await seedFriend(database.db, cases.friends),
    ] as [Friend, Friend, Friend];
    await befriend(cases.friends, a, b);
    await befriend(cases.friends, a, c);
    const scrolls = [await seedCallScroll(database.db), await seedCallScroll(database.db, options.part2)];
    const reel = await seedReel(database.db);
    const seriesId = `ci-series-${randomUUID()}`;
    await declareSeries(database.db, seriesId, [...scrolls, reel]);
    const root = { assetId: scrolls[options.rootPart === 2 ? 1 : 0]!.assetId, assetRevision: 1 };
    const started = unwrap(
      await threads().create(a.authority, {
        version,
        commandId: randomUUID(),
        root,
        friendPersonIds: [b.person.personId, c.person.personId],
      }),
    );
    const invitation = async (person: Friend): Promise<ContentThreadRef> => {
      const inbox = unwrap(await threads().inbox(person.authority, { version, readId: randomUUID(), limit: 50 }));
      const item = inbox.items.find((candidate) => candidate.state === 'invited');
      if (!item) throw new Error('CI invitation missing');
      return item.thread;
    };
    const refs = { a: started.thread, b: await invitation(b), c: await invitation(c) };
    for (const [person, ref] of [
      [b, refs.b],
      [c, refs.c],
    ] as const)
      unwrap(
        await threads().respond(person.authority, { version, commandId: randomUUID(), thread: ref, response: 'join' }),
      );
    return { a, b, c, scrolls, reel, refs, seriesId };
  }

  const lock = (actor: Friend, thread: ContentThreadRef, part: number, option: number, generation = 1) =>
    threads().lockCall(actor.authority, { version, thread, part, option, recordingGeneration: generation });
  const calls = async (actor: Friend, thread: ContentThreadRef) => {
    const answer = unwrap(await threads().calls(actor.authority, { version, readId: randomUUID(), thread }));
    if (answer.status !== 'ready') throw new Error(`CI calls are ${answer.status}`);
    return answer.calls;
  };
  const call = async (actor: Friend, thread: ContentThreadRef, part: number) =>
    callOf(await calls(actor, thread), part);
  const place = (actor: Friend, thread: ContentThreadRef, part: number, state: 'on' | 'finished') =>
    threads().setPlace(actor.authority, { version, thread, part, state });
  const hideNow = async (actor: Friend, thread: ContentThreadRef, hidden: boolean) =>
    unwrap(await threads().setPlaceHidden(actor.authority, { version, thread, hidden }));
  const leave = async (actor: Friend, thread: ContentThreadRef) =>
    unwrap(await threads().leave(actor.authority, { version, commandId: randomUUID(), thread }));
  const rowsOf = (person: Friend) =>
    database.db.selectFrom('social.thread_calls').selectAll().where('account_id', '=', person.accountId).execute();
  const inboxRevision = async (person: Friend) =>
    unwrap(await threads().inbox(person.authority, { version, readId: randomUUID(), limit: 10 })).viewRevision;
  const pause = (person: Friend, generation = 2) =>
    sql`update identity.universes set recording_on = false, recording_generation = ${generation} where id = ${person.universeId}::uuid`.execute(
      database.db,
    );
  /** The person's real, sealed Clear of exploration history (epoch 1 to 2). */
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

  describe('which parts have a call', () => {
    it('is the first Call it of each Scroll in the series, and none for a Reel', async () => {
      const { a, refs } = await party();
      const all = await calls(a, refs.a);
      expect(all.map((entry) => entry.part)).toEqual([1, 2]);
      expect(all[0]).toMatchObject({
        stage: 'open',
        prompt: TIDES_CALL.prompt,
        options: TIDES_CALL.options,
        called: 0,
        of: 3,
      });
    });

    it('has no call in a thread on a single item, and refuses to lock one', async () => {
      const [a, b] = [await seedFriend(database.db, cases.friends), await seedFriend(database.db, cases.friends)];
      await befriend(cases.friends, a, b);
      const scroll = await seedCallScroll(database.db);
      const started = unwrap(
        await threads().create(a.authority, {
          version,
          commandId: randomUUID(),
          root: { assetId: scroll.assetId, assetRevision: 1 },
          friendPersonIds: [b.person.personId],
        }),
      );
      expect(await calls(a, started.thread)).toEqual([]);
      expect(await lock(a, started.thread, 1, 0)).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(await rowsOf(a)).toEqual([]);
    });
  });

  describe('hidden until you lock, and until the party has finished', () => {
    it('shows counts and your own pick, and nothing of anyone else’s, before the reveal', async () => {
      const { a, b, c, refs } = await party();
      expect(unwrap(await lock(b, refs.b, 2, 1))).toMatchObject({
        operation: 'thread.call-lock',
        recorded: true,
        part: 2,
        result: 'locked',
      });
      unwrap(await lock(c, refs.c, 2, 0));
      // Asha has not locked: counts only, and no word of who or what.
      const open = await call(a, refs.a, 2);
      expect(open).toMatchObject({ stage: 'open', called: 2, of: 3 });
      expect(JSON.stringify(open)).not.toMatch(/"option"|answer|explain|twist|picks|right/);
      expect(JSON.stringify(open)).not.toContain(b.person.handle);
      // Ravi locked: he sees his own pick and the count, and not Kenji's pick or the answer.
      const own = await call(b, refs.b, 2);
      expect(own).toMatchObject({ stage: 'locked', option: 1, called: 2, of: 3 });
      expect(JSON.stringify(own)).not.toMatch(/answer|explain|twist|picks|right/);
      expect(JSON.stringify(own)).not.toContain(c.person.handle);
    });

    it('waits for every member who shares where they are to finish the part, then reveals to those who locked', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await lock(b, refs.b, 2, 1));
      unwrap(await place(a, refs.a, 2, 'finished'));
      unwrap(await place(b, refs.b, 2, 'finished'));
      // Kenji shares that he is still on Part 1: the party waits for him.
      unwrap(await place(c, refs.c, 1, 'on'));
      expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'locked', option: 0 });
      unwrap(await place(c, refs.c, 2, 'finished'));
      const revealed = await call(a, refs.a, 2);
      expect(revealed).toMatchObject({
        stage: 'revealed',
        option: 0,
        answer: TIDES_CALL.answer,
        explain: TIDES_CALL.explain,
        right: true,
        rightCount: 1,
        called: 2,
        of: 3,
      });
      if (revealed.stage !== 'revealed') throw new Error('expected a reveal');
      // Everyone who called, by option and then by name, and no time on the wire.
      expect(revealed.picks).toEqual([
        { person: a.person, you: true, option: 0, right: true },
        { person: b.person, you: false, option: 1, right: false },
      ]);
      expect(revealed.twist).toBeUndefined();
      expect(JSON.stringify(revealed)).not.toMatch(/\d{2}:\d{2}/);
      // Ravi called wrong: his reveal carries the warm second look, and costs him nothing.
      const wrong = await call(b, refs.b, 2);
      expect(wrong).toMatchObject({ stage: 'revealed', option: 1, right: false, twist: TIDES_CALL.twist });
    });

    it('never reveals to a member who has not locked, even when everyone has finished', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(b, refs.b, 2, 0));
      for (const [who, ref] of [
        [b, refs.b],
        [c, refs.c],
      ] as const)
        unwrap(await place(who, ref, 2, 'finished'));
      const closed = await call(a, refs.a, 2);
      expect(closed).toMatchObject({ stage: 'closed', reason: 'revealed', called: 1, of: 3 });
      expect(JSON.stringify(closed)).not.toMatch(/answer|explain|twist|picks|right|"option"/);
      // And the call is closed to him: he cannot lock now that others have found out.
      expect(unwrap(await lock(a, refs.a, 2, 0))).toMatchObject({ recorded: true, result: 'closed' });
      expect(await rowsOf(a)).toEqual([]);
    });

    it('does not wait for a member who never calls: only for those who share and have not finished', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await place(a, refs.a, 2, 'finished'));
      unwrap(await place(b, refs.b, 2, 'finished'));
      // Kenji never calls and shares nothing, so nobody waits for him.
      expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', called: 1, of: 3 });
    });

    it('does not wait for a member who hides where they are, who has no place, who left or was removed', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await place(a, refs.a, 2, 'finished'));
      unwrap(await place(b, refs.b, 1, 'on'));
      unwrap(await place(c, refs.c, 1, 'on'));
      expect((await call(a, refs.a, 2)).stage).toBe('locked');
      await hideNow(b, refs.b, true);
      expect((await call(a, refs.a, 2)).stage).toBe('locked');
      // Kenji leaves; Ravi hides; the party is Asha alone and has finished.
      await leave(c, refs.c);
      expect((await call(a, refs.a, 2)).stage).toBe('revealed');
    });

    it('opens by itself on the second day after the first lock, so a member who never finishes cannot hold the party', async () => {
      const { a, b, refs } = await party();
      cases.clock.now = new Date('2026-10-24T23:59:59Z');
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await place(b, refs.b, 1, 'on'));
      unwrap(await place(a, refs.a, 2, 'finished'));
      try {
        expect((await call(a, refs.a, 2)).stage).toBe('locked');
        cases.clock.now = new Date('2026-10-25T23:59:59Z');
        expect((await call(a, refs.a, 2)).stage).toBe('locked');
        cases.clock.now = new Date('2026-10-26T00:00:00Z');
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', answer: TIDES_CALL.answer });
      } finally {
        cases.clock.now = new Date('2026-10-24T08:00:00Z');
      }
    });

    it('opens by the clock when nobody shares a place at all, and not before', async () => {
      const { a, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 2));
      try {
        expect((await call(a, refs.a, 2)).stage).toBe('locked');
        cases.clock.now = new Date('2026-10-26T08:00:00Z');
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', option: 2, right: false });
      } finally {
        cases.clock.now = new Date('2026-10-24T08:00:00Z');
      }
    });

    it('is a guess made before the part: a member who has started it, or finished it, cannot lock', async () => {
      const { b, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'on'));
      expect(await call(b, refs.b, 2)).toMatchObject({ stage: 'closed', reason: 'started' });
      expect(unwrap(await lock(b, refs.b, 2, 0))).toMatchObject({ result: 'closed' });
      expect(await rowsOf(b)).toEqual([]);
      // A place further along has started every part before it too.
      expect(unwrap(await lock(b, refs.b, 1, 0))).toMatchObject({ result: 'closed' });
      expect(await rowsOf(b)).toEqual([]);
    });

    it('keeps a call locked before the part, after the member starts it', async () => {
      const { b, refs } = await party();
      unwrap(await lock(b, refs.b, 2, 1));
      unwrap(await place(b, refs.b, 2, 'on'));
      expect(await call(b, refs.b, 2)).toMatchObject({ stage: 'locked', option: 1 });
    });
  });

  describe('a lock', () => {
    it('stands once: a repeat or another pick answers stands and changes nothing', async () => {
      const { b, refs } = await party();
      expect(unwrap(await lock(b, refs.b, 1, 1))).toMatchObject({ result: 'locked' });
      expect(unwrap(await lock(b, refs.b, 1, 1))).toMatchObject({ result: 'stands' });
      expect(unwrap(await lock(b, refs.b, 1, 2))).toMatchObject({ result: 'stands' });
      expect((await rowsOf(b)).map((row) => [row.revision, row.option])).toEqual([[1, 1]]);
    });

    it('refuses a part with no call, a part the series lacks and an option the call lacks, and writes nothing', async () => {
      const { b, refs } = await party();
      for (const [part, option] of [
        [3, 0],
        [4, 0],
        [1, 3],
      ] as const)
        expect(await lock(b, refs.b, part, option)).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(await lock(b, refs.b, 0, 0)).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(await rowsOf(b)).toEqual([]);
    });

    it('is judged from the stored revision: the command carries no correctness', async () => {
      const { b, refs } = await party();
      const body = { version, thread: refs.b, part: 1, option: 0, recordingGeneration: 1, correct: false };
      expect(await threads().lockCall(b.authority, body)).toEqual({ kind: 'refused', code: 'invalid_input' });
      unwrap(await lock(b, refs.b, 1, 0));
      unwrap(await place(b, refs.b, 1, 'finished'));
      expect(await call(b, refs.b, 1)).toMatchObject({ stage: 'revealed', right: true, answer: 0 });
    });

    it('stores nothing while recording is paused, or with a stale generation, and says so', async () => {
      const { b, c, refs } = await party();
      await pause(b);
      expect(unwrap(await lock(b, refs.b, 1, 0, 1))).toEqual({
        version,
        scope: { accountId: b.accountId, privacyEpoch: 1 },
        operation: 'thread.call-lock',
        recorded: false,
        reason: 'recording_paused',
        currentGeneration: 2,
      });
      expect(await rowsOf(b)).toEqual([]);
      // Reading still works while paused.
      expect(await call(b, refs.b, 1)).toMatchObject({ stage: 'open', called: 0 });
      // A client that read the policy before it changed is told to read it again.
      expect(unwrap(await lock(c, refs.c, 1, 0, 3))).toMatchObject({
        recorded: false,
        reason: 'recording_generation_stale',
        currentGeneration: 1,
      });
      expect(await rowsOf(c)).toEqual([]);
    });

    it('is only the caller’s own pick: no command can write for another member', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(b, refs.b, 1, 1));
      expect(await rowsOf(a)).toEqual([]);
      expect((await rowsOf(b)).map((row) => row.option)).toEqual([1]);
    });

    it('tells every member’s inbox when someone calls, and nobody when nothing changed', async () => {
      const { a, b, refs } = await party();
      const before = await inboxRevision(a);
      unwrap(await lock(b, refs.b, 1, 0));
      const afterFirst = await inboxRevision(a);
      expect(afterFirst).toBeGreaterThan(before);
      unwrap(await lock(b, refs.b, 1, 0));
      expect(await inboxRevision(a)).toBe(afterFirst);
    });
  });

  describe('who can read or write', () => {
    it('gives a stranger, an invitee who has not joined and a leaver nothing', async () => {
      const { b, refs } = await party();
      const stranger = await seedFriend(database.db, cases.friends);
      unwrap(await lock(b, refs.b, 1, 0));
      expect(
        unwrap(await threads().calls(stranger.authority, { version, readId: randomUUID(), thread: refs.b })),
      ).toMatchObject({
        status: 'unavailable',
      });
      expect(await lock(stranger, refs.b, 1, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
      await leave(b, refs.b);
      expect(
        unwrap(await threads().calls(b.authority, { version, readId: randomUUID(), thread: refs.b })),
      ).toMatchObject({
        status: 'unavailable',
      });
      expect(await lock(b, refs.b, 2, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('refuses a stale membership reference without saying why', async () => {
      const { b, refs } = await party();
      const stale = { ...refs.b, membershipRevision: refs.b.membershipRevision + 5 };
      expect(await lock(b, stale, 1, 0)).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('never counts or shows a pick whose member no longer takes part, even if the row survived', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await lock(b, refs.b, 2, 1));
      await leave(b, refs.b);
      await database.db
        .insertInto('social.thread_calls')
        .values({
          thread_id: refs.b.threadId,
          account_id: b.accountId,
          asset_id: (await rowsOf(a))[0]!.asset_id,
          revision: 1,
          stop_id: (await rowsOf(a))[0]!.stop_id,
          option: 1,
          day: '2026-10-24',
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      expect(await call(a, refs.a, 2)).toMatchObject({ called: 1, of: 2 });
    });
  });

  describe('a block, in either direction', () => {
    it('hides the blocked member’s pick, count and progress from the blocker and the blocked, and holds the reveal for neither', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await lock(b, refs.b, 2, 1));
      unwrap(await lock(c, refs.c, 2, 0));
      unwrap(await place(a, refs.a, 2, 'finished'));
      unwrap(await place(c, refs.c, 2, 'finished'));
      // Ravi is still on Part 1 and shares it: the party waits for him.
      unwrap(await place(b, refs.b, 1, 'on'));
      expect((await call(a, refs.a, 2)).stage).toBe('locked');
      // Kenji and Ravi both joined on Asha's invitation, so neither membership rests on their own friendship.
      expect((await friendCommand(cases.friends, c, b, 'block')).kind).toBe('ok');
      const kenji = await call(c, refs.c, 2);
      expect(kenji).toMatchObject({ stage: 'revealed', called: 2, of: 2 });
      if (kenji.stage !== 'revealed') throw new Error('expected a reveal');
      expect(kenji.picks.map((pick) => pick.person.personId).sort()).toEqual(
        [a.person.personId, c.person.personId].sort(),
      );
      // Ravi, who was blocked, sees the same mask from his side: Kenji is not counted and does not hold anything.
      expect(await call(b, refs.b, 2)).toMatchObject({ stage: 'locked', called: 2, of: 2 });
      // Asha blocked nobody and still waits for Ravi, and the rows are all still there.
      expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'locked', called: 3, of: 3 });
      expect(await rowsOf(b)).toHaveLength(1);
      expect((await friendCommand(cases.friends, c, b, 'unblock')).kind).toBe('ok');
      expect(await call(c, refs.c, 2)).toMatchObject({ stage: 'locked', called: 3, of: 3 });
    });
  });

  describe('removed on leave, an ended friendship, Clear and deletion', () => {
    it('removes a member’s picks when they leave, and the count with them', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(b, refs.b, 1, 1));
      unwrap(await lock(b, refs.b, 2, 1));
      expect(await call(a, refs.a, 2)).toMatchObject({ called: 1 });
      await leave(b, refs.b);
      expect(await rowsOf(b)).toEqual([]);
      expect(await call(a, refs.a, 2)).toMatchObject({ called: 0, of: 2 });
    });

    it('removes the picks of someone the inviter blocks or removes as a friend: their standing ended', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(b, refs.b, 1, 1));
      unwrap(await lock(c, refs.c, 1, 0));
      unwrap(await lock(a, refs.a, 1, 0));
      expect((await friendCommand(cases.friends, a, b, 'block')).kind).toBe('ok');
      expect(await rowsOf(b)).toEqual([]);
      expect((await friendCommand(cases.friends, a, c, 'remove')).kind).toBe('ok');
      expect(await rowsOf(c)).toEqual([]);
      // The inviter's own pick stays: their membership does not rest on a friendship.
      expect(await rowsOf(a)).toHaveLength(1);
    });

    it('removes a person’s picks on Clear, and keeps the others’ and the thread', async () => {
      expect(socialErasure.clearExploration?.dispositions['social.thread_calls']).toBe('erase');
      const { a, b, refs } = await party();
      unwrap(await lock(b, refs.b, 1, 1));
      unwrap(await lock(a, refs.a, 1, 0));
      await clearExploration(b);
      expect(await rowsOf(b)).toEqual([]);
      expect(await rowsOf(a)).toHaveLength(1);
      expect(await call(a, refs.a, 1)).toMatchObject({ stage: 'locked', called: 1 });
      // The person who cleared is still a member and can call again from their new epoch.
      const after: Friend = { ...b, authority: { ...b.authority, privacyEpoch: 2 } };
      expect(unwrap(await lock(after, refs.b, 1, 0))).toMatchObject({ result: 'locked' });
    });

    it('removes a person’s picks with their account, and the thread goes on for the others', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(b, refs.b, 1, 1));
      unwrap(await lock(c, refs.c, 1, 0));
      await deleteAccount(b);
      expect(await rowsOf(b)).toEqual([]);
      expect(await call(a, refs.a, 1)).toMatchObject({ called: 1, of: 2 });
    });

    it('removes the picks of invitees whose friendship had ended when their inviter deletes their account', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(b, refs.b, 1, 1));
      const own = (await rowsOf(b))[0]!;
      await friendCommand(cases.friends, a, b, 'remove');
      expect(await rowsOf(b)).toEqual([]);
      // A stray row of the removed member must not survive the inviter: it is deleted with their membership.
      await database.db.insertInto('social.thread_calls').values(own).execute();
      await deleteAccount(a);
      expect(await rowsOf(b)).toEqual([]);
    });
  });

  describe('export', () => {
    it('lists the person’s own picks in words, with the day, and nothing about anyone else or whether they were right', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(a, refs.a, 1, 0));
      unwrap(await lock(b, refs.b, 1, 2));
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const exportOf = async (person: Friend) => {
        const outcome = await withScope(person.authority, (scope) =>
          socialErasure.export!.read(scope, {
            accountId: person.accountId,
            reach: (ids) => Promise.resolve(new Set(ids)),
          }),
        );
        if (outcome.kind !== 'entered') throw new Error('CI export');
        return outcome.value as { threads: { callsMade: Record<string, unknown>[] } };
      };
      const mine = await exportOf(b);
      expect(mine.threads.callsMade).toEqual([
        { question: TIDES_CALL.prompt, picked: TIDES_CALL.options[2], day: '2026-10-24' },
      ]);
      const json = JSON.stringify(mine);
      expect(json).not.toContain(a.person.handle);
      expect(json).not.toContain(TIDES_CALL.options[0]);
      expect(json).not.toMatch(/right|correct|answer/i);
      // A Scroll the person may no longer read is listed without its words.
      const withheld = await withScope(b.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: b.accountId, reach: () => Promise.resolve(new Set<string>()) }),
      );
      if (withheld.kind !== 'entered') throw new Error('CI export');
      expect(JSON.stringify(withheld.value)).not.toContain(TIDES_CALL.prompt);
    });
  });

  describe('the table', () => {
    it('keeps a pick with a member’s row, one per member and call, a real option and nothing finer than a day', async () => {
      const { b, refs } = await party();
      const stranger = await seedFriend(database.db, cases.friends);
      unwrap(await lock(b, refs.b, 1, 1));
      const own = (await rowsOf(b))[0]!;
      const insert = (patch: object) =>
        database.db
          .insertInto('social.thread_calls')
          .values({
            thread_id: refs.b.threadId,
            account_id: b.accountId,
            asset_id: own.asset_id,
            revision: own.revision,
            stop_id: own.stop_id,
            option: 0,
            day: '2026-10-24',
            ...patch,
          })
          .execute();
      await expect(insert({ account_id: stranger.accountId })).rejects.toThrow();
      await expect(insert({ option: 3 })).rejects.toThrow();
      await expect(insert({})).rejects.toThrow();
      const columns = await sql<{ column_name: string; data_type: string }>`
        select column_name, data_type from information_schema.columns
        where table_schema = 'social' and table_name = 'thread_calls' order by column_name`.execute(database.db);
      expect(columns.rows).toEqual([
        { column_name: 'account_id', data_type: 'uuid' },
        { column_name: 'asset_id', data_type: 'uuid' },
        { column_name: 'day', data_type: 'date' },
        { column_name: 'option', data_type: 'integer' },
        { column_name: 'revision', data_type: 'integer' },
        { column_name: 'stop_id', data_type: 'text' },
        { column_name: 'thread_id', data_type: 'uuid' },
      ]);
    });

    it('keeps no receipt of a lock and no time finer than a day anywhere, after a lock, a reveal, a read and leaving', async () => {
      const { a, b, c, refs } = await party();
      const lockReceipts = async () =>
        (
          await sql<{ operation: string }>`
            select operation from receipts.shared_commands where operation like '%call%'
            union all select operation from receipts.personal_commands where operation like '%call%'`.execute(
            database.db,
          )
        ).rows;
      /** Every table that holds a row mentioning this clock time, in any text form of it. */
      const tablesMentioning = async (needle: string) => {
        const tables = await sql<{ schemaname: string; tablename: string }>`
          select schemaname, tablename from pg_tables
          where schemaname not in ('pg_catalog', 'information_schema', 'pgboss') order by 1, 2`.execute(database.db);
        const found: string[] = [];
        for (const table of tables.rows) {
          const counted = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.table(`${table.schemaname}.${table.tablename}`)} as r
            where r::text like ${`%${needle}%`}`.execute(database.db);
          if ((counted.rows[0]?.n ?? 0) > 0) found.push(`${table.schemaname}.${table.tablename}`);
        }
        return found;
      };
      // Every call command runs at one distinctive instant; everything else runs at another time.
      cases.clock.now = new Date('2026-10-24T13:02:11.987Z');
      unwrap(await lock(a, refs.a, 1, 0));
      unwrap(await lock(b, refs.b, 1, 1));
      unwrap(await lock(b, refs.b, 1, 2));
      unwrap(await place(a, refs.a, 1, 'finished'));
      unwrap(await place(b, refs.b, 1, 'finished'));
      unwrap(await place(c, refs.c, 1, 'finished'));
      expect(await call(a, refs.a, 1)).toMatchObject({ stage: 'revealed' });
      cases.clock.now = new Date('2026-10-24T08:00:00Z');
      expect(await lockReceipts()).toEqual([]);
      expect(await tablesMentioning('13:02:11')).toEqual([]);
      expect(await rowsOf(a)).toHaveLength(1);
      expect(await rowsOf(b)).toHaveLength(1);
      await leave(b, refs.b);
      expect(await lockReceipts()).toEqual([]);
      expect(await tablesMentioning('13:02:11')).toEqual([]);
    });
  });

  describe('the play wall (D-063)', () => {
    /**
     * A fingerprint of every table except Social's own, the receipts (a leave writes its own receipt) and pg-boss's
     * queue tables, which are left out of it: what a pick must never change anywhere else. The test of receipts shows
     * that a lock writes none.
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

    it('locking, revealing, reading, leaving and exporting a pick change no table outside Social', async () => {
      const { a, b, c, refs } = await party();
      const before = await elsewhere();
      expect(Object.keys(before).length).toBeGreaterThan(50);
      // A right pick and a wrong one, finished, revealed, read and exported ...
      unwrap(await lock(a, refs.a, 2, 0));
      unwrap(await lock(b, refs.b, 2, 1));
      unwrap(await lock(c, refs.c, 2, 2));
      for (const [who, ref] of [
        [a, refs.a],
        [b, refs.b],
        [c, refs.c],
      ] as const)
        unwrap(await place(who, ref, 2, 'finished'));
      for (const [who, ref] of [
        [a, refs.a],
        [b, refs.b],
      ] as const)
        expect(await call(who, ref, 2)).toMatchObject({ stage: 'revealed' });
      await leave(c, refs.c);
      // ... changed nothing: not evidence, not an exposure, not a plan, a ranking, a place, a receipt.
      expect(await elsewhere()).toEqual(before);
    });

    it('can fail: reading a part does change what lies outside Social', async () => {
      const { b, scrolls } = await party();
      const before = await elsewhere();
      await activateFor(database.db, b, scrolls[0]!.assetId, 'scroll');
      const after = await elsewhere();
      expect(after).not.toEqual(before);
      expect(Object.keys(after).filter((table) => after[table] !== before[table])).toContain('experience.exposures');
    });

    it('gives a right pick and a wrong one the same everything else: the only difference is in Social', async () => {
      const { a, b, refs } = await party();
      unwrap(await lock(a, refs.a, 1, 0));
      unwrap(await lock(b, refs.b, 1, 1));
      const rows = (await rowsOf(a)).concat(await rowsOf(b));
      expect(rows.map((row) => row.option).sort()).toEqual([0, 1]);
      // The row says what was picked, never whether it was right: that is worked out when a reveal is read.
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'account_id',
        'asset_id',
        'day',
        'option',
        'revision',
        'stop_id',
        'thread_id',
      ]);
    });
  });

  describe('the common guess (D-157)', () => {
    /** One account locks `option` on the first call of a Scroll in each of `count` threads of its own. */
    async function lockInManyThreads(scroll: { assetId: string }, option: number, count: number) {
      const person = await seedFriend(database.db, cases.friends);
      const friend = await seedFriend(database.db, cases.friends);
      await befriend(cases.friends, person, friend);
      const row = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', scroll.assetId)
        .executeTakeFirstOrThrow();
      const stopId = (row.document as { stops: { id: string; kind: string }[] }).stops.find(
        (stop) => stop.kind === 'call_it',
      )!.id;
      for (let index = 0; index < count; index++) {
        const started = unwrap(
          await threads().create(person.authority, {
            version,
            commandId: randomUUID(),
            root: { assetId: scroll.assetId, assetRevision: 1 },
            friendPersonIds: [friend.person.personId],
          }),
        );
        await database.db
          .insertInto('social.thread_calls')
          .values({
            thread_id: started.thread.threadId,
            account_id: person.accountId,
            asset_id: scroll.assetId,
            revision: 1,
            stop_id: stopId,
            option,
            day: '2026-10-24',
          })
          .execute();
      }
    }
    /** Ravi and Asha call, everyone finishes Part 2 and the call reveals. */
    async function revealedParty(options: { readonly part2?: CallFixture } = {}, picks = { asha: 1, ravi: 0 }) {
      const world = await party(options);
      unwrap(await lock(world.a, world.refs.a, 2, picks.asha));
      unwrap(await lock(world.b, world.refs.b, 2, picks.ravi));
      for (const [who, ref] of [
        [world.a, world.refs.a],
        [world.b, world.refs.b],
        [world.c, world.refs.c],
      ] as const)
        unwrap(await place(who, ref, 2, 'finished'));
      return world;
    }
    const revealedCall = async (actor: Friend, ref: ContentThreadRef) => {
      const shown = await call(actor, ref, 2);
      if (shown.stage !== 'revealed') throw new Error('expected a reveal');
      return shown;
    };

    it('shows the Scroll’s own reviewed source to a member whose pick was the authored common guess, and to no one else', async () => {
      const { a, b, refs } = await revealedParty();
      // The authored guess is option 1: Asha picked it, Ravi picked the right answer.
      expect(await revealedCall(a, refs.a)).toMatchObject({ guessSource: GUESS_SOURCE });
      expect((await revealedCall(b, refs.b)).guessSource).toBeUndefined();
    });

    it('shows nothing when the authored source has not been reviewed', async () => {
      const { a, refs } = await revealedParty({ part2: { ...TIDES_CALL, guess: { option: 1, reviewed: false } } });
      const shown = await revealedCall(a, refs.a);
      expect(shown.guessSource).toBeUndefined();
      expect(JSON.stringify(shown)).not.toContain(GUESS_SOURCE);
    });

    it('never shows a figure built from other threads’ picks: one account locking in thirty threads changes nothing', async () => {
      const { a, scrolls, refs } = await revealedParty({}, { asha: 2, ravi: 0 });
      const before = JSON.stringify(await revealedCall(a, refs.a));
      await lockInManyThreads(scrolls[1]!, 2, 30);
      const after = JSON.stringify(await revealedCall(a, refs.a));
      expect(after).toBe(before);
      expect(after).not.toMatch(/percent|commonGuess|across threads|most called/i);
      // The same holds before the reveal: a locked call shows counts of this thread only.
      const { b: ravi, refs: other } = await party();
      unwrap(await lock(ravi, other.b, 2, 0));
      await lockInManyThreads(scrolls[1]!, 0, 30);
      expect(await call(ravi, other.b, 2)).toMatchObject({ stage: 'locked', called: 1, of: 3 });
    });
  });

  describe('a reveal that has happened stays (D-155)', () => {
    const day = (value: string) => new Date(`${value}T08:00:00Z`);
    const reveals = (thread: ContentThreadRef) =>
      database.db
        .selectFrom('social.thread_call_reveals')
        .selectAll()
        .where('thread_id', '=', thread.threadId)
        .execute();

    /** Ravi locked on the 24th and Asha on the 25th; nobody shares a place, so the clock opens it on the 26th. */
    async function lockedOnTwoDays() {
      const world = await party();
      try {
        cases.clock.now = day('2026-10-24');
        unwrap(await lock(world.b, world.refs.b, 2, 1));
        cases.clock.now = day('2026-10-25');
        unwrap(await lock(world.a, world.refs.a, 2, 0));
        expect(await call(world.a, world.refs.a, 2)).toMatchObject({ stage: 'locked' });
        expect(await reveals(world.refs.a)).toEqual([]);
      } finally {
        cases.clock.now = day('2026-10-24');
      }
      return world;
    }

    it('keeps the call revealed when the earliest locker leaves, which would otherwise move the clock back', async () => {
      const { a, b, refs } = await lockedOnTwoDays();
      try {
        cases.clock.now = day('2026-10-26');
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', called: 2 });
        // That it revealed is on record: a row with no day, no person and no pick.
        const [row] = await reveals(refs.a);
        expect(row).toMatchObject({ thread_id: refs.a.threadId });
        expect(Object.keys(row!).sort()).toEqual(['asset_id', 'revision', 'stop_id', 'thread_id']);
        await leave(b, refs.b);
        const after = await call(a, refs.a, 2);
        expect(after).toMatchObject({ stage: 'revealed', called: 1 });
        if (after.stage !== 'revealed') throw new Error('expected a reveal');
        expect(after.picks.map((pick) => pick.person.personId)).toEqual([a.person.personId]);
      } finally {
        cases.clock.now = day('2026-10-24');
      }
    });

    it('keeps it revealed when the earliest locker clears, and closed for a member who never locked', async () => {
      const { a, b, c, refs } = await lockedOnTwoDays();
      try {
        cases.clock.now = day('2026-10-26');
        expect(await call(c, refs.c, 2)).toMatchObject({ stage: 'closed', reason: 'revealed' });
        await clearExploration(b);
        expect(await rowsOf(b)).toEqual([]);
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', called: 1 });
        expect(await call(c, refs.c, 2)).toMatchObject({ stage: 'closed', reason: 'revealed' });
        expect(unwrap(await lock(c, refs.c, 2, 0))).toMatchObject({ result: 'closed' });
      } finally {
        cases.clock.now = day('2026-10-24');
      }
    });

    it('records that it revealed once, the first time anyone finds it so, and a repeat adds nothing', async () => {
      const { a, b, refs } = await lockedOnTwoDays();
      try {
        // Reading a call that has not revealed writes nothing.
        expect(await reveals(refs.a)).toEqual([]);
        cases.clock.now = day('2026-10-26');
        await call(b, refs.b, 2);
        expect(await reveals(refs.a)).toHaveLength(1);
        cases.clock.now = day('2026-10-29');
        await call(a, refs.a, 2);
        expect(await reveals(refs.a)).toHaveLength(1);
        // The table has no column for a day or a time: only that it revealed.
        const columns = await sql<{ column_name: string }>`
          select column_name from information_schema.columns
          where table_schema = 'social' and table_name = 'thread_call_reveals' order by column_name`.execute(
          database.db,
        );
        expect(columns.rows.map((column) => column.column_name)).toEqual([
          'asset_id',
          'revision',
          'stop_id',
          'thread_id',
        ]);
      } finally {
        cases.clock.now = day('2026-10-24');
      }
    });

    it('may be recorded by a lock that stands, and then stays a fact about the thread alone', async () => {
      const { a, b, refs } = await lockedOnTwoDays();
      try {
        cases.clock.now = day('2026-10-26');
        // Asha's repeat lock finds the call revealed: it answers stands, and the thread's record is written.
        expect(unwrap(await lock(a, refs.a, 2, 1))).toMatchObject({ result: 'stands' });
        expect(await reveals(refs.a)).toHaveLength(1);
        expect((await rowsOf(a)).map((row) => row.option)).toEqual([0]);
        expect((await rowsOf(b)).map((row) => row.option)).toEqual([1]);
      } finally {
        cases.clock.now = day('2026-10-24');
      }
    });

    it('does not let a member who shows a lower place again take the reveal back', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await lock(a, refs.a, 2, 0));
      for (const [who, ref] of [
        [a, refs.a],
        [b, refs.b],
        [c, refs.c],
      ] as const)
        unwrap(await place(who, ref, 2, 'finished'));
      expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed' });
      // A place only moves forward, but one who hid and shows again from a device that remembers less starts lower.
      await hideNow(c, refs.c, true);
      await hideNow(c, refs.c, false);
      unwrap(await place(c, refs.c, 1, 'on'));
      expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed' });
    });
  });

  describe('a block never lets another member move a reader’s card (D-155)', () => {
    const day = (value: string) => new Date(`${value}T08:00:00Z`);
    const revealsOf = (thread: ContentThreadRef) =>
      database.db
        .selectFrom('social.thread_call_reveals')
        .selectAll()
        .where('thread_id', '=', thread.threadId)
        .execute();
    /** What a card says, without the ids that differ between two parties. */
    const shape = (card: ThreadCall) => ({
      stage: card.stage,
      called: card.called,
      of: card.of,
      ...('option' in card ? { option: card.option } : {}),
    });

    /**
     * Kenji blocked Ravi; both joined on Asha's invitation, so both stay in the thread. Ravi called on the 24th,
     * unless the option says nobody did.
     */
    async function blockedParty(options: { readonly ravi: boolean }) {
      const world = await party();
      expect((await friendCommand(cases.friends, world.c, world.b, 'block')).kind).toBe('ok');
      try {
        cases.clock.now = day('2026-10-24');
        if (options.ravi) unwrap(await lock(world.b, world.refs.b, 2, 1));
        cases.clock.now = day('2026-10-26');
      } catch (error) {
        cases.clock.now = day('2026-10-24');
        throw error;
      }
      return world;
    }

    it('leaves the blocker’s card open, and lets them call, when the blocked member called and the thread has revealed', async () => {
      const { a, c, refs } = await blockedParty({ ravi: true });
      try {
        // Asha is touched by no block: for her the call has revealed (the clock from Ravi's lock), and the record is written.
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'closed', reason: 'revealed' });
        expect(await revealsOf(refs.a)).toHaveLength(1);
        // Kenji blocked Ravi: Ravi's lock is not in his view, so his card is open and he may still call.
        expect(await call(c, refs.c, 2)).toMatchObject({ stage: 'open', called: 0, of: 2 });
        expect(unwrap(await lock(c, refs.c, 2, 0))).toMatchObject({ result: 'locked' });
        // His own lock opens the clock from his own day, not Ravi's: the card stays hidden, and shows only his count.
        expect(await call(c, refs.c, 2)).toMatchObject({ stage: 'locked', option: 0, called: 1, of: 2 });
        expect((await rowsOf(c)).map((row) => row.option)).toEqual([0]);
      } finally {
        cases.clock.now = day('2026-10-24');
      }
    });

    it('gives the blocker the same card whether or not the blocked member called, so reading tells nothing of them', async () => {
      const withRavi = await blockedParty({ ravi: true });
      const cards: ReturnType<typeof shape>[] = [];
      try {
        // Asha reads first, so the thread's record exists before Kenji looks.
        await call(withRavi.a, withRavi.refs.a, 2);
        expect(await revealsOf(withRavi.refs.a)).toHaveLength(1);
        cards.push(shape(await call(withRavi.c, withRavi.refs.c, 2)));
        unwrap(await lock(withRavi.c, withRavi.refs.c, 2, 1));
        cards.push(shape(await call(withRavi.c, withRavi.refs.c, 2)));
      } finally {
        cases.clock.now = day('2026-10-24');
      }
      const without = await blockedParty({ ravi: false });
      const control: ReturnType<typeof shape>[] = [];
      try {
        control.push(shape(await call(without.c, without.refs.c, 2)));
        unwrap(await lock(without.c, without.refs.c, 2, 1));
        control.push(shape(await call(without.c, without.refs.c, 2)));
      } finally {
        cases.clock.now = day('2026-10-24');
      }
      expect(cards).toEqual(control);
    });

    it('still honours the latch for a reader no block touches, though two others block each other', async () => {
      const { a, b, c, refs } = await party();
      expect((await friendCommand(cases.friends, c, b, 'block')).kind).toBe('ok');
      try {
        cases.clock.now = day('2026-10-24');
        unwrap(await lock(b, refs.b, 2, 1));
        cases.clock.now = day('2026-10-25');
        unwrap(await lock(a, refs.a, 2, 0));
        cases.clock.now = day('2026-10-26');
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', called: 2 });
        expect(await revealsOf(refs.a)).toHaveLength(1);
        // The earliest locker leaves: the clock would now count from Asha's own lock, but the call stays revealed for her.
        await leave(b, refs.b);
        expect(await call(a, refs.a, 2)).toMatchObject({ stage: 'revealed', called: 1 });
      } finally {
        cases.clock.now = day('2026-10-24');
      }
    });
  });

  describe('a part whose Scroll gets a new revision (D-233)', () => {
    const SECOND_REVISION_CALL: CallFixture = {
      prompt: 'CI fixture question, second revision: what mainly causes tides?',
      options: ['CI the Moon alone', 'CI the Moon and the Sun', 'CI the wind'],
      answer: 1,
      explain: 'CI fixture explanation, second revision.',
      twist: 'CI fixture twist, second revision.',
    };

    /**
     * Asha's thread rests on Part 2. Part 1 is then replaced by revision 2 and the series is declared again with it, which is
     * how a thread whose root did not change comes to hold a newer Part 1 (the root's own revision is still in both).
     */
    async function releaseSecondRevision(world: Awaited<ReturnType<typeof party>>) {
      const [first, second] = world.scrolls as [{ assetId: string }, { assetId: string }];
      await seedCallRevision(database.db, first.assetId, 2, SECOND_REVISION_CALL);
      await declareSeries(
        database.db,
        world.seriesId,
        [{ assetId: first.assetId, assetRevision: 2 }, second, world.reel],
        2,
      );
    }
    const revisionsLocked = async (person: Friend) => (await rowsOf(person)).map((row) => row.revision);

    it('keeps the question the party called on, every pick and the count, and says the Scroll was updated', async () => {
      const world = await party({ rootPart: 2 });
      const { a, b, c, refs } = world;
      unwrap(await lock(a, refs.a, 1, 1));
      unwrap(await lock(b, refs.b, 1, 0));
      await releaseSecondRevision(world);

      // Those who called still see their pick, on the question they answered, with the count unchanged.
      expect(await call(a, refs.a, 1)).toMatchObject({
        stage: 'locked',
        option: 1,
        assetRevision: 1,
        prompt: TIDES_CALL.prompt,
        called: 2,
        of: 3,
        updated: 'held',
      });
      expect(await call(b, refs.b, 1)).toMatchObject({ stage: 'locked', option: 0, called: 2, updated: 'held' });
      // Kenji has not called: he is asked the same question as the rest, not a new one, and his pick goes with it.
      expect(await call(c, refs.c, 1)).toMatchObject({
        stage: 'open',
        assetRevision: 1,
        prompt: TIDES_CALL.prompt,
        updated: 'held',
      });
      expect(unwrap(await lock(c, refs.c, 1, 0))).toMatchObject({ result: 'locked' });
      expect(await revisionsLocked(c)).toEqual([1]);
      expect(await call(a, refs.a, 1)).toMatchObject({ stage: 'locked', called: 3, of: 3 });
    });

    it('reveals the picks of the revision the party called on, judged by that revision’s answer', async () => {
      const world = await party({ rootPart: 2 });
      const { a, b, c, refs } = world;
      // Revision 1 says option 0 is right; revision 2 says option 1 is.
      unwrap(await lock(a, refs.a, 1, 0));
      unwrap(await lock(b, refs.b, 1, 1));
      unwrap(await lock(c, refs.c, 1, 0));
      await releaseSecondRevision(world);
      for (const [person, ref] of [
        [a, refs.a],
        [b, refs.b],
        [c, refs.c],
      ] as const) {
        unwrap(await place(person, ref, 1, 'on'));
        unwrap(await place(person, ref, 1, 'finished'));
      }
      expect(await call(a, refs.a, 1)).toMatchObject({
        stage: 'revealed',
        assetRevision: 1,
        answer: 0,
        right: true,
        rightCount: 2,
        explain: TIDES_CALL.explain,
        updated: 'held',
      });
      expect(await call(b, refs.b, 1)).toMatchObject({ stage: 'revealed', answer: 0, right: false });
    });

    it('starts the question afresh on the new revision for a thread whose members had not called, and says nothing of an update', async () => {
      const world = await party({ rootPart: 2 });
      await releaseSecondRevision(world);
      const card = await call(world.a, world.refs.a, 1);
      expect(card).toMatchObject({ stage: 'open', assetRevision: 2, prompt: SECOND_REVISION_CALL.prompt, called: 0 });
      expect(card).not.toHaveProperty('updated');
      expect(unwrap(await lock(world.a, world.refs.a, 1, 1))).toMatchObject({ result: 'locked' });
      expect(await revisionsLocked(world.a)).toEqual([2]);
    });

    it('lists a pick in an export under the question it was made on', async () => {
      const world = await party({ rootPart: 2 });
      unwrap(await lock(world.b, world.refs.b, 1, 2));
      await releaseSecondRevision(world);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const outcome = await withScope(world.b.authority, (scope) =>
        socialErasure.export!.read(scope, {
          accountId: world.b.accountId,
          reach: (ids) => Promise.resolve(new Set(ids)),
        }),
      );
      if (outcome.kind !== 'entered') throw new Error('CI export');
      const exported = outcome.value as { threads: { callsMade: Record<string, unknown>[] } };
      expect(exported.threads.callsMade).toEqual([
        { question: TIDES_CALL.prompt, picked: TIDES_CALL.options[2], day: '2026-10-24' },
      ]);
    });

    it('asks the current question afresh, and says so, when the revision the picks are on can no longer be read', async () => {
      const world = await party({ rootPart: 2 });
      unwrap(await lock(world.a, world.refs.a, 1, 1));
      await releaseSecondRevision(world);
      await database.db
        .insertInto('content.revision_reviews')
        .values({
          asset_id: world.scrolls[0]!.assetId,
          revision: 1,
          state: 'rejected',
          decided_at: new Date(),
          decided_by: 'ci',
          reason: 'CI fixture: the first revision was rejected',
        })
        .execute();
      expect(await call(world.a, world.refs.a, 1)).toMatchObject({
        stage: 'open',
        assetRevision: 2,
        prompt: SECOND_REVISION_CALL.prompt,
        called: 0,
        updated: 'restarted',
      });
      // The pick on the earlier revision is not deleted, and a new one can be made on the current question.
      expect(unwrap(await lock(world.a, world.refs.a, 1, 0))).toMatchObject({ result: 'locked' });
      expect((await revisionsLocked(world.a)).toSorted()).toEqual([1, 2]);
    });

    it('lets a block move nothing: a member the reader blocked cannot decide which question the reader is shown', async () => {
      const world = await party({ rootPart: 2 });
      const { a, b, c, refs } = world;
      expect((await friendCommand(cases.friends, c, b, 'block')).kind).toBe('ok');
      // Only Ravi called, on revision 1. Kenji blocked Ravi, so for Kenji nobody has called.
      unwrap(await lock(b, refs.b, 1, 1));
      await releaseSecondRevision(world);
      expect(await call(a, refs.a, 1)).toMatchObject({ assetRevision: 1, updated: 'held' });
      const kenji = await call(c, refs.c, 1);
      expect(kenji).toMatchObject({ stage: 'open', assetRevision: 2, prompt: SECOND_REVISION_CALL.prompt, called: 0 });
      expect(kenji).not.toHaveProperty('updated');
    });
  });
});
