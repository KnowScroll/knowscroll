/**
 * Watch together (v3 R-10, D-256 to D-258) over real PostgreSQL: a room watches one library Reel on a shared clock. CI fixture
 * accounts, fixture Reels (labelled, never library content), a fixture clock. The point of every test is a rule: the server stores a
 * Reel and a start time and never a position; "N watching" is a number only from three people who joined; a person's own watch is
 * theirs alone; the stage is members' only; and everything a person has in a session goes when they take it back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { seedRooms } from '@knowscroll/backend/modules/rooms/nest-providers';
import { LEAD_IN_MS, SESSIONS_PER_ROOM_DAY } from '../../../packages/backend/src/modules/rooms/domain/watch.js';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  joined,
  libraryRoomSeeds,
  makeModerator,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  roomWorld,
  rowsIn,
  seedRoom,
  setPresence,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { consumptionRows, friendCommand, seedFriend, type Friend } from '../support/talk.js';
import { seedAuthoredGeography } from '../support/visit-world.js';

const version = 'rooms.v1' as const;
const START = new Date(Date.UTC(2026, 10, 1, 21, 0, 0));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LENGTH = 70_000;
const ATTENTION = 'machine-learning.attention';
const TRANSFORMERS = 'machine-learning.transformers';

describe('Watch together (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_watch');
    world = await roomWorld(database, { now: START });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });

  const at = (ms: number, base = START) => {
    world.clock.now = new Date(base.getTime() + ms);
  };
  /** Each test starts at its own day, so the day's cap and the one stage of a room never carry from one test to the next. */
  let dayOfTest = 0;
  const begin = () => {
    dayOfTest += 1;
    at(dayOfTest * DAY);
    return world.clock.now;
  };

  /** An admitted library Reel under a topic, as Content stores one; `fixture` marks one that must never be offered. */
  async function addReel(
    over: {
      topic?: string;
      role?: 'primary' | 'supporting';
      fixture?: boolean;
      status?: 'admitted' | 'withdrawn';
      title?: string;
      durationMs?: number;
    } = {},
  ) {
    const assetId = randomUUID();
    const mediaId = randomUUID();
    const digest = createHash('sha256').update(assetId).digest('hex');
    const mediaKey = `sha256/${digest.slice(0, 2)}/${digest}.mp4`;
    const durationMs = over.durationMs ?? LENGTH;
    const title = over.title ?? `CI fixture Reel ${assetId.slice(0, 6)}`;
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId,
      revision: 1,
      title,
      summary: 'CI only, not real media bytes',
      language: 'en',
      truthLabel: 'generated',
      fixture: over.fixture ?? false,
      captions: 'burned_in',
      mediaKey,
      durationMs,
      width: 720,
      height: 1280,
    };
    const db = world.db;
    await db
      .insertInto('content.assets')
      .values({ id: assetId, revision: 1, kind: 'reel', status: over.status ?? 'admitted' })
      .execute();
    await db
      .insertInto('content.asset_revisions')
      .values({
        asset_id: assetId,
        revision: 1,
        provenance_kind: 'cutroom_import',
        document_version: 'reel-document.v1',
        document: JSON.stringify(document),
        document_sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
        explanation_unit_id: `ci-watch-${assetId.slice(0, 8)}`,
        language: 'en',
        title,
        reading_facts: JSON.stringify({ reelDurationMs: durationMs }),
      })
      .execute();
    await db
      .insertInto('content.media_objects')
      .values({
        id: mediaId,
        logical_key: mediaKey,
        backend: 'local',
        sha256: digest,
        size_bytes: 1,
        mime: 'video/mp4',
        probe: JSON.stringify({ durationMs }),
      })
      .execute();
    await db
      .insertInto('content.reel_imports')
      .values({
        run_id: randomUUID(),
        asset_id: assetId,
        asset_revision: 1,
        media_id: mediaId,
        script_name: 'greenhouse',
        fixture: true,
      })
      .execute();
    await db
      .insertInto('content.encounter_topics')
      .values({
        asset_id: assetId,
        asset_revision: 1,
        topic_id: over.topic ?? ATTENTION,
        role: over.role ?? 'primary',
        weight: 1,
      })
      .execute();
    return { assetId, title, durationMs };
  }

  const start = (person: Friend, roomId: string, assetId: string, recordingGeneration = 1, commandId = randomUUID()) =>
    world.rooms.startWatch(person.authority, { version, commandId, roomId, assetId, recordingGeneration });
  const join = (person: Friend, roomId: string, sessionId: string, recordingGeneration = 1, commandId = randomUUID()) =>
    world.rooms.joinWatch(person.authority, { version, commandId, roomId, sessionId, recordingGeneration });
  const leave = (person: Friend, roomId: string, sessionId: string) =>
    world.rooms.leaveWatch(person.authority, { version, commandId: randomUUID(), roomId, sessionId });
  const stop = (person: Friend, roomId: string, sessionId: string) =>
    world.rooms.stopWatch(person.authority, { version, commandId: randomUUID(), roomId, sessionId });
  const stage = async (person: Friend, roomId: string) => {
    const view = unwrap(await world.rooms.watch(person.authority, { version, readId: randomUUID(), roomId }));
    if (view.status !== 'ready') throw new Error('expected a ready stage');
    return view;
  };
  const reelsOf = async (person: Friend, roomId: string) => {
    const read = unwrap(await world.rooms.watchReels(person.authority, { version, readId: randomUUID(), roomId }));
    if (read.status !== 'ready') throw new Error('expected a ready list');
    return read.reels;
  };
  const sessionIdOf = (result: Awaited<ReturnType<typeof start>>) => {
    const accepted = unwrap(result);
    if (accepted.outcome !== 'accepted') throw new Error('expected accepted');
    return accepted.sessionId;
  };
  /** The live session as this person reads it, which must exist. */
  const sessionFor = async (person: Friend, roomId: string) => {
    const { session } = await stage(person, roomId);
    if (session === undefined) throw new Error('expected a live session');
    return session;
  };

  /** A room with `count` members, all with the room open, and one library Reel under its topic. */
  async function readyRoom(count: number) {
    const { roomId, slug } = await seedRoom(world);
    const people = await joined(world, roomId, count);
    for (const person of people) unwrap(await setPresence(world, person, roomId));
    const reel = await addReel();
    return { roomId, slug, people, reel };
  }

  describe('the Reels a room may watch', () => {
    it('are the current library Reels under the room’s topic, by title, and no fixture, withdrawn, supporting or other Reel', async () => {
      begin();
      const { roomId, people } = await readyRoom(1);
      const [asha] = people as [Friend];
      const beta = await addReel({ title: 'Zeta fixture Reel', topic: TRANSFORMERS });
      const alpha = await addReel({ title: 'Alpha fixture Reel' });
      await addReel({ title: 'Fixture marked', fixture: true });
      await addReel({ title: 'Withdrawn', status: 'withdrawn' });
      await addReel({ title: 'Only supporting', role: 'supporting' });
      const titles = (await reelsOf(asha, roomId)).map((reel) => reel.title);
      expect(titles.filter((title) => /^(Alpha|Zeta)/.test(title))).toEqual([alpha.title, beta.title]);
      for (const hidden of ['Fixture marked', 'Withdrawn', 'Only supporting']) expect(titles).not.toContain(hidden);
      const listed = (await reelsOf(asha, roomId)).find((reel) => reel.title === alpha.title);
      expect(listed).toEqual({ assetId: alpha.assetId, assetRevision: 1, title: alpha.title, durationMs: LENGTH });
    });

    it('follow a planet room to its own planet only', async () => {
      begin();
      const { roomId } = await seedRoom(world, { topic: { kind: 'planet', id: TRANSFORMERS } });
      const [asha] = await joined(world, roomId, 1);
      const only = await addReel({ title: 'Planet room Reel', topic: TRANSFORMERS });
      const other = await addReel({ title: 'Other planet Reel', topic: ATTENTION });
      const titles = (await reelsOf(asha!, roomId)).map((reel) => reel.title);
      expect(titles).toContain(only.title);
      expect(titles).not.toContain(other.title);
    });

    it('are read by members only, with one answer for a stranger, someone who left and a room that does not exist', async () => {
      begin();
      const { roomId, people } = await readyRoom(2);
      const [asha, leaver] = people as [Friend, Friend];
      const outsider = await seedFriend(world.db, world.friends);
      unwrap(await world.rooms.leave(leaver.authority, { version, commandId: randomUUID(), roomId }));
      const refusal = await world.rooms.watchReels(outsider.authority, { version, readId: randomUUID(), roomId });
      expect(refusal).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await world.rooms.watchReels(leaver.authority, { version, readId: randomUUID(), roomId })).toEqual(
        refusal,
      );
      expect(
        await world.rooms.watchReels(asha.authority, { version, readId: randomUUID(), roomId: randomUUID() }),
      ).toEqual(refusal);
      expect((await world.rooms.watch(outsider.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
    });
  });

  describe('starting one', () => {
    it('needs a Reel under the topic, two people with the room open, a free stage and an open room, and says which', async () => {
      const t0 = begin();
      const quiet = await seedRoom(world, {
        topic: { kind: 'system', id: 'history' },
        slug: `ci-history-${randomUUID().slice(0, 6)}`,
      });
      const [lena] = await joined(world, quiet.roomId, 1);
      unwrap(await setPresence(world, lena!, quiet.roomId));
      expect((await stage(lena!, quiet.roomId)).start).toEqual({ allowed: false, reason: 'no_reels' });
      expect((await memberView(world, lena!, quiet.roomId)).watch).toBeUndefined();

      const { roomId, people, reel } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      // The people who have the room open are two, so it can start; with one lease lapsed it cannot.
      expect((await stage(asha, roomId)).start).toEqual({ allowed: true });
      expect((await memberView(world, asha, roomId)).watch).toEqual({ state: 'ready' });
      at(120_000, t0);
      expect((await stage(asha, roomId)).start).toEqual({ allowed: false, reason: 'few_here' });
      expect((await start(asha, roomId, reel.assetId)).kind).toBe('refused');
      unwrap(await setPresence(world, asha, roomId));
      unwrap(await setPresence(world, ravi, roomId));
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // A room that is paused is not started in.
      const paused = await readyRoom(2);
      await world.db
        .updateTable('rooms.rooms')
        .set({ status: 'paused' })
        .where('room_id', '=', paused.roomId)
        .execute();
      expect((await stage(paused.people[0]!, paused.roomId)).start).toEqual({ allowed: false, reason: 'room_paused' });
      expect((await start(paused.people[0]!, paused.roomId, paused.reel.assetId)).kind).toBe('refused');
    });

    it('puts the starter among those watching, with the Reel and its length frozen, and the first frame five seconds on', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const result = unwrap(await start(asha, roomId, reel.assetId));
      if (result.outcome !== 'accepted') throw new Error('expected accepted');
      expect(result).toMatchObject({ operation: 'watch.start', roomId, startsInMs: LEAD_IN_MS, replayed: false });
      const row = await world.db
        .selectFrom('rooms.watch_sessions')
        .selectAll()
        .where('room_id', '=', roomId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        asset_id: reel.assetId,
        asset_revision: 1,
        title: reel.title,
        duration_ms: LENGTH,
        started_by: asha.accountId,
        stopped_at: null,
      });
      expect(new Date(row.starts_at).getTime()).toBe(t0.getTime() + LEAD_IN_MS);
      const own = await sessionFor(asha, roomId);
      expect(own).toMatchObject({
        phase: 'starting',
        startsInMs: LEAD_IN_MS,
        youIn: true,
        canStop: true,
        reel: { assetId: reel.assetId, title: reel.title, durationMs: LENGTH },
      });
      expect(own.sharedBy?.personId).toBe(asha.person.personId);
      // Another member is told it is on, and that they have not joined: nothing opens for them.
      const other = await sessionFor(ravi, roomId);
      expect(other).toMatchObject({ youIn: false, canStop: false });
      expect((await memberView(world, ravi, roomId)).watch).toEqual({ state: 'live' });
      expect((await stage(ravi, roomId)).start).toBeUndefined();
    });

    it('is refused for a Reel the topic does not rest on, one that is not there, a second session and a repeat of the day', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(2);
      const [asha] = people as [Friend, Friend];
      const elsewhere = await addReel({ role: 'supporting' });
      const fixture = await addReel({ fixture: true });
      for (const assetId of [elsewhere.assetId, fixture.assetId, randomUUID()])
        expect(await start(asha, roomId, assetId), assetId).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(
        await world.db.selectFrom('rooms.watch_sessions').select('session_id').where('room_id', '=', roomId).execute(),
      ).toEqual([]);
      sessionIdOf(await start(asha, roomId, reel.assetId));
      // The stage is taken: no second session, for the same Reel or another.
      expect(await start(asha, roomId, reel.assetId)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect((await stage(asha, roomId)).start).toBeUndefined();
      // A room's day has a cap; the refusal is the one for "slow down".
      at(HOUR, t0);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      await world.db.deleteFrom('rooms.watch_viewers').execute();
      await world.db.deleteFrom('rooms.watch_sessions').where('room_id', '=', roomId).execute();
      for (let index = 0; index < SESSIONS_PER_ROOM_DAY; index++)
        await world.db
          .insertInto('rooms.watch_sessions')
          .values({
            session_id: randomUUID(),
            room_id: roomId,
            asset_id: reel.assetId,
            asset_revision: 1,
            title: reel.title,
            duration_ms: 5_000,
            started_by: null,
            starts_at: new Date(t0.getTime() + index * 1_000),
            stopped_at: new Date(t0.getTime() + index * 1_000 + 5_000),
          })
          .execute();
      expect((await stage(asha, roomId)).start).toEqual({ allowed: false, reason: 'too_many' });
      expect(await start(asha, roomId, reel.assetId)).toEqual({ kind: 'refused', code: 'rate_limited' });
    });

    it('makes one session when two members start at once, and the same command again replays', async () => {
      begin();
      const { roomId, people, reel } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const results = await Promise.all([start(asha, roomId, reel.assetId), start(ravi, roomId, reel.assetId)]);
      expect(results.filter((result) => result.kind === 'ok')).toHaveLength(1);
      expect(
        await world.db.selectFrom('rooms.watch_sessions').select('session_id').where('room_id', '=', roomId).execute(),
      ).toHaveLength(1);
      const room = await readyRoom(2);
      const command = randomUUID();
      const first = unwrap(await start(room.people[0]!, room.roomId, room.reel.assetId, 1, command));
      const second = unwrap(await start(room.people[0]!, room.roomId, room.reel.assetId, 1, command));
      expect(second).toMatchObject({ replayed: true });
      expect(first).toMatchObject({ outcome: 'accepted' });
      if (first.outcome === 'accepted' && second.outcome === 'accepted') expect(second.sessionId).toBe(first.sessionId);
    });

    it('is for members: a stranger and a person who left start nothing and read nothing', async () => {
      begin();
      const { roomId, people, reel } = await readyRoom(3);
      const [asha, leaver] = people as [Friend, Friend, Friend];
      const outsider = await seedFriend(world.db, world.friends);
      unwrap(await world.rooms.leave(leaver.authority, { version, commandId: randomUUID(), roomId }));
      for (const person of [outsider, leaver]) {
        expect((await start(person, roomId, reel.assetId)).kind).toBe('refused');
        expect((await world.rooms.watch(person.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
          'refused',
        );
      }
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      for (const person of [outsider, leaver]) {
        expect((await join(person, roomId, sessionId)).kind).toBe('refused');
        expect((await leave(person, roomId, sessionId)).kind).toBe('refused');
        expect((await stop(person, roomId, sessionId)).kind).toBe('refused');
      }
      // A preview does not say that something is on.
      expect(
        JSON.stringify(unwrap(await world.rooms.read(outsider.authority, { version, readId: randomUUID(), roomId }))),
      ).not.toContain('"watch"');
    });
  });

  describe('the clock', () => {
    it('is the server’s: every reader is told the same time since the first frame, and a device counts on from it', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      sessionIdOf(await start(asha, roomId, reel.assetId));
      const first = await sessionFor(ravi, roomId);
      expect(first).toMatchObject({ phase: 'starting', startsInMs: LEAD_IN_MS });
      at(LEAD_IN_MS + 41_000, t0);
      const readings = await Promise.all([asha, ravi, kenji].map((person) => sessionFor(person, roomId)));
      for (const reading of readings) expect(reading).toMatchObject({ phase: 'playing', elapsedMs: 41_000 });
      at(LEAD_IN_MS + LENGTH - 1, t0);
      expect(await sessionFor(kenji, roomId)).toMatchObject({ phase: 'playing', elapsedMs: LENGTH - 1 });
    });

    it('ends when the last frame is due: the stage is free, and says what was last on it', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(2);
      const [asha, ravi] = people as [Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      unwrap(await join(ravi, roomId, sessionId));
      at(LEAD_IN_MS + LENGTH, t0);
      const over = await stage(ravi, roomId);
      expect(over.session).toBeUndefined();
      expect(over.last).toEqual({
        kind: 'reel',
        at: new Date(t0.getTime() + LEAD_IN_MS).toISOString(),
        title: reel.title,
      });
      expect(over.start).toEqual({ allowed: false, reason: 'few_here' });
      expect((await memberView(world, ravi, roomId)).watch).toEqual({ state: 'ready' });
      // Stopping a Reel that has run out is refused: it is already over, and the settlement below still says when it ended.
      expect(await stop(asha, roomId, sessionId)).toEqual({ kind: 'refused', code: 'unavailable' });
      // The first member command after the end settles it: stopped when the last frame was due, and nobody is a viewer.
      for (const person of [asha, ravi]) unwrap(await setPresence(world, person, roomId));
      const settled = await world.db
        .selectFrom('rooms.watch_sessions')
        .select(['stopped_at'])
        .where('session_id', '=', sessionId)
        .executeTakeFirstOrThrow();
      expect(new Date(settled.stopped_at!).getTime()).toBe(t0.getTime() + LEAD_IN_MS + LENGTH);
      expect(
        await world.db
          .selectFrom('rooms.watch_viewers')
          .select('account_id')
          .where('session_id', '=', sessionId)
          .execute(),
      ).toEqual([]);
      // The stage is free again: another Reel can be started.
      expect(sessionIdOf(await start(ravi, roomId, reel.assetId))).not.toBe(sessionId);
    });

    it('settles a session nobody noticed for days at the time it ended, and deletes it after seven days', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(2);
      const [asha] = people as [Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      const ended = new Date(t0.getTime() + LEAD_IN_MS + LENGTH);
      at(3 * DAY, t0);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      const row = () =>
        world.db
          .selectFrom('rooms.watch_sessions')
          .select(['stopped_at'])
          .where('session_id', '=', sessionId)
          .executeTakeFirst();
      expect(new Date((await row())!.stopped_at!).getTime()).toBe(ended.getTime());
      at(8 * DAY, t0);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      expect(await row()).toBeUndefined();
    });
  });

  describe('what the server keeps', () => {
    it('has no column that could hold a position, a pause or a time of a person’s own', async () => {
      const columns = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name from information_schema.columns
        where table_schema = 'rooms' and table_name in ('watch_sessions', 'watch_viewers')
        order by table_name, ordinal_position`.execute(world.db);
      const byTable = (table: string) =>
        columns.rows.filter((row) => row.table_name === table).map((row) => row.column_name);
      expect(byTable('watch_sessions')).toEqual([
        'session_id',
        'room_id',
        'asset_id',
        'asset_revision',
        'title',
        'duration_ms',
        'started_by',
        'starts_at',
        'stopped_at',
      ]);
      expect(byTable('watch_viewers')).toEqual(['session_id', 'account_id']);
      expect(columns.rows.map((row) => row.column_name).join(' ')).not.toMatch(
        /position|pause|offset|elapsed|seek|playhead|cursor|progress/i,
      );
    });

    it('answers no position at all: nothing in what a member reads says where anyone is in the Reel', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      at(LEAD_IN_MS + 10_000, t0);
      for (const person of [ravi, kenji, lena]) unwrap(await join(person, roomId, sessionId));
      at(LEAD_IN_MS + 33_000, t0);
      const seen = JSON.stringify([await stage(asha, roomId), await stage(ravi, roomId), await stage(lena, roomId)]);
      // The room's own view says that something is on, and no more.
      expect((await memberView(world, kenji, roomId)).watch).toEqual({ state: 'live' });
      // The only time in the answers is the one clock, the same for everyone; there is no per-person time and no list of people.
      expect(seen).not.toMatch(/position|viewers|watchers|joinedAt|joined_at/i);
      expect(seen.match(/"elapsedMs":(\d+)/g)).toEqual(['"elapsedMs":33000', '"elapsedMs":33000', '"elapsedMs":33000']);
      expect(seen).not.toContain(ravi.person.personId);
      expect(seen).not.toContain(kenji.person.personId);
    });

    it('writes nothing for anyone in the personal universe or the consumption tables, around a whole session', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const personalBefore = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const consumptionBefore = await consumptionRows(world.db);
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      at(LEAD_IN_MS + 1_000, t0);
      for (const person of [ravi, kenji, lena]) unwrap(await join(person, roomId, sessionId));
      await stage(ravi, roomId);
      unwrap(await leave(kenji, roomId, sessionId));
      unwrap(await stop(asha, roomId, sessionId));
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(personalBefore);
      expect(await consumptionRows(world.db)).toBe(consumptionBefore);
      // No exposure exists for anyone: the session is not an encounter of anybody's.
      for (const person of people)
        expect(
          await sql`select 1 from experience.exposures where universe_id = ${person.universeId}::uuid`
            .execute(world.db)
            .then((r) => r.rows),
        ).toEqual([]);
    });
  });

  describe('N watching', () => {
    it('is a number only from three people who joined, and never from people who only have the room open', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(5);
      const [asha, ravi, kenji, lena, omar] = people as [Friend, Friend, Friend, Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      const watching = async (person: Friend) => (await sessionFor(person, roomId)).watching;
      // Five people have the room open, but only the starter has joined.
      expect(await watching(asha)).toBeUndefined();
      expect(await watching(ravi)).toBeUndefined();
      unwrap(await join(ravi, roomId, sessionId));
      expect(await watching(asha)).toBeUndefined();
      expect(await watching(omar)).toBeUndefined();
      unwrap(await join(kenji, roomId, sessionId));
      expect(await watching(asha)).toBe(3);
      // A person who has not joined is told the same number, and cannot tell who is in.
      expect(await watching(lena)).toBe(3);
      unwrap(await join(lena, roomId, sessionId));
      expect(await watching(omar)).toBe(4);
      // The same person joining twice is one.
      unwrap(await join(lena, roomId, sessionId));
      expect(await watching(omar)).toBe(4);
      // A person who leaves is not counted, and below three the number is gone.
      unwrap(await leave(lena, roomId, sessionId));
      unwrap(await leave(kenji, roomId, sessionId));
      expect(await watching(omar)).toBeUndefined();
      void t0;
    });

    it('counts only people who still have the room open: a lapsed lease is not watching', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      for (const person of [ravi, kenji]) unwrap(await join(person, roomId, sessionId));
      expect((await sessionFor(lena, roomId)).watching).toBe(3);
      // A minute passes: Asha and Ravi keep the room open, Kenji's device closed without saying so.
      at(70_000, t0);
      unwrap(await setPresence(world, asha, roomId));
      unwrap(await setPresence(world, ravi, roomId));
      expect((await sessionFor(lena, roomId)).watching).toBeUndefined();
      expect((await sessionFor(asha, roomId)).watching).toBeUndefined();
      // Kenji comes back to the room: still joined, counted again.
      unwrap(await setPresence(world, kenji, roomId));
      expect((await sessionFor(lena, roomId)).watching).toBe(3);
      // A device that says it is away at once is not counted either.
      unwrap(await setPresence(world, kenji, roomId, 'away'));
      expect((await sessionFor(lena, roomId)).watching).toBeUndefined();
    });

    it('leaves a person the reader blocked out of the number, for that reader only, and an AI can never be in it', async () => {
      begin();
      const { roomId, people, reel } = await readyRoom(5);
      const [asha, ravi, kenji, lena, omar] = people as [Friend, Friend, Friend, Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      for (const person of [ravi, kenji, lena]) unwrap(await join(person, roomId, sessionId));
      expect((await sessionFor(omar, roomId)).watching).toBe(4);
      unwrap(await friendCommand(world.friends, omar, kenji, 'block'));
      // Omar blocked Kenji: for Omar the number is three people, and when two more leave it is gone; for everyone else nothing changed.
      expect((await sessionFor(omar, roomId)).watching).toBe(3);
      expect((await sessionFor(asha, roomId)).watching).toBe(4);
      unwrap(await leave(lena, roomId, sessionId));
      expect((await sessionFor(omar, roomId)).watching).toBeUndefined();
      expect((await sessionFor(asha, roomId)).watching).toBe(3);
      // Viewers are accounts: there is no way for a resident to join, and the table cannot hold one.
      const rows = await world.db
        .selectFrom('rooms.watch_viewers')
        .select('account_id')
        .where('session_id', '=', sessionId)
        .execute();
      const members = await world.db
        .selectFrom('rooms.members')
        .select('account_id')
        .where('room_id', '=', roomId)
        .execute();
      expect(rows.every((row) => members.some((member) => member.account_id === row.account_id))).toBe(true);
    });

    it('hides who shared it from a reader who blocked them, and shows nobody else', async () => {
      begin();
      const { roomId, people, reel } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      sessionIdOf(await start(asha, roomId, reel.assetId));
      expect((await sessionFor(ravi, roomId)).sharedBy?.personId).toBe(asha.person.personId);
      unwrap(await friendCommand(world.friends, kenji, asha, 'block'));
      const blocking = await sessionFor(kenji, roomId);
      expect(blocking.sharedBy).toBeUndefined();
      // The session is still there for the blocker: the room goes on.
      expect(blocking.reel.title).toBe(reel.title);
    });
  });

  describe('joining, leaving and stopping', () => {
    it('lets a member join only while the session is on, once, and take the place back', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      expect(unwrap(await join(ravi, roomId, sessionId))).toMatchObject({
        outcome: 'accepted',
        operation: 'watch.join',
      });
      expect((await sessionFor(ravi, roomId)).youIn).toBe(true);
      expect((await sessionFor(kenji, roomId)).youIn).toBe(false);
      // Joining again changes nothing; the same command replays.
      const command = randomUUID();
      unwrap(await join(kenji, roomId, sessionId, 1, command));
      expect(unwrap(await join(kenji, roomId, sessionId, 1, command))).toMatchObject({ replayed: true });
      unwrap(await join(kenji, roomId, sessionId));
      expect(
        await world.db
          .selectFrom('rooms.watch_viewers')
          .select('account_id')
          .where('session_id', '=', sessionId)
          .execute(),
      ).toHaveLength(3);
      // A session that is not the room's, or that is over, cannot be joined.
      expect((await join(ravi, roomId, randomUUID())).kind).toBe('refused');
      unwrap(await leave(ravi, roomId, sessionId));
      expect((await sessionFor(ravi, roomId)).youIn).toBe(false);
      unwrap(await join(ravi, roomId, sessionId));
      at(LEAD_IN_MS + LENGTH, t0);
      expect(await join(ravi, roomId, sessionId)).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('keeps nothing and writes no receipt while recording is paused or the device is out of date, but always lets a person leave', async () => {
      begin();
      const { roomId, people, reel } = await readyRoom(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      const setRecording = (person: Friend, on: boolean, generation: number) =>
        world.db
          .updateTable('identity.universes')
          .set({ recording_on: on, recording_generation: generation })
          .where('account_id', '=', person.accountId)
          .execute();
      await setRecording(kenji, false, 2);
      expect(unwrap(await start(kenji, roomId, reel.assetId, 2))).toMatchObject({
        outcome: 'not_saved',
        reason: 'recording_paused',
      });
      expect(
        await world.db.selectFrom('rooms.watch_sessions').select('session_id').where('room_id', '=', roomId).execute(),
      ).toEqual([]);
      const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
      expect(unwrap(await join(kenji, roomId, sessionId, 2))).toMatchObject({
        outcome: 'not_saved',
        reason: 'recording_paused',
        roomId,
      });
      expect(
        await sql`select 1 from rooms.watch_viewers where account_id = ${kenji.accountId}::uuid`
          .execute(world.db)
          .then((r) => r.rows),
      ).toEqual([]);
      expect(
        await sql`select 1 from receipts.shared_commands where actor_account_id = ${kenji.accountId}::uuid and operation like 'rooms.watch-%'`
          .execute(world.db)
          .then((r) => r.rows),
      ).toEqual([]);
      // Back on, but the device still names the old generation: nothing stored either; then the new one is accepted.
      await setRecording(kenji, true, 3);
      expect(unwrap(await join(kenji, roomId, sessionId, 2))).toMatchObject({
        outcome: 'not_saved',
        reason: 'recording_generation_stale',
      });
      expect(unwrap(await join(kenji, roomId, sessionId, 3))).toMatchObject({ outcome: 'accepted' });
      // Someone who has joined and then pauses can still take their place back.
      await setRecording(kenji, false, 4);
      expect(unwrap(await leave(kenji, roomId, sessionId))).toMatchObject({ outcome: 'accepted' });
      // Another person's pause does not touch Ravi.
      expect(unwrap(await join(ravi, roomId, sessionId))).toMatchObject({ outcome: 'accepted' });
    });

    it('lets the member who shared it and a moderator stop it for everyone, and nobody else', async () => {
      begin();
      const { roomId, slug, people, reel } = await readyRoom(4);
      const [asha, ravi, kenji, mod] = people as [Friend, Friend, Friend, Friend];
      await makeModerator(world, slug, mod);
      const first = sessionIdOf(await start(asha, roomId, reel.assetId));
      for (const person of [ravi, kenji]) unwrap(await join(person, roomId, first));
      expect(await stop(ravi, roomId, first)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect((await sessionFor(ravi, roomId)).canStop).toBe(false);
      expect((await sessionFor(mod, roomId)).canStop).toBe(true);
      expect(unwrap(await stop(asha, roomId, first))).toMatchObject({ outcome: 'accepted', operation: 'watch.stop' });
      expect((await stage(kenji, roomId)).session).toBeUndefined();
      expect(
        await world.db.selectFrom('rooms.watch_viewers').select('account_id').where('session_id', '=', first).execute(),
      ).toEqual([]);
      expect(await stop(asha, roomId, first)).toEqual({ kind: 'refused', code: 'unavailable' });
      // A moderator can stop one they did not start.
      const second = sessionIdOf(await start(kenji, roomId, reel.assetId));
      expect(unwrap(await stop(mod, roomId, second))).toMatchObject({ outcome: 'accepted' });
      expect((await stage(asha, roomId)).last?.kind).toBe('reel');
    });
  });

  describe('a device that lost its hints', () => {
    it('reads the whole stage again from one durable read: the session, whether it joined, and what changed while it was away', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(4);
      const [asha, ravi, kenji, offline] = people as [Friend, Friend, Friend, Friend];
      // While `offline` heard nothing: a session began, three people joined, and it was stopped and another began.
      const first = sessionIdOf(await start(asha, roomId, reel.assetId));
      for (const person of [ravi, kenji]) unwrap(await join(person, roomId, first));
      unwrap(await stop(asha, roomId, first));
      at(60_000, t0);
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      const second = sessionIdOf(await start(ravi, roomId, reel.assetId));
      unwrap(await join(kenji, roomId, second));
      unwrap(await join(asha, roomId, second));
      at(60_000 + LEAD_IN_MS + 20_000, t0);
      const recovered = await sessionFor(offline, roomId);
      expect(recovered).toMatchObject({
        sessionId: second,
        phase: 'playing',
        elapsedMs: 20_000,
        youIn: false,
        watching: 3,
      });
      // It joins now, and is counted: the read and the command are all it needs.
      unwrap(await join(offline, roomId, second));
      expect(await sessionFor(offline, roomId)).toMatchObject({ youIn: true, watching: 4 });
      // And when it was away while the session ended, the same read says the stage is free and what was last on it.
      at(60_000 + LEAD_IN_MS + LENGTH, t0);
      const after = await stage(offline, roomId);
      expect(after.session).toBeUndefined();
      expect(after.last?.kind).toBe('reel');
    });

    it('queues a hint that names the room and nothing else, once for each thing that changes the stage', async () => {
      begin();
      const { roomId, people, reel } = await readyRoom(3);
      const [asha, ravi] = people as [Friend, Friend, Friend];
      const listener = new pg.Client({ connectionString: database.settings.url });
      await listener.connect();
      const raw: Record<string, unknown>[] = [];
      listener.on('notification', (notice) => {
        if (notice.channel !== 'ks_scope_changed' || notice.payload === undefined) return;
        const parsed = JSON.parse(notice.payload) as { scope: { kind: string; id: string } };
        if (parsed.scope.kind === 'room' && parsed.scope.id === roomId) raw.push(parsed);
      });
      try {
        await listener.query('listen ks_scope_changed');
        const settle = async (count: number) => {
          // pg_notify arrives after commit, on the listener's own connection.
          for (let attempt = 0; attempt < 50 && raw.length < count; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
          await new Promise((resolve) => setTimeout(resolve, 60));
          expect(raw).toHaveLength(count);
        };
        const sessionId = sessionIdOf(await start(asha, roomId, reel.assetId));
        await settle(1);
        unwrap(await join(ravi, roomId, sessionId));
        await settle(2);
        // Joining again changes nothing, so it says nothing.
        unwrap(await join(ravi, roomId, sessionId));
        await settle(2);
        unwrap(await leave(ravi, roomId, sessionId));
        await settle(3);
        unwrap(await stop(asha, roomId, sessionId));
        await settle(4);
        // The payloads are exactly these keys: nothing about a Reel, a time or a person can ride on a hint.
        for (const payload of raw) {
          expect(Object.keys(payload).sort()).toEqual(['eventId', 'revision', 'scope', 'v']);
          expect(Object.keys(payload['scope'] as object).sort()).toEqual(['id', 'kind']);
        }
        expect(JSON.stringify(raw)).not.toContain(reel.assetId);
        expect(JSON.stringify(raw)).not.toContain(sessionId);
      } finally {
        await listener.end();
      }
    });
  });

  describe('the stage is one thing at a time', () => {
    /** A Launch in its lobby or running, as the Launch use cases leave one: a deck ritual, then the Launch itself. */
    async function runningLaunch(roomId: string, startsAt: Date) {
      const ritualId = randomUUID();
      const when = world.clock.now;
      await sql`
        insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at, decided_at, decided_by)
        values (${ritualId}::uuid, ${roomId}::uuid, ${when.toISOString().slice(0, 10)}::date, 'launch', '{}'::jsonb, 'ritual.v1', 'approved',
          'template', ${when}, ${when}, 'cli:ci')`.execute(world.db);
      await world.db
        .insertInto('rooms.launches')
        .values({
          launch_id: randomUUID(),
          room_id: roomId,
          deck_ritual_id: ritualId,
          questions: JSON.stringify([{}, {}, {}, {}, {}]),
          starts_at: startsAt,
          created_at: when,
          state: 'live',
        })
        .execute();
    }

    it('keeps a Reel from starting while a Launch is on, and a Launch from starting while a Reel is on', async () => {
      const t0 = begin();
      const { roomId, people, reel } = await readyRoom(2);
      const [asha] = people as [Friend, Friend];
      await runningLaunch(roomId, new Date(t0.getTime() + 20_000));
      expect((await stage(asha, roomId)).start).toEqual({ allowed: false, reason: 'stage_busy' });
      expect(await start(asha, roomId, reel.assetId)).toEqual({ kind: 'refused', code: 'unavailable' });

      const other = await readyRoom(2);
      const [lena] = other.people as [Friend, Friend];
      sessionIdOf(await start(lena, other.roomId, other.reel.assetId));
      const launch = unwrap(
        await world.rooms.launch(lena.authority, { version, readId: randomUUID(), roomId: other.roomId }),
      );
      if (launch.status !== 'ready') throw new Error('expected ready');
      expect(launch.start).toEqual({ allowed: false, reason: 'stage_busy' });
      expect(
        (
          await world.rooms.startLaunch(lena.authority, {
            version,
            commandId: randomUUID(),
            roomId: other.roomId,
            recordingGeneration: 1,
          })
        ).kind,
      ).toBe('refused');
    });

    it('says on a member’s station that a Reel is on, and on no one else’s, and not once it is over', async () => {
      const t0 = begin();
      await seedRooms(world.db, libraryRoomSeeds(), world.clock.now);
      const earth = (
        await world.db.selectFrom('rooms.rooms').select('room_id').where('slug', '=', 'earth').executeTakeFirstOrThrow()
      ).room_id;
      const [asha, ravi] = (await joined(world, earth, 2)) as [Friend, Friend];
      for (const person of [asha, ravi]) unwrap(await setPresence(world, person, earth));
      const reel = await addReel({ topic: 'earth.seasons' });
      const outsider = await seedFriend(world.db, world.friends);
      for (const person of [asha, outsider]) await seedAuthoredGeography(world.db, person);
      const stationOf = async (person: Friend) =>
        unwrap(await world.rooms.stations(person.authority, { version, readId: randomUUID() })).stations.find(
          (station) => station.room.roomId === earth,
        );
      expect(await stationOf(asha)).not.toHaveProperty('live');
      sessionIdOf(await start(asha, earth, reel.assetId));
      expect((await stationOf(asha))?.live).toBe('reel');
      expect(await stationOf(outsider)).not.toHaveProperty('live');
      expect((await stationOf(outsider))?.standing).toBe('none');
      at(LEAD_IN_MS + LENGTH, t0);
      expect(await stationOf(asha)).not.toHaveProperty('live');
    });
  });

  describe('what a person can take back', () => {
    async function realMember(): Promise<Friend> {
      const person = await recordingPerson(database);
      const set = await world.friends.setProfile(person.authority, {
        version: 'sharing.v1',
        commandId: randomUUID(),
        expectedProfileRevision: 0,
        handle: `ci.${person.accountId.replaceAll('-', '').slice(0, 14)}`,
        displayName: 'Fixture person',
      });
      if (set.kind !== 'ok') throw new Error('profile refused');
      const readProfile = await world.friends.readProfile(person.authority);
      if (readProfile.kind !== 'ok' || readProfile.value.status !== 'claimed') throw new Error('profile unreadable');
      return { ...person, person: readProfile.value.person };
    }
    const held = async (accountId: string) => ({
      viewers: Number(
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from rooms.watch_viewers where account_id = ${accountId}::uuid`.execute(
            world.db,
          )
        ).rows[0]!.n,
      ),
      shared: Number(
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from rooms.watch_sessions where started_by = ${accountId}::uuid`.execute(
            world.db,
          )
        ).rows[0]!.n,
      ),
    });
    /** A real member (a Clear and a deletion run on them) who shared a session that Asha joined. */
    async function sharedByMember() {
      begin();
      const { roomId, reel, slug } = await readyRoom(0);
      const person = await realMember();
      unwrap(await world.rooms.join(person.authority, { version, commandId: randomUUID(), roomId }));
      const [asha] = (await joined(world, roomId, 1)) as [Friend];
      for (const member of [person, asha]) unwrap(await setPresence(world, member, roomId));
      const sessionId = sessionIdOf(await start(person, roomId, reel.assetId));
      unwrap(await join(asha, roomId, sessionId));
      return { roomId, slug, person, asha, sessionId };
    }

    it('empties the place and the link with a Clear, and deletes them with the account after listing them in the file', async () => {
      const { roomId, person, asha, sessionId } = await sharedByMember();
      expect(await held(person.accountId)).toEqual({ viewers: 1, shared: 1 });
      const exportNow = async (as: Friend = person) => {
        const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(as.authority, (scope) =>
          exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
        );
        if (exported.kind !== 'entered') throw new Error('export refused');
        return JSON.stringify(exported.value.sections['rooms']);
      };
      const file = await exportNow();
      expect(file).toContain('watchTogether');
      expect(file).toContain('"you":"shared"');
      expect(file).toContain('"you":"joined"');
      // A day and a room, never a position, and nobody else.
      expect(file).not.toMatch(/position|elapsed/i);
      expect(file).not.toContain(asha.person.displayName === 'Fixture person' ? '__none__' : asha.person.displayName);

      await clearRecordingPerson(database, boss, person);
      expect(await held(person.accountId)).toEqual({ viewers: 0, shared: 0 });
      const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
      // The session goes on for the people who are watching it; it just has nobody who shared it now.
      const remaining = await world.db
        .selectFrom('rooms.watch_sessions')
        .select(['session_id', 'started_by'])
        .where('session_id', '=', sessionId)
        .executeTakeFirstOrThrow();
      expect(remaining.started_by).toBeNull();
      expect(await held(asha.accountId)).toEqual({ viewers: 1, shared: 0 });
      void roomId;
      expect(await exportNow(cleared)).toContain('"watchTogether":[]');
    });

    it('does the same when they leave the room or are removed from it, and when the account is deleted', async () => {
      const left = await sharedByMember();
      unwrap(await world.rooms.leave(left.person.authority, { version, commandId: randomUUID(), roomId: left.roomId }));
      expect(await held(left.person.accountId)).toEqual({ viewers: 0, shared: 0 });
      expect((await sessionFor(left.asha, left.roomId)).sharedBy).toBeUndefined();

      const removed = await sharedByMember();
      await makeModerator(world, removed.slug, removed.asha);
      const removal = await world.rooms.moderate(removed.asha.authority, {
        version,
        commandId: randomUUID(),
        roomId: removed.roomId,
        action: { kind: 'remove_member', personId: removed.person.person.personId },
      });
      expect(removal.kind).toBe('ok');
      expect(await held(removed.person.accountId)).toEqual({ viewers: 0, shared: 0 });

      const deleted = await sharedByMember();
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(deleted.person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await held(deleted.person.accountId)).toEqual({ viewers: 0, shared: 0 });
      expect(
        await world.db
          .selectFrom('rooms.watch_sessions')
          .select('session_id')
          .where('session_id', '=', deleted.sessionId)
          .execute(),
      ).toHaveLength(1);
    });

    it('lists nothing for a person who never took part', async () => {
      begin();
      const person = await realMember();
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      expect(JSON.stringify(exported.value.sections['rooms'] ?? {})).not.toContain('watchTogether');
    });
  });
});
