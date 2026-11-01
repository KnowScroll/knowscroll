import { describe, expect, it } from 'vitest';
import { RANK_RULES, arrange, hotScore, sortHot, sortNew, sortTop, windowStart, type Ranked } from './feed-rank.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-04T12:00:00.000Z');
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const post = (n: number, hoursOld: number, votes: number): Ranked => ({
  discussionId: id(n),
  postedAt: new Date(NOW.getTime() - hoursOld * HOUR),
  votes,
});
const ids = (posts: readonly Ranked[]) => posts.map((entry) => Number(entry.discussionId.slice(-12)));

describe('Hot: votes decayed by age', () => {
  it('scores (votes + 1) over (hours + 2) to the power 1.5, and counts a time in the future as just posted', () => {
    expect(hotScore(0, NOW, NOW)).toBeCloseTo(1 / 2 ** 1.5, 10);
    expect(hotScore(3, NOW, new Date(NOW.getTime() - 6 * HOUR))).toBeCloseTo(4 / 8 ** 1.5, 10);
    expect(hotScore(0, NOW, new Date(NOW.getTime() + 5 * HOUR))).toBe(hotScore(0, NOW, NOW));
  });

  it('puts more votes first at the same age, and the newer post first at the same votes', () => {
    expect(ids(sortHot([post(1, 5, 1), post(2, 5, 4), post(3, 5, 2)], NOW))).toEqual([2, 3, 1]);
    expect(ids(sortHot([post(1, 9, 3), post(2, 2, 3), post(3, 5, 3)], NOW))).toEqual([2, 3, 1]);
  });

  it('lets a vote keep a post up and its age bring it down', () => {
    // Ten votes keep a post six hours old above one that has just been made; a day and a half on, the new post is above it.
    expect(ids(sortHot([post(1, 0.5, 0), post(2, 6, 10)], NOW))).toEqual([2, 1]);
    expect(ids(sortHot([post(1, 0.5, 0), post(2, 36, 10)], NOW))).toEqual([1, 2]);
  });

  it('is the order of New when nobody has voted', () => {
    const posts = [post(1, 9, 0), post(2, 2, 0), post(3, 5, 0)];
    expect(ids(sortHot(posts, NOW))).toEqual(ids(sortNew(posts)));
  });

  it('breaks an exact tie by the larger ID, the same whatever order the posts arrive in', () => {
    const first = post(1, 3, 2);
    const second = post(2, 3, 2);
    expect(ids(sortHot([first, second], NOW))).toEqual([2, 1]);
    expect(ids(sortHot([second, first], NOW))).toEqual([2, 1]);
  });

  it('does not read replies: only votes lift a post', () => {
    const withReplies = { ...post(1, 4, 0), replies: 40 };
    expect(ids(sortHot([withReplies, post(2, 4, 1)], NOW))).toEqual([2, 1]);
  });
});

describe('New and Top', () => {
  it('New is the newest first', () => {
    expect(ids(sortNew([post(1, 9, 9), post(2, 2, 0), post(3, 5, 4)]))).toEqual([2, 3, 1]);
  });

  it('Top is the most votes first, then the newer post', () => {
    expect(ids(sortTop([post(1, 9, 3), post(2, 2, 1), post(3, 5, 3), post(4, 1, 7)]))).toEqual([4, 3, 1, 2]);
  });

  it('arranges by the sort asked for and leaves its input alone', () => {
    const posts = [post(1, 9, 9), post(2, 2, 0)];
    const before = [...posts];
    expect(ids(arrange(posts, 'new', NOW))).toEqual([2, 1]);
    expect(ids(arrange(posts, 'top', NOW))).toEqual([1, 2]);
    expect(ids(arrange(posts, 'hot', NOW))).toEqual(ids(sortHot(posts, NOW)));
    expect(posts).toEqual(before);
  });
});

describe('the window Top counts', () => {
  it('is the last day, week or month, or every post', () => {
    expect(windowStart('day', NOW)?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(windowStart('week', NOW)?.toISOString()).toBe('2026-10-28T12:00:00.000Z');
    expect(windowStart('month', NOW)?.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(windowStart('all', NOW)).toBeUndefined();
    expect(RANK_RULES.defaultWindow).toBe('week');
  });
});
