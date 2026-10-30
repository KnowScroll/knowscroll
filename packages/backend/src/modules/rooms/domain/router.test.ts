import { describe, expect, it } from 'vitest';
import {
  STALE_AFTER_MS,
  UNPROMPTED_CAPS,
  WAITS,
  residentFor,
  route,
  waitFor,
  type CapCounts,
  type RouteFacts,
} from './router.js';

const MINUTE = 60_000;
const at = new Date('2026-10-30T12:00:00.000Z');
const later = (ms: number) => new Date(at.getTime() + ms);
const quietCounts: CapCounts = { roomLastHour: 0, roomToday: 0, residentLastHour: 0, personLastHour: 0 };

/** A question asked at noon in an open room with both residents, someone else listening, and nothing said since. */
const question = (overrides: Partial<RouteFacts> = {}): RouteFacts => ({
  now: later(5 * MINUTE),
  trigger: {
    kind: 'unanswered_question',
    at,
    authorKeptOut: false,
    authorFirstMessage: false,
    decidedBefore: false,
  },
  room: { open: true, residents: ['explainer', 'skeptic'], listeners: 2 },
  onlyAuthorHere: false,
  after: { byOthers: 0, byAi: 0 },
  typingUntil: undefined,
  counts: quietCounts,
  ...overrides,
});

const claim = (overrides: Partial<RouteFacts> = {}): RouteFacts =>
  question({ trigger: { ...question().trigger, kind: 'overstated_claim' }, ...overrides });

const reply = (overrides: Partial<RouteFacts> = {}): RouteFacts =>
  question({ trigger: { ...question().trigger, kind: 'answer_overstated' }, ...overrides });

describe('who answers what', () => {
  it('sends a question to the Explainer and a claim, or an overstated answer, to the Skeptic', () => {
    expect(residentFor('unanswered_question')).toBe('explainer');
    expect(residentFor('overstated_claim')).toBe('skeptic');
    expect(residentFor('answer_overstated')).toBe('skeptic');
  });
});

describe('the wait people are owed', () => {
  it('holds a question for four minutes, or ninety seconds when only its author is here', () => {
    expect(waitFor('unanswered_question', false)).toBe(4 * MINUTE);
    expect(waitFor('unanswered_question', true)).toBe(90_000);
    expect(route(question({ now: later(4 * MINUTE - 1) }))).toEqual({
      kind: 'wait',
      until: later(4 * MINUTE),
      reason: 'too_early',
    });
    expect(route(question({ now: later(4 * MINUTE) })).kind).toBe('speak');
    expect(route(question({ now: later(89_999), onlyAuthorHere: true })).kind).toBe('wait');
    expect(route(question({ now: later(90_000), onlyAuthorHere: true })).kind).toBe('speak');
  });

  it('gives a claim two minutes and the reply to an overstated answer one', () => {
    expect(WAITS.claim.room).toBe(2 * MINUTE);
    expect(route(claim({ now: later(2 * MINUTE - 1) })).kind).toBe('wait');
    expect(route(claim({ now: later(2 * MINUTE) })).kind).toBe('speak');
    expect(route(reply({ now: later(MINUTE - 1) })).kind).toBe('wait');
    expect(route(reply({ now: later(MINUTE) })).kind).toBe('speak');
  });

  it('holds back while someone is typing, until the hold lapses', () => {
    const until = later(5 * MINUTE + 8_000);
    expect(route(question({ typingUntil: until }))).toEqual({ kind: 'wait', until, reason: 'typing' });
    expect(route(question({ typingUntil: later(5 * MINUTE) })).kind).toBe('speak');
    expect(route(question({ typingUntil: later(4 * MINUTE) })).kind).toBe('speak');
  });
});

describe('a human answer inside the wait', () => {
  it('lets the trigger go when another person or an AI posted after the message', () => {
    expect(route(question({ after: { byOthers: 1, byAi: 0 } }))).toEqual({ kind: 'drop', reason: 'answered' });
    expect(route(question({ after: { byOthers: 0, byAi: 1 } }))).toEqual({ kind: 'drop', reason: 'answered' });
    expect(route(claim({ after: { byOthers: 2, byAi: 0 } }))).toEqual({ kind: 'drop', reason: 'answered' });
  });

  it('ends the chain when anything follows an overstated answer', () => {
    expect(route(reply({ after: { byOthers: 1, byAi: 0 } }))).toEqual({ kind: 'drop', reason: 'chain' });
    expect(route(reply({ after: { byOthers: 0, byAi: 1 } }))).toEqual({ kind: 'drop', reason: 'chain' });
  });
});

describe('who is never answered', () => {
  it('does not answer a newcomer first message with a challenge, but may answer their first question', () => {
    const first = { ...claim().trigger, authorFirstMessage: true };
    expect(route(claim({ trigger: first }))).toEqual({ kind: 'drop', reason: 'newcomer' });
    expect(route(question({ trigger: { ...question().trigger, authorFirstMessage: true } })).kind).toBe('speak');
  });

  it('does not answer an author who keeps their messages out, a room nobody listens to, or one already decided', () => {
    expect(route(question({ trigger: { ...question().trigger, authorKeptOut: true } }))).toEqual({
      kind: 'drop',
      reason: 'kept_out',
    });
    expect(route(question({ room: { open: true, residents: ['explainer', 'skeptic'], listeners: 0 } }))).toEqual({
      kind: 'drop',
      reason: 'nobody_listening',
    });
    expect(route(question({ trigger: { ...question().trigger, decidedBefore: true } }))).toEqual({
      kind: 'drop',
      reason: 'decided',
    });
  });

  it('does nothing in a room that is paused or closed, without the resident, or for an old message', () => {
    expect(route(question({ room: { open: false, residents: ['explainer'], listeners: 2 } })).kind).toBe('drop');
    expect(route(question({ room: { open: true, residents: ['skeptic'], listeners: 2 } }))).toEqual({
      kind: 'drop',
      reason: 'no_resident',
    });
    expect(route(question({ now: later(STALE_AFTER_MS + 1) }))).toEqual({ kind: 'drop', reason: 'stale' });
  });
});

describe('the caps', () => {
  it('allows the first turn of a room whatever the ratio, then needs three human messages per turn', () => {
    expect(route(question({ counts: { ...quietCounts } })).kind).toBe('speak');
    for (const humans of [0, 1, 2])
      expect(route(question({ counts: { ...quietCounts, humanSinceLastTurn: humans } }))).toMatchObject({
        kind: 'refuse',
        cap: 'ratio',
      });
    expect(route(question({ counts: { ...quietCounts, humanSinceLastTurn: 3 } })).kind).toBe('speak');
  });

  it('refuses the ninth turn of an hour and the forty-first of a day', () => {
    expect(UNPROMPTED_CAPS.roomPerHour).toBe(8);
    expect(UNPROMPTED_CAPS.roomPerDay).toBe(40);
    expect(route(question({ counts: { ...quietCounts, roomLastHour: 7 } })).kind).toBe('speak');
    expect(route(question({ counts: { ...quietCounts, roomLastHour: 8 } }))).toMatchObject({ cap: 'room_hour' });
    expect(route(question({ counts: { ...quietCounts, roomToday: 39 } })).kind).toBe('speak');
    expect(route(question({ counts: { ...quietCounts, roomToday: 40 } }))).toMatchObject({ cap: 'room_day' });
  });

  it('gives the Explainer four turns an hour and the Skeptic three, and the Skeptic one per person', () => {
    expect(route(question({ counts: { ...quietCounts, residentLastHour: 3 } })).kind).toBe('speak');
    expect(route(question({ counts: { ...quietCounts, residentLastHour: 4 } }))).toMatchObject({
      cap: 'resident_hour',
    });
    expect(route(claim({ counts: { ...quietCounts, residentLastHour: 2 } })).kind).toBe('speak');
    expect(route(claim({ counts: { ...quietCounts, residentLastHour: 3 } }))).toMatchObject({ cap: 'resident_hour' });
    expect(route(claim({ counts: { ...quietCounts, personLastHour: 1 } }))).toMatchObject({ cap: 'person_hour' });
    // The per-person bound is the Skeptic's alone.
    expect(route(question({ counts: { ...quietCounts, personLastHour: 5 } })).kind).toBe('speak');
  });

  it('does not count the one reply of the Skeptic to an overstated answer against the ratio, but counts it for the rest', () => {
    const counts = { ...quietCounts, humanSinceLastTurn: 0 };
    expect(route(reply({ counts })).kind).toBe('speak');
    expect(route(reply({ counts: { ...counts, roomLastHour: 8 } }))).toMatchObject({ cap: 'room_hour' });
  });

  it('records the counts it compared with a refusal and with a go-ahead', () => {
    const counts = { ...quietCounts, humanSinceLastTurn: 1 };
    expect(route(question({ counts }))).toEqual({ kind: 'refuse', cap: 'ratio', counts });
    expect(route(question({ counts: quietCounts }))).toEqual({
      kind: 'speak',
      inhabitant: 'explainer',
      counts: quietCounts,
    });
  });
});
