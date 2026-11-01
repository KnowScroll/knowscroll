import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type RoomFeedPost } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  createRoomFeed,
  emptyFeedWords,
  feedChip,
  findKindWord,
  findTitleWords,
  memoryWords,
  rhythmLines,
} from './room-feed';

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
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

const card = (kind: 'reel' | 'scroll'): RoomFeedPost['content'] => ({
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
  posts: [],
  residents: [],
  memory: { state: 'none' },
  canEditMemory: true,
  aiLevel: 'lively',
  limits: { postsPerDay: 3, restHours: 6 },
  ...over,
});

describe('the words of the feed', () => {
  it('names what a find is about and survives its withdrawal', () => {
    expect(findKindWord({ content: card('reel') })).toBe('Reel');
    expect(findKindWord({ content: card('scroll') })).toBe('Scroll');
    expect(findTitleWords({ content: card('reel') })).toBe('Light that bends');
    const gone = { content: { status: 'unavailable', target: { assetId: id(20), assetRevision: 1 } } } as const;
    expect(findKindWord(gone)).toBe('Gone from the library');
    expect(findTitleWords(gone)).toBe('This is no longer in the library');
  });

  it('draws the Now strip chip with who found something and how long ago, never a count', () => {
    const now = new Date('2026-11-01T11:07:00.000Z');
    expect(feedChip(undefined, now)).toBeUndefined();
    expect(feedChip({ by: NOVA, postedAt: '2026-11-01T09:07:00.000Z' }, now)).toEqual({
      label: 'Feed',
      detail: 'Nova found something · 2 h ago',
    });
  });

  it('says the rhythm from the server’s own numbers', () => {
    expect(rhythmLines({ postsPerDay: 3, restHours: 6 })).toEqual({
      checksIn: 'Looks at the room about 3 times a day',
      posts: 'Each posts at most once every 6 hours',
    });
  });

  it('is honest about an empty feed, and says why for a reader whose residents are off', () => {
    expect(emptyFeedWords('lively').title).toBe('Nothing new right now');
    expect(emptyFeedWords('quieter').title).toBe('Nothing new right now');
    expect(emptyFeedWords('off').title).toBe('Residents are off for you');
  });

  it('shows the memory when there is one and nothing when there is not', () => {
    expect(memoryWords({ state: 'none' })).toBeUndefined();
    expect(memoryWords({ state: 'ready', text: 'People compared tides.', by: 'residents' })).toBe(
      'People compared tides.',
    );
  });
});

describe('one room’s feed', () => {
  it('reads the feed and keeps the answer', async () => {
    const scope = scopeOf({ feed: () => Promise.resolve(ready()) });
    const feed = createRoomFeed({ scope, roomId, newId });
    expect(feed.getState().phase).toBe('loading');
    await feed.load();
    expect(feed.getState()).toMatchObject({ phase: 'ready', offline: false });
    expect(scope.calls[0]).toMatchObject({ name: 'feed', input: { version: 'rooms.v1', roomId } });
  });

  it('says unavailable, without saying why, for a refusal', async () => {
    const feed = createRoomFeed({ scope: scopeOf({ feed: () => Promise.reject(refused()) }), roomId, newId });
    await feed.load();
    expect(feed.getState()).toMatchObject({ phase: 'unavailable', view: undefined });
    const gone = createRoomFeed({
      scope: scopeOf({
        feed: () =>
          Promise.resolve({
            version: 'rooms.v1',
            readId: id(7),
            scope: { accountId: id(9), privacyEpoch: 1 },
            status: 'unavailable',
          }),
      }),
      roomId,
      newId,
    });
    await gone.load();
    expect(gone.getState().phase).toBe('unavailable');
  });

  it('fails when it cannot reach the server at first, and keeps what it had when it cannot later', async () => {
    let reachable = false;
    const feed = createRoomFeed({
      scope: scopeOf({ feed: () => (reachable ? Promise.resolve(ready()) : Promise.reject(new Error('network'))) }),
      roomId,
      newId,
    });
    await feed.load();
    expect(feed.getState()).toMatchObject({ phase: 'failed', offline: true });
    reachable = true;
    await feed.load();
    expect(feed.getState().phase).toBe('ready');
    reachable = false;
    await feed.load();
    expect(feed.getState()).toMatchObject({ phase: 'ready', offline: true });
  });

  it('replaces what the residents remember, then reads again', async () => {
    let memory: unknown = { state: 'none' };
    const scope = scopeOf({
      feed: () => Promise.resolve(ready({ memory })),
      replaceMemory: (input) => {
        memory = { state: 'ready', text: (input as { text: string }).text, by: 'moderator' };
        return Promise.resolve({});
      },
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.replaceMemory('Beginners are welcome.')).toBe(true);
    expect(feed.getState().view?.memory).toEqual({ state: 'ready', text: 'Beginners are welcome.', by: 'moderator' });
    expect(scope.calls.map((call) => call.name)).toEqual(['feed', 'replaceMemory', 'feed']);
  });

  it('clears the memory with null, and says plainly when the server refused', async () => {
    const scope = scopeOf({
      feed: () => Promise.resolve(ready()),
      replaceMemory: () => Promise.reject(refused()),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.replaceMemory(null)).toBe(false);
    expect(scope.calls.find((call) => call.name === 'replaceMemory')?.input).toMatchObject({ text: null });
    expect(feed.getState().refused).toBe(true);
    // The feed is read again, so the screen shows how it stands now.
    expect(scope.calls.at(-1)?.name).toBe('feed');
  });

  it('sends the same command again after an unknown outcome, so a retry never makes a second edit', async () => {
    let attempt = 0;
    const scope = scopeOf({
      feed: () => Promise.resolve(ready()),
      replaceMemory: () => (attempt++ === 0 ? Promise.reject(new Error('network')) : Promise.resolve({})),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.replaceMemory('Same words.')).toBe(false);
    expect(feed.getState().offline).toBe(true);
    expect(await feed.replaceMemory('Same words.')).toBe(true);
    const sent = scope.calls
      .filter((call) => call.name === 'replaceMemory')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(new Set(sent).size).toBe(1);
  });
});
