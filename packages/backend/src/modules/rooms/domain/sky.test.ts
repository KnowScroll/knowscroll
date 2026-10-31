import { describe, expect, it } from 'vitest';
import { debateStartProblem, isClosedAt, resultOf } from './debate.js';
import {
  STARS_PER_DAY_DEFAULT,
  constellationCandidates,
  constellationOfStar,
  finishesConstellation,
  namingClosesAt,
  skyOf,
  starDecision,
  usefulEarnsStar,
  winningCandidate,
} from './sky.js';

const ASHA = 'a0000000-0000-4000-8000-000000000001';
const RAVI = 'a0000000-0000-4000-8000-000000000002';
const KENJI = 'a0000000-0000-4000-8000-000000000003';

describe('what earns a star (D-174)', () => {
  it('earns once per act and source, and stops at the day cap', () => {
    expect(starDecision({ alreadyAwarded: false, earnedToday: 0, perDay: STARS_PER_DAY_DEFAULT })).toBe('award');
    expect(starDecision({ alreadyAwarded: false, earnedToday: 2, perDay: 3 })).toBe('award');
    expect(starDecision({ alreadyAwarded: false, earnedToday: 3, perDay: 3 })).toBe('day_full');
    expect(starDecision({ alreadyAwarded: true, earnedToday: 0, perDay: 3 })).toBe('duplicate');
    expect(STARS_PER_DAY_DEFAULT).toBe(3);
  });

  const facts = (over: Record<string, unknown> = {}) => ({
    discussion: { kind: 'today' as const, tag: null, startedByAccountId: null },
    authorAccountId: ASHA,
    giverAccountId: RAVI,
    hasWords: true,
    ...over,
  });

  it('counts a person words in Today that someone else marked', () => {
    expect(usefulEarnsStar(facts())).toBe(true);
  });

  it('refuses the own mark, a resident, a card and a message without words', () => {
    expect(usefulEarnsStar(facts({ giverAccountId: ASHA }))).toBe(false);
    expect(usefulEarnsStar(facts({ authorAccountId: null }))).toBe(false);
    expect(usefulEarnsStar(facts({ hasWords: false }))).toBe(false);
  });

  it('counts a question topic answer by someone other than the asker, and nothing in General, a debate or a share', () => {
    const topic = (tag: 'question' | 'debate' | 'share' | null, started = KENJI) => ({
      discussion: { kind: 'topic' as const, tag, startedByAccountId: started },
    });
    expect(usefulEarnsStar(facts(topic('question')))).toBe(true);
    expect(usefulEarnsStar(facts(topic('question', ASHA)))).toBe(false);
    expect(usefulEarnsStar(facts(topic('debate')))).toBe(false);
    expect(usefulEarnsStar(facts(topic('share')))).toBe(false);
    expect(usefulEarnsStar(facts(topic(null)))).toBe(false);
    expect(usefulEarnsStar(facts({ discussion: { kind: 'general', tag: null, startedByAccountId: null } }))).toBe(
      false,
    );
  });
});

describe('a constellation (D-175)', () => {
  it('belongs to the seven stars before and after a finishing star', () => {
    expect([0, 6, 7, 13, 14].map(constellationOfStar)).toEqual([1, 1, 2, 2, 3]);
    expect([0, 1, 6, 7, 8, 14].map(finishesConstellation)).toEqual([false, false, false, true, false, true]);
  });

  it('draws lit stars, finished constellations and the latest name', () => {
    const named = { latestIsNamed: true, latestName: 'The Lantern' };
    expect(skyOf({ stars: 0, latestIsNamed: false, latestName: undefined })).toEqual({
      lit: 0,
      of: 7,
      state: 'forming',
      finished: 0,
    });
    expect(skyOf({ stars: 6, latestIsNamed: false, latestName: undefined })).toMatchObject({
      lit: 6,
      state: 'forming',
    });
    expect(skyOf({ stars: 7, latestIsNamed: false, latestName: undefined })).toMatchObject({
      lit: 7,
      state: 'naming',
      finished: 1,
    });
    expect(skyOf({ stars: 7, ...named })).toEqual({
      lit: 7,
      of: 7,
      state: 'named',
      finished: 1,
      constellationName: 'The Lantern',
    });
    expect(skyOf({ stars: 8, ...named })).toEqual({
      lit: 1,
      of: 7,
      state: 'forming',
      finished: 1,
      constellationName: 'The Lantern',
    });
    expect(skyOf({ stars: 14, latestIsNamed: false, latestName: 'The Lantern' })).toMatchObject({
      lit: 7,
      state: 'naming',
      finished: 2,
    });
  });

  it('offers three different names, none a room already uses while others remain, the same on every call', () => {
    const roomId = '0199b000-0000-7000-8000-00000000abcd';
    for (const topicId of ['space', 'earth', 'human-body', 'unknown-topic']) {
      const names = constellationCandidates({ topicId, roomId, no: 1, used: [] });
      expect(new Set(names).size).toBe(3);
      expect(constellationCandidates({ topicId, roomId, no: 1, used: [] })).toEqual(names);
      const next = constellationCandidates({ topicId, roomId, no: 2, used: [names[0]] });
      expect(next).not.toContain(names[0]);
    }
  });

  it('names by the most votes, ties to the earlier name, and the first when nobody voted', () => {
    expect(winningCandidate([0, 0, 0])).toBe(0);
    expect(winningCandidate([1, 2, 1])).toBe(1);
    expect(winningCandidate([1, 2, 2])).toBe(1);
    expect(winningCandidate([0, 1, 3])).toBe(2);
    expect(winningCandidate([2, 2, 2])).toBe(0);
  });

  it('closes the name vote a day after the seventh star', () => {
    expect(namingClosesAt(new Date('2026-10-26T10:00:00Z')).toISOString()).toBe('2026-10-27T10:00:00.000Z');
  });
});

describe('a debate (D-176)', () => {
  it('needs a debate for the tag and refuses one for any other', () => {
    const debate = { sides: ['Yes', 'No'] as [string, string], closesInHours: 24 };
    expect(debateStartProblem('debate', undefined)).toBe('needs_debate');
    expect(debateStartProblem('debate', debate)).toBeUndefined();
    expect(debateStartProblem('question', debate)).toBe('not_a_debate');
    expect(debateStartProblem(undefined, debate)).toBe('not_a_debate');
    expect(debateStartProblem(undefined, undefined)).toBeUndefined();
  });

  it('is closed from its close time on', () => {
    const closes = new Date('2026-10-26T10:00:00Z');
    expect(isClosedAt(closes, new Date('2026-10-26T09:59:59Z'))).toBe(false);
    expect(isClosedAt(closes, closes)).toBe(true);
  });

  it('earns a star from two different voters, and a tie has no winner', () => {
    expect(resultOf({ a: 1, b: 0 })).toEqual({ voters: 1, winner: 'a', earnsStar: false });
    expect(resultOf({ a: 1, b: 1 })).toEqual({ voters: 2, winner: undefined, earnsStar: true });
    expect(resultOf({ a: 0, b: 3 })).toMatchObject({ winner: 'b', earnsStar: true });
    expect(resultOf({ a: 0, b: 0 })).toEqual({ voters: 0, winner: undefined, earnsStar: false });
  });
});
