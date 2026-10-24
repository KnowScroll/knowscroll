import { describe, expect, it } from 'vitest';
import {
  CONTRIBUTION_MAX_CHARS,
  KINDS_OF,
  PERSON_ASKS_PER_DAY,
  PERSON_REQUESTS_PER_DAY,
  ROOM_ASKS_PER_DAY,
  askDecision,
  contributionProblem,
  utcDayStart,
} from './contribution.js';

describe('askDecision', () => {
  const quiet = { roomAsksToday: 0, personAsksToday: 0, personRequestsToday: 0, openAsk: false };

  it('lets a member ask when nothing is being prepared and the bounds are not reached', () => {
    expect(askDecision(quiet)).toBe('allowed');
  });

  it('holds one ask per discussion at a time', () => {
    expect(askDecision({ ...quiet, openAsk: true })).toBe('preparing');
  });

  it('rests an inhabitant when the room or the person has used the day', () => {
    expect(askDecision({ ...quiet, roomAsksToday: ROOM_ASKS_PER_DAY - 1 })).toBe('allowed');
    expect(askDecision({ ...quiet, roomAsksToday: ROOM_ASKS_PER_DAY })).toBe('room_resting');
    expect(askDecision({ ...quiet, personAsksToday: PERSON_ASKS_PER_DAY })).toBe('person_resting');
  });

  it('also rests a person who has made many asks that never counted, so failed asks cannot pile up', () => {
    expect(askDecision({ ...quiet, personRequestsToday: PERSON_REQUESTS_PER_DAY - 1 })).toBe('allowed');
    expect(askDecision({ ...quiet, personRequestsToday: PERSON_REQUESTS_PER_DAY })).toBe('person_resting');
    expect(PERSON_REQUESTS_PER_DAY).toBeGreaterThan(PERSON_ASKS_PER_DAY);
  });

  it('keeps the person’s bound below the room’s, so one person cannot use the whole room day', () => {
    expect(PERSON_ASKS_PER_DAY).toBeLessThan(ROOM_ASKS_PER_DAY);
  });
});

describe('utcDayStart', () => {
  it('is midnight UTC of the same day', () => {
    expect(utcDayStart(new Date('2026-10-24T23:59:59.999Z')).toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(utcDayStart(new Date('2026-10-25T00:00:00.000Z')).toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });
});

describe('contributionProblem', () => {
  it('accepts a short plain suggestion', () => {
    expect(contributionProblem('Does that assume requests arrive in bursts?')).toBeUndefined();
  });

  it('refuses nothing, too much, a link, and a claim to be a person', () => {
    expect(contributionProblem('   ')).toBe('empty');
    expect(contributionProblem('x'.repeat(CONTRIBUTION_MAX_CHARS + 1))).toBe('too_long');
    expect(contributionProblem('x'.repeat(CONTRIBUTION_MAX_CHARS))).toBeUndefined();
    expect(contributionProblem('See https://example.invalid/a')).toBe('has_link');
    expect(contributionProblem('Try www.example.invalid')).toBe('has_link');
    expect(contributionProblem('As a student I saw this once.')).toBe('claims_to_be_a_person');
    expect(contributionProblem("I'm a human and I disagree.")).toBe('claims_to_be_a_person');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(contributionProblem('é'.repeat(CONTRIBUTION_MAX_CHARS))).toBeUndefined();
    expect(contributionProblem('😀'.repeat(CONTRIBUTION_MAX_CHARS))).toBeUndefined();
  });
});

describe('what each inhabitant may say', () => {
  it('keeps explaining and challenging apart', () => {
    expect(KINDS_OF.explainer).toEqual(['explanation']);
    expect(KINDS_OF.skeptic).toEqual(['assumption', 'perspective', 'counterexample']);
  });
});
