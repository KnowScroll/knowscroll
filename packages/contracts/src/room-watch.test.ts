import { describe, expect, it } from 'vitest';
import { roomsContract } from './rooms.js';
import {
  JoinWatchSchema,
  LeaveWatchSchema,
  RoomWatchSchema,
  RoomWatchStripSchema,
  StartWatchSchema,
  StopWatchSchema,
  WATCH_COUNT_FROM,
  WatchJoinedAcceptanceSchema,
  WatchReelsSchema,
  WatchSessionViewSchema,
  WatchStartedAcceptanceSchema,
} from './room-watch.js';

const ID = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const person = { kind: 'person' as const, personId: ID(5), displayName: 'Lena', handle: 'lena' };
const reel = { assetId: ID(2), assetRevision: 1, title: 'How big is the universe?', durationMs: 70_000 };
const session = { sessionId: ID(1), reel, youIn: true, canStop: false };
const scope = { accountId: ID(9), privacyEpoch: 1 };
const read = { version: 'rooms.v1' as const, readId: ID(8), scope, status: 'ready' as const };

describe('the session a member reads (D-256)', () => {
  it('draws a session that is starting and one that is playing, on the server clock', () => {
    expect(WatchSessionViewSchema.parse({ phase: 'starting', ...session, startsInMs: 4_000 })).toBeDefined();
    expect(
      WatchSessionViewSchema.parse({ phase: 'playing', ...session, elapsedMs: 41_000, sharedBy: person }),
    ).toBeDefined();
  });

  it('has no field for anyone position, so none can be sent: a field of that kind is refused', () => {
    const playing = { phase: 'playing', ...session, elapsedMs: 41_000 };
    for (const extra of [
      { positionMs: 41_000 },
      { position: 41 },
      { viewers: [{ person, positionMs: 3_000 }] },
      { positions: {} },
      { watchers: [person] },
      { youAt: 12_000 },
    ])
      expect(WatchSessionViewSchema.safeParse({ ...playing, ...extra }).success, JSON.stringify(extra)).toBe(false);
  });

  it('says a session is over only by leaving it out: a playing view cannot be past the Reel', () => {
    expect(WatchSessionViewSchema.safeParse({ phase: 'playing', ...session, elapsedMs: 70_000 }).success).toBe(false);
    expect(WatchSessionViewSchema.safeParse({ phase: 'playing', ...session, elapsedMs: 69_999 }).success).toBe(true);
  });

  it('carries "N watching" only from three people', () => {
    const playing = { phase: 'playing', ...session, elapsedMs: 1_000 };
    expect(WATCH_COUNT_FROM).toBe(3);
    for (const watching of [0, 1, 2])
      expect(WatchSessionViewSchema.safeParse({ ...playing, watching }).success, String(watching)).toBe(false);
    for (const watching of [3, 4, 40])
      expect(WatchSessionViewSchema.safeParse({ ...playing, watching }).success, String(watching)).toBe(true);
    expect(WatchSessionViewSchema.safeParse(playing).success).toBe(true);
  });

  it('names no person beyond the one who shared it', () => {
    const playing = { phase: 'playing', ...session, elapsedMs: 1_000, watching: 4 };
    expect(WatchSessionViewSchema.safeParse({ ...playing, faces: [person] }).success).toBe(false);
    expect(
      WatchSessionViewSchema.safeParse({ ...playing, sharedBy: { ...person, personId: 'not-a-person' } }).success,
    ).toBe(false);
  });
});

describe('the stage a member reads', () => {
  it('has a live session, or a start decision and what was last on stage', () => {
    const live = RoomWatchSchema.parse({
      ...read,
      session: { phase: 'playing', ...session, elapsedMs: 5_000 },
    });
    expect(live.status === 'ready' && live.start).toBeUndefined();
    const idle = RoomWatchSchema.parse({
      ...read,
      start: { allowed: true },
      last: { kind: 'launch', at: '2026-10-31T21:30:00.000Z' },
    });
    expect(idle.status === 'ready' && idle.last?.kind).toBe('launch');
    // A Reel names itself; a Launch has no title; neither names a person.
    const last = (value: unknown) =>
      RoomWatchSchema.safeParse({ ...read, start: { allowed: true }, last: value }).success;
    expect(last({ kind: 'reel', at: '2026-10-31T21:30:00.000Z', title: 'A blanket made of gas' })).toBe(true);
    expect(last({ kind: 'reel', at: '2026-10-31T21:30:00.000Z' })).toBe(false);
    expect(last({ kind: 'launch', at: '2026-10-31T21:30:00.000Z', title: 'A blanket made of gas' })).toBe(false);
    expect(RoomWatchSchema.safeParse({ ...read, start: { allowed: false, reason: 'stage_busy' } }).success).toBe(true);
    expect(RoomWatchSchema.safeParse({ ...read, start: { allowed: false, reason: 'no_such_reason' } }).success).toBe(
      false,
    );
  });

  it('answers a stranger with one shape, naming no room, session or person', () => {
    expect(RoomWatchSchema.parse({ version: 'rooms.v1', readId: ID(8), scope, status: 'unavailable' })).toEqual({
      version: 'rooms.v1',
      readId: ID(8),
      scope,
      status: 'unavailable',
    });
    expect(
      RoomWatchSchema.safeParse({ version: 'rooms.v1', readId: ID(8), scope, status: 'unavailable', session }).success,
    ).toBe(false);
  });

  it('lists Reels with their length and nothing else', () => {
    expect(WatchReelsSchema.parse({ ...read, reels: [reel] })).toBeDefined();
    expect(WatchReelsSchema.safeParse({ ...read, reels: [{ ...reel, secret: 1 }] }).success).toBe(false);
  });

  it('gives the room view a word and no number or person', () => {
    expect(RoomWatchStripSchema.parse({ state: 'ready' })).toEqual({ state: 'ready' });
    expect(RoomWatchStripSchema.parse({ state: 'live' })).toEqual({ state: 'live' });
    expect(RoomWatchStripSchema.safeParse({ state: 'live', watching: 3 }).success).toBe(false);
  });
});

describe('the commands', () => {
  const command = { version: 'rooms.v1' as const, commandId: ID(7), roomId: ID(3) };

  it('start names the Reel and the recording generation, and join the session; no command carries a time or a position', () => {
    expect(StartWatchSchema.safeParse({ ...command, assetId: ID(2), recordingGeneration: 1 }).success).toBe(true);
    expect(StartWatchSchema.safeParse({ ...command, assetId: ID(2) }).success).toBe(false);
    expect(JoinWatchSchema.safeParse({ ...command, sessionId: ID(1), recordingGeneration: 1 }).success).toBe(true);
    for (const extra of [{ positionMs: 3_000 }, { startsAt: '2026-11-01T21:00:00.000Z' }, { elapsedMs: 5 }]) {
      expect(
        JoinWatchSchema.safeParse({ ...command, sessionId: ID(1), recordingGeneration: 1, ...extra }).success,
      ).toBe(false);
      expect(StartWatchSchema.safeParse({ ...command, assetId: ID(2), recordingGeneration: 1, ...extra }).success).toBe(
        false,
      );
    }
  });

  it('leave and stop need no recording generation, so they are always possible', () => {
    expect(LeaveWatchSchema.safeParse({ ...command, sessionId: ID(1) }).success).toBe(true);
    expect(StopWatchSchema.safeParse({ ...command, sessionId: ID(1) }).success).toBe(true);
  });

  it('answers a paused recording with not_saved and a receipt otherwise', () => {
    const base = { version: 'rooms.v1', scope, commandId: ID(7), roomId: ID(3) };
    expect(
      WatchJoinedAcceptanceSchema.parse({
        ...base,
        outcome: 'not_saved',
        operation: 'watch.join',
        reason: 'recording_paused',
      }),
    ).toBeDefined();
    expect(
      WatchStartedAcceptanceSchema.parse({
        ...base,
        outcome: 'accepted',
        operation: 'watch.start',
        recordedAt: '2026-11-01T21:00:00.000Z',
        replayed: false,
        sessionId: ID(1),
        startsInMs: 5_000,
      }),
    ).toBeDefined();
  });

  it('is served by the rooms contract under /v1/rooms/watch', () => {
    for (const name of ['watch', 'watchReels', 'startWatch', 'joinWatch', 'leaveWatch', 'stopWatch'] as const)
      expect(roomsContract[name]).toBeDefined();
  });
});
