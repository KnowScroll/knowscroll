/**
 * Party places in content threads (D-065) over real PostgreSQL: where each member says they are in the
 * thread's series, coarse (a part, on or finished, and a day), member-only and written only from the member's
 * own command. Evidence label: fixture people, the real Social adapters, no HTTP, no provider and no model call.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { eraseCurrentAccount, eraseCurrentExploration, personalStores } from '@knowscroll/backend/erasure-registry';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { clearExplorationFor, deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { befriend, consumptionRows, friendCommand, seedFriend, talkCases, type Friend } from '../support/talk.js';
import { activateFor, declareSeries, seedReel } from '../support/thread-fixtures.js';

const version = 'content-thread.v1' as const;
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('party places (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_places');
    cases = talkCases(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const threads = () => cases.threads;

  /** Asha started a thread on a series of three Reels with Ravi and Kenji, who both joined. */
  async function party() {
    const [a, b, c] = [
      await seedFriend(database.db, cases.friends),
      await seedFriend(database.db, cases.friends),
      await seedFriend(database.db, cases.friends),
    ] as [Friend, Friend, Friend];
    await befriend(cases.friends, a, b);
    await befriend(cases.friends, a, c);
    const reels = [await seedReel(database.db), await seedReel(database.db), await seedReel(database.db)];
    await declareSeries(database.db, `ci-series-${randomUUID()}`, reels);
    const root = { assetId: reels[0]!.assetId, assetRevision: 1 };
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
    return { a, b, c, reels, root, refs };
  }

  const place = (
    actor: Friend,
    thread: ContentThreadRef,
    part: number,
    state: 'on' | 'finished',
    commandId = randomUUID(),
  ) => threads().setPlace(actor.authority, { version, commandId, thread, part, state });
  const hideNow = async (actor: Friend, thread: ContentThreadRef, hidden: boolean) =>
    unwrap(await threads().setPlaceHidden(actor.authority, { version, commandId: randomUUID(), thread, hidden }));
  const read = async (actor: Friend, thread: ContentThreadRef) =>
    unwrap(await threads().places(actor.authority, { version, readId: randomUUID(), thread }));
  async function shown(actor: Friend, thread: ContentThreadRef) {
    const answer = await read(actor, thread);
    if (answer.status !== 'ready') throw new Error(`CI places are ${answer.status}`);
    return answer;
  }
  const rowsOf = (person: Friend) =>
    database.db.selectFrom('social.thread_places').selectAll().where('account_id', '=', person.accountId).execute();
  const inboxRevision = async (person: Friend) =>
    unwrap(await threads().inbox(person.authority, { version, readId: randomUUID(), limit: 10 })).viewRevision;
  const leave = async (actor: Friend, thread: ContentThreadRef) =>
    unwrap(await threads().leave(actor.authority, { version, commandId: randomUUID(), thread }));

  describe('what is shown', () => {
    it('lists a member who shares: a part, on or finished, a day, and nothing else', async () => {
      const { a, b, refs } = await party();
      expect(await shown(a, refs.a)).toMatchObject({ hidden: false, places: [] });
      expect(unwrap(await place(b, refs.b, 2, 'on'))).toMatchObject({
        operation: 'thread.place',
        result: 'stored',
        replayed: false,
      });
      const answer = await shown(a, refs.a);
      expect(answer.places).toEqual([{ person: b.person, you: false, part: 2, state: 'on', day: '2026-10-24' }]);
      // The member's own place comes back to them flagged, so their device can say "you".
      expect((await shown(b, refs.b)).places).toEqual([
        { person: b.person, you: true, part: 2, state: 'on', day: '2026-10-24' },
      ]);
    });

    it('puts no time of day, playhead, branch, selected episode or "watching" on the wire', async () => {
      const { a, b, c, refs } = await party();
      cases.clock.now = new Date('2026-10-24T13:02:11.987Z');
      unwrap(await place(b, refs.b, 1, 'finished'));
      unwrap(await place(c, refs.c, 2, 'on'));
      const json = JSON.stringify(await shown(a, refs.a));
      expect(json).not.toMatch(/\d{2}:\d{2}/);
      expect(json).not.toMatch(
        /position|playhead|currentEpisode|currentItem|selected|branch|seenBy|readBy|lastSeen|watching|presence/i,
      );
      expect(json).toContain('"day":"2026-10-24"');
      // The column itself is a date: a finer time cannot be stored, whatever a writer tries.
      const columns = await sql<{ column_name: string; data_type: string }>`
        select column_name, data_type from information_schema.columns
        where table_schema = 'social' and table_name = 'thread_places' order by column_name`.execute(database.db);
      expect(columns.rows).toEqual([
        { column_name: 'account_id', data_type: 'uuid' },
        { column_name: 'day', data_type: 'date' },
        { column_name: 'part', data_type: 'integer' },
        { column_name: 'state', data_type: 'text' },
        { column_name: 'thread_id', data_type: 'uuid' },
      ]);
      cases.clock.now = new Date('2026-10-24T08:00:00Z');
    });

    it('orders places by how far along and then by name, not by who arrived first', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await place(c, refs.c, 2, 'on'));
      unwrap(await place(b, refs.b, 1, 'on'));
      const answer = await shown(a, refs.a);
      expect(answer.places.map((entry) => entry.part)).toEqual([1, 2]);
    });

    it('shows nothing for a member who has not set a place, even if they have opened every part', async () => {
      const { a, b, reels, refs } = await party();
      for (const reel of reels) await activateFor(database.db, b, reel.assetId, 'reel');
      // Their own exploring is theirs: the server never reads it to make a place for anyone.
      expect((await shown(a, refs.a)).places).toEqual([]);
      expect(await rowsOf(b)).toEqual([]);
    });

    it('keeps places out of the thread view and the thread list', async () => {
      const { a, b, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'on'));
      const view = unwrap(
        await threads().read(a.authority, { version, readId: randomUUID(), thread: refs.a, limit: 50 }),
      );
      const inbox = unwrap(await threads().inbox(a.authority, { version, readId: randomUUID(), limit: 50 }));
      for (const answer of [view, inbox]) {
        const json = JSON.stringify(answer);
        expect(json).not.toMatch(
          /position|playhead|currentEpisode|currentItem|seenBy|readBy|lastSeen|presence|watching/i,
        );
        expect(json).not.toMatch(/placeHidden|"places"|"finished"|"day"/);
      }
    });

    it('has no places for a thread that is not a series, and refuses to set one', async () => {
      const [a, b] = [await seedFriend(database.db, cases.friends), await seedFriend(database.db, cases.friends)];
      await befriend(cases.friends, a, b);
      const reel = await seedReel(database.db);
      const started = unwrap(
        await threads().create(a.authority, {
          version,
          commandId: randomUUID(),
          root: { assetId: reel.assetId, assetRevision: 1 },
          friendPersonIds: [b.person.personId],
        }),
      );
      expect(await place(a, started.thread, 1, 'on')).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(await shown(a, started.thread)).toMatchObject({ places: [] });
    });
  });

  describe('writing a place', () => {
    it('moves forward only, and a repeat or an earlier part changes nothing, not even the day', async () => {
      const { a, b, refs } = await party();
      expect(unwrap(await place(b, refs.b, 1, 'on')).result).toBe('stored');
      cases.clock.now = new Date('2026-10-25T09:00:00Z');
      expect(unwrap(await place(b, refs.b, 1, 'on')).result).toBe('unchanged');
      expect(unwrap(await place(b, refs.b, 1, 'finished')).result).toBe('stored');
      expect(unwrap(await place(b, refs.b, 1, 'on')).result).toBe('unchanged');
      expect(unwrap(await place(b, refs.b, 2, 'on')).result).toBe('stored');
      cases.clock.now = new Date('2026-10-26T09:00:00Z');
      expect(unwrap(await place(b, refs.b, 1, 'finished')).result).toBe('unchanged');
      expect((await shown(a, refs.a)).places).toEqual([
        { person: b.person, you: false, part: 2, state: 'on', day: '2026-10-25' },
      ]);
      cases.clock.now = new Date('2026-10-24T08:00:00Z');
    });

    it('is idempotent: the same command replays its answer, and another body under it is refused', async () => {
      const { b, refs } = await party();
      const commandId = randomUUID();
      const first = unwrap(await place(b, refs.b, 2, 'on', commandId));
      expect(first).toMatchObject({ replayed: false, result: 'stored' });
      expect(unwrap(await place(b, refs.b, 2, 'on', commandId))).toMatchObject({ replayed: true, result: 'stored' });
      expect(await place(b, refs.b, 3, 'on', commandId)).toEqual({ kind: 'refused', code: 'command_key_reused' });
      expect(await rowsOf(b)).toHaveLength(1);
    });

    it('keeps one row per member under concurrent writes, at the furthest place', async () => {
      const { a, b, refs } = await party();
      await Promise.all([
        place(b, refs.b, 3, 'on'),
        place(b, refs.b, 1, 'on'),
        place(b, refs.b, 2, 'finished'),
        place(b, refs.b, 2, 'on'),
      ]);
      expect(await rowsOf(b)).toHaveLength(1);
      expect((await shown(a, refs.a)).places[0]).toMatchObject({ part: 3, state: 'on' });
    });

    it('refuses a part the series does not have, and writes nothing', async () => {
      const { b, refs } = await party();
      for (const part of [4, 99])
        expect(await place(b, refs.b, part, 'on')).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(
        await threads().setPlace(b.authority, {
          version,
          commandId: randomUUID(),
          thread: refs.b,
          part: 0,
          state: 'on',
        }),
      ).toEqual({
        kind: 'refused',
        code: 'invalid_input',
      });
      expect(await rowsOf(b)).toEqual([]);
    });

    it('is never consumption evidence', async () => {
      const before = await consumptionRows(database.db);
      const { a, b, refs } = await party();
      unwrap(await place(b, refs.b, 1, 'on'));
      unwrap(await place(b, refs.b, 1, 'finished'));
      await shown(a, refs.a);
      await hideNow(b, refs.b, true);
      expect(await consumptionRows(database.db)).toBe(before);
    });

    it('is only the caller’s own row: a place cannot be written for another member', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'on'));
      // The command has no field for whose place it is; it lands on the caller's own row only.
      unwrap(await place(c, refs.c, 1, 'on'));
      expect((await rowsOf(b)).map((row) => row.part)).toEqual([2]);
      expect((await rowsOf(c)).map((row) => row.part)).toEqual([1]);
      expect(await rowsOf(a)).toEqual([]);
    });
  });

  describe('hide where I am', () => {
    it('is off by default, and turning it on deletes the place and hides it from everyone', async () => {
      const { a, b, refs } = await party();
      expect(await shown(b, refs.b)).toMatchObject({ hidden: false });
      unwrap(await place(b, refs.b, 2, 'on'));
      expect((await shown(a, refs.a)).places).toHaveLength(1);
      expect(await hideNow(b, refs.b, true)).toMatchObject({
        operation: 'thread.place-hidden',
        hidden: true,
        changed: true,
      });
      expect(await rowsOf(b)).toEqual([]);
      expect((await shown(a, refs.a)).places).toEqual([]);
      expect(await shown(b, refs.b)).toMatchObject({ hidden: true, places: [] });
    });

    it('writes no row while it is on, and says so', async () => {
      const { a, b, refs } = await party();
      await hideNow(b, refs.b, true);
      expect(unwrap(await place(b, refs.b, 3, 'finished'))).toMatchObject({ result: 'hidden' });
      expect(await rowsOf(b)).toEqual([]);
      expect((await shown(a, refs.a)).places).toEqual([]);
    });

    it('shows the member again only from their next place, never from before', async () => {
      const { a, b, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'on'));
      await hideNow(b, refs.b, true);
      expect(await hideNow(b, refs.b, false)).toMatchObject({ hidden: false, changed: true });
      expect((await shown(a, refs.a)).places).toEqual([]);
      unwrap(await place(b, refs.b, 1, 'on'));
      expect((await shown(a, refs.a)).places).toMatchObject([{ part: 1, state: 'on' }]);
    });

    it('is a wanted state: a repeat changes nothing', async () => {
      const { b, refs } = await party();
      expect(await hideNow(b, refs.b, false)).toMatchObject({ changed: false });
      expect(await hideNow(b, refs.b, true)).toMatchObject({ changed: true });
      expect(await hideNow(b, refs.b, true)).toMatchObject({ changed: false });
    });

    it('is per thread: hiding in one thread leaves another thread’s place alone', async () => {
      const one = await party();
      const reels = [await seedReel(database.db), await seedReel(database.db)];
      await declareSeries(database.db, `ci-series-${randomUUID()}`, reels);
      const other = unwrap(
        await threads().create(one.a.authority, {
          version,
          commandId: randomUUID(),
          root: { assetId: reels[0]!.assetId, assetRevision: 1 },
          friendPersonIds: [one.b.person.personId],
        }),
      );
      const inbox = unwrap(await threads().inbox(one.b.authority, { version, readId: randomUUID(), limit: 50 }));
      const invited = inbox.items.find((item) => item.state === 'invited')!;
      unwrap(
        await threads().respond(one.b.authority, {
          version,
          commandId: randomUUID(),
          thread: invited.thread,
          response: 'join',
        }),
      );
      unwrap(await place(one.b, one.refs.b, 1, 'on'));
      unwrap(await place(one.b, invited.thread, 1, 'on'));
      await hideNow(one.b, one.refs.b, true);
      expect((await shown(one.a, one.refs.a)).places).toEqual([]);
      expect((await shown(one.a, other.thread)).places).toHaveLength(1);
    });

    it('never lists a hidden member even if a row outlived the switch', async () => {
      const { a, b, refs } = await party();
      await hideNow(b, refs.b, true);
      await database.db
        .insertInto('social.thread_places')
        .values({ thread_id: refs.b.threadId, account_id: b.accountId, part: 2, state: 'on', day: '2026-10-24' })
        .execute();
      expect((await shown(a, refs.a)).places).toEqual([]);
    });

    it('does not make the member blind to the others', async () => {
      const { a, b, refs } = await party();
      unwrap(await place(a, refs.a, 1, 'on'));
      await hideNow(b, refs.b, true);
      expect((await shown(b, refs.b)).places).toMatchObject([{ person: a.person, you: false }]);
    });

    it('cannot be told apart from never having opened a part', async () => {
      const hidden = await party();
      unwrap(await place(hidden.b, hidden.refs.b, 2, 'on'));
      await hideNow(hidden.b, hidden.refs.b, true);
      const never = await party();
      const what = async (who: Friend, thread: ContentThreadRef) => {
        const { status, hidden: own, places } = await shown(who, thread);
        return { status, hidden: own, places };
      };
      expect(await what(hidden.a, hidden.refs.a)).toEqual(await what(never.a, never.refs.a));
      expect(await what(hidden.c, hidden.refs.c)).toEqual(await what(never.c, never.refs.c));
    });
  });

  describe('who can read or write', () => {
    it('gives a stranger, an invitee who has not joined and a leaver nothing', async () => {
      const { a, b, refs } = await party();
      const stranger = await seedFriend(database.db, cases.friends);
      unwrap(await place(b, refs.b, 1, 'on'));
      // A stranger holding no reference of their own: a borrowed one is refused the same way.
      expect(await read(stranger, refs.b)).toMatchObject({ status: 'unavailable' });
      expect(await place(stranger, refs.b, 1, 'on')).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(
        await threads().setPlaceHidden(stranger.authority, {
          version,
          commandId: randomUUID(),
          thread: refs.a,
          hidden: true,
        }),
      ).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      // An invitation reads only itself: no places, and no way to set one.
      const d = await seedFriend(database.db, cases.friends);
      await befriend(cases.friends, a, d);
      const reel = await seedReel(database.db);
      await declareSeries(database.db, `ci-series-${randomUUID()}`, [reel]);
      const started = unwrap(
        await threads().create(a.authority, {
          version,
          commandId: randomUUID(),
          root: { assetId: reel.assetId, assetRevision: 1 },
          friendPersonIds: [d.person.personId],
        }),
      );
      const invited = unwrap(await threads().inbox(d.authority, { version, readId: randomUUID(), limit: 50 })).items[0]!
        .thread;
      expect(await read(d, invited)).toMatchObject({ status: 'unavailable' });
      expect(await place(d, invited, 1, 'on')).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(started.thread.threadId).toBe(invited.threadId);
      // A member who left sees nothing either.
      await leave(b, refs.b);
      expect(await read(b, refs.b)).toMatchObject({ status: 'unavailable' });
      expect(await place(b, refs.b, 2, 'on')).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('never lists a row whose member no longer takes part, even if it survived', async () => {
      const { a, b, refs } = await party();
      await leave(b, refs.b);
      await database.db
        .insertInto('social.thread_places')
        .values({ thread_id: refs.b.threadId, account_id: b.accountId, part: 2, state: 'on', day: '2026-10-24' })
        .execute();
      expect((await shown(a, refs.a)).places).toEqual([]);
    });

    it('refuses a stale membership reference without saying why', async () => {
      const { b, refs } = await party();
      const stale = { ...refs.b, membershipRevision: refs.b.membershipRevision + 5 };
      expect(await read(b, stale)).toMatchObject({ status: 'unavailable' });
      expect(await place(b, stale, 1, 'on')).toEqual({ kind: 'refused', code: 'unavailable' });
    });
  });

  describe('removed on leave, block, Clear and deletion', () => {
    it('removes a place when the member leaves', async () => {
      const { a, b, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'finished'));
      await leave(b, refs.b);
      expect(await rowsOf(b)).toEqual([]);
      expect((await shown(a, refs.a)).places).toEqual([]);
    });

    it('removes the place of someone the inviter blocks, or removes as a friend, and of the inviter when they are blocked', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await place(b, refs.b, 1, 'on'));
      unwrap(await place(c, refs.c, 2, 'on'));
      unwrap(await place(a, refs.a, 3, 'on'));
      expect((await friendCommand(cases.friends, a, b, 'block')).kind).toBe('ok');
      // Ravi's membership rested on that friendship: it ended, and so did his place.
      expect(await rowsOf(b)).toEqual([]);
      expect((await shown(a, refs.a)).places.map((entry) => entry.part)).toEqual([2, 3]);
      expect(await read(b, refs.b)).toMatchObject({ status: 'unavailable' });
      // Removing a friend does the same.
      expect((await friendCommand(cases.friends, a, c, 'remove')).kind).toBe('ok');
      expect(await rowsOf(c)).toEqual([]);
      expect((await shown(a, refs.a)).places.map((entry) => entry.part)).toEqual([3]);
      // The inviter's own place stays: their membership does not rest on a friendship.
      expect(await rowsOf(a)).toHaveLength(1);
    });

    it('hides a place from anyone who blocked the member or was blocked by them, in both directions', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await place(b, refs.b, 1, 'on'));
      unwrap(await place(c, refs.c, 2, 'on'));
      // Ravi and Kenji both joined on Asha's invitation, so neither membership rests on their own friendship.
      expect((await friendCommand(cases.friends, c, b, 'block')).kind).toBe('ok');
      expect((await shown(c, refs.c)).places.map((entry) => entry.person.personId)).toEqual([c.person.personId]);
      expect((await shown(b, refs.b)).places.map((entry) => entry.person.personId)).toEqual([b.person.personId]);
      // Asha blocked nobody and sees both, and the rows are still there for her.
      expect((await shown(a, refs.a)).places).toHaveLength(2);
      expect(await rowsOf(b)).toHaveLength(1);
      expect((await friendCommand(cases.friends, c, b, 'unblock')).kind).toBe('ok');
      expect((await shown(c, refs.c)).places).toHaveLength(2);
    });

    it('removes places on Clear, and keeps the choice to hide', async () => {
      expect(socialErasure.clearExploration?.dispositions['social.thread_places']).toBe('erase');
      const { a, b, c, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'on'));
      unwrap(await place(c, refs.c, 1, 'finished'));
      await hideNow(c, refs.c, true);
      unwrap(await place(a, refs.a, 1, 'on'));
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
            { accountId: b.accountId, universeId: b.universeId, privacyEpoch: 1 },
            {
              version: 'clear-exploration.v1',
              commandId,
              expectedPrivacyEpoch: 1,
              confirmation: 'clear-exploration-preserve-keep-and-social',
            },
          ),
        ).toMatchObject({ kind: 'entered', value: { kind: 'ok' } });
        await use.process({ v: 1, accountId: b.accountId, commandId });
      } finally {
        await boss.stop({ graceful: false });
      }
      expect(await rowsOf(b)).toEqual([]);
      // Only the person who cleared lost their place; the others' stay.
      expect(await rowsOf(a)).toHaveLength(1);
      expect(await rowsOf(c)).toEqual([]);
      expect((await shown(a, refs.a)).places).toMatchObject([{ person: a.person }]);
      // Clear keeps a choice: Kenji's "hide where I am" is not exploration history.
      const hiddenRow = await database.db
        .selectFrom('social.conversation_members')
        .select('place_hidden')
        .where('account_id', '=', c.accountId)
        .where('conversation_id', '=', refs.c.threadId)
        .executeTakeFirstOrThrow();
      expect(hiddenRow.place_hidden).toBe(true);
      // The person who cleared is still a member and can set a fresh place from their new epoch.
      const after: Friend = { ...b, authority: { ...b.authority, privacyEpoch: 2 } };
      expect(unwrap(await place(after, refs.b, 1, 'on'))).toMatchObject({ result: 'stored' });
    });

    it('removes a person’s places with their account, and the thread goes on for the others', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await place(b, refs.b, 3, 'on'));
      unwrap(await place(c, refs.c, 1, 'on'));
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
      expect(await rowsOf(b)).toEqual([]);
      expect((await shown(a, refs.a)).places).toMatchObject([{ person: c.person, part: 1 }]);
    });

    it('removes the places of invitees whose friendship had ended when their inviter deletes their account', async () => {
      const { a, b, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'on'));
      // Ravi is removed as Asha's friend (his place is gone with his standing); a stray row must not survive Asha.
      await friendCommand(cases.friends, a, b, 'remove');
      expect(await rowsOf(b)).toEqual([]);
      await database.db
        .insertInto('social.thread_places')
        .values({ thread_id: refs.b.threadId, account_id: b.accountId, part: 1, state: 'on', day: '2026-10-24' })
        .execute();
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
      } finally {
        await boss.stop({ graceful: false });
      }
      expect(await rowsOf(b)).toEqual([]);
    });
  });

  describe('export and live hints', () => {
    it('exports the person’s own places and where they hide, and nothing about anyone else', async () => {
      const { a, b, c, refs } = await party();
      unwrap(await place(b, refs.b, 2, 'finished'));
      unwrap(await place(a, refs.a, 1, 'on'));
      await hideNow(c, refs.c, true);
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const exportOf = async (person: Friend) => {
        const outcome = await withScope(person.authority, (scope) =>
          socialErasure.export!.read(scope, {
            accountId: person.accountId,
            reach: (ids) => Promise.resolve(new Set(ids)),
          }),
        );
        if (outcome.kind !== 'entered') throw new Error('CI export');
        return outcome.value as {
          threads: {
            placesShown: { part: number; state: string; day: string; thread?: string }[];
            hidingWhereIAmIn: number;
          };
        };
      };
      const mine = await exportOf(b);
      expect(mine.threads.placesShown).toEqual([{ part: 2, state: 'finished', day: '2026-10-24' }]);
      expect(mine.threads.hidingWhereIAmIn).toBe(0);
      expect((await exportOf(c)).threads).toMatchObject({ placesShown: [], hidingWhereIAmIn: 1 });
      const json = JSON.stringify(await exportOf(b));
      expect(json).not.toContain(a.person.handle);
      expect(json).not.toContain(c.person.handle);
    });

    it('tells every member’s inbox when a place changes or is hidden, and nobody when nothing changed', async () => {
      const { a, b, refs } = await party();
      const before = await inboxRevision(a);
      unwrap(await place(b, refs.b, 1, 'on'));
      const afterFirst = await inboxRevision(a);
      expect(afterFirst).toBeGreaterThan(before);
      unwrap(await place(b, refs.b, 1, 'on'));
      expect(await inboxRevision(a)).toBe(afterFirst);
      await hideNow(b, refs.b, true);
      const afterHide = await inboxRevision(a);
      expect(afterHide).toBeGreaterThan(afterFirst);
      await hideNow(b, refs.b, true);
      expect(await inboxRevision(a)).toBe(afterHide);
      expect(await place(b, refs.b, 2, 'on').then(unwrap)).toMatchObject({ result: 'hidden' });
      expect(await inboxRevision(a)).toBe(afterHide);
    });
  });

  describe('the table', () => {
    it('keeps a place with a member’s row, one per member, a real part and a known state', async () => {
      const { b, refs } = await party();
      const stranger = await seedFriend(database.db, cases.friends);
      const insert = (patch: object) =>
        database.db
          .insertInto('social.thread_places')
          .values({
            thread_id: refs.b.threadId,
            account_id: b.accountId,
            part: 1,
            state: 'on',
            day: '2026-10-24',
            ...patch,
          })
          .execute();
      await expect(insert({ account_id: stranger.accountId })).rejects.toThrow();
      await expect(insert({ part: 0 })).rejects.toThrow();
      await expect(insert({ part: 100 })).rejects.toThrow();
      await expect(insert({ state: 'watching' })).rejects.toThrow();
      await insert({});
      await expect(insert({ part: 2 })).rejects.toThrow();
    });
  });
});
