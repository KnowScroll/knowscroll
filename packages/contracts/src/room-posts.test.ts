import { describe, expect, it } from 'vitest';
import {
  PostRoomFindSchema,
  ROOM_POST_TITLE_MAX_CHARS,
  ROOM_POST_WORDS_MAX_CHARS,
  ROOM_SOURCE_MAX_CHARS,
  RoomFindPostedAcceptanceSchema,
  RoomPostVoteAcceptanceSchema,
  VoteRoomPostSchema,
} from './room-posts.js';
import { ReadRoomFeedSchema, RoomFeedPostSchema, roomsContract } from './rooms.js';

const ID = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SCOPE = { accountId: ID(9), privacyEpoch: 1 };
const PERSON = { kind: 'person', personId: ID(1), displayName: 'Asha', handle: 'asha' } as const;
const card = {
  status: 'available',
  target: { assetId: ID(20), assetRevision: 1 },
  metadata: { kind: 'reel', title: 'Light that bends', summary: 'A cluster bends the light.', language: 'en' },
} as const;
const base = {
  kind: 'post',
  discussionId: ID(3),
  postedAt: '2026-11-01T09:07:00.000Z',
  replies: 2,
  votes: 14,
  youVoted: false,
  canVote: true,
  author: { kind: 'person', person: PERSON, you: false },
  title: 'Found a Reel on lensing',
  words: 'At 0:40 the arc is a normal galaxy far behind, stretched by mass we mostly cannot see.',
} as const;

describe('a member’s post in the Feed (v3 R-8b, D-271)', () => {
  it('links a library asset or a source, never both and never neither', () => {
    expect(RoomFeedPostSchema.safeParse({ ...base, link: { kind: 'content', content: card } }).success).toBe(true);
    expect(
      RoomFeedPostSchema.safeParse({
        ...base,
        link: { kind: 'source', source: { url: 'https://example.org/a', host: 'example.org' } },
      }).success,
    ).toBe(true);
    expect(RoomFeedPostSchema.safeParse(base).success).toBe(false);
    expect(
      RoomFeedPostSchema.safeParse({
        ...base,
        link: { kind: 'source', content: card, source: { url: 'https://example.org/a', host: 'example.org' } },
      }).success,
    ).toBe(false);
  });

  it('is by a person with a public profile, and never carries an AI label or a resident', () => {
    const link = { kind: 'content', content: card } as const;
    expect(
      RoomFeedPostSchema.safeParse({
        ...base,
        link,
        author: { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' },
      }).success,
    ).toBe(false);
    expect(
      RoomFeedPostSchema.safeParse({ ...base, link, author: { ...base.author, label: 'AI · Scout' } }).success,
    ).toBe(false);
  });

  it('has a headline and words that fit, and is never folded or held back', () => {
    const link = { kind: 'content', content: card } as const;
    expect(
      RoomFeedPostSchema.safeParse({ ...base, link, title: 'x'.repeat(ROOM_POST_TITLE_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(
      RoomFeedPostSchema.safeParse({ ...base, link, words: 'x'.repeat(ROOM_POST_WORDS_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(RoomFeedPostSchema.safeParse({ ...base, link, folded: true }).success).toBe(false);
  });

  it('shows votes as a number, and nothing that says who voted or what a person is worth', () => {
    const link = { kind: 'content', content: card } as const;
    for (const extra of [
      { voters: [PERSON] },
      { karma: 12 },
      { score: 3 },
      { rank: 1 },
      { downvotes: 1 },
      { votedBy: ['asha'] },
    ])
      expect(RoomFeedPostSchema.safeParse({ ...base, link, ...extra }).success).toBe(false);
    expect(RoomFeedPostSchema.safeParse({ ...base, link, votes: -1 }).success).toBe(false);
  });
});

describe('posting and voting (v3 R-8b, D-271 to D-273)', () => {
  const post = {
    version: 'rooms.v1',
    commandId: ID(5),
    roomId: ID(1),
    title: 'Found a Reel on lensing',
    words: 'The arc is a far galaxy.',
    link: { kind: 'content', target: { assetId: ID(20), assetRevision: 1 } },
  };

  it('is one headline, words and one link, with nothing a person could set for themselves besides', () => {
    expect(PostRoomFindSchema.safeParse(post).success).toBe(true);
    expect(
      PostRoomFindSchema.safeParse({ ...post, link: { kind: 'source', url: 'https://example.org/a' } }).success,
    ).toBe(true);
    expect(PostRoomFindSchema.safeParse({ ...post, link: undefined }).success).toBe(false);
    expect(PostRoomFindSchema.safeParse({ ...post, title: '' }).success).toBe(false);
    expect(PostRoomFindSchema.safeParse({ ...post, words: '' }).success).toBe(false);
    expect(PostRoomFindSchema.safeParse({ ...post, title: ' padded ' }).success).toBe(false);
    expect(
      PostRoomFindSchema.safeParse({
        ...post,
        link: { kind: 'source', url: 'x'.repeat(ROOM_SOURCE_MAX_CHARS * 2 + 1) },
      }).success,
    ).toBe(false);
    for (const extra of [{ authorKind: 'agent' }, { asResident: 'explainer' }, { votes: 100 }, { tag: 'question' }])
      expect(PostRoomFindSchema.safeParse({ ...post, ...extra }).success).toBe(false);
  });

  it('answers with where the post is, and whether it was made or the room already had it', () => {
    const receipt = {
      version: 'rooms.v1',
      scope: SCOPE,
      commandId: ID(5),
      recordedAt: '2026-11-01T09:07:00.000Z',
      replayed: false,
      outcome: 'accepted',
      operation: 'room.find-post',
      roomId: ID(1),
      discussionId: ID(3),
    };
    expect(RoomFindPostedAcceptanceSchema.safeParse({ ...receipt, result: 'posted' }).success).toBe(true);
    expect(RoomFindPostedAcceptanceSchema.safeParse({ ...receipt, result: 'already_there' }).success).toBe(true);
    expect(RoomFindPostedAcceptanceSchema.safeParse({ ...receipt, result: 'maybe' }).success).toBe(false);
  });

  it('votes up or takes the vote back, and the answer is a number', () => {
    const vote = { version: 'rooms.v1', commandId: ID(5), roomId: ID(1), discussionId: ID(3), voted: true };
    expect(VoteRoomPostSchema.safeParse(vote).success).toBe(true);
    expect(VoteRoomPostSchema.safeParse({ ...vote, voted: false }).success).toBe(true);
    // There is no down vote and no weight.
    expect(VoteRoomPostSchema.safeParse({ ...vote, voted: 'down' }).success).toBe(false);
    expect(VoteRoomPostSchema.safeParse({ ...vote, weight: 5 }).success).toBe(false);
    const receipt = {
      version: 'rooms.v1',
      scope: SCOPE,
      commandId: ID(5),
      recordedAt: '2026-11-01T09:07:00.000Z',
      replayed: false,
      outcome: 'accepted',
      operation: 'room.post-vote',
      roomId: ID(1),
      discussionId: ID(3),
      voted: true,
      votes: 3,
    };
    expect(RoomPostVoteAcceptanceSchema.safeParse(receipt).success).toBe(true);
    expect(RoomPostVoteAcceptanceSchema.safeParse({ ...receipt, voters: [ID(9)] }).success).toBe(false);
  });

  it('is read in Hot, New or Top over a window, and Rising is not a sort', () => {
    const read = { version: 'rooms.v1', readId: ID(7), roomId: ID(1) };
    for (const sort of ['hot', 'new', 'top'])
      expect(ReadRoomFeedSchema.safeParse({ ...read, sort }).success).toBe(true);
    expect(ReadRoomFeedSchema.safeParse({ ...read, sort: 'rising' }).success).toBe(false);
    for (const window of ['day', 'week', 'month', 'all'])
      expect(ReadRoomFeedSchema.safeParse({ ...read, sort: 'top', window }).success).toBe(true);
    expect(ReadRoomFeedSchema.safeParse({ ...read, window: 'year' }).success).toBe(false);
    expect(ReadRoomFeedSchema.safeParse(read).success).toBe(true);
  });

  it('is served by two routes of the rooms contract', () => {
    expect(Object.keys(roomsContract)).toEqual(expect.arrayContaining(['postFind', 'votePost']));
  });
});
