/**
 * Rules of "Challenge a friend" that need no database, clock or crypto (D-245).
 *
 * A challenge is one question of one exact Scroll revision, sent into a direct conversation. Each of the two people locks
 * one pick. Nobody sees the other's pick, or the right answer, before they have locked their own; once both have locked,
 * both see both picks and the answer. A pick is a play result (D-063): these rules read nothing about what anyone watched
 * and return only what to show the reader, so no pick or right answer leaves through them.
 */

/** One stored pick: whose, and which option. Never a time of day. */
export interface ChallengePickRow {
  readonly accountId: string;
  readonly option: number;
}

/**
 * What one reader may see of one challenge.
 * - `open`: they have not locked and may. Nothing about the friend, not even whether they have called.
 * - `locked`: they locked and the friend has not. Their own pick only.
 * - `revealed`: both locked. Both picks.
 */
export type ChallengeView =
  | { readonly stage: 'open' }
  | { readonly stage: 'locked'; readonly option: number }
  | { readonly stage: 'revealed'; readonly option: number; readonly theirs: number };

/**
 * The reader's view from the picks of a conversation's call. The conversation has two people, so "theirs" is the pick of
 * anyone else. A friend whose account is gone has no pick left (erasure removes it) and the card stays `locked`; a
 * friend who is blocked either way cannot be reached at all, because the conversation is not entered (D-042).
 */
export function viewChallenge(readerAccountId: string, picks: readonly ChallengePickRow[]): ChallengeView {
  const own = picks.find((pick) => pick.accountId === readerAccountId);
  if (own === undefined) return { stage: 'open' };
  const theirs = picks.find((pick) => pick.accountId !== readerAccountId);
  return theirs === undefined
    ? { stage: 'locked', option: own.option }
    : { stage: 'revealed', option: own.option, theirs: theirs.option };
}
