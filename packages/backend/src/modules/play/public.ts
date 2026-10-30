/**
 * Play's framework-free public surface (D-063, D-064, D-180): the calls a person locks on a Scroll
 * and the sparks and combo they earn.
 *
 * Play is a wall, not a signal. Which option a person picked, whether it was right, sparks and
 * combo are shown back to the person and exported to them; they never reach ranking, planning,
 * evidence, formation or the Universe. The modules that do those jobs (`composer`, `planner`,
 * `evidence`, `personal-context`, `geography`, `scenes`, and the reasoning engine they call) are
 * forbidden from importing this module, and this module from importing them: the dependency rule
 * `play-wall` in `.dependency-cruiser.cjs`, proved by `pnpm boundaries:probe`.
 */
import type { LockCall } from './application/lock-call.js';
import type { ReadResults } from './application/read-results.js';

export type { CallLockRefusal, CallLockResult } from './application/lock-call.js';
export type { ReadResultsResult } from './application/read-results.js';

export interface PlayUseCases {
  readonly lockCall: LockCall;
  readonly readResults: ReadResults;
}

export const PLAY_USE_CASES = Symbol('play.useCases');
