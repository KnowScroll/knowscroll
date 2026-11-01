import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type RoomScout } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  createRoomFeed,
  feedAuthorName,
  liveChips,
  scoutCadenceWords,
  scoutDraftOf,
  scoutSignature,
  scoutStatusWords,
  toggleInterest,
} from './room-feed';

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const ASHA = { kind: 'person', personId: id(2), handle: 'asha', displayName: 'Asha' } as const;
const SCOUT = { kind: 'agent', sentBy: ASHA, label: 'AI · Scout' } as const;
const NOVA = { kind: 'ai', inhabitant: 'explainer', name: 'Nova', label: 'AI · Explainer' } as const;
const choices = [
  { id: 'a', label: 'Attention' },
  { id: 'b', label: 'Training' },
];
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

const ready = (scout: RoomScout) => ({
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
  scout,
});
const on = (over: Partial<Extract<RoomScout, { state: 'on' }>> = {}): RoomScout => ({
  state: 'on',
  choices,
  interests: ['a'],
  cadence: 'daily',
  paused: false,
  stopped: false,
  ...over,
});

describe('who a find is by, in words', () => {
  it('signs a scout’s find with its owner’s name and a resident’s with none', () => {
    expect(feedAuthorName(NOVA)).toBe('Nova');
    expect(feedAuthorName(SCOUT)).toBe('Asha’s scout');
    expect(scoutSignature(SCOUT)).toBe('Sent by Asha');
    expect(scoutSignature(NOVA)).toBeUndefined();
  });

  it('puts a scout in the Now strip as the owner’s scout, never as the owner', () => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    expect(
      liveChips([{ kind: 'posted', by: SCOUT, at: '2026-11-04T08:37:00.000Z', discussionId: id(3) }], now),
    ).toEqual([{ key: `posted:${id(3)}`, label: 'Asha’s scout', detail: 'posted · 1 h ago', discussionId: id(3) }]);
  });
});

describe('a scout’s sheet', () => {
  it('opens empty for a member with none, and as it stands for one who sent it', () => {
    expect(scoutDraftOf({ state: 'none', choices })).toEqual({ interests: [], cadence: 'daily', paused: false });
    expect(scoutDraftOf(on({ interests: ['b'], cadence: 'weekly', paused: true }))).toEqual({
      interests: ['b'],
      cadence: 'weekly',
      paused: true,
    });
    expect(scoutCadenceWords).toEqual({ daily: 'Once a day', weekly: 'Once a week' });
  });

  it('ticks and unticks topics, and never past the most a scout may look in', () => {
    let draft = scoutDraftOf({ state: 'none', choices });
    draft = toggleInterest(draft, 'a', 2);
    draft = toggleInterest(draft, 'b', 2);
    draft = toggleInterest(draft, 'c', 2);
    expect(draft.interests).toEqual(['a', 'b']);
    expect(toggleInterest(draft, 'a', 2).interests).toEqual(['b']);
  });

  it('says what the scout is doing without ever saying it read or watched anything', () => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    expect(scoutStatusWords({ state: 'none', choices }, now)).toBe('No scout sent to this room yet.');
    expect(scoutStatusWords(on(), now)).toBe('Looking. It has not posted here yet.');
    expect(scoutStatusWords(on({ lastPostedAt: '2026-11-04T08:00:00.000Z' }), now)).toBe(
      'Looking. It last posted here 2 h ago.',
    );
    expect(scoutStatusWords(on({ paused: true }), now)).toContain('Paused. It posts nothing until you start it again.');
    expect(scoutStatusWords(on({ stopped: true }), now)).toContain('A moderator stopped your scout');
    // While recording is paused it says so, and never that the scout is looking; a moderator's stop is told first.
    expect(scoutStatusWords(on({ recordingPaused: true }), now)).toBe(
      'Recording is paused, so your scout posts nothing. It looks again when you turn recording back on.',
    );
    expect(scoutStatusWords(on({ recordingPaused: true }), now)).not.toContain('Looking');
    expect(scoutStatusWords(on({ recordingPaused: true, stopped: true }), now)).toContain('A moderator stopped');
    for (const scout of [on(), on({ paused: true }), on({ stopped: true }), on({ recordingPaused: true })])
      expect(scoutStatusWords(scout, now)).not.toMatch(/\b(watched|read)\b/);
  });
});

describe('sending a scout', () => {
  it('sends the member’s own choice, once per intent, and reads the feed again', async () => {
    let scout: RoomScout = { state: 'none', choices };
    const scope = scopeOf({
      feed: () => Promise.resolve(ready(scout)),
      setScout: (input: { scout: { interests: string[]; cadence: 'daily' | 'weekly'; paused: boolean } | null }) => {
        scout = input.scout === null ? { state: 'none', choices } : on(input.scout);
        return Promise.resolve({ outcome: 'accepted' });
      },
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.setScout({ interests: ['a'], cadence: 'weekly', paused: false })).toBe(true);
    expect(scope.calls.find((call) => call.name === 'setScout')?.input).toMatchObject({
      version: 'rooms.v1',
      roomId,
      scout: { interests: ['a'], cadence: 'weekly', paused: false },
    });
    expect(feed.getState().view?.scout).toMatchObject({ state: 'on', interests: ['a'], cadence: 'weekly' });
    expect(await feed.setScout(null)).toBe(true);
    expect(feed.getState().view?.scout).toMatchObject({ state: 'none' });
    expect(feed.getState()).toMatchObject({ working: false, refused: false });
  });

  it('shows a refusal and how the room stands now', async () => {
    const scope = scopeOf({
      feed: () => Promise.resolve(ready({ state: 'none', choices })),
      setScout: () => Promise.reject(refused()),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.setScout({ interests: ['a'], cadence: 'daily', paused: false })).toBe(false);
    expect(feed.getState()).toMatchObject({ refused: true, working: false });
    expect(scope.calls.filter((call) => call.name === 'feed')).toHaveLength(2);
  });

  it('lets a moderator stop a scout or let it post again, by the person it was sent by', async () => {
    const scope = scopeOf({
      feed: () => Promise.resolve(ready({ state: 'none', choices })),
      moderate: () => Promise.resolve({ outcome: 'accepted' }),
    });
    const feed = createRoomFeed({ scope, roomId, newId });
    await feed.load();
    expect(await feed.stopScout(id(2), true)).toBe(true);
    expect(await feed.stopScout(id(2), false)).toBe(true);
    expect(scope.calls.filter((call) => call.name === 'moderate').map((call) => call.input)).toMatchObject([
      { roomId, action: { kind: 'stop_scout', personId: id(2) } },
      { roomId, action: { kind: 'allow_scout', personId: id(2) } },
    ]);
  });
});
