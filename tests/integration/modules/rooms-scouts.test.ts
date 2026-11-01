/**
 * Scouts (v3 R-9, D-259 to D-261) over real PostgreSQL, the real reasoning harness with a CI fixture model (never provider
 * output) and library assets admitted through the real import use case. A member sends a scout into a room and chooses, from the
 * room's own topics, where it looks; it posts at most one find a day, signed with its owner's name and labelled AI; code picks the
 * asset and a model writes only the note; and it starts no encounter and writes no evidence, for anyone.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { reportCases } from '../support/feedback.js';
import { recordingPerson } from '../support/recording-person.js';
import {
  FIND_NOTE,
  PLANETS,
  feedHeartbeat,
  feedTurns,
  find,
  libraryReel,
  libraryScroll,
  moderateScout,
  never,
  NOTHING,
  readFeed,
  requestText,
  scoutBeat,
  scoutRow,
  scoutTurns,
  setScout,
} from '../support/rooms-feed.js';
import {
  PERSONAL_UNIVERSE_SCHEMAS,
  askAbout,
  hideMessage,
  joined,
  makeModerator,
  markUseful,
  memberView,
  readDiscussion,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPreferences,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, seedFriend, type Friend } from '../support/talk.js';

const START = new Date('2026-11-04T07:59:00Z');
const version = 'rooms.v1' as const;
const [ASTRO, OTHER] = [PLANETS[0]!, PLANETS[1]!];

describe('scouts (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let off: RoomWorld;
  let boss: ReturnType<typeof createBoss>;
  let reports: ReturnType<typeof reportCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_scouts');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true, scoutsEnabled: true });
    // The same database, in a world where scouts are not switched on.
    off = await roomWorld(database, { now: START }, { residentsEnabled: true });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    reports = reportCases(database.db, () => world.clock.now);
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await off.close();
    await world.close();
    await database.drop();
  });
  // Each test starts from an empty library, no open room of an earlier test and the same clock.
  beforeEach(async () => {
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).execute();
    await database.db.updateTable('rooms.rooms').set({ status: 'closed' }).execute();
    world.clock.now = START;
    off.clock.now = START;
  });

  const at = (iso: string) => {
    world.clock.now = new Date(iso);
  };

  /** A room with a moderator, an owner who will send a scout and `others` members who listen. */
  async function room(others = 2) {
    const { roomId, slug } = await seedRoom(world);
    const [owner, ...rest] = await joined(world, roomId, others + 1);
    const moderator = await seedFriend(world.db, world.friends);
    await makeModerator(world, slug, moderator);
    return { roomId, slug, owner: owner!, listeners: rest, moderator };
  }
  type Scene = Awaited<ReturnType<typeof room>>;
  /** A room whose owner has sent a scout to the first planet. */
  async function sent(others = 2, choice: { cadence?: 'daily' | 'weekly' } = {}) {
    const scene = await room(others);
    unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO], ...choice }));
    return scene;
  }
  const finds = (roomId: string) =>
    database.db
      .selectFrom('rooms.discussions')
      .selectAll()
      .where('room_id', '=', roomId)
      .where('kind', '=', 'find')
      .execute();
  const scoutFeed = async (scene: Scene, person: Friend) => (await readFeed(world, person, scene.roomId)).scout;

  describe('sending one', () => {
    it('is off until a member sends it, offers only the room’s own topics, and is theirs alone to see', async () => {
      const scene = await room();
      const before = await scoutFeed(scene, scene.owner);
      expect(before).toMatchObject({ state: 'none' });
      // The choices are the planets of the room's system, each with a plain label: nothing about the member fills them in.
      expect(before!.choices.map((choice) => choice.id).sort()).toEqual([...PLANETS].sort());
      expect(before!.choices.every((choice) => choice.label.length > 0)).toBe(true);
      const universe = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const accepted = unwrap(
        await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO, OTHER], cadence: 'weekly' }),
      );
      expect(accepted.scout).toMatchObject({
        state: 'on',
        interests: [ASTRO, OTHER],
        cadence: 'weekly',
        paused: false,
      });
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(universe);
      // Nobody else is told what it looks in: not a member, not a moderator.
      for (const other of [scene.listeners[0]!, scene.moderator]) {
        const seen = await readFeed(world, other, scene.roomId);
        expect(seen.scout).toMatchObject({ state: 'none' });
        // What the owner chose is theirs: the list of choices names every topic, a setting names none.
        expect(JSON.stringify(seen)).not.toContain('"interests"');
      }
      expect(
        await world.db.selectFrom('rooms.scouts').selectAll().where('room_id', '=', scene.roomId).execute(),
      ).toHaveLength(1);
    });

    it('takes one to five of the room’s topics, none twice, and nothing else', async () => {
      const scene = await room();
      const refused = async (interests: string[]) =>
        expect(await setScout(world, scene.owner, scene.roomId, { interests })).toEqual({
          kind: 'refused',
          code: 'invalid_input',
        });
      await refused([]);
      await refused(['cooking']);
      await refused([ASTRO, 'cooking']);
      await refused([ASTRO, ASTRO]);
      // Another system's planet is not a topic of this room.
      await refused(['earth.greenhouse-effect']);
      const many = [...PLANETS, 'a', 'b', 'c', 'd', 'e', 'f'].slice(0, 6);
      await refused(many);
      expect(await scoutRow(world.db, scene.roomId, scene.owner)).toBeUndefined();
    });

    it('is refused for a person who is not in the room, and while scouts are off in this world', async () => {
      const scene = await room();
      const stranger = await seedFriend(world.db, world.friends);
      expect(await setScout(world, stranger, scene.roomId, { interests: [ASTRO] })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await setScout(off, scene.owner, scene.roomId, { interests: [ASTRO] })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      // The feed of a world that has them off says nothing of scouts at all.
      const feed = unwrap(
        await off.rooms.feed(scene.owner.authority, { version, readId: randomUUID(), roomId: scene.roomId }),
      );
      expect(feed.status === 'ready' && feed.scout).toBeFalsy();
      expect(await scoutRow(world.db, scene.roomId, scene.owner)).toBeUndefined();
    });

    it('is changed, paused and taken back, and the same command again changes nothing', async () => {
      const scene = await room();
      const first = unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO] }));
      const created = await scoutRow(world.db, scene.roomId, scene.owner);
      const command = {
        version,
        commandId: randomUUID(),
        roomId: scene.roomId,
        scout: { interests: [OTHER], cadence: 'daily', paused: true },
      };
      const changed = unwrap(await world.rooms.setScout(scene.owner.authority, command));
      expect(changed.scout).toMatchObject({ state: 'on', interests: [OTHER], paused: true, stopped: false });
      expect(unwrap(await world.rooms.setScout(scene.owner.authority, command))).toEqual({
        ...changed,
        replayed: true,
      });
      // Changing it keeps the same scout (its place in the list and its rest), it does not make another.
      expect((await scoutRow(world.db, scene.roomId, scene.owner))?.scout_id).toBe(created?.scout_id);
      expect(first.scout.state).toBe('on');
      unwrap(await setScout(world, scene.owner, scene.roomId, null));
      expect(await scoutRow(world.db, scene.roomId, scene.owner)).toBeUndefined();
      expect(await scoutFeed(scene, scene.owner)).toMatchObject({ state: 'none' });
    });

    it('ends when the owner leaves or is removed, and a member who comes back starts with none', async () => {
      const left = await sent();
      unwrap(await world.rooms.leave(left.owner.authority, { version, commandId: randomUUID(), roomId: left.roomId }));
      expect(await scoutRow(world.db, left.roomId, left.owner)).toBeUndefined();
      unwrap(await world.rooms.join(left.owner.authority, { version, commandId: randomUUID(), roomId: left.roomId }));
      expect(await scoutFeed(left, left.owner)).toMatchObject({ state: 'none' });
      const removed = await sent();
      unwrap(
        await world.rooms.moderate(removed.moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId: removed.roomId,
          action: { kind: 'remove_member', personId: removed.owner.person.personId },
        }),
      );
      expect(await scoutRow(world.db, removed.roomId, removed.owner)).toBeUndefined();
    });
  });

  describe('a find', () => {
    it('is picked by code from the owner’s own topics, written as a note by a model that reads nothing else, signed with the owner’s name and labelled AI', async () => {
      const wanted = await libraryScroll(world.db, 'The Scroll in the chosen topic', 120, ASTRO);
      await libraryScroll(world.db, 'A newer Scroll in a topic nobody chose', 5, OTHER);
      const scene = await sent();
      await say(
        world,
        scene.listeners[0]!,
        scene.roomId,
        (await memberView(world, scene.owner, scene.roomId)).general.discussionId,
        'MEMBER-WORDS-NOBODY-SENT-TO-A-MODEL',
      );
      const { look, model } = scoutBeat(world);
      const result = await look(scene.slug, scene.owner);
      expect(result.find.kind).toBe('posted');
      // One call, about the one asset in the chosen topic; code chose it and the model wrote only the note.
      expect(model.calls).toHaveLength(1);
      const request = requestText(model.calls[0]!);
      expect(request).toContain('The Scroll in the chosen topic');
      expect(request).not.toContain('A newer Scroll in a topic nobody chose');
      expect(request).toContain('<context-item ref="asked-for"');
      expect(request).not.toContain('MEMBER-WORDS-NOBODY-SENT-TO-A-MODEL');
      expect(request).not.toContain(scene.owner.person.handle);
      expect(request).not.toContain('<context-item ref="memory"');
      const [discussion] = await finds(scene.roomId);
      expect(discussion).toMatchObject({
        kind: 'find',
        root_asset_id: wanted,
        root_asset_revision: 1,
        started_by_account_id: null,
      });
      const [note] = await database.db
        .selectFrom('rooms.messages')
        .selectAll()
        .where('discussion_id', '=', discussion!.discussion_id)
        .execute();
      expect(note).toMatchObject({
        author_kind: 'agent',
        author_account_id: null,
        agent_owner_account_id: scene.owner.accountId,
        inhabitant: null,
        ai_kind: 'find',
        trigger: 'scout_find',
        body_text: FIND_NOTE,
        command_id: null,
      });
      const [turn] = await scoutTurns(world.db, scene.roomId);
      expect(turn).toMatchObject({
        trigger: 'scout_find',
        decided_by: 'caps_clear',
        state: 'completed',
        dispatched: true,
        inhabitant: null,
        requested_by_account_id: scene.owner.accountId,
        find_asset_id: wanted,
        discussion_id: discussion!.discussion_id,
        message_id: note!.message_id,
        role_version: 'scout.1',
        model: model.model,
      });
      // A member reads it signed "sent by" the owner and labelled AI, with the library asset as its card.
      const feed = await readFeed(world, scene.listeners[0]!, scene.roomId);
      expect(feed.posts).toHaveLength(1);
      expect(feed.posts[0]).toMatchObject({
        author: { kind: 'agent', sentBy: { personId: scene.owner.person.personId }, label: 'AI · Scout' },
        note: FIND_NOTE,
        replies: 0,
      });
      expect(feed.posts[0]!.content).toMatchObject({
        status: 'available',
        target: { assetId: wanted, assetRevision: 1 },
      });
      // Opened, it is an ordinary labelled message in the discussion, signed the same way.
      const opened = await readDiscussion(world, scene.listeners[0]!, scene.roomId, discussion!.discussion_id);
      if (opened.status !== 'ready') throw new Error('expected ready');
      expect(opened.messages[0]).toMatchObject({
        status: 'available',
        author: { kind: 'agent', sentBy: { personId: scene.owner.person.personId }, label: 'AI · Scout' },
        suggestion: 'find',
        trigger: 'scout_find',
      });
      // The owner reads that their scout posted, and when.
      const mine = await scoutFeed(scene, scene.owner);
      expect(mine?.state === 'on' ? typeof mine.lastPostedAt : 'none').toBe('string');
    });

    it('can be about a Reel as well as a Scroll', async () => {
      const reel = await libraryReel(world.db, 'A Reel in the chosen topic', 10, ASTRO);
      const scene = await sent();
      const { look } = scoutBeat(world);
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      expect((await finds(scene.roomId))[0]).toMatchObject({ root_asset_id: reel });
    });

    it('is never made without a real asset: the database refuses a scout’s find with none, and a withdrawn asset is not posted', async () => {
      const asset = await libraryScroll(world.db, 'A Scroll withdrawn during the call', 10, ASTRO);
      const scene = await sent();
      await expect(
        sql`insert into rooms.ai_turns (turn_id, room_id, trigger, state, decided_by, created_at)
          values (${randomUUID()}::uuid, ${scene.roomId}::uuid, 'scout_find', 'queued', 'caps_clear', now())`.execute(
          world.db,
        ),
      ).rejects.toThrow();
      const { look } = scoutBeat(world, async () => {
        await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', asset).execute();
        return find();
      });
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'not_made', reason: 'asset_withdrawn' });
      expect(await finds(scene.roomId)).toEqual([]);
    });

    it('is checked for its voice: a note that speaks as "I" is repaired once and, failing again, never posted', async () => {
      await libraryScroll(world.db, 'A Scroll for the voice check', 10, ASTRO);
      const scene = await sent();
      const first = scoutBeat(world, (sequence) =>
        sequence === 1 ? find('I watched this twice and it changed how I picture dark matter.') : find(),
      );
      expect((await first.look(scene.slug, scene.owner)).find.kind).toBe('posted');
      expect(first.model.calls).toHaveLength(2);
      expect(await finds(scene.roomId)).toHaveLength(1);
      const other = await sent();
      await libraryScroll(world.db, 'A Scroll for the second voice check', 10, ASTRO);
      const failing = scoutBeat(world, () => find('I remember this one well.'));
      expect((await failing.look(other.slug, other.owner)).find.kind).toBe('not_made');
      expect(await finds(other.roomId)).toEqual([]);
    });

    it('may be declined by the scout itself: the call counts, the asset is not offered to the room again', async () => {
      await libraryScroll(world.db, 'A Scroll not worth a post', 10, ASTRO);
      const scene = await sent();
      const { look, model } = scoutBeat(world, () => NOTHING);
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'declined' });
      expect(await finds(scene.roomId)).toEqual([]);
      expect((await scoutTurns(world.db, scene.roomId))[0]).toMatchObject({ state: 'declined', dispatched: true });
      at('2026-11-05T08:01:00Z');
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect(model.calls).toHaveLength(1);
    });
  });

  describe('once a day, per scout, per room', () => {
    it('posts once a UTC day: a later slot the same day rests with no call, and the next day it posts the next asset', async () => {
      await libraryScroll(world.db, 'The first find', 10, ASTRO);
      await libraryScroll(world.db, 'The second find', 20, ASTRO);
      await libraryScroll(world.db, 'The third find', 30, ASTRO);
      const scene = await sent();
      const { look, model } = scoutBeat(world);
      at('2026-11-04T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      at('2026-11-04T08:37:00Z');
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'resting' });
      at('2026-11-04T16:37:00Z');
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'resting' });
      expect(model.calls).toHaveLength(1);
      expect(await finds(scene.roomId)).toHaveLength(1);
      at('2026-11-05T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      expect(await finds(scene.roomId)).toHaveLength(2);
      expect(await scoutTurns(world.db, scene.roomId)).toHaveLength(2);
    });

    it('lets a weekly scout post once in seven UTC days', async () => {
      await libraryScroll(world.db, 'Week one', 10, ASTRO);
      await libraryScroll(world.db, 'Week two', 20, ASTRO);
      const scene = await sent(2, { cadence: 'weekly' });
      const { look } = scoutBeat(world);
      at('2026-11-04T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      at('2026-11-10T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'resting' });
      at('2026-11-11T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
    });

    it('cannot be got round by taking the scout back and sending it again: the rest is the ledger’s', async () => {
      await libraryScroll(world.db, 'One today', 10, ASTRO);
      await libraryScroll(world.db, 'Another today', 20, ASTRO);
      const scene = await sent();
      const { look } = scoutBeat(world);
      at('2026-11-04T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      unwrap(await setScout(world, scene.owner, scene.roomId, null));
      unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO] }));
      at('2026-11-04T08:37:00Z');
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'resting' });
    });

    it('is exact under a retry: the same slot twice posts and pays once', async () => {
      await libraryScroll(world.db, 'A Scroll for once only', 10, ASTRO);
      const scene = await sent();
      const { heartbeat, model } = scoutBeat(world);
      at('2026-11-04T08:37:00Z');
      await heartbeat.lookAtAll({ signal: new AbortController().signal });
      await heartbeat.lookAtAll({ signal: new AbortController().signal });
      expect(model.calls).toHaveLength(1);
      expect(await finds(scene.roomId)).toHaveLength(1);
      expect(await scoutTurns(world.db, scene.roomId)).toHaveLength(1);
    });

    it('gives a room’s scouts five finds a day together, and the rest are refused quietly with no call', async () => {
      for (const [n, name] of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].entries())
        await libraryScroll(world.db, `Find ${name}`, 10 + n, ASTRO);
      const { roomId, slug } = await seedRoom(world);
      const people = await joined(world, roomId, 7);
      for (const person of people.slice(0, 6)) unwrap(await setScout(world, person, roomId, { interests: [ASTRO] }));
      const { heartbeat, model } = scoutBeat(world);
      at('2026-11-04T00:37:00Z');
      const looks = await heartbeat.lookAtAll({ signal: new AbortController().signal });
      expect(looks.filter((entry) => entry.room === slug)).toHaveLength(6);
      expect(looks.filter((entry) => entry.find.kind === 'posted')).toHaveLength(5);
      expect(looks.filter((entry) => entry.find.kind === 'refused')).toEqual([
        { room: slug, find: { kind: 'refused', cap: 'scout_day' } },
      ]);
      expect(model.calls).toHaveLength(5);
      const turns = await scoutTurns(world.db, roomId);
      expect(turns.filter((turn) => turn.state === 'refused')).toHaveLength(1);
      expect(turns.find((turn) => turn.state === 'refused')).toMatchObject({
        decided_by: 'scout_day',
        dispatched: false,
      });
    });

    it('counts toward the room’s own unprompted caps: eight turns in an hour refuse a scout, and a scout’s find is one of the eight for a resident', async () => {
      await libraryScroll(world.db, 'A Scroll the hour cap holds back', 10, ASTRO);
      const scene = await sent();
      for (let n = 1; n <= 8; n++)
        await sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at, settled_at, dispatched, role_version, prompt_version, model)
          values (${randomUUID()}::uuid, ${scene.roomId}::uuid, 'explainer', 'memory_refresh', 'declined', 'caps_clear', ${new Date(START.getTime() - n * 60_000)}, ${START}, true, 'memory.1', 'p', 'm')`.execute(
          world.db,
        );
      const { look, model } = scoutBeat(world);
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'refused', cap: 'room_hour' });
      expect(model.calls).toHaveLength(0);
      expect((await scoutTurns(world.db, scene.roomId))[0]).toMatchObject({
        state: 'refused',
        decided_by: 'room_hour',
      });
      // The refusal posts nothing and leaves the asset for the next look; a resident's own look sees the room's count, scouts included.
      await sql`delete from rooms.ai_turns where trigger = 'memory_refresh' and room_id = ${scene.roomId}::uuid`.execute(
        world.db,
      );
      at('2026-11-04T08:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      await libraryScroll(world.db, 'A Scroll for the resident', 5, ASTRO);
      const residents = feedHeartbeat(world);
      at('2026-11-04T09:00:00Z');
      expect((await residents.look(scene.slug)).find.kind).toBe('posted');
      const [resident] = await feedTurns(world.db, scene.roomId);
      expect(resident!.caps).toMatchObject({ roomToday: 1 });
    });

    it('shares what the room has seen with the residents: a find is never posted twice, whoever found it', async () => {
      const shared = await libraryScroll(world.db, 'The only Scroll in the topic', 10, ASTRO);
      const scene = await sent();
      const residents = feedHeartbeat(world);
      at('2026-11-04T08:00:00Z');
      expect((await residents.look(scene.slug)).find.kind).toBe('posted');
      const { look, model } = scoutBeat(world);
      at('2026-11-05T00:37:00Z');
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect(model.calls).toHaveLength(0);
      // And the other way round: what a scout found is not the residents' to repeat.
      const second = await libraryScroll(world.db, 'The newest Scroll', 1, ASTRO);
      at('2026-11-05T08:37:00Z');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      at('2026-11-06T00:00:00Z');
      expect((await residents.look(scene.slug)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect((await finds(scene.roomId)).map((discussion) => discussion.root_asset_id).sort()).toEqual(
        [shared, second].sort(),
      );
    });
  });

  describe('when it stays silent (no call, nothing written)', () => {
    /** A scene, a library with something new in the scout's topic, and one look. */
    async function silentLook(prepare: (scene: Scene) => Promise<void>) {
      await libraryScroll(world.db, 'A Scroll that must stay unmentioned', 10, ASTRO);
      const scene = await sent();
      await prepare(scene);
      const { look, model } = scoutBeat(world);
      const result = await look(scene.slug, scene.owner);
      expect(model.calls).toHaveLength(0);
      expect(await finds(scene.roomId)).toEqual([]);
      expect(await scoutTurns(world.db, scene.roomId)).toEqual([]);
      return result.find;
    }
    const pauseRecording = (person: Friend, on: boolean) =>
      sql`update identity.universes set recording_on = ${on}, recording_generation = recording_generation + 1
        where account_id = ${person.accountId}::uuid`.execute(world.db);

    it('when the library holds nothing new in its topics, even if it holds something in another', async () => {
      await libraryScroll(world.db, 'Only in a topic nobody chose', 10, OTHER);
      const scene = await sent();
      const { look, model } = scoutBeat(world);
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect(model.calls).toHaveLength(0);
    });

    it('when its owner paused it', async () => {
      expect(
        await silentLook(async (scene) => {
          unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO], paused: true }));
        }),
      ).toEqual({ kind: 'dropped', reason: 'paused' });
    });

    it('when its owner paused recording, and again once recording is back on', async () => {
      const scene = await sent();
      await libraryScroll(world.db, 'A Scroll for the recording pause', 10, ASTRO);
      const { look, model } = scoutBeat(world);
      await pauseRecording(scene.owner, false);
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'recording_paused' });
      expect(model.calls).toHaveLength(0);
      // The owner is told it is waiting for recording, not that it is looking.
      expect(await scoutFeed(scene, scene.owner)).toMatchObject({ state: 'on', recordingPaused: true });
      // The heartbeat does not even list it while recording is paused.
      const { heartbeat } = scoutBeat(world);
      expect(await heartbeat.lookAtAll({ signal: new AbortController().signal })).toEqual([]);
      await pauseRecording(scene.owner, true);
      expect(await scoutFeed(scene, scene.owner)).not.toHaveProperty('recordingPaused');
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
    });

    it('when nobody else in the room has AI on', async () => {
      expect(
        await silentLook(async (scene) => {
          for (const person of [...scene.listeners, scene.moderator])
            unwrap(await setPreferences(world, person, scene.roomId, { aiLevel: 'off' }));
        }),
      ).toEqual({ kind: 'dropped', reason: 'nobody_listening' });
    });

    it('when its owner is the only one in the room', async () => {
      await libraryScroll(world.db, 'A Scroll for an empty room', 10, ASTRO);
      const scene = await sent(0);
      unwrap(await setPreferences(world, scene.moderator, scene.roomId, { aiLevel: 'off' }));
      const { look, model } = scoutBeat(world);
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'nobody_listening' });
      expect(model.calls).toHaveLength(0);
    });

    it('when a moderator stopped it, and posts again once a moderator lets it', async () => {
      const scene = await sent();
      await libraryScroll(world.db, 'A Scroll for the stop', 10, ASTRO);
      const { look, model } = scoutBeat(world);
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'stop_scout'));
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'stopped' });
      expect(model.calls).toHaveLength(0);
      // The owner is told, can still change or take it back, and cannot lift the stop themselves.
      expect(await scoutFeed(scene, scene.owner)).toMatchObject({ state: 'on', stopped: true });
      unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO, OTHER] }));
      expect(await scoutFeed(scene, scene.owner)).toMatchObject({ stopped: true, interests: [ASTRO, OTHER] });
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'stopped' });
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'allow_scout'));
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
    });

    it('when a moderator stopped it and its owner took it back and sent it again: the stop stands', async () => {
      const scene = await sent();
      await libraryScroll(world.db, 'A Scroll for the stop that stands', 10, ASTRO);
      const { look, model } = scoutBeat(world);
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'stop_scout'));
      unwrap(await setScout(world, scene.owner, scene.roomId, null));
      // Taking it back does not delete a stopped scout: it is paused, the stop is kept and the owner is still told.
      expect(await scoutRow(world.db, scene.roomId, scene.owner)).toMatchObject({ paused: true });
      expect((await scoutRow(world.db, scene.roomId, scene.owner))?.stopped_at).not.toBeNull();
      expect(await scoutFeed(scene, scene.owner)).toMatchObject({ state: 'on', stopped: true, paused: true });
      unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [ASTRO] }));
      expect(await scoutFeed(scene, scene.owner)).toMatchObject({ state: 'on', stopped: true, paused: false });
      expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'dropped', reason: 'stopped' });
      expect(model.calls).toHaveLength(0);
      // Only a moderator lifts it; then it posts.
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'allow_scout'));
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
    });

    it('is deleted with the stop when its owner leaves, even a scout a moderator had stopped', async () => {
      const scene = await sent();
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'stop_scout'));
      unwrap(
        await world.rooms.leave(scene.owner.authority, { version, commandId: randomUUID(), roomId: scene.roomId }),
      );
      expect(await scoutRow(world.db, scene.roomId, scene.owner)).toBeUndefined();
    });

    it('for topics its owner changed after the library was read: that look is dropped, and the next one is for the new topics', async () => {
      await libraryScroll(world.db, 'A Scroll in the topic it left', 10, ASTRO);
      const wanted = await libraryScroll(world.db, 'A Scroll in the topic it moved to', 20, OTHER);
      const scene = await sent();
      const { heartbeat, model } = scoutBeat(world);
      const planned = (await heartbeat.scoutIn(scene.slug, scene.owner.person.handle))!;
      unwrap(await setScout(world, scene.owner, scene.roomId, { interests: [OTHER] }));
      expect((await heartbeat.lookAt(planned, never)).find).toEqual({ kind: 'dropped', reason: 'changed' });
      expect(model.calls).toHaveLength(0);
      expect(await scoutTurns(world.db, scene.roomId)).toEqual([]);
      const current = (await heartbeat.scoutIn(scene.slug, scene.owner.person.handle))!;
      expect((await heartbeat.lookAt(current, never)).find.kind).toBe('posted');
      expect((await finds(scene.roomId))[0]).toMatchObject({ root_asset_id: wanted });
    });

    it('when the room is paused or closed', async () => {
      expect(
        await silentLook(async (scene) => {
          await database.db
            .updateTable('rooms.rooms')
            .set({ status: 'paused' })
            .where('room_id', '=', scene.roomId)
            .execute();
        }),
      ).toEqual({ kind: 'dropped', reason: 'room_closed' });
    });

    it('when its owner left, was removed or deleted their account, even if a stale setting is still there', async () => {
      const scene = await sent();
      await libraryScroll(world.db, 'A Scroll for the one who left', 10, ASTRO);
      const { look, model } = scoutBeat(world);
      const ref = (await scoutBeat(world).heartbeat.scoutIn(scene.slug, scene.owner.person.handle))!;
      // Everything the pass reads under the lock says the owner is gone; the setting itself is out of its way.
      await sql`update rooms.members set ended_at = now(), ended_by = 'left'
        where room_id = ${scene.roomId}::uuid and account_id = ${scene.owner.accountId}::uuid`.execute(world.db);
      const result = await scoutBeat(world).heartbeat.lookAt(ref, new AbortController().signal);
      expect(result.find).toEqual({ kind: 'dropped', reason: 'owner_gone' });
      expect(model.calls).toHaveLength(0);
      expect(look).toBeDefined();
    });

    it('when its owner leaves, is removed or pauses recording while the model is being called: the call is paid, nothing is posted', async () => {
      const cases: ((scene: Scene) => Promise<unknown>)[] = [
        (scene) => world.rooms.leave(scene.owner.authority, { version, commandId: randomUUID(), roomId: scene.roomId }),
        (scene) =>
          world.rooms.moderate(scene.moderator.authority, {
            version,
            commandId: randomUUID(),
            roomId: scene.roomId,
            action: { kind: 'remove_member', personId: scene.owner.person.personId },
          }),
        (scene) => moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'stop_scout'),
        (scene) => setScout(world, scene.owner, scene.roomId, { interests: [ASTRO], paused: true }),
        (scene) =>
          sql`update identity.universes set recording_on = false, recording_generation = recording_generation + 1
            where account_id = ${scene.owner.accountId}::uuid`.execute(world.db),
      ];
      for (const interrupt of cases) {
        await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).execute();
        await libraryScroll(world.db, 'A Scroll for the interrupted call', 10, ASTRO);
        const scene = await sent();
        const { look, model } = scoutBeat(world, async () => {
          await interrupt(scene);
          return find();
        });
        expect((await look(scene.slug, scene.owner)).find).toEqual({ kind: 'not_made', reason: 'room_changed' });
        expect(model.calls).toHaveLength(1);
        expect(await finds(scene.roomId)).toEqual([]);
        expect((await scoutTurns(world.db, scene.roomId))[0]).toMatchObject({ state: 'failed', dispatched: true });
      }
    });
  });

  describe('what it never does', () => {
    it('starts no encounter and writes no evidence: no row in a person’s universe changes for anyone, whatever a scout does', async () => {
      await libraryScroll(world.db, 'A Scroll for the evidence check', 10, ASTRO);
      await libraryReel(world.db, 'A Reel for the evidence check', 20, ASTRO);
      const scene = await sent();
      const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const { look } = scoutBeat(world);
      expect((await look(scene.slug, scene.owner)).find.kind).toBe('posted');
      const feed = await readFeed(world, scene.listeners[0]!, scene.roomId);
      await readDiscussion(world, scene.listeners[0]!, scene.roomId, feed.posts[0]!.discussionId);
      await readFeed(world, scene.owner, scene.roomId);
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'stop_scout'));
      unwrap(await moderateScout(world, scene.moderator, scene.roomId, scene.owner, 'allow_scout'));
      unwrap(await setScout(world, scene.owner, scene.roomId, null));
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
      // The composer's and planner's rows are among those schemas; so is anything the encounter and the map keep.
      expect(PERSONAL_UNIVERSE_SCHEMAS).toEqual(
        expect.arrayContaining(['experience', 'geography', 'composer', 'planner']),
      );
    });

    it('cannot vote, earn a star or be counted as a person: a Useful mark on its note earns nothing and it is nobody’s lease', async () => {
      await libraryScroll(world.db, 'A Scroll for the star check', 10, ASTRO);
      const scene = await sent();
      const { look } = scoutBeat(world);
      await look(scene.slug, scene.owner);
      const feed = await readFeed(world, scene.listeners[0]!, scene.roomId);
      const discussionId = feed.posts[0]!.discussionId;
      const opened = await readDiscussion(world, scene.listeners[1]!, scene.roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      const stars = await database.db
        .selectFrom('rooms.stars')
        .select('star_id')
        .where('room_id', '=', scene.roomId)
        .execute();
      unwrap(await markUseful(world, scene.listeners[1]!, scene.roomId, discussionId, opened.messages[0]!.messageId));
      expect(
        await database.db.selectFrom('rooms.stars').select('star_id').where('room_id', '=', scene.roomId).execute(),
      ).toEqual(stars);
      const view = await memberView(world, scene.listeners[0]!, scene.roomId);
      expect(view.memberTotal).toBe(4);
      expect(JSON.stringify(view.here)).not.toContain('"kind":"agent"');
    });
  });

  describe('who reads it', () => {
    it('follows each reader’s AI level: Lively reads the note, Quieter has it held back, Off is listed no find', async () => {
      await libraryScroll(world.db, 'A Scroll for the levels', 10, ASTRO);
      const scene = await sent(3);
      const [lively, quieter, silent] = scene.listeners as [Friend, Friend, Friend];
      unwrap(await setPreferences(world, quieter, scene.roomId, { aiLevel: 'quieter' }));
      unwrap(await setPreferences(world, silent, scene.roomId, { aiLevel: 'off' }));
      const { look } = scoutBeat(world);
      await look(scene.slug, scene.owner);
      expect((await readFeed(world, lively, scene.roomId)).posts[0]).toMatchObject({ note: FIND_NOTE });
      const folded = (await readFeed(world, quieter, scene.roomId)).posts[0]!;
      expect(folded).toMatchObject({ folded: true });
      expect(folded.note).toBeUndefined();
      expect((await readFeed(world, silent, scene.roomId)).posts).toEqual([]);
      const discussionId = (await readFeed(world, lively, scene.roomId)).posts[0]!.discussionId;
      const asOff = await readDiscussion(world, silent, scene.roomId, discussionId);
      if (asOff.status !== 'ready') throw new Error('expected ready');
      expect(asOff.messages[0]).toMatchObject({ status: 'muted' });
      expect(JSON.stringify(asOff)).not.toContain(FIND_NOTE);
    });

    it('is not shown to a reader who blocked its owner: not in the feed, not in the Now strip, and a marker in the discussion; everyone else still reads it', async () => {
      await libraryScroll(world.db, 'A Scroll for the block check', 10, ASTRO);
      const scene = await sent(3);
      const [blocker, bystander] = scene.listeners as [Friend, Friend, Friend];
      const { look } = scoutBeat(world);
      await look(scene.slug, scene.owner);
      expect((await readFeed(world, blocker, scene.roomId)).posts).toHaveLength(1);
      const discussionId = (await readFeed(world, bystander, scene.roomId)).posts[0]!.discussionId;
      unwrap(await friendCommand(world.friends, blocker, scene.owner, 'block'));
      const blocked = await readFeed(world, blocker, scene.roomId);
      expect(blocked.posts).toEqual([]);
      expect(JSON.stringify(blocked)).not.toContain(scene.owner.person.handle);
      const strip = await memberView(world, blocker, scene.roomId);
      expect(strip.feed).toBeUndefined();
      const opened = await readDiscussion(world, blocker, scene.roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      expect(opened.messages[0]).toMatchObject({ status: 'blocked' });
      expect(JSON.stringify(opened)).not.toContain(FIND_NOTE);
      // Nobody else is told, and the owner's own scout is still theirs.
      expect((await readFeed(world, bystander, scene.roomId)).posts).toHaveLength(1);
      expect((await memberView(world, bystander, scene.roomId)).feed).toMatchObject({
        by: { kind: 'agent', sentBy: { personId: scene.owner.person.personId } },
      });
    });

    it('is not something a reader who blocked its owner can ask a resident about', async () => {
      await libraryScroll(world.db, 'A Scroll for the ask check', 10, ASTRO);
      const scene = await sent(3);
      const [blocker, other] = scene.listeners as [Friend, Friend, Friend];
      await scoutBeat(world).look(scene.slug, scene.owner);
      const discussionId = (await readFeed(world, other, scene.roomId)).posts[0]!.discussionId;
      const opened = await readDiscussion(world, other, scene.roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      const noteId = opened.messages[0]!.messageId;
      unwrap(await friendCommand(world.friends, blocker, scene.owner, 'block'));
      expect(await askAbout(world, blocker, scene.roomId, discussionId, 'challenge', noteId)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      unwrap(await askAbout(world, other, scene.roomId, discussionId, 'challenge', noteId));
    });

    it('is removed with the note when a moderator removes the note, and the stop is a moderator’s alone', async () => {
      await libraryScroll(world.db, 'A Scroll for moderation', 10, ASTRO);
      const scene = await sent();
      const { look } = scoutBeat(world);
      await look(scene.slug, scene.owner);
      const feed = await readFeed(world, scene.listeners[0]!, scene.roomId);
      const discussionId = feed.posts[0]!.discussionId;
      // A member is not a moderator; a moderator cannot stop a member who has no scout, nor themselves.
      expect(await moderateScout(world, scene.listeners[0]!, scene.roomId, scene.owner, 'stop_scout')).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await moderateScout(world, scene.moderator, scene.roomId, scene.listeners[0]!, 'stop_scout')).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      const opened = await readDiscussion(world, scene.listeners[0]!, scene.roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      unwrap(await hideMessage(world, scene.moderator, scene.roomId, discussionId, opened.messages[0]!.messageId));
      expect((await readFeed(world, scene.listeners[1]!, scene.roomId)).posts).toEqual([]);
    });
  });

  describe('a report about a scout’s find (D-261)', () => {
    const abuse = (messageId: string) => ({
      commandId: randomUUID(),
      target: { kind: 'room_message', messageId } as const,
      category: 'spam' as const,
    });
    const noteOf = async (scene: Scene, reader: Friend) => {
      const feed = await readFeed(world, reader, scene.roomId);
      const discussionId = feed.posts[0]!.discussionId;
      const opened = await readDiscussion(world, reader, scene.roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      return { discussionId, messageId: opened.messages[0]!.messageId };
    };
    const reportsOf = (person: Friend, roomId: string) =>
      world.rooms.reports(person.authority, { version, readId: randomUUID(), roomId });

    it('is received from a reader, filed against the member who sent the scout, and shown to the moderators; the owner cannot report their own scout', async () => {
      await libraryScroll(world.db, 'A Scroll for the report check', 10, ASTRO);
      const scene = await sent();
      await scoutBeat(world).look(scene.slug, scene.owner);
      const { messageId } = await noteOf(scene, scene.listeners[0]!);
      expect(await reports.reportAbuse(scene.owner.authority, abuse(messageId))).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
      expect(await reports.reportAbuse(scene.listeners[0]!.authority, abuse(messageId))).toMatchObject({
        kind: 'received',
      });
      const [filed] = await database.db
        .selectFrom('feedback.reports')
        .selectAll()
        .where('reporter_account_id', '=', scene.listeners[0]!.accountId)
        .execute();
      expect(filed).toMatchObject({
        target_kind: 'room_message',
        message_id: messageId,
        room_id: scene.roomId,
        reported_account_id: scene.owner.accountId,
      });
      const shown = unwrap(await reportsOf(scene.moderator, scene.roomId));
      expect(shown.reports.map((report) => report.messageId)).toEqual([messageId]);
      // Nobody else in the room reads the list, and it names neither reporter nor owner.
      expect(await reportsOf(scene.listeners[1]!, scene.roomId)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(JSON.stringify(shown)).not.toContain(scene.owner.accountId);
    });

    it('is left out of the list of a moderator whose own scout it is, and is not reportable once a moderator removed the note', async () => {
      await libraryScroll(world.db, 'A Scroll for the moderator’s own scout', 10, ASTRO);
      const { roomId, slug } = await seedRoom(world);
      const [reader, other] = await joined(world, roomId, 2);
      const moderator = await seedFriend(world.db, world.friends);
      unwrap(await world.rooms.join(moderator.authority, { version, commandId: randomUUID(), roomId }));
      await makeModerator(world, slug, moderator);
      const second = await seedFriend(world.db, world.friends);
      unwrap(await world.rooms.join(second.authority, { version, commandId: randomUUID(), roomId }));
      await makeModerator(world, slug, second);
      unwrap(await setScout(world, moderator, roomId, { interests: [ASTRO] }));
      await scoutBeat(world).look(slug, moderator);
      const discussionId = (await readFeed(world, reader!, roomId)).posts[0]!.discussionId;
      const opened = await readDiscussion(world, reader!, roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      const messageId = opened.messages[0]!.messageId;
      expect(await reports.reportAbuse(reader!.authority, abuse(messageId))).toMatchObject({ kind: 'received' });
      // The scout is the first moderator's own: not for them to read. The other moderator reads it.
      expect(unwrap(await reportsOf(moderator, roomId)).reports).toEqual([]);
      expect(unwrap(await reportsOf(second, roomId)).reports.map((report) => report.messageId)).toEqual([messageId]);
      // A moderator removes the note: nobody can report it any more.
      unwrap(await hideMessage(world, second, roomId, discussionId, messageId));
      expect(await reports.reportAbuse(other!.authority, abuse(messageId))).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
    });
  });

  describe('what a person takes back', () => {
    async function namedPerson(): Promise<Friend> {
      const person = await recordingPerson(database);
      const set = await world.friends.setProfile(person.authority, {
        version: 'sharing.v1',
        commandId: randomUUID(),
        expectedProfileRevision: 0,
        handle: `ci.${person.accountId.replaceAll('-', '').slice(0, 14)}`,
        displayName: 'Fixture owner',
      });
      if (set.kind !== 'ok') throw new Error('profile refused');
      const read = await world.friends.readProfile(person.authority);
      if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('profile unreadable');
      return { ...person, person: read.value.person };
    }

    it('exports the scouts a person sent and what they posted in their name, and deletes all of it with their account: the notes become tombstones and the others’ replies stay', async () => {
      await libraryScroll(world.db, 'A Scroll for the export and the deletion', 10, ASTRO);
      const { roomId, slug } = await seedRoom(world);
      const listeners = await joined(world, roomId, 2);
      const owner = await namedPerson();
      unwrap(await world.rooms.join(owner.authority, { version, commandId: randomUUID(), roomId }));
      unwrap(await setScout(world, owner, roomId, { interests: [ASTRO], cadence: 'weekly' }));
      const { look } = scoutBeat(world);
      expect((await look(slug, owner)).find.kind).toBe('posted');
      const feed = await readFeed(world, listeners[0]!, roomId);
      const discussionId = feed.posts[0]!.discussionId;
      const reply = unwrap(
        await say(world, listeners[1]!, roomId, discussionId, 'A reply that stays after the owner goes'),
      );
      const opened = await readDiscussion(world, listeners[0]!, roomId, discussionId);
      if (opened.status !== 'ready') throw new Error('expected ready');
      unwrap(await markUseful(world, listeners[1]!, roomId, discussionId, opened.messages[0]!.messageId));

      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(owner.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: owner.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const section = JSON.stringify(exported.value.sections['rooms']);
      expect(section).toContain('"scouts":[{"room":"Fixture room","topics":["' + ASTRO + '"],"often":"once a week"');
      expect(section).toContain(
        '"scoutNotes":[{"room":"Fixture room","find":"A Scroll for the export and the deletion"',
      );
      expect(section).toContain(FIND_NOTE);

      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(owner.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');

      expect(
        await database.db
          .selectFrom('rooms.scouts')
          .select('scout_id')
          .where('owner_account_id', '=', owner.accountId)
          .execute(),
      ).toEqual([]);
      const messages = await database.db
        .selectFrom('rooms.messages')
        .selectAll()
        .where('discussion_id', '=', discussionId)
        .orderBy('sequence')
        .execute();
      expect(messages[0]).toMatchObject({
        author_kind: 'person',
        author_account_id: null,
        agent_owner_account_id: null,
        body_text: null,
        ai_kind: null,
        trigger: null,
      });
      expect(messages[1]).toMatchObject({
        message_id: reply.messageId,
        body_text: 'A reply that stays after the owner goes',
      });
      expect(
        await database.db
          .selectFrom('rooms.message_useful')
          .select('message_id')
          .where('message_id', '=', messages[0]!.message_id)
          .execute(),
      ).toEqual([]);
      // The find is not listed without its note, and the ledger keeps the call with no owner link.
      expect((await readFeed(world, listeners[0]!, roomId)).posts).toEqual([]);
      expect((await scoutTurns(world.db, roomId))[0]).toMatchObject({
        requested_by_account_id: null,
        state: 'completed',
      });
      expect(JSON.stringify(await readDiscussion(world, listeners[0]!, roomId, discussionId))).not.toContain(FIND_NOTE);
    });
  });
});
