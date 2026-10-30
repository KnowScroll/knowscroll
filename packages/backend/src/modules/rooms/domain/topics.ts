/**
 * How the list of topics is ordered (R3 B2, D-167). Pinned topics always lead. Hot is a code formula over what the
 * list already shows (replies, Useful marks, how recently someone spoke); there is no model and no score on screen.
 * No database or clock: the caller supplies `now`.
 */
export type TopicSort = 'hot' | 'new' | 'unanswered';

export interface TopicFacts {
  readonly discussionId: string;
  readonly pinned: boolean;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly replyCount: number;
  readonly usefulCount: number;
  /** Someone other than the starter has spoken in it. */
  readonly answered: boolean;
}

const HOUR_MS = 3_600_000;

/** Replies and Useful marks over how long since anyone spoke, softened so a fresh topic does not leap over a busy one. */
export function hotScore(topic: TopicFacts, now: Date): number {
  const hours = Math.max(0, (now.getTime() - topic.lastActivityAt.getTime()) / HOUR_MS);
  return (topic.replyCount + 2 * topic.usefulCount + 1) / (hours + 2) ** 1.5;
}

/**
 * The topics in the order a sort asks for: pinned first, then Hot (best first), New (newest first) or Unanswered (those
 * no one but the starter has spoken in, newest first). Ties fall to the newest activity and then the ID, so the order is
 * the same on every read.
 */
export function orderTopics<T extends TopicFacts>(topics: readonly T[], sort: TopicSort, now: Date): T[] {
  const chosen = sort === 'unanswered' ? topics.filter((topic) => !topic.answered) : [...topics];
  const key = (topic: T): number => (sort === 'hot' ? hotScore(topic, now) : topic.createdAt.getTime());
  return chosen.sort(
    (first, second) =>
      Number(second.pinned) - Number(first.pinned) ||
      key(second) - key(first) ||
      second.lastActivityAt.getTime() - first.lastActivityAt.getTime() ||
      first.discussionId.localeCompare(second.discussionId),
  );
}
