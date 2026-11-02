import type { PipelineResult } from './answer-pipeline.js';
import type { TurnOutcome } from './ports.js';

/**
 * How a turn ends when no message is posted: the answer was not wanted (the speaker left, the room paused, someone
 * answered first), there was none, or it could not be posted. The model was called unless the result says it was not, so
 * the turn stays counted; `declined` is an honest "nothing to add" or "the library does not cover it" from a resident that was
 * still allowed to speak, and anything else (a failure, a refusal, an authority that went meanwhile) is `failed`. How the answer
 * came out is kept with the turn.
 */
export function unpostedOutcome(
  result: Pick<PipelineResult, 'verdict' | 'support' | 'runs'>,
  allowed: boolean,
  at: Date,
): Exclude<TurnOutcome, { state: 'completed' }> {
  const { verdict } = result;
  const spoke = verdict.kind === 'nothing_to_add' || verdict.kind === 'not_covered';
  const declined = spoke && allowed;
  return {
    state: declined ? 'declined' : 'failed',
    at,
    // A declined turn is always counted: the schema holds that only a queued, failed or refused turn may not have been sent, and
    // a resident that was asked and had nothing to say used one of the asker's asks.
    dispatched: declined || (verdict.kind === 'failed' ? verdict.dispatched : result.runs.length > 0),
    ...(result.support === undefined ? {} : { support: result.support }),
  };
}
