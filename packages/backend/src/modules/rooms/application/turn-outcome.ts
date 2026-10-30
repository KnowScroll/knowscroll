import type { ContributionVerdict } from './inhabitant-role.js';
import type { TurnOutcome } from './ports.js';

/**
 * How a turn ends when no message is posted: the answer was not wanted (the speaker left, the room paused, someone
 * answered first) or there was none. The model was called unless the verdict says it was not, so the turn
 * stays counted; `declined` is an honest "nothing to add" from a resident that was still allowed to speak, and
 * anything else (a failure, a refusal, an authority that went meanwhile) is `failed`.
 */
export function unpostedOutcome(
  verdict: ContributionVerdict,
  allowed: boolean,
  at: Date,
): Exclude<TurnOutcome, { state: 'completed' }> {
  return {
    state: verdict.kind === 'nothing_to_add' && allowed ? 'declined' : 'failed',
    at,
    dispatched: verdict.kind === 'failed' ? verdict.dispatched : true,
  };
}
