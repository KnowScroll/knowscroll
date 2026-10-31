import type { ReadLandmarksResponse } from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import type { PlayPorts } from './ports.js';

export type ReadLandmarksResult =
  | { readonly kind: 'landmarks'; readonly landmarks: ReadLandmarksResponse['landmarks'] }
  | { readonly kind: 'refused'; readonly reason: 'epoch_changed' | 'universe_unavailable' };

/**
 * `POST /v1/play/landmarks/read`: the landmarks the caller has earned, newest first. Their own rows
 * only, at their current epoch. A read, so it answers while recording is paused (what was saved
 * before the pause is still theirs to see) and writes nothing. The Universe overlay and the tray read
 * it later; a landmark never makes a place form (D-063, D-084).
 */
export function makeReadLandmarks(ports: Pick<PlayPorts, 'withPersonalScope' | 'fenceOwn' | 'store'>) {
  return async (authority: PersonalAuthority): Promise<ReadLandmarksResult> => {
    const entered = await ports.withPersonalScope(authority, async (scope) => {
      if ((await ports.fenceOwn(scope)).kind !== 'active') return undefined;
      return ports.store.listLandmarks(scope);
    });
    if (entered.kind === 'refused')
      return {
        kind: 'refused',
        reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
      };
    if (entered.value === undefined) return { kind: 'refused', reason: 'universe_unavailable' };
    return {
      kind: 'landmarks',
      landmarks: entered.value.map((listing) => ({
        assetId: listing.assetId,
        revision: listing.revision,
        key: listing.key,
        name: listing.name,
        tier: listing.tier,
        earnedAt: listing.earnedAt.toISOString(),
      })),
    };
  };
}

export type ReadLandmarks = ReturnType<typeof makeReadLandmarks>;
