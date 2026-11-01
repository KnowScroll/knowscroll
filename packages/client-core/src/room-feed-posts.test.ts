import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type ConversationContentProjection, type RoomFeedPost } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  createRoomFeed,
  emptyPostDraft,
  feedAuthorName,
  postCard,
  postDraftReady,
  postKindWord,
  postTitleWords,
  voteWords,
} from './room-feed';

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const ASHA = { kind: 'person', personId: id(2), handle: 'asha', displayName: 'Asha' } as const;
const NOVA = { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' } as const;
const refused = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(rooms: Api): AccountScope & { calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(rooms).map(([name, handler]) => [
      name,
      (input: never) => {
        calls.push({ name, input });
        return handler(input);
      },
    ]),
  );
  return { active: true, api: { rooms: wrapped }, calls } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
  };
}
let counter = 100;
const newId = () => id(counter++);

const card = (kind: 'reel' | 'scroll'): ConversationContentProjection => ({
  status: 'available',
  target: { assetId: id(20), assetRevision: 1 },
  metadata: { kind, title: 'Light that bends', summary: 'A cluster bends the light behind it.', language: 'en' },
});
const ready = (over: object = {}) => ({
  version: 'rooms.v1',
  readId: id(7),
  scope: { accountId: id(9), privacyEpoch: 1 },
  status: 'ready',
  roomId,
  identity: {},
  sort: 'hot',
  window: 'week',
  posts: [],
  canPost: true,
  residents: [],
  memory: { state: 'none' },
  canEditMemory: true,
  aiLevel: 'lively',
  limits: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
  ...over,
});
const memberPost = (over: object = {}): RoomFeedPost => ({
  kind: 'post',
  discussionId: id(30),
  postedAt: '2026-11-01T09:07:00.000Z',
  replies: 0,
  votes: 2,
  youVoted: false,
  canVote: true,
  author: { kind: 'person', person: ASHA, you: false },
  title: 'Found a Reel on lensing',
  words: 'The arc is a far galaxy.',
  link: { kind: 'content', content: card('reel') },
  ...over,
});
const sent = (scope: ReturnType<typeof scopeOf>, name: string) => scope.calls.filter((call) => call.name === name);

describe('the words of a member’s post (v3 R-8b)', () => {
  it('names a member by their own name, and the reader as You', () => {
    expect(feedAuthorName(memberPost().author)).toBe('Asha');
    expect(feedAuthorName({ kind: 'person', person: ASHA, you: true })).toBe('You');
  });

  it('says what a post links: a Reel or Scroll by its card, a Link for a source, and its headline', () => {
    expect(postKindWord(memberPost())).toBe('Reel');
    expect(postCard(memberPost())).toEqual(card('reel'));
    const sourced = memberPost({
      link: { kind: 'source', source: { url: 'https://example.org/a', host: 'example.org' } },
    });
    expect(postKindWord(sourced)).toBe('Link');
    expect(postCard(sourced)).toBeUndefined();
    expect(postTitleWords(sourced)).toBe('Found a Reel on lensing');
    const find = { kind: 'find', author: NOVA, content: card('scroll') } as unknown as RoomFeedPost;
    expect(postTitleWords(find)).toBe('Light that bends');
    expect(postKindWord(find)).toBe('Scroll');
  });

  it('says a vote in words, with how many people, never a score', () => {
    expect(voteWords({ votes: 1, youVoted: false, canVote: true })).toBe('1 vote. Vote up');
    expect(voteWords({ votes: 14, youVoted: true, canVote: true })).toBe('14 votes. You voted. Take your vote back');
    expect(voteWords({ votes: 0, youVoted: false, canVote: false })).toBe('0 votes. Your own post');
  });

  it('lets a draft be sent only when the server would take its shape', () => {
    const link = { kind: 'content', target: { assetId: id(20), assetRevision: 1 } } as const;
    const draft = { title: 'A headline', words: 'Some words.', link };
    expect(postDraftReady(emptyPostDraft)).toBe(false);
    expect(postDraftReady(draft)).toBe(true);
    expect(postDraftReady({ ...draft, link: undefined })).toBe(false);
    expect(postDraftReady({ ...draft, title: '  ' })).toBe(false);
    expect(postDraftReady({ ...draft, words: 'See https://example.com' })).toBe(false);
    expect(postDraftReady({ ...draft, title: 'x'.repeat(81) })).toBe(false);
    expect(postDraftReady({ ...draft, link: { kind: 'source', url: 'https://example.org/a' } })).toBe(true);
    expect(postDraftReady({ ...draft, link: { kind: 'source', url: 'example.org/a' } })).toBe(false);
    expect(postDraftReady({ ...draft, link: { kind: 'source', url: 'ftp://example.org/a' } })).toBe(false);
  });
});

describe('sorts, votes and posting in one room’s feed (v3 R-8b)', () => {
  it('opens in Hot over a week, and reads again in the order and the window asked for', async () => {
    const scope = scopeOf({ feed: () => Promise.resolve(ready()) });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    await feed.setSort('top');
    await feed.setWindow('month');
    expect(feed.getState()).toMatchObject({ sort: 'top', window: 'month' });
    expect(sent(scope, 'feed').map((call) => call.input)).toEqual([
      expect.objectContaining({ sort: 'hot', window: 'week' }),
      expect.objectContaining({ sort: 'top', window: 'week' }),
      expect.objectContaining({ sort: 'top', window: 'month' }),
    ]);
    // The same sort again is not another read.
    await feed.setSort('top');
    expect(sent(scope, 'feed')).toHaveLength(3);
  });

  it('votes from the answer and leaves the order where it was, so a post does not jump under a thumb', async () => {
    const posts = [memberPost({ discussionId: id(31) }), memberPost({ discussionId: id(32), votes: 0 })];
    const scope = scopeOf({
      feed: () => Promise.resolve(ready({ posts })),
      votePost: (input) =>
        Promise.resolve({ operation: 'room.post-vote', voted: (input as { voted: boolean }).voted, votes: 1 }),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.vote(id(32), true)).toBe(true);
    expect(feed.getState().view?.posts.map((post) => [post.discussionId, post.votes, post.youVoted])).toEqual([
      [id(31), 2, false],
      [id(32), 1, true],
    ]);
    // A vote does not read the whole feed again.
    expect(sent(scope, 'feed')).toHaveLength(1);
    expect(sent(scope, 'votePost')[0]?.input).toMatchObject({ roomId, discussionId: id(32), voted: true });
  });

  it('reads the feed again when a vote is refused, and says so', async () => {
    const scope = scopeOf({ feed: () => Promise.resolve(ready()), votePost: () => Promise.reject(refused()) });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.vote(id(31), true)).toBe(false);
    expect(feed.getState().refused).toBe(true);
    expect(scope.calls.at(-1)?.name).toBe('feed');
  });

  it('posts a find, then reads the feed again, and says where an existing post is', async () => {
    let result: 'posted' | 'already_there' = 'posted';
    const scope = scopeOf({
      feed: () => Promise.resolve(ready()),
      postFind: () => Promise.resolve({ operation: 'room.find-post', discussionId: id(40), result }),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    const draft = {
      title: ' A headline ',
      words: ' Some words. ',
      link: { kind: 'source', url: ' https://example.org/a ' },
    } as const;
    expect(await feed.post(draft)).toEqual({ kind: 'posted', discussionId: id(40) });
    expect(sent(scope, 'postFind')[0]?.input).toMatchObject({
      roomId,
      title: 'A headline',
      words: 'Some words.',
      link: { kind: 'source', url: 'https://example.org/a' },
    });
    expect(scope.calls.at(-1)?.name).toBe('feed');
    result = 'already_there';
    expect(await feed.post({ ...draft, title: 'Another' })).toEqual({ kind: 'already_there', discussionId: id(40) });
  });

  it('tells a post that was refused from one that waits for tomorrow, and sends nothing without a link', async () => {
    const tooMany = new ORPCError('TOO_MANY_REQUESTS', { status: 429, data: problemDetails('TOO_MANY_REQUESTS') });
    let failure: Error = tooMany;
    const scope = scopeOf({ feed: () => Promise.resolve(ready()), postFind: () => Promise.reject(failure) });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    const draft = { title: 'T', words: 'W', link: { kind: 'source', url: 'https://example.org/a' } } as const;
    expect(await feed.post(draft)).toEqual({ kind: 'rate_limited' });
    failure = refused();
    expect(await feed.post(draft)).toEqual({ kind: 'refused' });
    failure = new Error('network');
    expect(await feed.post(draft)).toEqual({ kind: 'offline' });
    expect(await feed.post({ ...draft, link: undefined })).toEqual({ kind: 'refused' });
    expect(sent(scope, 'postFind')).toHaveLength(3);
  });

  it('sends the same command again after an unknown outcome, so a retry never posts twice', async () => {
    let attempt = 0;
    const scope = scopeOf({
      feed: () => Promise.resolve(ready()),
      postFind: () =>
        attempt++ === 0
          ? Promise.reject(new Error('network'))
          : Promise.resolve({ operation: 'room.find-post', discussionId: id(40), result: 'posted' }),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    const draft = { title: 'T', words: 'W', link: { kind: 'source', url: 'https://example.org/a' } } as const;
    expect((await feed.post(draft)).kind).toBe('offline');
    expect((await feed.post(draft)).kind).toBe('posted');
    const commandIds = sent(scope, 'postFind').map((call) => (call.input as { commandId: string }).commandId);
    expect(new Set(commandIds).size).toBe(1);
  });
});
