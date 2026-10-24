import { apiProblem } from './api-client';
import { ScopeEndedError } from './account-scope';

/**
 * Why a Talk request did not give an answer, in the few ways a screen treats differently:
 * - `ended`: the account scope ended meanwhile; the request is moot and nothing should be shown.
 * - `unavailable`: the server refuses without a reason (not a member, blocked, closed, withdrawn).
 * - `stale`: the person's view of a revision is old; read again.
 * - `offline`: the request got no answer (network); the outcome of a command is unknown.
 * - `failed`: the server answered with an error that retrying later may fix.
 */
export type TalkFailure = 'ended' | 'unavailable' | 'stale' | 'offline' | 'failed';

/** Classifies a thrown request error; reads only the problem code, never a received body. */
export function talkFailure(error: unknown): TalkFailure {
  if (error instanceof ScopeEndedError) return 'ended';
  const problem = apiProblem(error);
  if (problem === undefined) return 'offline';
  if (problem.code === 'SHARING_UNAVAILABLE' || problem.code === 'FORBIDDEN') return 'unavailable';
  if (problem.code === 'SHARING_REVISION_STALE' || problem.code === 'CONFLICT') return 'stale';
  return 'failed';
}
