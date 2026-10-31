/**
 * Play's framework-free public surface (D-063, D-064, D-180, D-187, D-188): the calls a person locks on a
 * Scroll, the sparks and combo they earn, and the landmark a Final call awards.
 *
 * Play is a wall, not a signal. Which option a person picked, whether it was right, sparks and
 * combo are shown back to the person and exported to them; they never reach ranking, planning,
 * evidence, formation or the Universe. Only the apps' composition roots, tests and the erasure
 * registry may import this module, and it imports only the public surfaces of `identity`, `content`
 * and `experience`: two allow-lists (`play-wall-*` in `.dependency-cruiser.cjs`), so a module the
 * lists never named, and a path through one, is walled too. `pnpm boundaries:probe` proves they fail.
 */
import type { LockCall } from './application/lock-call.js';
import type { ReadLandmarks } from './application/read-landmarks.js';
import type { ReadResults } from './application/read-results.js';

export type { CallLockRefusal, CallLockResult } from './application/lock-call.js';
export type { ReadLandmarksResult } from './application/read-landmarks.js';
export type { ReadResultsResult } from './application/read-results.js';

export interface PlayUseCases {
  readonly lockCall: LockCall;
  readonly readResults: ReadResults;
  readonly readLandmarks: ReadLandmarks;
}

export const PLAY_USE_CASES = Symbol('play.useCases');
