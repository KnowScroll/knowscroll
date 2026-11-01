import { describe, expect, it } from 'vitest';
import {
  QUESTION_LEFT_WORDS,
  QUIET_OFFER_AFTER_MS,
  laterWords,
  questionReplyLine,
  questionsChip,
  quietOffer,
} from './room-questions';

const NOW = new Date('2026-11-01T21:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const person = {
  kind: 'person' as const,
  personId: '0199e000-0000-7000-8000-000000000009',
  handle: 'lena',
  displayName: 'Lena',
};

describe('the words of a question left for people', () => {
  it('says how long an answer took, in the server’s own times', () => {
    expect(laterWords('2026-10-26T21:14:00Z', '2026-10-26T21:30:00Z')).toBe('a few minutes later');
    expect(laterWords('2026-10-26T21:14:00Z', '2026-10-27T00:20:00Z')).toBe('3 h later');
    expect(laterWords('2026-10-26T21:14:00Z', '2026-10-27T21:15:00Z')).toBe('1 day later');
    expect(laterWords('2026-10-26T21:14:00Z', '2026-10-28T19:02:00Z')).toBe('1 day later');
    expect(laterWords('2026-10-26T21:14:00Z', '2026-10-28T21:14:00Z')).toBe('2 days later');
    // An answer cannot come before the question: a skewed pair reads as no wait, never a negative one.
    expect(laterWords('2026-10-28T21:14:00Z', '2026-10-26T21:14:00Z')).toBe('a few minutes later');
  });

  it('names the person who answered, and nobody else', () => {
    expect(questionReplyLine({ by: person, askedAt: '2026-10-26T21:14:00Z', at: '2026-10-28T21:20:00Z' })).toBe(
      'Lena answered your question · 2 days later',
    );
  });

  it('says how many questions wait only when some do, and never a made-up count', () => {
    expect(questionsChip(undefined)).toBeUndefined();
    expect(questionsChip({ waiting: 0, replies: [] })).toBeUndefined();
    expect(questionsChip({ waiting: 1, replies: [] })).toEqual({ label: 'Open', detail: '1 question waiting' });
    expect(questionsChip({ waiting: 3, replies: [] })).toEqual({ label: 'Open', detail: '3 questions waiting' });
  });

  it('says what happened to the resident without hiding that it is AI or what the asker chose', () => {
    expect(QUESTION_LEFT_WORDS.queued).toContain('AI');
    expect(QUESTION_LEFT_WORDS.kept_out).toContain('keep your messages out');
    for (const words of Object.values(QUESTION_LEFT_WORDS)) expect(words).toContain('open for people');
  });
});

describe('the quiet room’s offer', () => {
  const replay = { day: '2026-10-31' };

  it('is made only when there is a real Launch to replay and no person has written for half an hour', () => {
    const offer = quietOffer({ replay, lastMessageAt: ago(QUIET_OFFER_AFTER_MS), now: NOW, dismissed: new Set() });
    expect(offer?.key).toBe('2026-10-31');
    expect(offer?.line).toContain('31 Oct');
    expect(offer?.line).toContain('played it');
    // Nothing is claimed about people who are not there.
    expect(offer?.line).not.toMatch(/online|here now|active/i);
  });

  it('is not made with nothing to replay, in a room people are talking in, or once dismissed', () => {
    const base = { lastMessageAt: ago(QUIET_OFFER_AFTER_MS), now: NOW, dismissed: new Set<string>() };
    expect(quietOffer({ ...base, replay: undefined })).toBeUndefined();
    expect(quietOffer({ ...base, replay, lastMessageAt: ago(QUIET_OFFER_AFTER_MS - 60_000) })).toBeUndefined();
    expect(quietOffer({ ...base, replay, dismissed: new Set(['2026-10-31']) })).toBeUndefined();
  });

  it('is made in a room nobody has ever written in', () => {
    expect(quietOffer({ replay, lastMessageAt: undefined, now: NOW, dismissed: new Set() })).toBeDefined();
  });
});
