import { describe, expect, it } from 'vitest';
import {
  AWAY_AFTER_MS,
  AWAY_MIN_NEW_MESSAGES,
  COVERS_AT_MOST_MS,
  WINDOW_MS,
  coversFrom,
  isOwedSummary,
  wasAwayLongEnough,
  welcomeText,
  windowOf,
} from './away.js';

const NOW = new Date('2026-10-30T09:00:00Z');
const before = (ms: number) => new Date(NOW.getTime() - ms);

describe('when a return is owed a "while you were away"', () => {
  const facts = {
    previous: before(AWAY_AFTER_MS + 60_000),
    now: NOW,
    newMessages: AWAY_MIN_NEW_MESSAGES,
    level: 'lively',
  } as const;

  it('is owed after a long absence to enough new messages', () => {
    expect(isOwedSummary(facts)).toBe(true);
    expect(isOwedSummary({ ...facts, level: 'quieter' })).toBe(true);
  });

  it('is not owed after a short absence, to too few messages, to a member who never opened the room, or to one with AI off', () => {
    expect(isOwedSummary({ ...facts, previous: before(AWAY_AFTER_MS - 60_000) })).toBe(false);
    expect(isOwedSummary({ ...facts, newMessages: AWAY_MIN_NEW_MESSAGES - 1 })).toBe(false);
    expect(isOwedSummary({ ...facts, previous: undefined })).toBe(false);
    expect(isOwedSummary({ ...facts, level: 'off' })).toBe(false);
  });

  it('counts exactly the threshold absence as long enough', () => {
    expect(isOwedSummary({ ...facts, previous: before(AWAY_AFTER_MS) })).toBe(true);
  });

  it('is decided by time and level alone before any message is counted, and the count only adds to it', () => {
    expect(wasAwayLongEnough(facts)).toBe(true);
    expect(wasAwayLongEnough({ ...facts, previous: before(AWAY_AFTER_MS - 1) })).toBe(false);
    expect(wasAwayLongEnough({ ...facts, previous: undefined })).toBe(false);
    expect(wasAwayLongEnough({ ...facts, level: 'off' })).toBe(false);
    // Long enough away says nothing of how much was said.
    expect(wasAwayLongEnough(facts)).toBe(true);
    expect(isOwedSummary({ ...facts, newMessages: 0 })).toBe(false);
  });
});

describe('the window of a return', () => {
  it('is the 12-hour UTC block, so every return in it shares one summary', () => {
    const morning = new Date('2026-10-30T08:40:00Z');
    const noon = new Date('2026-10-30T11:59:59Z');
    const afternoon = new Date('2026-10-30T12:00:00Z');
    expect(windowOf(morning)).toBe(windowOf(noon));
    expect(windowOf(afternoon)).toBe(windowOf(noon) + 1);
    expect(WINDOW_MS).toBe(12 * 3_600_000);
  });

  it('starts where the first member left, but never more than a day before it is written', () => {
    expect(coversFrom(before(14 * 3_600_000), NOW).getTime()).toBe(NOW.getTime() - 14 * 3_600_000);
    expect(coversFrom(before(5 * 24 * 3_600_000), NOW).getTime()).toBe(NOW.getTime() - COVERS_AT_MOST_MS);
  });
});

describe('the welcome', () => {
  it('is filled from the room and its topic, and reads as a template', () => {
    expect(welcomeText({ name: 'Computing', topicMeaning: 'How the web works.' })).toBe(
      'Welcome to Computing. How the web works. Ask me anything here, or just say hello in General.',
    );
  });

  it('ends a topic meaning that has no full stop, and stays whole without a meaning', () => {
    expect(welcomeText({ name: 'Space', topicMeaning: 'Stars and planets' })).toContain('Stars and planets.');
    expect(welcomeText({ name: 'Space', topicMeaning: undefined })).toBe(
      'Welcome to Space. Ask me anything here, or just say hello in General.',
    );
  });
});
