import type { NewDebate } from '@knowscroll/contracts';
import { DEBATE_MIN_VOTERS } from './sky.js';

/**
 * Debates (R3 B and E, D-176): a topic tagged `debate` carries two sides and a close time. Pure rules only.
 */

/** Whether a start that names a tag and maybe a debate is well formed: the tag `debate` needs one, any other refuses it. */
export function debateStartProblem(
  tag: string | undefined,
  debate: NewDebate | undefined,
): 'needs_debate' | 'not_a_debate' | undefined {
  if (tag === 'debate') return debate === undefined ? 'needs_debate' : undefined;
  return debate === undefined ? undefined : 'not_a_debate';
}

/** When a debate started at `now` closes. */
export const closesAtOf = (now: Date, closesInHours: number): Date =>
  new Date(now.getTime() + closesInHours * 3_600_000);

/** Whether a debate is closed to votes at `now`: a vote at or after the close time does not count. */
export const isClosedAt = (closesAt: Date, now: Date): boolean => now.getTime() >= closesAt.getTime();

export type DebateResult = {
  readonly voters: number;
  /** The side with more votes; none on a tie (or when no one voted). */
  readonly winner: 'a' | 'b' | undefined;
  /** Whether the close earns the room a star. */
  readonly earnsStar: boolean;
};

/** What closing a debate with these tallies means: who won, and whether enough different people voted for a star. */
export function resultOf(votes: { readonly a: number; readonly b: number }): DebateResult {
  const voters = votes.a + votes.b;
  return {
    voters,
    winner: votes.a === votes.b ? undefined : votes.a > votes.b ? 'a' : 'b',
    earnsStar: voters >= DEBATE_MIN_VOTERS,
  };
}
