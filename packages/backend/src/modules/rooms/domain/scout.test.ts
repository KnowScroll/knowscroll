import { ROOM_SCOUT_INTERESTS_MAX } from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import type { FindCandidate } from './feed.js';
import {
  SCOUT_RULES,
  interestsProblem,
  nextPostAfter,
  restStartOf,
  routeScout,
  scoutSilence,
  type ScoutFacts,
} from './scout.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-04T09:37:00.000Z');
const CAPS = { roomPerHour: 8, roomPerDay: 40 };
const candidate: FindCandidate = {
  assetId: '0199a000-0000-7000-8000-000000000001',
  assetRevision: 1,
  kind: 'scroll',
  title: 'A Scroll',
  summary: 'A summary.',
};

const facts = (over: Partial<ScoutFacts> = {}): ScoutFacts => ({
  now: NOW,
  room: { open: true, listeners: 2 },
  scout: { cadence: 'daily', paused: false, stopped: false },
  owner: { member: true, recording: true },
  candidate,
  lastPostAt: undefined,
  counts: { roomLastHour: 0, roomToday: 0, scoutsToday: 0 },
  ...over,
});

describe('the topics a member chooses (their own, from the room, never read from them)', () => {
  const room = ['black-holes', 'dark-matter', 'galaxies'];

  it('accepts one to five distinct topics of the room', () => {
    expect(interestsProblem(['black-holes'], room)).toBeUndefined();
    expect(interestsProblem(room, room)).toBeUndefined();
  });

  it('refuses none, too many, a repeat, and anything that is not a topic of this room', () => {
    expect(interestsProblem([], room)).toBe('empty');
    const many = Array.from({ length: SCOUT_RULES.interestsMax + 1 }, (_, index) => `topic-${String(index)}`);
    expect(interestsProblem(many, many)).toBe('too_many');
    expect(interestsProblem(['galaxies', 'galaxies'], room)).toBe('duplicate');
    expect(interestsProblem(['cooking'], room)).toBe('not_in_room');
    expect(interestsProblem(['galaxies', 'cooking'], room)).toBe('not_in_room');
  });

  it('is the same most the contract tells a screen', () => {
    expect(SCOUT_RULES.interestsMax).toBe(ROOM_SCOUT_INTERESTS_MAX);
  });
});

describe('how often a scout may post (a cap, by UTC day)', () => {
  it('rests a daily scout for the rest of the UTC day, and frees it at midnight', () => {
    expect(restStartOf('daily', NOW).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(nextPostAfter('daily', new Date('2026-11-04T00:37:00Z'))?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(nextPostAfter('daily', undefined)).toBeUndefined();
  });

  it('rests a weekly scout for seven UTC days, the day of the post included', () => {
    expect(restStartOf('weekly', NOW).toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(nextPostAfter('weekly', new Date('2026-11-04T08:00:00Z'))?.toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });
});

describe('what silences a scout whatever the library holds', () => {
  const silenced = (over: Partial<ScoutFacts>) => scoutSilence(facts(over));

  it('is checked in one order, and nothing else', () => {
    expect(silenced({})).toBeUndefined();
    expect(silenced({ room: { open: false, listeners: 2 } })).toBe('room_closed');
    expect(silenced({ scout: undefined })).toBe('no_scout');
    expect(silenced({ owner: { member: false, recording: true } })).toBe('owner_gone');
    expect(silenced({ scout: { cadence: 'daily', paused: true, stopped: true } })).toBe('stopped');
    expect(silenced({ scout: { cadence: 'daily', paused: true, stopped: false } })).toBe('paused');
    expect(silenced({ owner: { member: true, recording: false } })).toBe('recording_paused');
  });
});

describe('one look at one scout (zero calls from every branch but a post)', () => {
  const decide = (over: Partial<ScoutFacts> = {}) => routeScout(facts(over), CAPS);

  it('posts when everything allows it', () => {
    expect(decide()).toEqual({ kind: 'post', counts: { roomLastHour: 0, roomToday: 0, scoutsToday: 0 } });
  });

  it.each([
    ['a closed room', { room: { open: false, listeners: 2 } }, 'room_closed'],
    ['a scout its owner took back', { scout: undefined }, 'no_scout'],
    ['an owner who left or was removed', { owner: { member: false, recording: true } }, 'owner_gone'],
    ['a moderator’s stop', { scout: { cadence: 'daily', paused: false, stopped: true } }, 'stopped'],
    ['its owner’s pause', { scout: { cadence: 'daily', paused: true, stopped: false } }, 'paused'],
    ['an owner who paused recording', { owner: { member: true, recording: false } }, 'recording_paused'],
    ['a room nobody else listens to', { room: { open: true, listeners: 0 } }, 'nobody_listening'],
    ['a library with nothing new in its topics', { candidate: undefined }, 'nothing_new'],
  ] as const)('drops %s without a call', (_name, over, reason) => {
    expect(decide(over)).toEqual({ kind: 'drop', reason });
  });

  it('lets a daily scout post once a UTC day: today’s post rests it, yesterday’s does not', () => {
    expect(decide({ lastPostAt: new Date(NOW.getTime() - 60_000) })).toEqual({ kind: 'drop', reason: 'resting' });
    expect(decide({ lastPostAt: new Date('2026-11-04T00:00:00.000Z') })).toEqual({ kind: 'drop', reason: 'resting' });
    expect(decide({ lastPostAt: new Date('2026-11-03T23:59:59.000Z') }).kind).toBe('post');
  });

  it('lets a weekly scout post once in seven UTC days', () => {
    const weekly = { cadence: 'weekly', paused: false, stopped: false } as const;
    expect(decide({ scout: weekly, lastPostAt: new Date(NOW.getTime() - 3 * DAY) })).toEqual({
      kind: 'drop',
      reason: 'resting',
    });
    expect(decide({ scout: weekly, lastPostAt: new Date('2026-10-29T00:00:00.000Z') })).toEqual({
      kind: 'drop',
      reason: 'resting',
    });
    expect(decide({ scout: weekly, lastPostAt: new Date('2026-10-28T23:59:00.000Z') }).kind).toBe('post');
  });

  it('refuses quietly at the room’s own caps and at the scouts’ five a day, in that order of precedence', () => {
    const counts = (over: Partial<ScoutFacts['counts']>) => ({
      roomLastHour: 0,
      roomToday: 0,
      scoutsToday: 0,
      ...over,
    });
    expect(decide({ counts: counts({ scoutsToday: SCOUT_RULES.roomPostsPerDay }) })).toMatchObject({
      kind: 'refuse',
      cap: 'scout_day',
    });
    expect(decide({ counts: counts({ roomLastHour: CAPS.roomPerHour }) })).toMatchObject({
      kind: 'refuse',
      cap: 'room_hour',
    });
    expect(decide({ counts: counts({ roomToday: CAPS.roomPerDay }) })).toMatchObject({
      kind: 'refuse',
      cap: 'room_day',
    });
    expect(
      decide({ counts: counts({ scoutsToday: SCOUT_RULES.roomPostsPerDay - 1, roomToday: CAPS.roomPerDay - 1 }) }).kind,
    ).toBe('post');
  });

  it('lets silence and a resting scout win over a cap: a scout that may not post is never recorded as refused', () => {
    expect(
      decide({
        scout: { cadence: 'daily', paused: true, stopped: false },
        counts: { roomLastHour: 99, roomToday: 99, scoutsToday: 99 },
      }),
    ).toEqual({ kind: 'drop', reason: 'paused' });
  });
});
