/**
 * People's posts and votes in a room's Feed (v3 R-8b, D-269 to D-272) over real PostgreSQL, with library assets admitted through the
 * real import use case and the real reasoning harness over a CI fixture model (never provider output). A member posts a find with their
 * own words and one link, an admitted Reel or Scroll or a checked source; people vote up and nobody else can; the Feed is ordered Hot,
 * New or Top; no post and no vote calls a model or writes to a person's own universe; leaving, removal and deletion take the votes.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  eraseCurrentAccount,
  eraseCurrentExploration,
  exportCurrentPerson,
  personalStores,
} from '@knowscroll/backend/erasure-registry';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { clearExplorationFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { recordingPerson } from '../support/recording-person.js';
import {
  assetLink,
  feedHeartbeat,
  find,
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
  joinRoom,
  makeModerator,
  PERSONAL_UNIVERSE_SCHEMAS,
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

const roomsErasure = personalStores.find((declaration) => declaration.module === 'rooms')!;
const HOUR = 3_600_000;
const START = new Date('2026-11-01T07:59:00Z');
const version = 'rooms.v1' as const;

describe('people’s posts and votes in the Feed (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_posts');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
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
  const posted = async (
    author: Friend,
    roomId: string,
    link: Parameters<typeof postFind>[3]['link'],
    title?: string,
  ) => {
    const accepted = unwrap(await postFind(world, author, roomId, { link, ...(title === undefined ? {} : { title }) }));
    expect(accepted.result).toBe('posted');
    return accepted.discussionId;
  };
  const postsOf = async (roomId: string, person: Friend, order?: Parameters<typeof readFeed>[3]) =>
    (await readFeed(world, person, roomId, order)).posts;
  /** The votes cast on the posts of one room: the table is shared by every test of the file. */
  const votesIn = (roomId: string) =>
    world.db
      .selectFrom('rooms.post_votes')
      .innerJoin('rooms.discussions', 'rooms.discussions.discussion_id', 'rooms.post_votes.discussion_id')
      .select(['rooms.post_votes.discussion_id', 'rooms.post_votes.account_id'])
      .where('rooms.discussions.room_id', '=', roomId)
      .execute();
  const personPosts = async (roomId: string, person: Friend, order?: Parameters<typeof readFeed>[3]) =>
    (await postsOf(roomId, person, order)).flatMap((post) => (post.kind === 'post' ? [post] : []));

  describe('posting', () => {
    it('lets a member post a find that links an admitted Reel, and the Feed shows it with the card, the words and no votes', async () => {
      const reel = await libraryReel(world.db, 'Light that bends');
      const { roomId, people } = await scene();
      const [asha, ravi] = people as [Friend, Friend];
      const discussionId = await posted(asha, roomId, assetLink(reel), 'Found a Reel on lensing');
      const [post] = await postsOf(roomId, ravi);
      expect(post).toMatchObject({
        kind: 'post',
        discussionId,
        title: 'Found a Reel on lensing',
        author: { kind: 'person', you: false, person: { personId: asha.person.personId } },
        replies: 0,
        votes: 0,
        youVoted: false,
        canVote: true,
        link: {
          kind: 'content',
          content: { status: 'available', metadata: { kind: 'reel', title: 'Light that bends' } },
        },
      });
      expect(post).toHaveProperty('words');
      // The author reads their own post as theirs, and cannot vote on it.
      const own = (await postsOf(roomId, asha))[0];
      expect(own).toMatchObject({ author: { you: true }, canVote: false });
    });

    it('lets a member post a Scroll, and a source: shown as a plain address of a site, never fetched', async () => {
      const scroll = await libraryScroll(world.db, 'Weighing the halo');
      const { roomId, people } = await scene();
      const [asha] = people as [Friend];
      await posted(asha, roomId, assetLink(scroll));
      world.clock.now = new Date(START.getTime() + HOUR);
      await posted(asha, roomId, sourceLink('https://www.Nature.com/articles/s41586?utm_source=x#top'), 'A paper');
      const posts = await personPosts(roomId, asha, { sort: 'new' });
      expect(posts.map((post) => post.link.kind)).toEqual(['source', 'content']);
      expect(posts[0]!.link).toEqual({
        kind: 'source',
        source: { url: 'https://www.nature.com/articles/s41586', host: 'nature.com' },
      });
      // The address is stored as plain text on the discussion and nowhere else.
      const rows = await world.db
        .selectFrom('rooms.discussions')
        .select(['source_url', 'person_post', 'kind', 'root_asset_id'])
        .where('room_id', '=', roomId)
        .where('kind', '=', 'find')
        .orderBy('created_at')
        .execute();
      expect(rows).toEqual([
        expect.objectContaining({ source_url: null, person_post: true, root_asset_id: scroll }),
        expect.objectContaining({
          source_url: 'https://www.nature.com/articles/s41586',
          person_post: true,
          root_asset_id: null,
        }),
      ]);
    });

    it('calls no model, queues no job and checks nothing with a resident: a post and a vote are a member’s own act', async () => {
      const reel = await libraryReel(world.db, 'No call for this');
      const { roomId, people } = await scene();
      const [asha, ravi] = people as [Friend, Friend];
      const before = {
        queued: world.queued.length,
        checks: world.castChecks.length,
        passes: world.castPasses.length,
        summaries: world.summaries.length,
        turns: Number(
          (await sql<{ n: string }>`select count(*)::text as n from rooms.ai_turns`.execute(world.db)).rows[0]!.n,
        ),
      };
      const discussionId = await posted(asha, roomId, assetLink(reel));
      unwrap(await votePost(world, ravi, roomId, discussionId));
      await postsOf(roomId, ravi);
      expect({
        queued: world.queued.length,
        checks: world.castChecks.length,
        passes: world.castPasses.length,
        summaries: world.summaries.length,
        turns: Number(
          (await sql<{ n: string }>`select count(*)::text as n from rooms.ai_turns`.execute(world.db)).rows[0]!.n,
        ),
      }).toEqual(before);
    });

    it('writes nothing to a person’s own universe: a post and a vote are not evidence', async () => {
      const reel = await libraryReel(world.db, 'Not evidence');
      const { roomId, people } = await scene();
      const [asha, ravi] = people as [Friend, Friend];
      const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const discussionId = await posted(asha, roomId, assetLink(reel));
      unwrap(await votePost(world, ravi, roomId, discussionId));
      unwrap(await votePost(world, ravi, roomId, discussionId, false));
      await postsOf(roomId, ravi);
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
    });

    it('refuses a stranger, a person who left, and a paused room, with the one answer', async () => {
      const reel = await libraryReel(world.db, 'For nobody outside');
      const { roomId, people } = await scene(2);
      const stranger = await seedFriend(world.db, world.friends);
      expect(await postFind(world, stranger, roomId, { link: assetLink(reel) })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      const [asha] = people as [Friend];
      await world.db.updateTable('rooms.rooms').set({ status: 'paused' }).where('room_id', '=', roomId).execute();
      expect(await postFind(world, asha, roomId, { link: assetLink(reel) })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      await world.db.updateTable('rooms.rooms').set({ status: 'open' }).where('room_id', '=', roomId).execute();
      unwrap(await world.rooms.leave(asha.authority, { version, commandId: randomUUID(), roomId }));
      expect(await postFind(world, asha, roomId, { link: assetLink(reel) })).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
    });

    it('refuses words and headlines that fail their rules, and links that are not a library asset or a plain source', async () => {
      const reel = await libraryReel(world.db, 'A Reel');
      const gone = await libraryReel(world.db, 'A withdrawn Reel');
      await world.db.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', gone).execute();
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      const refusal = async (input: Parameters<typeof postFind>[3]) => {
        const result = await postFind(world, asha, roomId, input);
        return result.kind === 'refused' ? result.code : 'accepted';
      };
      expect(await refusal({ link: assetLink(reel), words: 'See https://example.com for it' })).toBe('invalid_input');
      expect(await refusal({ link: assetLink(reel), title: 'Visit www.example.com' })).toBe('invalid_input');
      expect(await refusal({ link: assetLink(reel), words: ' ' })).toBe('invalid_input');
      expect(await refusal({ link: sourceLink('https://bit.ly/abc') })).toBe('invalid_input');
      expect(await refusal({ link: sourceLink('http://127.0.0.1/secret') })).toBe('invalid_input');
      expect(await refusal({ link: sourceLink('https://user:pw@example.com/') })).toBe('invalid_input');
      expect(await refusal({ link: sourceLink('javascript:alert(1)') })).toBe('invalid_input');
      expect(await refusal({ link: assetLink(gone) })).toBe('unavailable');
      expect(await refusal({ link: assetLink(randomUUID()) })).toBe('unavailable');
      // A revision that is not the current one is not what a post may link.
      expect(await refusal({ link: { kind: 'content', target: { assetId: reel, assetRevision: 7 } } })).toBe(
        'unavailable',
      );
      expect(await personPosts(roomId, asha)).toEqual([]);
    });

    it('lets a member post three a day in a room, and the fourth waits for the next UTC day', async () => {
      const reels = [
        await libraryReel(world.db, 'One'),
        await libraryReel(world.db, 'Two'),
        await libraryReel(world.db, 'Three'),
        await libraryReel(world.db, 'Four'),
      ];
      const { roomId, people } = await scene(2);
      const [asha, ravi] = people as [Friend, Friend];
      expect((await readFeed(world, asha, roomId)).canPost).toBe(true);
      for (const reel of reels.slice(0, 3)) await posted(asha, roomId, assetLink(reel));
      expect(await postFind(world, asha, roomId, { link: assetLink(reels[3]!) })).toEqual({
        kind: 'refused',
        code: 'rate_limited',
      });
      expect((await readFeed(world, asha, roomId)).canPost).toBe(false);
      // The cap is the member's own in that room: another member posts, and the next day the first does too.
      await posted(ravi, roomId, assetLink(reels[3]!));
      world.clock.now = new Date('2026-11-02T00:01:00Z');
      const fresh = await libraryReel(world.db, 'Five');
      expect((await readFeed(world, asha, roomId)).canPost).toBe(true);
      await posted(asha, roomId, assetLink(fresh));
    });

    it('does not post twice for one asset or one source: the room has it, and the answer names where', async () => {
      const reel = await libraryReel(world.db, 'Only once');
      const { roomId, people } = await scene(2);
      const [asha, ravi] = people as [Friend, Friend];
      const first = await posted(asha, roomId, assetLink(reel));
      const again = unwrap(await postFind(world, ravi, roomId, { link: assetLink(reel) }));
      expect(again).toMatchObject({ result: 'already_there', discussionId: first });
      const source = await posted(asha, roomId, sourceLink('https://example.org/a?utm_campaign=x'));
      const sameSource = unwrap(
        await postFind(world, ravi, roomId, { link: sourceLink('https://EXAMPLE.org/a#frag') }),
      );
      expect(sameSource).toMatchObject({ result: 'already_there', discussionId: source });
      expect(await personPosts(roomId, ravi)).toHaveLength(2);
      // Nothing was made for the repeat, so it did not use up the day.
      expect((await readFeed(world, ravi, roomId)).canPost).toBe(true);
    });

    it('is accepted again with the same command, and makes the post once', async () => {
      const reel = await libraryReel(world.db, 'Retry');
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      const request = {
        version,
        commandId: randomUUID(),
        roomId,
        title: 'Same command',
        words: 'The same words.',
        link: assetLink(reel),
      };
      const first = unwrap(await world.rooms.postFind(asha.authority, request));
      const second = unwrap(await world.rooms.postFind(asha.authority, request));
      expect(second).toMatchObject({ replayed: true, discussionId: first.discussionId });
      expect(await personPosts(roomId, asha)).toHaveLength(1);
    });

    it('does not make a resident answer it, and lets people reply under it like any thread', async () => {
      const reel = await libraryReel(world.db, 'Replies');
      const { roomId, people } = await scene(3);
      const [asha, ravi] = people as [Friend, Friend];
      const checks = world.castChecks.length;
      const discussionId = await posted(asha, roomId, assetLink(reel));
      expect(world.castChecks.length).toBe(checks);
      unwrap(await say(world, ravi, roomId, discussionId, 'The arc at 0:40 is wild.'));
      const [post] = await personPosts(roomId, ravi);
      expect(post!.replies).toBe(1);
      const view = await readDiscussion(world, ravi, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.discussion).toMatchObject({ kind: 'find', title: 'The arc at the edge' });
      expect(view.messages.map((message) => message.sequence)).toEqual([1, 2]);
    });

    it('shows a source’s address in the discussion, and not in the list of topics', async () => {
      const { roomId, people } = await scene(2);
      const [asha, ravi] = people as [Friend, Friend];
      const discussionId = await posted(asha, roomId, sourceLink('https://example.org/a'));
      const view = await readDiscussion(world, ravi, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      expect(view.discussion.source).toEqual({ url: 'https://example.org/a', host: 'example.org' });
      const room = unwrap(await world.rooms.read(ravi.authority, { version, readId: randomUUID(), roomId }));
      if (room.status !== 'member') throw new Error('expected member');
      expect(room.discussions.map((entry) => entry.discussionId)).not.toContain(discussionId);
    });
  });

  describe('votes', () => {
    it('counts people’s votes as a number, once each, and takes a vote back; the same value again changes nothing', async () => {
      const reel = await libraryReel(world.db, 'Votable');
      const { roomId, people } = await scene(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const discussionId = await posted(asha, roomId, assetLink(reel));
      expect(unwrap(await votePost(world, ravi, roomId, discussionId))).toMatchObject({ voted: true, votes: 1 });
      expect(unwrap(await votePost(world, ravi, roomId, discussionId))).toMatchObject({ voted: true, votes: 1 });
      expect(unwrap(await votePost(world, kenji, roomId, discussionId))).toMatchObject({ votes: 2 });
      expect(unwrap(await votePost(world, lena, roomId, discussionId))).toMatchObject({ votes: 3 });
      expect((await postsOf(roomId, ravi))[0]).toMatchObject({ votes: 3, youVoted: true, canVote: true });
      expect((await postsOf(roomId, asha))[0]).toMatchObject({ votes: 3, youVoted: false, canVote: false });
      expect(unwrap(await votePost(world, ravi, roomId, discussionId, false))).toMatchObject({
        voted: false,
        votes: 2,
      });
      expect(unwrap(await votePost(world, ravi, roomId, discussionId, false))).toMatchObject({
        voted: false,
        votes: 2,
      });
      expect((await postsOf(roomId, ravi))[0]).toMatchObject({ votes: 2, youVoted: false });
    });

    it('never lists who voted: no answer carries a voter, and the table is the only place that holds one', async () => {
      const reel = await libraryReel(world.db, 'Private votes');
      const { roomId, people } = await scene(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      const discussionId = await posted(asha, roomId, assetLink(reel));
      const raviAnswer = unwrap(await votePost(world, ravi, roomId, discussionId));
      const kenjiAnswer = unwrap(await votePost(world, kenji, roomId, discussionId));
      // What each person is told: the feed, the discussion and the answer to their own vote. None names the other voter.
      const told = async (reader: Friend, answer: object | undefined) =>
        JSON.stringify([
          await readFeed(world, reader, roomId, { sort: 'top', window: 'all' }),
          await readDiscussion(world, reader, roomId, discussionId),
          answer,
        ]);
      const seen: [Friend, Friend, string][] = [
        [asha, ravi, await told(asha, undefined)],
        [asha, kenji, await told(asha, undefined)],
        [kenji, ravi, await told(kenji, kenjiAnswer)],
        [ravi, kenji, await told(ravi, raviAnswer)],
      ];
      for (const [reader, voter, text] of seen) {
        expect(text, `${reader.person.handle} is not told who ${voter.person.handle} is`).not.toContain(
          voter.accountId,
        );
        expect(text).not.toContain(voter.person.personId);
        expect(text).not.toContain(voter.person.handle);
      }
    });

    it('refuses a vote on one’s own post, on a post that is not there, and from a stranger', async () => {
      const reel = await libraryReel(world.db, 'Not for the author');
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      const discussionId = await posted(asha, roomId, assetLink(reel));
      expect(await votePost(world, asha, roomId, discussionId)).toEqual({ kind: 'refused', code: 'invalid_input' });
      expect(await votePost(world, asha, roomId, randomUUID())).toEqual({ kind: 'refused', code: 'unavailable' });
      const stranger = await seedFriend(world.db, world.friends);
      expect(await votePost(world, stranger, roomId, discussionId)).toEqual({ kind: 'refused', code: 'unavailable' });
      // A discussion that is not a find is not something to vote on.
      const general = await world.db
        .selectFrom('rooms.discussions')
        .select('discussion_id')
        .where('room_id', '=', roomId)
        .where('kind', '=', 'general')
        .executeTakeFirstOrThrow();
      const [, ravi] = people as [Friend, Friend];
      expect(await votePost(world, ravi, roomId, general.discussion_id)).toEqual({
        kind: 'refused',
        code: 'unavailable',
      });
      expect(await votesIn(roomId)).toEqual([]);
    });

    it('counts people on a resident’s find, and a resident or a scout has no account, so nothing else can vote', async () => {
      await libraryScroll(world.db, 'A Scroll a resident finds', 10);
      const { roomId, slug, people } = await scene(3);
      const [asha, ravi] = people as [Friend, Friend];
      const { look } = feedHeartbeat(world, () => find());
      expect((await look(slug)).find).toMatchObject({ kind: 'posted' });
      const [resident] = await postsOf(roomId, asha);
      expect(resident).toMatchObject({ kind: 'find', votes: 0, youVoted: false, canVote: true });
      unwrap(await votePost(world, ravi, roomId, resident!.discussionId));
      expect((await postsOf(roomId, asha))[0]).toMatchObject({ kind: 'find', votes: 1 });
      // Every row of votes belongs to an account: the table has no other kind of voter to hold.
      expect((await votesIn(roomId)).map((row) => row.account_id)).toEqual([ravi.accountId]);
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_schema = 'rooms' and table_name = 'post_votes' order by ordinal_position`.execute(world.db);
      expect(columns.rows.map((row) => row.column_name)).toEqual(['discussion_id', 'account_id', 'voted_at']);
      // A vote earns nobody a star and nobody a mark of Useful.
      expect(
        Number((await sql<{ n: string }>`select count(*)::text as n from rooms.stars`.execute(world.db)).rows[0]!.n),
      ).toBe(0);
      expect(
        Number(
          (await sql<{ n: string }>`select count(*)::text as n from rooms.message_useful`.execute(world.db)).rows[0]!.n,
        ),
      ).toBe(0);
    });

    it('does not take a vote for a post a moderator removed, and leaves it out of the Feed', async () => {
      const reel = await libraryReel(world.db, 'Removed');
      const { roomId, slug, people } = await scene(3);
      const [asha, ravi, moderator] = people as [Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      const discussionId = await posted(asha, roomId, assetLink(reel));
      const view = await readDiscussion(world, moderator, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      unwrap(await hideMessage(world, moderator, roomId, discussionId, view.messages[0]!.messageId));
      expect(await personPosts(roomId, ravi)).toEqual([]);
      expect(await votePost(world, ravi, roomId, discussionId)).toEqual({ kind: 'refused', code: 'unavailable' });
      unwrap(await hideMessage(world, moderator, roomId, discussionId, view.messages[0]!.messageId, false));
      expect(await personPosts(roomId, ravi)).toHaveLength(1);
    });

    it('lists no post by someone the reader blocked and takes no vote on it, with the same counts for everyone else', async () => {
      const reel = await libraryReel(world.db, 'A blocked author');
      const { roomId, people } = await scene(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const discussionId = await posted(asha, roomId, assetLink(reel));
      unwrap(await votePost(world, kenji, roomId, discussionId));
      unwrap(await votePost(world, lena, roomId, discussionId));
      unwrap(await friendCommand(world.friends, ravi, asha, 'block'));
      expect(await postsOf(roomId, ravi)).toEqual([]);
      expect(await votePost(world, ravi, roomId, discussionId)).toEqual({ kind: 'refused', code: 'unavailable' });
      // The blocked person is not told, and reads the room as before; the count is nobody's but the room's.
      expect((await postsOf(roomId, asha))[0]).toMatchObject({ votes: 2 });
      expect((await postsOf(roomId, kenji))[0]).toMatchObject({ votes: 2 });
      // A vote of a person the reader blocked changes neither the count nor the order for the reader.
      unwrap(await friendCommand(world.friends, kenji, lena, 'block'));
      expect((await postsOf(roomId, kenji))[0]).toMatchObject({ votes: 2 });
    });
  });

  describe('the order of the Feed', () => {
    it('is New: the newest first, whoever posted it', async () => {
      await libraryScroll(world.db, 'A resident’s Scroll', 5);
      const reels = [await libraryReel(world.db, 'First'), await libraryReel(world.db, 'Second')];
      const { roomId, slug, people } = await scene(3);
      const [asha, ravi] = people as [Friend, Friend];
      const first = await posted(asha, roomId, assetLink(reels[0]!), 'First');
      world.clock.now = new Date(START.getTime() + HOUR);
      const second = await posted(ravi, roomId, assetLink(reels[1]!), 'Second');
      world.clock.now = new Date(START.getTime() + 2 * HOUR);
      const { look } = feedHeartbeat(world, () => find());
      expect((await look(slug)).find).toMatchObject({ kind: 'posted' });
      world.clock.now = new Date(START.getTime() + 3 * HOUR);
      const third = await posted(asha, roomId, assetLink(await libraryReel(world.db, 'Third')), 'Third');
      const order = (await postsOf(roomId, ravi, { sort: 'new' })).map((post) => post.discussionId);
      expect(order).toHaveLength(4);
      expect(order[0]).toBe(third);
      expect(order.slice(2)).toEqual([second, first]);
      expect((await postsOf(roomId, ravi, { sort: 'new' }))[1]).toMatchObject({ kind: 'find' });
    });

    it('is Top: the most votes among the posts of a window, and a post outside the window is not counted', async () => {
      const reels = [
        await libraryReel(world.db, 'Old'),
        await libraryReel(world.db, 'Middle'),
        await libraryReel(world.db, 'Recent'),
      ];
      const { roomId, people } = await scene(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const old = await posted(asha, roomId, assetLink(reels[0]!), 'Old');
      for (const voter of [ravi, kenji, lena]) unwrap(await votePost(world, voter, roomId, old));
      world.clock.now = new Date(START.getTime() + 10 * 24 * HOUR);
      const middle = await posted(ravi, roomId, assetLink(reels[1]!), 'Middle');
      unwrap(await votePost(world, kenji, roomId, middle));
      unwrap(await votePost(world, lena, roomId, middle));
      world.clock.now = new Date(START.getTime() + 10 * 24 * HOUR + 6 * HOUR);
      const recent = await posted(kenji, roomId, assetLink(reels[2]!), 'Recent');
      unwrap(await votePost(world, lena, roomId, recent));
      const ids = async (window: 'day' | 'week' | 'month' | 'all') =>
        (await postsOf(roomId, asha, { sort: 'top', window })).map((post) => post.discussionId);
      expect(await ids('all')).toEqual([old, middle, recent]);
      expect(await ids('month')).toEqual([old, middle, recent]);
      expect(await ids('week')).toEqual([middle, recent]);
      expect(await ids('day')).toEqual([middle, recent]);
      world.clock.now = new Date(START.getTime() + 10 * 24 * HOUR + 40 * HOUR);
      expect(await ids('day')).toEqual([]);
      expect(await ids('week')).toEqual([middle, recent]);
      expect((await readFeed(world, asha, roomId, { sort: 'top', window: 'week' })).window).toBe('week');
    });

    it('is Hot by default: votes decayed by age, so a voted post stays up and a fresh one is seen', async () => {
      const reels = [
        await libraryReel(world.db, 'Voted'),
        await libraryReel(world.db, 'Fresh'),
        await libraryReel(world.db, 'Stale'),
      ];
      const { roomId, people } = await scene(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const stale = await posted(asha, roomId, assetLink(reels[2]!), 'Stale');
      world.clock.now = new Date(START.getTime() + 24 * HOUR);
      const voted = await posted(asha, roomId, assetLink(reels[0]!), 'Voted');
      for (const voter of [ravi, kenji, lena]) unwrap(await votePost(world, voter, roomId, voted));
      world.clock.now = new Date(START.getTime() + 26.5 * HOUR);
      const fresh = await posted(ravi, roomId, assetLink(reels[1]!), 'Fresh');
      const hot = (await readFeed(world, asha, roomId)).posts.map((post) => post.discussionId);
      expect((await readFeed(world, asha, roomId)).sort).toBe('hot');
      // Three votes at two and a half hours keep a post above one just made with none; the day-old post with none is last.
      expect(hot).toEqual([voted, fresh, stale]);
      expect((await postsOf(roomId, asha, { sort: 'new' })).map((post) => post.discussionId)).toEqual([
        fresh,
        voted,
        stale,
      ]);
      // The same posts, a week later: age has brought the voted post below one that is new.
      world.clock.now = new Date(START.getTime() + 8 * 24 * HOUR);
      const newest = await posted(kenji, roomId, assetLink(await libraryReel(world.db, 'Newest')), 'Newest');
      expect((await readFeed(world, asha, roomId)).posts[0]!.discussionId).toBe(newest);
    });

    it('is the same order for every reader: a block removes a post from one reader’s list and moves no other', async () => {
      const reels = [await libraryReel(world.db, 'A'), await libraryReel(world.db, 'B')];
      const { roomId, people } = await scene(4);
      const [asha, ravi, kenji, lena] = people as [Friend, Friend, Friend, Friend];
      const a = await posted(asha, roomId, assetLink(reels[0]!), 'A');
      const b = await posted(ravi, roomId, assetLink(reels[1]!), 'B');
      unwrap(await votePost(world, kenji, roomId, a));
      unwrap(await votePost(world, lena, roomId, a));
      unwrap(await votePost(world, kenji, roomId, b));
      const before = (await postsOf(roomId, lena)).map((post) => post.discussionId);
      unwrap(await friendCommand(world.friends, kenji, asha, 'block'));
      expect((await postsOf(roomId, lena)).map((post) => post.discussionId)).toEqual(before);
      expect((await postsOf(roomId, kenji)).map((post) => post.discussionId)).toEqual([b]);
    });

    it('offers no Rising, and refuses a sort or a window it does not know', async () => {
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      for (const bad of [{ sort: 'rising' }, { window: 'year' }, { sort: 'top', window: 'hour' }])
        expect(await world.rooms.feed(asha.authority, { version, readId: randomUUID(), roomId, ...bad })).toEqual({
          kind: 'refused',
          code: 'invalid_input',
        });
    });

    it('is at most thirty posts, whatever the sort', async () => {
      const { roomId, people } = await scene(2);
      const [asha] = people as [Friend];
      const author = people[1]!;
      for (let index = 0; index < 33; index++) {
        const discussionId = randomUUID();
        await sql`insert into rooms.discussions (discussion_id, room_id, title, kind, person_post, started_by_account_id,
            source_url, last_sequence, last_change_sequence, last_activity_at, created_at)
          values (${discussionId}::uuid, ${roomId}::uuid, ${`Bulk ${String(index)}`}, 'find', true, ${author.accountId}::uuid,
            ${`https://example.org/bulk/${String(index)}`}, 1, 1, ${new Date(START.getTime() + index * 60_000)},
            ${new Date(START.getTime() + index * 60_000)})`.execute(world.db);
        await sql`insert into rooms.messages (discussion_id, sequence, message_id, change_sequence, command_id, author_kind,
            author_account_id, body_text, recorded_at)
          values (${discussionId}::uuid, 1, ${randomUUID()}::uuid, 1, ${randomUUID()}::uuid, 'person',
            ${author.accountId}::uuid, 'Words', ${new Date(START.getTime() + index * 60_000)})`.execute(world.db);
      }
      world.clock.now = new Date(START.getTime() + 2 * HOUR);
      for (const sort of ['hot', 'new', 'top'] as const)
        expect((await postsOf(roomId, asha, { sort, window: 'all' })).length, sort).toBe(30);
    });
  });

  describe('what the reader’s AI level changes', () => {
    it('lists a reader whose AI is Off every post a member made and no find a resident posted, and folds a find’s note for Quieter', async () => {
      await libraryScroll(world.db, 'A Scroll for the levels', 10);
      const reel = await libraryReel(world.db, 'A Reel a member posts');
      const { roomId, slug, people } = await scene(3);
      const [asha, ravi, kenji] = people as [Friend, Friend, Friend];
      await posted(asha, roomId, assetLink(reel));
      const { look } = feedHeartbeat(world, () => find());
      world.clock.now = new Date(START.getTime() + HOUR);
      expect((await look(slug)).find).toMatchObject({ kind: 'posted' });
      unwrap(await setPreferences(world, ravi, roomId, { aiLevel: 'off' }));
      unwrap(await setPreferences(world, kenji, roomId, { aiLevel: 'quieter' }));
      expect((await postsOf(roomId, ravi)).map((post) => post.kind)).toEqual(['post']);
      const quieter = await postsOf(roomId, kenji, { sort: 'new' });
      expect(quieter.map((post) => post.kind)).toEqual(['find', 'post']);
      expect(quieter[0]).toMatchObject({ folded: true });
      expect(quieter[0]).not.toHaveProperty('note');
      expect(quieter[1]).toHaveProperty('words');
      expect((await postsOf(roomId, asha, { sort: 'new' }))[0]).toHaveProperty('note');
    });
  });

  describe('leaving, removal, Clear and deletion', () => {
    it('deletes a member’s votes when they leave or are removed, and keeps what they posted', async () => {
      const reels = [await libraryReel(world.db, 'One'), await libraryReel(world.db, 'Two')];
      const { roomId, slug, people } = await scene(4);
      const [asha, ravi, kenji, moderator] = people as [Friend, Friend, Friend, Friend];
      await makeModerator(world, slug, moderator);
      const one = await posted(asha, roomId, assetLink(reels[0]!));
      const two = await posted(ravi, roomId, assetLink(reels[1]!));
      for (const voter of [ravi, kenji]) unwrap(await votePost(world, voter, roomId, one));
      unwrap(await votePost(world, kenji, roomId, two));
      unwrap(await world.rooms.leave(ravi.authority, { version, commandId: randomUUID(), roomId }));
      expect((await postsOf(roomId, asha, { sort: 'new' })).map((post) => [post.discussionId, post.votes])).toEqual([
        [two, 1],
        [one, 1],
      ]);
      unwrap(
        await world.rooms.moderate(moderator.authority, {
          version,
          commandId: randomUUID(),
          roomId,
          action: { kind: 'remove_member', personId: kenji.person.personId },
        }),
      );
      expect((await postsOf(roomId, asha, { sort: 'new' })).map((post) => [post.discussionId, post.votes])).toEqual([
        [two, 0],
        [one, 0],
      ]);
      // What the person who left posted stays with the room, as their messages do.
      expect(await personPosts(roomId, asha)).toHaveLength(2);
    });

    describe('with the real account lifecycle', () => {
      async function namedPerson(): Promise<Friend> {
        const person = await recordingPerson(database);
        const set = await world.friends.setProfile(person.authority, {
          version: 'sharing.v1',
          commandId: randomUUID(),
          expectedProfileRevision: 0,
          handle: `ci.${person.accountId.replaceAll('-', '').slice(0, 14)}`,
          displayName: 'Fixture person',
        });
        if (set.kind !== 'ok') throw new Error('profile refused');
        const read = await world.friends.readProfile(person.authority);
        if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('profile unreadable');
        return { ...person, person: read.value.person };
      }
      const deleteAccount = async (person: Friend) => {
        const receiptId = randomUUID();
        const deleting = deleteAccountFor(database.db, boss, {
          eraseAccountData: eraseCurrentAccount,
          lockTimeoutMs: 5_000,
        });
        expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
        expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      };

      /** The person's real, sealed Clear of exploration history (epoch 1 to 2). */
      async function clearExploration(person: Friend) {
        const installer = createBoss(database.settings, 'install', {
          onError: () => undefined,
          onWarning: () => undefined,
        });
        await installer.start();
        try {
          await applyQueueDeclarations(installer, [clearExplorationQueue, recoverClearOperationsQueue]);
          const use = clearExplorationFor(database.db, installer, {
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
          await installer.stop({ graceful: false });
        }
      }

      it('keeps a member’s posts and votes through a Clear of exploration history: they are conversation and hold no reading', async () => {
        const author = await namedPerson();
        const voter = await namedPerson();
        const { roomId } = await seedRoom(world);
        for (const person of [author, voter]) unwrap(await joinRoom(world, person, roomId));
        const mine = await posted(voter, roomId, sourceLink('https://example.org/clear-mine'), 'A post the voter made');
        const theirs = await posted(
          author,
          roomId,
          sourceLink('https://example.org/clear-theirs'),
          'A post the voter voted on',
        );
        unwrap(await votePost(world, voter, roomId, theirs));
        await clearExploration(voter);
        expect(roomsErasure.clearExploration?.dispositions['rooms.post_votes']).toBe('preserve');
        expect(roomsErasure.clearExploration?.dispositions['rooms.discussions']).toBe('preserve');
        expect((await votesIn(roomId)).map((row) => [row.discussion_id, row.account_id])).toEqual([
          [theirs, voter.accountId],
        ]);
        const listed = (await personPosts(roomId, author, { sort: 'new' })).map((post) => post.discussionId);
        expect([...listed].sort()).toEqual([theirs, mine].sort());
      });

      it('exports a member’s own posts and votes, and in no one else’s file', async () => {
        const author = await namedPerson();
        const voter = await namedPerson();
        const { roomId } = await seedRoom(world);
        for (const person of [author, voter]) unwrap(await joinRoom(world, person, roomId));
        const discussionId = await posted(author, roomId, sourceLink('https://example.org/exported'), 'Exported words');
        unwrap(await votePost(world, voter, roomId, discussionId));
        const exportOf = async (person: Friend) => {
          const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(
            person.authority,
            (scope) => exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
          );
          if (exported.kind !== 'entered') throw new Error('export refused');
          return JSON.stringify(exported.value.sections['rooms']);
        };
        const mine = await exportOf(author);
        expect(mine).toContain('Exported words');
        expect(mine).toContain('https://example.org/exported');
        const theirs = await exportOf(voter);
        expect(theirs).toContain('"postVotes":[{');
        expect(theirs).not.toContain('Exported words');
        expect(theirs).not.toContain('https://example.org/exported');
        // A person who never voted has an empty list of votes, and the author's own words are in their own file only.
        expect(mine).toContain('"postVotes":[]');
      });

      it('deletes the votes of a deleted account and of a deleted author’s post, tombstones the post and takes its words and source with it', async () => {
        const author = await namedPerson();
        const voter = await namedPerson();
        const staying = await seedFriend(world.db, world.friends);
        const { roomId } = await seedRoom(world);
        for (const person of [author, voter, staying]) unwrap(await joinRoom(world, person, roomId));
        const reel = await libraryReel(world.db, 'Deleted author');
        const sourced = await posted(
          author,
          roomId,
          sourceLink('https://example.org/deleted-author'),
          'Words that will go',
        );
        const asset = await posted(author, roomId, assetLink(reel), 'Another headline that will go');
        const others = await posted(staying, roomId, sourceLink('https://example.org/staying'), 'Words that stay');
        for (const discussionId of [sourced, asset, others]) unwrap(await votePost(world, voter, roomId, discussionId));
        unwrap(await votePost(world, staying, roomId, sourced));
        unwrap(await say(world, staying, roomId, sourced, 'A reply that stays'));
        await deleteAccount(author);
        expect(await postsOf(roomId, staying)).toHaveLength(1);
        expect((await postsOf(roomId, staying))[0]).toMatchObject({ discussionId: others, votes: 1 });
        const rows = await world.db
          .selectFrom('rooms.discussions')
          .select(['discussion_id', 'title', 'source_url', 'started_by_account_id', 'person_post', 'root_asset_id'])
          .where('discussion_id', 'in', [sourced, asset])
          .execute();
        for (const row of rows) {
          expect(row).toMatchObject({
            title: 'A post from a deleted account',
            source_url: null,
            started_by_account_id: null,
            person_post: true,
          });
        }
        expect(JSON.stringify(rows)).not.toContain('will go');
        // Votes on the deleted author's posts went with them; the staying voter's vote on the other post is the voter's own.
        expect((await votesIn(roomId)).map((row) => [row.discussion_id, row.account_id])).toEqual([
          [others, voter.accountId],
        ]);
        // What others wrote under the post stays, with the post's first message gone.
        const view = await readDiscussion(world, staying, roomId, sourced);
        if (view.status !== 'ready') throw new Error('expected ready');
        expect(view.messages.map((message) => message.status)).toEqual(['unavailable', 'available']);
        expect(JSON.stringify(view)).not.toContain('Words that will go');
        expect(JSON.stringify(view)).not.toContain('deleted-author');
        await deleteAccount(voter);
        expect(await votesIn(roomId)).toEqual([]);
      });
    });
  });
});
