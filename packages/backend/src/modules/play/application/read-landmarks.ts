import type { ReadLandmarksResponse } from '@knowscroll/contracts';
import type { PersonalAuthority } from '../../identity/public.js';
import { landmarkTopicOf } from '../domain/landmark-topic.js';
import type { PlayPorts } from './ports.js';

export type ReadLandmarksResult =
  | { readonly kind: 'landmarks'; readonly landmarks: ReadLandmarksResponse['landmarks'] }
  | { readonly kind: 'refused'; readonly reason: 'epoch_changed' | 'universe_unavailable' };

/**
 * `POST /v1/play/landmarks/read`: the landmarks the caller has earned, newest first, each with the
 * catalogue topic of its Scroll. Their own rows only, at their current epoch. A read, so it answers
 * while recording is paused (what was saved before the pause is still theirs to see) and writes
 * nothing. The Universe sets a landmark on the planet of its topic, or keeps it in the tray until
 * that planet forms; a landmark never makes a place form (D-063, D-084, D-214).
 */
export function makeReadLandmarks(ports: Pick<PlayPorts, 'withPersonalScope' | 'fenceOwn' | 'store' | 'readTopics'>) {
  return async (authority: PersonalAuthority): Promise<ReadLandmarksResult> => {
    const entered = await ports.withPersonalScope(authority, async (scope) => {
      if ((await ports.fenceOwn(scope)).kind !== 'active') return undefined;
      const listings = await ports.store.listLandmarks(scope);
      const earned: ReadLandmarksResponse['landmarks'] = [];
      for (const listing of listings) {
        const topicId = landmarkTopicOf(
          await ports.readTopics(scope, { assetId: listing.assetId, assetRevision: listing.revision }),
        );
        earned.push({
          assetId: listing.assetId,
          revision: listing.revision,
          key: listing.key,
          name: listing.name,
          tier: listing.tier,
          earnedAt: listing.earnedAt.toISOString(),
          ...(topicId === undefined ? {} : { topicId }),
        });
      }
      return earned;
    });
    if (entered.kind === 'refused')
      return {
        kind: 'refused',
        reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
      };
    if (entered.value === undefined) return { kind: 'refused', reason: 'universe_unavailable' };
    return { kind: 'landmarks', landmarks: entered.value };
  };
}

export type ReadLandmarks = ReturnType<typeof makeReadLandmarks>;
