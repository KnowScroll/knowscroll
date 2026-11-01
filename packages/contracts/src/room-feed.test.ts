import { describe, expect, it } from 'vitest';
import {
  ROOM_FEED_POSTS_MAX,
  ROOM_FIND_NOTE_MAX_CHARS,
  ROOM_MEMORY_MAX_CHARS,
  ReplaceRoomMemorySchema,
  RoomFeedPostSchema,
  RoomFeedSchema,
  RoomFeedStripSchema,
  RoomMemoryReplacementSchema,
  RoomMemorySchema,
  RoomMessageSchema,
  roomsContract,
} from './rooms.js';
import { ROOM_KIT_VERSION } from './room-identity.js';

const kit = {
  version: ROOM_KIT_VERSION,
  palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
  emblem: { frame: 'circle', glyph: 'ringed-planet' },
  motif: 'constellation',
  motion: 'twinkle',
  cast: { explainer: 'star', skeptic: 'hourglass' },
};
const ID = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOVA = { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' } as const;
const SCOPE = { accountId: ID(9), privacyEpoch: 1 };
const card = {
  status: 'available',
  target: { assetId: ID(20), assetRevision: 1 },
  metadata: {
    kind: 'reel',
    title: 'Light that bends',
    summary: 'A galaxy cluster bends the light behind it.',
    language: 'en',
  },
} as const;
const PERSON = { kind: 'person', personId: ID(1), displayName: 'Asha', handle: 'asha' } as const;
const post = {
  kind: 'find',
  discussionId: ID(3),
  votes: 14,
  youVoted: false,
  canVote: true,
  author: NOVA,
  postedAt: '2026-11-01T09:07:00.000Z',
  content: card,
  note: 'Worth a look: the arc near the middle is the far galaxy, stretched.',
  replies: 2,
};

describe('a resident’s find in the feed (v3 R-8, D-248)', () => {
  it('has a resident author, a card for a real asset and a note', () => {
    expect(RoomFeedPostSchema.safeParse(post).success).toBe(true);
  });

  it('cannot be drawn without the AI label, or as a person', () => {
    expect(RoomFeedPostSchema.safeParse({ ...post, author: { ...NOVA, label: 'Explainer' } }).success).toBe(false);
    expect(
      RoomFeedPostSchema.safeParse({
        ...post,
        author: { kind: 'person', person: PERSON, you: false },
      }).success,
    ).toBe(false);
  });

  it('has no find without its card', () => {
    const { content: _content, ...withoutCard } = post;
    expect(RoomFeedPostSchema.safeParse(withoutCard).success).toBe(false);
  });

  it('holds the note back exactly when it is folded', () => {
    const { note: _note, ...withoutNote } = post;
    expect(RoomFeedPostSchema.safeParse({ ...withoutNote, folded: true }).success).toBe(true);
    expect(RoomFeedPostSchema.safeParse(withoutNote).success).toBe(false);
    expect(RoomFeedPostSchema.safeParse({ ...post, folded: true }).success).toBe(false);
  });

  it('keeps the note short', () => {
    const long = 'a'.repeat(ROOM_FIND_NOTE_MAX_CHARS + 1);
    expect(RoomFeedPostSchema.safeParse({ ...post, note: long }).success).toBe(false);
  });

  it('shows a find whose asset was withdrawn as unavailable, still with its target', () => {
    const unavailable = { status: 'unavailable', target: { assetId: ID(20), assetRevision: 1 } };
    expect(RoomFeedPostSchema.safeParse({ ...post, content: unavailable }).success).toBe(true);
  });
});

describe('what the residents remember (v3 R-8, D-247)', () => {
  it('says nothing, or says a bounded text and who wrote it', () => {
    expect(RoomMemorySchema.safeParse({ state: 'none' }).success).toBe(true);
    expect(
      RoomMemorySchema.safeParse({ state: 'ready', text: 'People compared tides.', by: 'residents' }).success,
    ).toBe(true);
    expect(RoomMemorySchema.safeParse({ state: 'ready', text: 'x', by: 'a moderator' }).success).toBe(false);
    expect(RoomMemorySchema.safeParse({ state: 'ready', text: '', by: 'residents' }).success).toBe(false);
    expect(
      RoomMemorySchema.safeParse({ state: 'ready', text: 'x'.repeat(ROOM_MEMORY_MAX_CHARS + 1), by: 'residents' })
        .success,
    ).toBe(false);
  });

  it('is replaced or cleared by a command with a bounded text and nothing else', () => {
    const base = { version: 'rooms.v1', commandId: ID(5), roomId: ID(1) };
    expect(ReplaceRoomMemorySchema.safeParse({ ...base, text: 'We talk about tides.' }).success).toBe(true);
    expect(ReplaceRoomMemorySchema.safeParse({ ...base, text: null }).success).toBe(true);
    expect(ReplaceRoomMemorySchema.safeParse({ ...base, text: '' }).success).toBe(false);
    expect(ReplaceRoomMemorySchema.safeParse({ ...base, text: 'ok', aiLevel: 'off' }).success).toBe(false);
    expect(
      RoomMemoryReplacementSchema.safeParse({
        version: 'rooms.v1',
        scope: SCOPE,
        commandId: ID(5),
        recordedAt: '2026-11-01T09:07:00.000Z',
        replayed: false,
        outcome: 'accepted',
        operation: 'room.memory-replace',
        roomId: ID(1),
        memory: { state: 'none' },
      }).success,
    ).toBe(true);
  });
});

describe('the feed a member reads', () => {
  const ready = {
    version: 'rooms.v1',
    readId: ID(7),
    scope: SCOPE,
    status: 'ready',
    roomId: ID(1),
    identity: { kit },
    posts: [post],
    residents: [{ inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer', blurb: 'Answers when asked' }],
    memory: { state: 'none' },
    canEditMemory: false,
    aiLevel: 'lively',
    sort: 'hot',
    window: 'week',
    canPost: true,
    limits: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
  };

  it('is a bounded window of finds with the rules residents post by', () => {
    expect(RoomFeedSchema.safeParse(ready).success).toBe(true);
    expect(
      RoomFeedSchema.safeParse({ ...ready, posts: Array.from({ length: ROOM_FEED_POSTS_MAX + 1 }, () => post) })
        .success,
    ).toBe(false);
    expect(RoomFeedSchema.safeParse({ ...ready, limits: { postsPerDay: 3, restHours: 6 } }).success).toBe(false);
  });

  it('answers a stranger with the one shape of a room that is not there', () => {
    expect(
      RoomFeedSchema.safeParse({ version: 'rooms.v1', readId: ID(7), scope: SCOPE, status: 'unavailable' }).success,
    ).toBe(true);
    expect(
      RoomFeedSchema.safeParse({ version: 'rooms.v1', readId: ID(7), scope: SCOPE, status: 'unavailable', posts: [] })
        .success,
    ).toBe(false);
  });

  it('has a strip that names a resident and a time and nothing about a person', () => {
    expect(RoomFeedStripSchema.safeParse({ by: NOVA, postedAt: '2026-11-01T09:07:00.000Z' }).success).toBe(true);
    expect(RoomFeedStripSchema.safeParse({ by: NOVA, postedAt: '2026-11-01T09:07:00.000Z', count: 3 }).success).toBe(
      false,
    );
  });

  it('is served by the routes of the rooms contract, with a post and a vote of their own', () => {
    expect(Object.keys(roomsContract)).toEqual(
      expect.arrayContaining(['feed', 'replaceMemory', 'postFind', 'votePost']),
    );
  });

  it('lets a find note be a message of its own kind that a reader’s level can fold', () => {
    const message = {
      messageId: ID(11),
      sequence: 1,
      status: 'available',
      author: NOVA,
      recordedAt: '2026-11-01T09:07:00.000Z',
      body: { kind: 'text', text: post.note },
      suggestion: 'find',
      trigger: 'feed_find',
    };
    expect(RoomMessageSchema.safeParse(message).success).toBe(true);
    expect(RoomMessageSchema.safeParse({ ...message, suggestion: 'a find' }).success).toBe(false);
  });
});
