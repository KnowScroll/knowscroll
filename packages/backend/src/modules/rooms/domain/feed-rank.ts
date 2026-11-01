/**
 * How the room's Feed is ordered (v3 R-8b, D-272): Hot, New and Top. Pure: facts in, an order out, with no database, clock, model
 * or network. Only people's votes count, and the ranking is the same for every reader (a block changes who is listed, never the
 * order or the count), so neither says who voted.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What ranking reads of a post. */
export interface Ranked {
  readonly discussionId: string;
  readonly postedAt: Date;
  /** People's votes. */
  readonly votes: number;
}

export type FeedSort = 'hot' | 'new' | 'top';
export type FeedWindow = 'day' | 'week' | 'month' | 'all';

/** The numbers behind the order. A post is a find, not a conversation, so replies do not lift it: only votes do. */
export const RANK_RULES = {
  /** How steeply a post sinks: the age's power in the divisor. Topics use the same shape (D-168). */
  gravity: 1.5,
  /** Hours added to the age, so a post a minute old does not outrank everything on its first vote. */
  ageOffsetHours: 2,
  /** How many of the newest posts Hot ranks. An old post still in them sinks by its age; the rest are in New and Top. */
  hotCandidates: 100,
  /** The window Top uses unless a member picks another. */
  defaultWindow: 'week' as FeedWindow,
} as const;

/**
 * A post's Hot score: `(votes + 1) / (hours since it was posted + 2) ^ 1.5`. The one in the numerator is every post's own, so a
 * new post with no votes is seen once and outranks an older one with a few; a vote keeps a post up and its age brings it down. A
 * time in the future (a clock that moved) counts as just posted. The score is for ordering and is never shown.
 */
export function hotScore(votes: number, now: Date, postedAt: Date): number {
  const hours = Math.max(0, now.getTime() - postedAt.getTime()) / HOUR_MS;
  return (votes + 1) / (hours + RANK_RULES.ageOffsetHours) ** RANK_RULES.gravity;
}

/** The newer post first, then the larger ID, so equal times give one order everywhere. */
const newestFirst = (a: Ranked, b: Ranked): number =>
  b.postedAt.getTime() - a.postedAt.getTime() ||
  (a.discussionId < b.discussionId ? 1 : a.discussionId > b.discussionId ? -1 : 0);

/** Hot: the highest score first; ties fall to the newer post, then the ID. */
export function sortHot<T extends Ranked>(posts: readonly T[], now: Date): T[] {
  return posts
    .map((post) => ({ post, score: hotScore(post.votes, now, post.postedAt) }))
    .sort((a, b) => b.score - a.score || newestFirst(a.post, b.post))
    .map((entry) => entry.post);
}

/** New: the newest first; equal times fall to the ID. */
export const sortNew = <T extends Ranked>(posts: readonly T[]): T[] => [...posts].sort(newestFirst);

/** Top: the most votes first; ties fall to the newer post, then the ID. */
export const sortTop = <T extends Ranked>(posts: readonly T[]): T[] =>
  [...posts].sort((a, b) => b.votes - a.votes || newestFirst(a, b));

/** Puts `posts` in the order a sort asks for. */
export function arrange<T extends Ranked>(posts: readonly T[], sort: FeedSort, now: Date): T[] {
  return sort === 'hot' ? sortHot(posts, now) : sort === 'top' ? sortTop(posts) : sortNew(posts);
}

/** The start of the window Top counts, or none for every post. A day is the last 24 hours, a week 7 days, a month 30 days. */
export function windowStart(window: FeedWindow, now: Date): Date | undefined {
  if (window === 'all') return undefined;
  const days = window === 'day' ? 1 : window === 'week' ? 7 : 30;
  return new Date(now.getTime() - days * DAY_MS);
}
