/**
 * People and residents together in a room's Feed (v3 R-8b, second part; D-275 to D-279) over real PostgreSQL, with library assets
 * admitted through the real import use case and the real reasoning harness over a CI fixture model (never provider output). A
 * moderator has a resident introduce itself, once, in the product's own words; a resident's profile and the live strip above General
 * are read from rows that exist; a resident joins a member's post only through the room's own router, within its caps and ledger; an
 * idle room makes no call.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  assetLink,
  feedHeartbeat,
  find,
  introduceResident,
  libraryReel,
  libraryScroll,
  postFind,
  readFeed,
  sourceLink,
  votePost,
} from '../support/rooms-feed.js';
import {
  hideMessage,
  joined,
  makeModerator,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  readDiscussion,
  roomScope,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPreferences,
  setPresence,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, type Friend } from '../support/talk.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const START = new Date('2026-11-01T07:59:00Z');
const version = 'rooms.v1' as const;
const CLAIM = "so we've proven it, the Moon causes the tides alone";
const pushesBack: FixtureScenario = {
  kind: 'success',
  text: JSON.stringify({
    kind: 'assumption',
    text: 'Does that assume the Moon is the only thing pulling on the oceans?',
  }),
};

describe('people and residents in the Feed (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_people');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).execute();
    await database.db.updateTable('rooms.rooms').set({ status: 'closed' }).execute();
    world.clock.now = START;
  });

  const scene = async (members = 3) => {
    const { roomId, slug } = await seedRoom(world);
    const people = await joined(world, roomId, members);
    return { roomId, slug, people };
  };
  const at = (milliseconds: number) => {
    world.clock.now = new Date(START.getTime() + milliseconds);
  };
  const posted = async (
    author: Friend,
    roomId: string,
    link: Parameters<typeof postFind>[3]['link'],
    title = 'A post',
  ) => unwrap(await postFind(world, author, roomId, { link, title })).discussionId;
  /** The ledger's rows: the whole file's, or one room's (the table is shared by every test of the file). */
  const turnCount = async (roomId?: string) =>
    Number(
      (
        await (
          roomId === undefined
            ? sql<{ n: string }>`select count(*)::text as n from rooms.ai_turns`
            : sql<{ n: string }>`select count(*)::text as n from rooms.ai_turns where room_id = ${roomId}::uuid`
        ).execute(world.db)
      ).rows[0]!.n,
    );
  const live = async (reader: Friend, roomId: string) => (await memberView(world, reader, roomId)).live;

  describe('an introduction', () => {
    it('is made by a moderator once, in the resident’s fixed words, with no call, no job and no ledger row', async () => {
      const { roomId, slug, people } = await scene();
      const [moderator, asha] = people as [Friend, Friend];
      await makeModerator(world, slug, moderator);
      const before = {
        queued: world.queued.length,
        checks: world.castChecks.length,
        passes: world.castPasses.length,
        turns: await turnCount(),
      };
      const made = unwrap(await introduceResident(world, moderator, roomId, 'explainer'));
      expect(made.result).toBe('introduced');
      const [intro] = (await readFeed(world, asha, roomId)).posts;
      expect(intro).toMatchObject({
        kind: 'intro',
        discussionId: made.discussionId,
        author: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' },
        votes: 0,
        canVote: true,
      });
      expect(intro).toHaveProperty('text', expect.stringContaining("Hi, I'm Nova."));
      expect(intro).not.toHaveProperty('title');
      expect({
        queued: world.queued.length,
        checks: world.castChecks.length,
        passes: world.castPasses.length,
        turns: await turnCount(),
      }).toEqual(before);
    });

    it('is one per resident: asking again is accepted, says so, and makes nothing', async () => {
      const { roomId, slug, people } = await scene(2);
      const [moderator] = people as [Friend];
      await makeModerator(world, slug, moderator);
      const first = unwrap(await introduceResident(world, moderator, roomId, 'skeptic'));
      const again = unwrap(await introduceResident(world, moderator, roomId, 'skeptic'));
      expect(again).toMatchObject({ result: 'already_introduced', discussionId: first.discussionId });
      const other = unwrap(await introduceResident(world, moderator, roomId, 'explainer'));
      expect(other.discussionId).not.toBe(first.discussionId);
      const rows = await world.db
        .selectFrom('rooms.discussions')
        .select(['intro_inhabitant', 'kind', 'started_by_account_id'])
        .where('room_id', '=', roomId)
        .where('kind', '=', 'intro')
        .execute();
      expect(rows.map((row) => row.intro_inhabitant).sort()).toEqual(['explainer', 'skeptic']);
      expect(rows.every((row) => row.started_by_account_id === moderator.accountId)).toBe(true);
    });

    it('is for a moderator only, for a resident the room has, in a room that is open; and writes nothing to a person’s universe', async () => {
      const { roomId, slug, people } = await scene(3);
      const [moderator, asha] = people as [Friend, Friend];
      await makeModerator(world, slug, moderator);
      expect(await introduceResident(world, asha, roomId)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(
        await world.rooms.introduceResident(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          inhabitant: 'quizmaster',
        }),
      ).toEqual({ kind: 'refused', code: 'invalid_input' });
      await world.db.updateTable('rooms.rooms').set({ status: 'paused' }).where('room_id', '=', roomId).execute();
      expect(await introduceResident(world, moderator, roomId)).toEqual({ kind: 'refused', code: 'unavailable' });
      await world.db.updateTable('rooms.rooms').set({ status: 'open' }).where('room_id', '=', roomId).execute();
      const universe = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      unwrap(await introduceResident(world, moderator, roomId));
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(universe);
    });

    it('is a post people vote on and reply under, and not a topic of the room', async () => {
      const { roomId, slug, people } = await scene(3);
      const [moderator, asha, ravi] = people as [Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      const { discussionId } = unwrap(await introduceResident(world, moderator, roomId, 'skeptic'));
      expect(unwrap(await votePost(world, asha, roomId, discussionId))).toMatchObject({ votes: 1 });
      unwrap(await say(world, ravi, roomId, discussionId, 'Welcome, Halley.'));
      expect((await readFeed(world, ravi, roomId)).posts[0]).toMatchObject({ kind: 'intro', votes: 1, replies: 1 });
      const view = await readDiscussion(world, asha, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.discussion).toMatchObject({
        kind: 'intro',
        title: 'Meet Halley',
        post: { votes: 1, youVoted: true, canVote: true },
      });
      expect(view.messages[0]).toMatchObject({ author: { kind: 'ai', name: 'Halley', label: 'AI · Skeptic' } });
      const room = await memberView(world, asha, roomId);
      expect(room.discussions.map((entry) => entry.discussionId)).not.toContain(discussionId);
    });

    it('is listed for a reader whose AI is Lively or Quieter, and for a reader whose AI is Off it is not', async () => {
      const { roomId, slug, people } = await scene(4);
      const [moderator, lively, quieter, off] = people as [Friend, Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      unwrap(await introduceResident(world, moderator, roomId));
      unwrap(await setPreferences(world, quieter, roomId, { aiLevel: 'quieter' }));
      unwrap(await setPreferences(world, off, roomId, { aiLevel: 'off' }));
      expect((await readFeed(world, lively, roomId)).posts.map((post) => post.kind)).toEqual(['intro']);
      expect((await readFeed(world, quieter, roomId)).posts.map((post) => post.kind)).toEqual(['intro']);
      expect((await readFeed(world, off, roomId)).posts).toEqual([]);
    });
  });

  describe('a resident’s profile', () => {
    it('is the product’s words and the room’s ledger: made by KnowScroll, its interests, when the room began, and nothing it has not done', async () => {
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      const { profiles, residents } = await readFeed(world, asha, roomId);
      expect(profiles.map((profile) => profile.inhabitant)).toEqual(residents.map((resident) => resident.inhabitant));
      for (const profile of profiles) {
        expect(profile).toMatchObject({ madeBy: 'KnowScroll', introduced: false, recent: [] });
        expect(profile.caresAbout.length).toBeGreaterThan(0);
        expect(profile).not.toHaveProperty('lastAt');
        expect(profile).not.toHaveProperty('nextAfter');
      }
      const room = await world.db
        .selectFrom('rooms.rooms')
        .select('created_at')
        .where('room_id', '=', roomId)
        .executeTakeFirstOrThrow();
      expect(new Date(profiles[0]!.roomSince).getTime()).toBe(new Date(room.created_at).getTime());
    });

    it('says when a resident last spoke and, only while it is still ahead, when it may post next; and lists its newest finds', async () => {
      await libraryScroll(world.db, 'A Scroll for a profile', 10);
      const { roomId, slug, people } = await scene(2);
      const [asha] = people as [Friend];
      const { look } = feedHeartbeat(world, () => find());
      expect((await look(slug)).find).toMatchObject({ kind: 'posted' });
      const nova = async () =>
        (await readFeed(world, asha, roomId)).profiles.find((profile) => profile.inhabitant === 'explainer')!;
      const first = await nova();
      expect(first.lastAt).toBe(START.toISOString());
      expect(first.nextAfter).toBe(new Date(START.getTime() + 6 * HOUR).toISOString());
      expect(first.recent).toHaveLength(1);
      expect(typeof first.recent[0]?.title).toBe('string');
      const feed = await readFeed(world, asha, roomId);
      expect(feed.profiles.find((profile) => profile.inhabitant === 'skeptic')).not.toHaveProperty('lastAt');
      // Seven hours on, the rest is over: the profile promises nothing.
      at(7 * HOUR);
      const later = await nova();
      expect(later.lastAt).toBe(START.toISOString());
      expect(later).not.toHaveProperty('nextAfter');
    });

    it('carries the first message of a find, so it can be reported, and says an introduction was made', async () => {
      await libraryScroll(world.db, 'A Scroll to report', 10);
      const { roomId, slug, people } = await scene(2);
      const [moderator, asha] = people as [Friend, Friend];
      await makeModerator(world, slug, moderator);
      const { look } = feedHeartbeat(world, () => find());
      await look(slug);
      unwrap(await introduceResident(world, moderator, roomId, 'explainer'));
      const profile = (await readFeed(world, asha, roomId)).profiles.find((entry) => entry.inhabitant === 'explainer')!;
      expect(profile.introduced).toBe(true);
      const messageId = profile.recent[0]!.messageId;
      const view = await readDiscussion(world, asha, roomId, profile.recent[0]!.discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages[0]!.messageId).toBe(messageId);
    });
  });

  describe('the live strip above General', () => {
    it('says nothing in a room where nothing has been posted, however long it is open', async () => {
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      expect(await live(asha, roomId)).toBeUndefined();
      at(30 * HOUR);
      expect(await live(asha, roomId)).toBeUndefined();
    });

    it('tells who posted and who replied, newest first, from the rows that exist, and nothing else about anyone', async () => {
      const reel = await libraryReel(world.db, 'A Reel for the strip');
      const { roomId, people } = await scene(3);
      const [asha, ravi] = people as [Friend, Friend];
      const post = await posted(asha, roomId, assetLink(reel));
      at(20 * MINUTE);
      unwrap(await say(world, ravi, roomId, post, 'Which arc is the far one?'));
      at(25 * MINUTE);
      const strip = (await live(ravi, roomId))!;
      expect(strip.map((event) => [event.kind, event.by.kind, event.discussionId])).toEqual([
        ['replied', 'person', post],
        ['posted', 'person', post],
      ]);
      expect(strip[0]).toMatchObject({
        at: new Date(START.getTime() + 20 * MINUTE).toISOString(),
        by: { person: { personId: ravi.person.personId }, you: true },
      });
      expect(strip[1]).toMatchObject({ by: { person: { personId: asha.person.personId }, you: false } });
      for (const event of strip) expect(Object.keys(event).sort()).toEqual(['at', 'by', 'discussionId', 'kind']);
      expect(JSON.stringify(strip)).not.toMatch(/online|here now|count|total|watch|read/i);
    });

    it('names a resident that posted, shows at most three, and drops what is a day old', async () => {
      await libraryScroll(world.db, 'A Scroll a resident finds', 10);
      const reels = [
        await libraryReel(world.db, 'One', 300),
        await libraryReel(world.db, 'Two', 200),
        await libraryReel(world.db, 'Three', 100),
      ];
      const { roomId, slug, people } = await scene(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      await posted(asha, roomId, assetLink(reels[0]!));
      at(HOUR);
      await posted(ravi, roomId, assetLink(reels[1]!));
      at(2 * HOUR);
      const { look } = feedHeartbeat(world, () => find());
      expect((await look(slug)).find).toMatchObject({ kind: 'posted' });
      at(3 * HOUR);
      await posted(kenji, roomId, assetLink(reels[2]!));
      const strip = (await live(lena, roomId))!;
      expect(strip).toHaveLength(3);
      expect(strip.map((event) => event.by.kind)).toEqual(['person', 'ai', 'person']);
      expect(strip[1]!.by).toMatchObject({ kind: 'ai', name: 'Nova', label: 'AI · Explainer' });
      at(30 * HOUR);
      expect(await live(lena, roomId)).toBeUndefined();
    });

    it('leaves out what a reader whose AI is Off is not told of, a person the reader blocked, and a post a moderator removed', async () => {
      await libraryScroll(world.db, 'A Scroll for the levels of the strip', 10);
      const reel = await libraryReel(world.db, 'A Reel of a blocked person', 200);
      const second = await libraryReel(world.db, 'A Reel a moderator removes', 100);
      const { roomId, slug, people } = await scene(5);
      const [moderator, asha, ravi, off, kenji] = people as [Friend, Friend, Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      const { look } = feedHeartbeat(world, () => find());
      await look(slug);
      at(MINUTE);
      await posted(asha, roomId, assetLink(reel));
      at(2 * MINUTE);
      const removed = await posted(ravi, roomId, assetLink(second));
      unwrap(await setPreferences(world, off, roomId, { aiLevel: 'off' }));
      expect((await live(off, roomId))!.map((event) => event.by.kind)).toEqual(['person', 'person']);
      expect((await live(kenji, roomId))!.map((event) => event.by.kind)).toEqual(['person', 'person', 'ai']);
      unwrap(await friendCommand(world.friends, kenji, asha, 'block'));
      expect(
        (await live(kenji, roomId))!.every(
          (event) => event.by.kind !== 'person' || event.by.person.personId !== asha.person.personId,
        ),
      ).toBe(true);
      expect(
        (await live(ravi, roomId))!.some(
          (event) => event.by.kind === 'person' && event.by.person.personId === asha.person.personId,
        ),
      ).toBe(true);
      const view = await readDiscussion(world, moderator, roomId, removed);
      if (view.status !== 'ready') throw new Error('expected ready');
      unwrap(await hideMessage(world, moderator, roomId, removed, view.messages[0]!.messageId));
      expect((await live(ravi, roomId))!.map((event) => event.discussionId)).not.toContain(removed);
    });
  });

  describe('a resident joins a member’s post', () => {
    /** Three people who have each spoken, all with the room open, and the one who will post. */
    async function gathering() {
      const room = await scene(3);
      const [asha, ravi, kenji] = room.people as [Friend, Friend, Friend];
      const general = (await memberView(world, asha, room.roomId)).general.discussionId;
      for (const person of [asha, ravi, kenji]) {
        unwrap(await setPresence(world, person, room.roomId));
        unwrap(await say(world, person, room.roomId, general, 'Hello, glad to be here'));
      }
      return { ...room, asha, ravi, kenji };
    }
    const checksOf = (discussionId: string) =>
      world.castChecks.filter((check) => check.job.discussionId === discussionId);

    it('is the room’s own router deciding about the post’s words: a strong claim draws one correction, labelled, within the caps and the ledger', async () => {
      const room = await gathering();
      at(MINUTE);
      for (const person of [room.asha, room.ravi, room.kenji]) unwrap(await setPresence(world, person, room.roomId));
      const discussionId = unwrap(
        await postFind(world, room.kenji, room.roomId, { link: sourceLink('https://example.org/tides'), words: CLAIM }),
      ).discussionId;
      const [check] = checksOf(discussionId);
      expect(check!.job.trigger).toBe('overstated_claim');
      expect(check!.job.discussionId).toBe(discussionId);
      // Nothing is called until the router has looked, and the look is the residents' own pass.
      expect(await turnCount(room.roomId)).toBe(0);
      world.clock.now = new Date(check!.startAfter!.getTime());
      await world.decide()(check!.job);
      const model = fixtureModel(() => pushesBack, { label: 'rooms-people' });
      const { harness, withScope } = roomScope(world.db, model);
      await world.pass(harness, withScope)(world.castPasses.at(-1)!.job);
      expect(model.calls).toHaveLength(1);
      const turns = await world.db
        .selectFrom('rooms.ai_turns')
        .selectAll()
        .where('room_id', '=', room.roomId)
        .execute();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        trigger: 'overstated_claim',
        inhabitant: 'skeptic',
        state: 'completed',
        discussion_id: discussionId,
      });
      const view = await readDiscussion(world, room.asha, room.roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.messages.at(-1)).toMatchObject({
        author: { kind: 'ai', name: 'Halley', label: 'AI · Skeptic' },
        trigger: 'overstated_claim',
      });
      expect((await readFeed(world, room.asha, room.roomId)).posts[0]).toMatchObject({ kind: 'post', replies: 1 });
    });

    it('makes no call, queues nothing and writes no turn for a post that is neither a question nor a strong claim, however long the room is left', async () => {
      const room = await gathering();
      at(MINUTE);
      const checks = world.castChecks.length;
      const discussionId = unwrap(
        await postFind(world, room.kenji, room.roomId, {
          link: sourceLink('https://example.org/calm'),
          words: 'A calm note about the tides.',
        }),
      ).discussionId;
      expect(world.castChecks).toHaveLength(checks);
      expect(checksOf(discussionId)).toEqual([]);
      at(40 * HOUR);
      expect(await turnCount(room.roomId)).toBe(0);
    });

    it('queues nothing where residents are off in the world: the post is made and no resident is asked', async () => {
      const quiet = await roomWorld(database, { now: START }, { residentsEnabled: false });
      try {
        const { roomId } = await seedRoom(quiet);
        const people = await joined(quiet, roomId, 3);
        const [asha] = people as [Friend];
        const accepted = unwrap(
          await postFind(quiet, asha, roomId, { link: sourceLink('https://example.org/off'), words: CLAIM }),
        );
        expect(accepted.result).toBe('posted');
        expect(quiet.castChecks).toEqual([]);
      } finally {
        await quiet.close();
      }
    });
  });

  describe('a post’s own page', () => {
    it('carries what people’s votes made of it for the reader, and says a member’s own post cannot be voted on', async () => {
      const reel = await libraryReel(world.db, 'A Reel for its page');
      const { roomId, people } = await scene(3);
      const [asha, ravi] = people as [Friend, Friend];
      const discussionId = await posted(asha, roomId, assetLink(reel));
      unwrap(await votePost(world, ravi, roomId, discussionId));
      const read = async (person: Friend) => {
        const view = await readDiscussion(world, person, roomId, discussionId);
        if (view.status !== 'ready') throw new Error('expected ready');
        return view.discussion.post;
      };
      expect(await read(ravi)).toEqual({ votes: 1, youVoted: true, canVote: true });
      expect(await read(asha)).toEqual({ votes: 1, youVoted: false, canVote: false });
      // A topic has none.
      const topic = (await memberView(world, ravi, roomId)).general.discussionId;
      const general = await readDiscussion(world, ravi, roomId, topic);
      if (general.status !== 'ready') throw new Error('expected ready');
      expect(general.discussion).not.toHaveProperty('post');
    });
  });
});
