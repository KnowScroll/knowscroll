import { WATCH_COUNT_FROM } from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import {
  COUNT_FROM,
  ENDED_KEPT_DAYS,
  LEAD_IN_MS,
  LONGEST_REEL_MS,
  SESSIONS_PER_ROOM_DAY,
  dayStartOf,
  endsAt,
  keptUntil,
  mayStop,
  phaseAt,
  startBlock,
  startsAtFrom,
  watchingShown,
  type StartFacts,
} from './watch.js';

const STARTS = new Date('2026-11-01T21:00:05.000Z');
const LENGTH = 70_000;
const at = (ms: number) => new Date(STARTS.getTime() + ms);

describe('where a session is on the server clock (D-256)', () => {
  it('is due five seconds after the command', () => {
    const started = new Date('2026-11-01T21:00:00.000Z');
    expect(startsAtFrom(started).toISOString()).toBe(STARTS.toISOString());
    expect(LEAD_IN_MS).toBe(5_000);
  });

  it('is starting until the first frame is due, playing from then, and over after the last frame', () => {
    expect(phaseAt(STARTS, LENGTH, at(-5_000))).toEqual({ kind: 'starting', startsInMs: 5_000 });
    expect(phaseAt(STARTS, LENGTH, at(-1))).toEqual({ kind: 'starting', startsInMs: 1 });
    expect(phaseAt(STARTS, LENGTH, at(0))).toEqual({ kind: 'playing', elapsedMs: 0 });
    expect(phaseAt(STARTS, LENGTH, at(41_000))).toEqual({ kind: 'playing', elapsedMs: 41_000 });
    expect(phaseAt(STARTS, LENGTH, at(LENGTH - 1))).toEqual({ kind: 'playing', elapsedMs: LENGTH - 1 });
    expect(phaseAt(STARTS, LENGTH, at(LENGTH))).toEqual({ kind: 'over' });
    expect(phaseAt(STARTS, LENGTH, at(LENGTH + 3_600_000))).toEqual({ kind: 'over' });
  });

  it('ends when the last frame is due, the same instant the phase says over', () => {
    expect(endsAt(STARTS, LENGTH).getTime()).toBe(STARTS.getTime() + LENGTH);
    expect(phaseAt(STARTS, LENGTH, endsAt(STARTS, LENGTH)).kind).toBe('over');
  });

  it('is the same on every device: the position is the server time since the start, so two devices told the same time agree', () => {
    const first = phaseAt(STARTS, LENGTH, at(12_345));
    const second = phaseAt(STARTS, LENGTH, at(12_345));
    expect(first).toEqual(second);
  });
});

describe('"N watching" (D-257)', () => {
  it('agrees with the contract on from how many', () => {
    expect(COUNT_FROM).toBe(WATCH_COUNT_FROM);
    expect(COUNT_FROM).toBe(3);
  });

  it('says no number below three, and the number from three', () => {
    expect([0, 1, 2].map(watchingShown)).toEqual([undefined, undefined, undefined]);
    expect([3, 4, 12].map(watchingShown)).toEqual([3, 4, 12]);
  });
});

describe('when a Reel may be started', () => {
  const ready: StartFacts = { roomOpen: true, stageTaken: false, hasReels: true, here: 2, startedToday: 0 };

  it('needs an open room, a free stage, a Reel, two people here and a room that has not used its day', () => {
    expect(startBlock(ready)).toBeUndefined();
    expect(startBlock({ ...ready, roomOpen: false })).toBe('room_paused');
    expect(startBlock({ ...ready, stageTaken: true })).toBe('stage_busy');
    expect(startBlock({ ...ready, hasReels: false })).toBe('no_reels');
    expect(startBlock({ ...ready, here: 1 })).toBe('few_here');
    expect(startBlock({ ...ready, startedToday: SESSIONS_PER_ROOM_DAY - 1 })).toBeUndefined();
    expect(startBlock({ ...ready, startedToday: SESSIONS_PER_ROOM_DAY })).toBe('too_many');
  });

  it('says the first reason that applies', () => {
    expect(startBlock({ roomOpen: false, stageTaken: true, hasReels: false, here: 0, startedToday: 99 })).toBe(
      'room_paused',
    );
    expect(startBlock({ roomOpen: true, stageTaken: true, hasReels: false, here: 0, startedToday: 99 })).toBe(
      'stage_busy',
    );
  });
});

describe('who may stop a session, and what is kept', () => {
  it('lets the member who shared it and a moderator stop it, and nobody else', () => {
    expect(mayStop({ isStarter: true, isModerator: false })).toBe(true);
    expect(mayStop({ isStarter: false, isModerator: true })).toBe(true);
    expect(mayStop({ isStarter: false, isModerator: false })).toBe(false);
  });

  it('counts a room day from the start of the UTC day, and keeps an ended session seven days', () => {
    expect(dayStartOf(new Date('2026-11-01T23:59:59.999Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(ENDED_KEPT_DAYS).toBe(7);
    expect(keptUntil(new Date('2026-11-08T00:00:00.000Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(LONGEST_REEL_MS).toBe(3_600_000);
  });
});
