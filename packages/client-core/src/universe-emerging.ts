import { EmergingUniverseSchema } from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import type { AccountScope } from './account-scope';

/** One unlabelled cue: recent reading is gathering toward a system that is not established yet. */
export interface DustCue {
  readonly id: string;
}

export type DustRead =
  | { readonly status: 'ready'; readonly cues: readonly DustCue[]; readonly geographyRevision: number }
  | { readonly status: 'unavailable'; readonly reason: 'network' | 'authority' | 'invalid' | 'temporarily_unavailable' };

const AUTHORITY_CODES = ['UNAUTHENTICATED', 'FORBIDDEN', 'SCOPE_MISMATCH', 'PRIVACY_EPOCH_CHANGED', 'UNIVERSE_UNAVAILABLE'];

/**
 * Reads the dust cues of this account's universe (`POST /v1/universe/emerging/read`).
 *
 * Authority: the actual scope's own session; the reply must name the same universe and epoch.
 * Side effects: none. The server never forms a place from this read, and a cue is not a place:
 * the screen draws it unlabelled and never makes it tappable as a destination.
 * Failure: a typed `unavailable` outcome; nothing is retried here, the caller reads again on its
 * next foreground or geography change.
 */
export async function readDustCues(scope: AccountScope, signal?: AbortSignal): Promise<DustRead> {
  if (!scope.active) return { status: 'unavailable', reason: 'authority' };
  try {
    const raw = await scope.api.geography.emerging({}, signal ? { signal } : undefined);
    const parsed = EmergingUniverseSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.universeId !== scope.account.universeId ||
      parsed.data.privacyEpoch !== scope.account.privacyEpoch
    )
      return { status: 'unavailable', reason: 'invalid' };
    return {
      status: 'ready',
      cues: parsed.data.dust.map((cue) => ({ id: cue.id })),
      geographyRevision: parsed.data.geography.revision,
    };
  } catch (error) {
    const problem = apiProblem(error);
    if (problem) {
      return {
        status: 'unavailable',
        reason: AUTHORITY_CODES.includes(problem.code) ? 'authority' : 'temporarily_unavailable',
      };
    }
    return { status: 'unavailable', reason: error instanceof TypeError ? 'network' : 'invalid' };
  }
}
