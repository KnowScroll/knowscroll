import type { ReadScrollResultsRequest, ScrollResults } from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import type { PlayPorts } from './ports.js';
import { resultsOf } from './results.js';

export type ReadResultsResult =
  | { readonly kind: 'results'; readonly results: ScrollResults }
  | { readonly kind: 'refused'; readonly reason: 'epoch_changed' | 'universe_unavailable' };

/**
 * `POST /v1/play/results/read`: what the caller has locked on one Scroll revision, the sparks and
 * the combo. Their own rows only, at their current epoch; a revision they never played reads as
 * nothing locked. A read, so it answers while recording is paused (what was saved before the pause
 * is still theirs to see) and writes nothing.
 */
export function makeReadResults(ports: Pick<PlayPorts, 'withPersonalScope' | 'fenceOwn' | 'store'>) {
  return async (authority: PersonalAuthority, request: ReadScrollResultsRequest): Promise<ReadResultsResult> => {
    const entered = await ports.withPersonalScope(authority, async (scope) => {
      if ((await ports.fenceOwn(scope)).kind !== 'active') return undefined;
      return ports.store.readPlay(scope, request.assetId, request.revision);
    });
    if (entered.kind === 'refused')
      return {
        kind: 'refused',
        reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
      };
    if (entered.value === undefined) return { kind: 'refused', reason: 'universe_unavailable' };
    return { kind: 'results', results: resultsOf(request, entered.value) };
  };
}

export type ReadResults = ReturnType<typeof makeReadResults>;
