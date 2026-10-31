import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import { lockOf, type StageKeeping, type StageLandmark, type StagePlay } from './stage-play';

/** How the Final call stands at the end of the Scroll. */
export type FinalCallStanding = 'right' | 'wrong' | 'open';

/**
 * What the payoff at the end of a Scroll shows of the person's play (D-187, D-188): the sparks and
 * the best run of right calls, how the Final call went, and the landmark it awarded. It is read off
 * the play layer for this one Scroll and never summed across Scrolls (D-064).
 */
export interface Payoff {
  readonly sparks: number;
  /** The longest run of right calls; shown only from two. */
  readonly bestCombo: number;
  readonly final: FinalCallStanding;
  readonly landmark: StageLandmark | undefined;
  /** Whether the Final call's lock is kept: the payoff says so when it is not (paused, waiting, refused). */
  readonly keeping: StageKeeping | undefined;
}

/** The payoff of a Scroll's play. Pure. */
export function payoffOf(calls: readonly (CallItStop | FinalCallStop)[], play: StagePlay): Payoff {
  const finalCall = calls.find((call) => call.kind === 'final_call');
  const finalLock = finalCall === undefined ? undefined : lockOf(play, finalCall.id);
  return {
    sparks: play.sparks,
    bestCombo: Math.max(0, ...play.locks.map((lock) => lock.combo)),
    final: finalLock === undefined ? 'open' : finalLock.correct ? 'right' : 'wrong',
    landmark: play.landmark,
    keeping: finalLock?.keeping,
  };
}
