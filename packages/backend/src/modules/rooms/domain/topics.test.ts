import { describe, expect, it } from 'vitest';
import { hotScore, orderTopics, type TopicFacts } from './topics.js';

const NOW = new Date('2026-10-30T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

let counter = 0;
const topic = (overrides: Partial<TopicFacts> = {}): TopicFacts => ({
  discussionId: `topic-${String(++counter).padStart(2, '0')}`,
  pinned: false,
  createdAt: hoursAgo(5),
  lastActivityAt: hoursAgo(1),
  replyCount: 0,
  usefulCount: 0,
  answered: false,
  ...overrides,
});

describe('how hot a topic is', () => {
  it('grows with replies and with Useful marks, and cools as time passes without anyone speaking', () => {
    const base = topic({ replyCount: 4 });
    expect(hotScore({ ...base, usefulCount: 2 }, NOW)).toBeGreaterThan(hotScore(base, NOW));
    expect(hotScore({ ...base, replyCount: 9 }, NOW)).toBeGreaterThan(hotScore(base, NOW));
    expect(hotScore({ ...base, lastActivityAt: hoursAgo(30) }, NOW)).toBeLessThan(hotScore(base, NOW));
  });

  it('never goes negative for an activity time a little in the future (a clock that runs behind)', () => {
    const future = topic({ lastActivityAt: new Date(NOW.getTime() + 60_000), replyCount: 3 });
    expect(hotScore(future, NOW)).toBeGreaterThan(0);
  });
});

describe('the order of a list of topics', () => {
  const quiet = topic({ replyCount: 1, lastActivityAt: hoursAgo(40), createdAt: hoursAgo(50) });
  const busy = topic({ replyCount: 12, usefulCount: 3, lastActivityAt: hoursAgo(1), createdAt: hoursAgo(20) });
  const fresh = topic({ replyCount: 0, lastActivityAt: hoursAgo(0.2), createdAt: hoursAgo(0.2) });

  it('puts the busy recent topic first when asked for Hot', () => {
    expect(orderTopics([quiet, fresh, busy], 'hot', NOW).map((entry) => entry.discussionId)[0]).toBe(busy.discussionId);
  });

  it('puts the newest first when asked for New, by when the topic began and not by its last reply', () => {
    expect(orderTopics([quiet, busy, fresh], 'new', NOW).map((entry) => entry.discussionId)).toEqual([
      fresh.discussionId,
      busy.discussionId,
      quiet.discussionId,
    ]);
  });

  it('keeps only the topics no one but the starter has spoken in when asked for Unanswered', () => {
    const answered = topic({ answered: true, replyCount: 2 });
    const open = topic({ answered: false });
    expect(orderTopics([answered, open, fresh], 'unanswered', NOW).map((entry) => entry.discussionId)).toEqual([
      fresh.discussionId,
      open.discussionId,
    ]);
  });

  it('always leads with the pinned topics, whatever the sort', () => {
    const pinned = topic({ pinned: true, replyCount: 0, createdAt: hoursAgo(90), lastActivityAt: hoursAgo(90) });
    for (const sort of ['hot', 'new', 'unanswered'] as const)
      expect(orderTopics([busy, pinned, fresh], sort, NOW)[0]!.discussionId).toBe(pinned.discussionId);
  });

  it('breaks a tie by the newest activity and then the id, so every read agrees', () => {
    const first = topic({ createdAt: hoursAgo(3), lastActivityAt: hoursAgo(2) });
    const second = topic({ createdAt: hoursAgo(3), lastActivityAt: hoursAgo(1) });
    expect(orderTopics([first, second], 'new', NOW).map((entry) => entry.discussionId)).toEqual([
      second.discussionId,
      first.discussionId,
    ]);
    const sameA = topic({ createdAt: hoursAgo(3), lastActivityAt: hoursAgo(1) });
    const sameB = topic({ createdAt: hoursAgo(3), lastActivityAt: hoursAgo(1) });
    expect(orderTopics([sameB, sameA], 'new', NOW).map((entry) => entry.discussionId)).toEqual([
      sameA.discussionId,
      sameB.discussionId,
    ]);
  });
});
