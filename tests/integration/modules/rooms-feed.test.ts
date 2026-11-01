/**
 * The residents' feed (v3 R-8, D-248) over real PostgreSQL, the real reasoning harness with a CI fixture model (never provider
 * output) and library assets admitted through the real import use case. Code picks an asset the room has not seen; the model
 * writes only a short note; a post always links an existing asset; an idle room, a room nobody listens to and a library with
 * nothing new make no call; a cap refuses quietly; a note that claims an experience is never posted.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReadLibraryFinds } from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  feedHeartbeat,
  feedTurns,
  find,
  FIND_NOTE,
  libraryReel,
  libraryScroll,
  never,
  readFeed,
  requestText,
} from '../support/rooms-feed.js';
import {
  hideMessage,
  joined,
  makeModerator,
  markUseful,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  readDiscussion,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPreferences,
  setPresence,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { seedFriend } from '../support/talk.js';

const HOUR = 3_600_000;
const START = new Date('2026-11-01T07:59:00Z');
const version = 'rooms.v1' as const;

describe('residents’ finds (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_feed');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });
  // Each test starts from an empty library and the same clock, so what one admits is nobody else's candidate.
  beforeEach(async () => {
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).execute();
    // ...and from the rooms of earlier tests, so a heartbeat looks only at the room a test made.
    await database.db.updateTable('rooms.rooms').set({ status: 'closed' }).execute();
    world.clock.now = START;
  });

  const at = (iso: string) => {
    world.clock.now = new Date(iso);
  };
  const listening = async (members = 2) => {
    const { roomId, slug } = await seedRoom(world);
    const people = await joined(world, roomId, members);
    return { roomId, slug, people };
  };
  const finds = (roomId: string) =>
    database.db
      .selectFrom('rooms.discussions')
      .selectAll()
      .where('room_id', '=', roomId)
      .where('kind', '=', 'find')
      .execute();

  describe('zero calls', () => {
    it('makes no call, and writes nothing, when the library holds nothing new for the room', async () => {
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world);
      const result = await look(slug);
      expect(result.find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect(result.memory).toEqual({ kind: 'dropped', reason: 'not_due' });
      expect(model.calls).toHaveLength(0);
      expect(await feedTurns(world.db, roomId)).toEqual([]);
      expect(await finds(roomId)).toEqual([]);
    });

    it('makes no call for a room nobody listens to, and the heartbeat does not even look at it', async () => {
      await libraryScroll(world.db, 'A Scroll nobody will be told about');
      const empty = await seedRoom(world);
      const off = await listening(2);
      for (const person of off.people) unwrap(await setPreferences(world, person, off.roomId, { aiLevel: 'off' }));
      const { heartbeat, model } = feedHeartbeat(world);
      const looks = await heartbeat.lookAtAll({ signal: never });
      expect(looks).toEqual([]);
      expect(model.calls).toHaveLength(0);
      expect(await feedTurns(world.db, empty.roomId)).toEqual([]);
      expect(await feedTurns(world.db, off.roomId)).toEqual([]);
      // A look an operator asks for by name ends the same way, with nothing recorded.
      const named = await heartbeat.lookAt((await heartbeat.roomBySlug(off.slug))!, never);
      expect(named.find).toEqual({ kind: 'dropped', reason: 'nobody_listening' });
      expect(model.calls).toHaveLength(0);
    });

    it('makes no call for a paused or closed room', async () => {
      await libraryScroll(world.db, 'A Scroll for a paused room');
      const { roomId, slug } = await listening();
      await database.db.updateTable('rooms.rooms').set({ status: 'paused' }).where('room_id', '=', roomId).execute();
      const { look, model } = feedHeartbeat(world);
      expect((await look(slug)).find).toEqual({ kind: 'dropped', reason: 'room_closed' });
      expect(model.calls).toHaveLength(0);
    });
  });

  describe('a find', () => {
    it('links an existing asset, is labelled, and has a ledger row naming its trigger and the cap that decided it', async () => {
      const older = await libraryScroll(world.db, 'The older Scroll', 120);
      const newer = await libraryScroll(world.db, 'The newer Scroll', 10);
      const { roomId, slug, people } = await listening();
      const { look, model } = feedHeartbeat(world);
      const result = await look(slug);
      expect(result.find.kind).toBe('posted');
      // Code chose the newest asset the room had not seen; the model was asked once and wrote only the note.
      expect(model.calls).toHaveLength(1);
      const request = requestText(model.calls[0]!);
      expect(request).toContain('The newer Scroll');
      expect(request).not.toContain('The older Scroll');
      const [discussion] = await finds(roomId);
      expect(discussion).toMatchObject({
        kind: 'find',
        root_asset_id: newer,
        root_asset_revision: 1,
        started_by_account_id: null,
        title: 'The newer Scroll',
      });
      const messages = await database.db
        .selectFrom('rooms.messages')
        .selectAll()
        .where('discussion_id', '=', discussion!.discussion_id)
        .execute();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        author_kind: 'ai',
        author_account_id: null,
        inhabitant: 'explainer',
        ai_kind: 'find',
        trigger: 'feed_find',
        body_text: FIND_NOTE,
      });
      const [turn] = await feedTurns(world.db, roomId);
      expect(turn).toMatchObject({
        trigger: 'feed_find',
        decided_by: 'caps_clear',
        state: 'completed',
        dispatched: true,
        find_asset_id: newer,
        find_asset_revision: 1,
        discussion_id: discussion!.discussion_id,
        message_id: messages[0]!.message_id,
        requested_by_account_id: null,
        cause_message_id: null,
        // The model the worker is configured for is recorded on the turn (D-031 checks the response's own field).
        model: model.model,
        role_version: 'find.1',
      });
      expect(older).not.toBe(newer);
      // A member reads it, labelled, with the asset as a card and the note.
      const feed = await readFeed(world, people[0]!, roomId);
      expect(feed.posts).toHaveLength(1);
      expect(feed.posts[0]).toMatchObject({
        discussionId: discussion!.discussion_id,
        author: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' },
        note: FIND_NOTE,
        replies: 0,
      });
      expect(feed.posts[0]).toMatchObject({
        content: { status: 'available', target: { assetId: newer, assetRevision: 1 } },
      });
    });

    it('can be about a Reel as well as a Scroll', async () => {
      await libraryScroll(world.db, 'A Scroll', 60);
      const reel = await libraryReel(world.db, 'A Reel about tokens', 5);
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world);
      expect((await look(slug)).find.kind).toBe('posted');
      expect(requestText(model.calls[0]!)).toContain('A Reel: "A Reel about tokens"');
      expect((await finds(roomId))[0]).toMatchObject({ root_asset_id: reel });
    });

    it('never reaches a model with a member’s words: the call reads the room, the asset and what is remembered', async () => {
      await libraryScroll(world.db, 'A Scroll for the call');
      const { roomId, slug, people } = await listening(3);
      const general = (await memberView(world, people[0]!, roomId)).general.discussionId;
      unwrap(await setPreferences(world, people[2]!, roomId, { keepOut: true }));
      unwrap(await say(world, people[0]!, roomId, general, 'ORDINARY-WORDS about attention'));
      unwrap(await say(world, people[2]!, roomId, general, 'KEPT-OUT-WORDS about attention'));
      const { look, model } = feedHeartbeat(world);
      await look(slug);
      expect(model.calls).toHaveLength(1);
      const request = requestText(model.calls[0]!);
      expect(request).not.toContain('KEPT-OUT-WORDS');
      expect(request).not.toContain('ORDINARY-WORDS');
      expect(request).toContain('<context-item ref="room"');
      expect(request).toContain('<context-item ref="find"');
    });

    it('is checked where it is stored: a post with no asset, or an asset that does not exist, cannot be made', async () => {
      const { roomId } = await listening();
      const id = randomUUID();
      const stray = async (root: { asset: string | null; revision: number | null }) =>
        database.db
          .insertInto('rooms.discussions')
          .values({
            discussion_id: randomUUID(),
            room_id: roomId,
            title: 'A stray find',
            kind: 'find',
            root_asset_id: root.asset,
            root_asset_revision: root.revision,
            last_activity_at: world.clock.now,
            created_at: world.clock.now,
          })
          .execute();
      await expect(stray({ asset: null, revision: null })).rejects.toThrow(/discussions_find_check/);
      await expect(stray({ asset: id, revision: 1 })).rejects.toThrow(/foreign key|discussions_root/i);
      // And a ledger row of a find without an asset that exists is refused for the same reason.
      await expect(
        sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at, find_asset_id, find_asset_revision)
          values (${randomUUID()}::uuid, ${roomId}::uuid, 'explainer', 'feed_find', 'queued', 'caps_clear', now(), ${id}::uuid, 1)`.execute(
          world.db,
        ),
      ).rejects.toThrow(/ai_turns_find_asset_fkey/);
      await expect(
        sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at)
          values (${randomUUID()}::uuid, ${roomId}::uuid, 'explainer', 'feed_find', 'queued', 'caps_clear', now())`.execute(
          world.db,
        ),
      ).rejects.toThrow(/ai_turns_decision_check/);
    });

    it('is not made when the asset was withdrawn while the resident wrote: nothing links nothing', async () => {
      const asset = await libraryScroll(world.db, 'A Scroll that will be withdrawn');
      const { roomId, slug } = await listening();
      const real = makeReadFinds();
      let rereadFor: unknown;
      let rereads = 0;
      const { look } = feedHeartbeat(world, undefined, {
        readFinds: async (topic, limit, only) => {
          // The first exact read is the look before the call; the second is the check after it, where the asset has gone.
          if (only !== undefined && (rereads += 1) === 2) {
            rereadFor = only;
            await database.db
              .updateTable('content.assets')
              .set({ status: 'withdrawn' })
              .where('id', '=', asset)
              .execute();
          }
          return real(topic, limit, only);
        },
      });
      const result = await look(slug);
      expect(result.find).toEqual({ kind: 'not_made', reason: 'asset_withdrawn' });
      expect(rereadFor).toEqual({ assetId: asset, assetRevision: 1 });
      expect(await finds(roomId)).toEqual([]);
      const [turn] = await feedTurns(world.db, roomId);
      // The call was made, so the turn stays counted and the asset is not offered to this room again.
      expect(turn).toMatchObject({ state: 'failed', dispatched: true, discussion_id: null });
    });

    function makeReadFinds() {
      return makeReadLibraryFinds(world.db);
    }
  });

  describe('the voice of a note', () => {
    it('never posts a note that claims an experience ("changed how I picture…"), and asks once more with a fixed hint', async () => {
      const first = await libraryScroll(world.db, 'The first Scroll', 20);
      const second = await libraryScroll(world.db, 'The second Scroll', 90);
      const { roomId, slug } = await listening();
      const claim = (text: string) => ({ kind: 'success' as const, text: JSON.stringify({ kind: 'find', text }) });
      const { look, model } = feedHeartbeat(world, (sequence) =>
        sequence <= 2 ? claim('At 0:40 the arc changed how I picture dark matter.') : find(),
      );
      const result = await look(slug);
      // The harness refused the answer, sent the one repair, refused that too, and nothing was posted.
      expect(result.find.kind).toBe('not_made');
      expect(model.calls).toHaveLength(2);
      expect(Buffer.from(model.calls[1]!.bytes).toString('utf8')).toContain('never about yourself');
      expect(await finds(roomId)).toEqual([]);
      const [turn] = await feedTurns(world.db, roomId);
      expect(turn).toMatchObject({ find_asset_id: first, state: 'failed', dispatched: true, message_id: null });
      // The asset had its one call in this room: the next look offers the next one.
      at('2026-11-01T08:30:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      expect((await finds(roomId))[0]).toMatchObject({ root_asset_id: second });
    });

    it('lets the one repair fix a note, and posts it once', async () => {
      await libraryScroll(world.db, 'A Scroll to repair');
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world, (sequence) =>
        sequence === 1
          ? { kind: 'success', text: JSON.stringify({ kind: 'find', text: 'I remember when this was a mystery.' }) }
          : find(),
      );
      expect((await look(slug)).find.kind).toBe('posted');
      expect(model.calls).toHaveLength(2);
      expect(await finds(roomId)).toHaveLength(1);
      expect(await feedTurns(world.db, roomId)).toHaveLength(1);
    });

    it('posts nothing when the resident has nothing worth saying, and the call stays counted', async () => {
      await libraryScroll(world.db, 'A Scroll that is not worth a post');
      const { roomId, slug } = await listening();
      const { look } = feedHeartbeat(world, () => ({
        kind: 'success',
        text: JSON.stringify({ kind: 'nothing_to_add', text: '' }),
      }));
      expect((await look(slug)).find).toEqual({ kind: 'declined' });
      expect(await finds(roomId)).toEqual([]);
      expect((await feedTurns(world.db, roomId))[0]).toMatchObject({ state: 'declined', dispatched: true });
    });

    it('posts nothing when the call fails, and says so honestly', async () => {
      await libraryScroll(world.db, 'A Scroll for a failing call');
      const { roomId, slug } = await listening();
      const { look } = feedHeartbeat(world, () => ({ kind: 'server_error', status: 500 }));
      expect((await look(slug)).find).toEqual({ kind: 'not_made', reason: 'call_failed' });
      expect(await finds(roomId)).toEqual([]);
      expect((await feedTurns(world.db, roomId))[0]).toMatchObject({ state: 'failed' });
    });
  });

  describe('the heartbeat and each resident’s rest', () => {
    it('looks once in each 8-hour slot: a second look in the same slot finds the first one’s turn and changes nothing', async () => {
      await libraryScroll(world.db, 'The first Scroll of the day', 30);
      await libraryScroll(world.db, 'The second Scroll of the day', 40);
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T09:07:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      at('2026-11-01T11:30:00Z');
      expect((await look(slug)).find).toEqual({ kind: 'dropped', reason: 'already_looked' });
      expect(model.calls).toHaveLength(1);
      expect(await feedTurns(world.db, roomId)).toHaveLength(1);
    });

    it('lets one resident post per six hours: the other resident posts next, and the first again once its rest is over', async () => {
      await libraryScroll(world.db, 'The first of three Scrolls', 10);
      await libraryScroll(world.db, 'The second of three Scrolls', 20);
      await libraryScroll(world.db, 'The third of three Scrolls', 30);
      const { roomId, slug } = await listening();
      const { look } = feedHeartbeat(world);
      at('2026-11-01T07:59:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      // A minute later is the next slot, and Nova is resting: Halley posts.
      at('2026-11-01T08:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      // Eight hours on, both have rested; Nova posted longest ago.
      at('2026-11-01T16:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      const turns = await feedTurns(world.db, roomId);
      expect(turns.map((turn) => turn.inhabitant)).toEqual(['explainer', 'skeptic', 'explainer']);
      expect(turns.every((turn) => turn.state === 'completed')).toBe(true);
    });

    it('lets go while every resident is resting, with no call', async () => {
      await libraryScroll(world.db, 'Another Scroll about the sky', 10);
      await libraryScroll(world.db, 'Yet another Scroll about water', 20);
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world);
      for (const [name, hoursAgo] of [
        ['explainer', 2],
        ['skeptic', 3],
      ] as const) {
        const asset = await libraryScroll(world.db, `Already shown by the ${name}`, 500);
        await sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at, settled_at, dispatched, find_asset_id, find_asset_revision, role_version, prompt_version, model)
          values (${randomUUID()}::uuid, ${roomId}::uuid, ${name}, 'feed_find', 'declined', 'caps_clear', ${new Date(START.getTime() - hoursAgo * HOUR)}, ${START}, true, ${asset}::uuid, 1, 'find.1', 'p', 'm')`.execute(
          world.db,
        );
      }
      expect((await look(slug)).find).toEqual({ kind: 'dropped', reason: 'resting' });
      expect(model.calls).toHaveLength(0);
    });

    it('runs the library dry honestly: each asset once, then silence, with no repeat dressed as new', async () => {
      const first = await libraryScroll(world.db, 'Only two Scrolls remain', 10);
      const second = await libraryReel(world.db, 'Only two, a Reel remains', 20);
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T08:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      at('2026-11-01T16:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      at('2026-11-02T00:00:00Z');
      expect((await look(slug)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      at('2026-11-02T08:00:00Z');
      expect((await look(slug)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect(model.calls).toHaveLength(2);
      expect((await finds(roomId)).map((discussion) => discussion.root_asset_id).sort()).toEqual(
        [first, second].sort(),
      );
    });

    it('counts a card a member shared as seen: the room is not shown what it already has', async () => {
      const shared = await libraryScroll(world.db, 'Shared by a member', 10);
      const fresh = await libraryScroll(world.db, 'Not yet seen', 50);
      const { roomId, slug, people } = await listening();
      const general = (await memberView(world, people[0]!, roomId)).general.discussionId;
      unwrap(
        await world.rooms.send(people[0]!.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          discussionId: general,
          body: { kind: 'content', target: { assetId: shared, assetRevision: 1 } },
        }),
      );
      const { look } = feedHeartbeat(world);
      expect((await look(slug)).find.kind).toBe('posted');
      expect((await finds(roomId))[0]).toMatchObject({ root_asset_id: fresh });
    });

    /** Makes `second` a twin of `first`: the same explanation, as a Reel and the Scroll made from it are. */
    const makeTwins = (first: string, second: string) =>
      sql`update content.asset_revisions set explanation_unit_id =
          (select explanation_unit_id from content.asset_revisions where asset_id = ${first}::uuid limit 1)
        where asset_id = ${second}::uuid`.execute(database.db);

    it('counts a Reel and the Scroll of its explanation as one find: the twin of a find is not a second find', async () => {
      const scroll = await libraryScroll(world.db, 'One explanation as a Scroll', 5);
      const reel = await libraryReel(world.db, 'One explanation as a Reel', 20);
      const other = await libraryScroll(world.db, 'A different explanation entirely', 60);
      await makeTwins(scroll, reel);
      const { roomId, slug } = await listening();
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T08:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      at('2026-11-01T16:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
      at('2026-11-02T00:00:00Z');
      // The Reel is not offered after the Scroll it twins: the library is dry, though it holds an asset the room never saw by ID.
      expect((await look(slug)).find).toEqual({ kind: 'dropped', reason: 'nothing_new' });
      expect(model.calls).toHaveLength(2);
      expect((await finds(roomId)).map((discussion) => discussion.root_asset_id).sort()).toEqual(
        [scroll, other].sort(),
      );
    });

    it('counts the twin of a card a member shared as seen', async () => {
      const shared = await libraryReel(world.db, 'A Reel a member shared', 30);
      const twin = await libraryScroll(world.db, 'Its Scroll, the newest in the library', 1);
      const fresh = await libraryScroll(world.db, 'Something the room has not seen', 80);
      await makeTwins(shared, twin);
      const { roomId, slug, people } = await listening();
      const general = (await memberView(world, people[0]!, roomId)).general.discussionId;
      unwrap(
        await world.rooms.send(people[0]!.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          discussionId: general,
          body: { kind: 'content', target: { assetId: shared, assetRevision: 1 } },
        }),
      );
      const { look } = feedHeartbeat(world);
      expect((await look(slug)).find.kind).toBe('posted');
      expect((await finds(roomId))[0]).toMatchObject({ root_asset_id: fresh });
    });
  });

  describe('caps', () => {
    it('refuses quietly, naming the cap, once the room has had three finds today: no call, no message, no error', async () => {
      await libraryScroll(world.db, 'A fourth Scroll for the day', 1);
      const { roomId, slug, people } = await listening();
      for (let n = 0; n < 3; n++) {
        const asset = await libraryScroll(world.db, `Earlier Scroll about ${['air', 'sea', 'ice'][n]!}`, 600 + n);
        await sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at, settled_at, dispatched, find_asset_id, find_asset_revision, role_version, prompt_version, model)
          values (${randomUUID()}::uuid, ${roomId}::uuid, 'skeptic', 'feed_find', 'declined', 'caps_clear', ${new Date(START.getTime() - 30 * HOUR + n)}, ${START}, true, ${asset}::uuid, 1, 'find.1', 'p', 'm')`.execute(
          world.db,
        );
      }
      // Three finds are on the books for today by the clock below.
      await sql`update rooms.ai_turns set created_at = ${new Date('2026-11-01T01:00:00Z')} where room_id = ${roomId}::uuid`.execute(
        world.db,
      );
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T16:00:00Z');
      const result = await look(slug);
      expect(result.find).toEqual({ kind: 'refused', cap: 'feed_day' });
      expect(model.calls).toHaveLength(0);
      expect(await finds(roomId)).toEqual([]);
      const refused = (await feedTurns(world.db, roomId)).filter((turn) => turn.state === 'refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        decided_by: 'feed_day',
        dispatched: false,
        discussion_id: null,
        message_id: null,
      });
      // The refusal shows nothing: the member's feed has no post and says nothing of it.
      expect((await readFeed(world, people[0]!, roomId)).posts).toEqual([]);
      expect((await memberView(world, people[0]!, roomId)).feed).toBeUndefined();
      // The refused row holds nothing: the asset is offered again once the day turns.
      at('2026-11-02T08:00:00Z');
      expect((await look(slug)).find.kind).toBe('posted');
    });

    it('counts finds against the room’s own unprompted caps: eight in an hour refuses, naming the hour cap', async () => {
      await libraryScroll(world.db, 'Never offered Scroll today', 1);
      const { roomId, slug } = await listening();
      for (let n = 0; n < 8; n++)
        await sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at, settled_at, dispatched, role_version, prompt_version, model)
          values (${randomUUID()}::uuid, ${roomId}::uuid, 'explainer', 'memory_refresh', 'declined', 'caps_clear', ${new Date(START.getTime() - n * 60_000)}, ${START}, true, 'memory.1', 'p', 'm')`.execute(
          world.db,
        );
      const { look, model } = feedHeartbeat(world);
      expect((await look(slug)).find).toEqual({ kind: 'refused', cap: 'room_hour' });
      expect(model.calls).toHaveLength(0);
    });
  });

  describe('what a member sees and may do', () => {
    async function postedRoom(members = 3) {
      const asset = await libraryScroll(world.db, 'The Scroll of the day', 5);
      const { roomId, slug, people } = await listening(members);
      const { look, model } = feedHeartbeat(world);
      expect((await look(slug)).find.kind).toBe('posted');
      return { asset, roomId, slug, people, model };
    }

    it('lists the find for a Lively reader in full and for a Quieter reader without the note; an Off reader is listed none', async () => {
      const { roomId, people } = await postedRoom();
      const [lively, quieter, off] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]];
      unwrap(await setPreferences(world, quieter, roomId, { aiLevel: 'quieter' }));
      unwrap(await setPreferences(world, off, roomId, { aiLevel: 'off' }));
      const full = await readFeed(world, lively, roomId);
      expect(full.posts[0]).toMatchObject({ note: FIND_NOTE });
      expect(full.posts[0]).not.toHaveProperty('folded');
      expect((await memberView(world, lively, roomId)).feed).toMatchObject({
        by: { kind: 'ai', name: 'Nova', label: 'AI · Explainer' },
      });
      const folded = await readFeed(world, quieter, roomId);
      expect(folded.posts[0]).toMatchObject({ folded: true });
      expect(folded.posts[0]).not.toHaveProperty('note');
      expect(JSON.stringify(folded)).not.toContain(FIND_NOTE);
      const none = await readFeed(world, off, roomId);
      expect(none.posts).toEqual([]);
      expect(none.aiLevel).toBe('off');
      expect((await memberView(world, off, roomId)).feed).toBeUndefined();
      expect(JSON.stringify(none)).not.toContain(FIND_NOTE);
    });

    it('answers a stranger and a person who left with the one shape of a room that is not there', async () => {
      const { roomId, people } = await postedRoom();
      const stranger = await seedFriend(world.db, world.friends);
      expect(await world.rooms.feed(stranger.authority, { version, readId: randomUUID(), roomId })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      unwrap(await world.rooms.leave(people[1]!.authority, { version, commandId: randomUUID(), roomId }));
      expect((await world.rooms.feed(people[1]!.authority, { version, readId: randomUUID(), roomId })).kind).toBe(
        'refused',
      );
    });

    it('opens as a content thread about the asset, with the resident’s note first, and keeps finds out of the topic lists', async () => {
      const { roomId, asset, people } = await postedRoom();
      const feed = await readFeed(world, people[0]!, roomId);
      const view = await readDiscussion(world, people[0]!, roomId, feed.posts[0]!.discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.discussion).toMatchObject({ kind: 'find', title: 'The Scroll of the day' });
      expect(view.content?.root).toMatchObject({ status: 'available', target: { assetId: asset, assetRevision: 1 } });
      expect(view.messages[0]).toMatchObject({
        author: { kind: 'ai', label: 'AI · Explainer' },
        suggestion: 'find',
        trigger: 'feed_find',
        body: { text: FIND_NOTE },
      });
      const room = await memberView(world, people[0]!, roomId);
      expect(room.discussions.map((discussion) => discussion.kind)).not.toContain('find');
      const topics = unwrap(
        await world.rooms.topics(people[0]!.authority, { version, readId: randomUUID(), roomId, sort: 'new' }),
      );
      expect(JSON.stringify(topics)).not.toContain(feed.posts[0]!.discussionId);
    });

    it('counts replies after the note, and lists no find whose note a moderator removed', async () => {
      const { roomId, slug, people } = await postedRoom();
      const moderator = await seedFriend(world.db, world.friends);
      await makeModerator(world, slug, moderator);
      const feed = await readFeed(world, people[0]!, roomId);
      const discussionId = feed.posts[0]!.discussionId;
      unwrap(await say(world, people[0]!, roomId, discussionId, 'A reply about the asset'));
      expect((await readFeed(world, people[1]!, roomId)).posts[0]!.replies).toBe(1);
      const view = await readDiscussion(world, people[0]!, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      unwrap(await hideMessage(world, moderator, roomId, discussionId, view.messages[0]!.messageId));
      expect((await readFeed(world, people[1]!, roomId)).posts).toEqual([]);
    });

    it('draws a find whose asset was withdrawn since as unavailable, still with its link', async () => {
      const { roomId, asset, people } = await postedRoom();
      await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', asset).execute();
      const feed = await readFeed(world, people[0]!, roomId);
      expect(feed.posts[0]).toMatchObject({
        content: { status: 'unavailable', target: { assetId: asset, assetRevision: 1 } },
      });
    });

    it('lets a person vote Useful on a reply, never earns a star for a find, and an agent has no way to vote, direct-message or be counted here', async () => {
      const { roomId, people } = await postedRoom();
      const feed = await readFeed(world, people[0]!, roomId);
      const discussionId = feed.posts[0]!.discussionId;
      const reply = unwrap(await say(world, people[1]!, roomId, discussionId, 'A reply that helps'));
      const view = await readDiscussion(world, people[0]!, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      const note = view.messages[0]!;
      const starsBefore = await database.db
        .selectFrom('rooms.stars')
        .select('star_id')
        .where('room_id', '=', roomId)
        .execute();
      unwrap(await markUseful(world, people[0]!, roomId, discussionId, reply.messageId));
      unwrap(await markUseful(world, people[2]!, roomId, discussionId, note.messageId));
      // A find is not a question topic and a resident never earns: no star came of either mark.
      expect(
        await database.db.selectFrom('rooms.stars').select('star_id').where('room_id', '=', roomId).execute(),
      ).toEqual(starsBefore);
      // A resident is not an account: the rows that carry one never name it, and it holds no lease, vote or place.
      const turns = await feedTurns(world.db, roomId);
      expect(turns.every((turn) => turn.requested_by_account_id === null)).toBe(true);
      const aiMessages = await database.db
        .selectFrom('rooms.messages')
        .select(['author_account_id', 'author_kind'])
        .where('author_kind', '=', 'ai')
        .execute();
      expect(aiMessages.length).toBeGreaterThan(0);
      expect(aiMessages.every((message) => message.author_account_id === null)).toBe(true);
      // Presence: faces and the count are people only, however many residents posted.
      for (const person of people) unwrap(await setPresence(world, person, roomId));
      const room = await memberView(world, people[0]!, roomId);
      expect(room.here.faces).toHaveLength(3);
      expect(room.here.count).toBe(3);
      expect(room.memberTotal).toBe(3);
      expect(JSON.stringify(room.here)).not.toContain('"kind":"ai"');
    });
  });

  describe('the worker’s heartbeat', () => {
    it('looks at every room that has someone listening, and one room failing does not stop the others (it throws after the loop so the job retries)', async () => {
      await libraryScroll(world.db, 'A Scroll for two rooms', 10);
      const one = await listening();
      const two = await listening();
      const failures: string[] = [];
      let calls = 0;
      const { heartbeat } = feedHeartbeat(world, () => {
        calls += 1;
        return calls === 1 ? { kind: 'server_error', status: 500 } : find();
      });
      // A failing call is an honest `not_made`, not a thrown error; a room that throws is one whose look could not finish.
      const looks = await heartbeat.lookAtAll({ signal: never, onRoomFailed: (slug) => failures.push(slug) });
      expect(looks.map((entry) => entry.room).sort()).toEqual([one.slug, two.slug].sort());
      expect(failures).toEqual([]);
      const kinds = looks.map((entry) => entry.find.kind).sort();
      expect(kinds).toEqual(['not_made', 'posted']);
    });

    it('is exact under a retry: running the same slot twice posts and pays once', async () => {
      await libraryScroll(world.db, 'A Scroll for once only', 10);
      const { roomId } = await listening();
      const { heartbeat, model } = feedHeartbeat(world);
      at('2026-11-01T09:07:00Z');
      await heartbeat.lookAtAll({ signal: never });
      await heartbeat.lookAtAll({ signal: never });
      expect(model.calls).toHaveLength(1);
      expect(await finds(roomId)).toHaveLength(1);
      expect(await feedTurns(world.db, roomId)).toHaveLength(1);
    });

    it('writes nothing to a person’s own universe', async () => {
      await libraryScroll(world.db, 'A Scroll for the universe check', 10);
      const { roomId, slug, people } = await listening();
      const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const { look } = feedHeartbeat(world);
      await look(slug);
      await readFeed(world, people[0]!, roomId);
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
    });
  });
});
