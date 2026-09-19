/**
 * Pure discovery-selection helpers, mirroring apps/mobile/.../ui/ReaderDiscovery.kt.
 * "Next" is a deliberate, explicit action (Law 16: no obligation mechanics) that
 * never auto-advances; a finite editorial library eventually rests (Law 7).
 */
import type { FeedResponse, FeedItem } from '../api/types.ts';

export type DiscoverySelection =
  | { kind: 'item'; item: FeedItem }
  | { kind: 'exhausted' }
  | { kind: 'invalid-scope' };

export type DiscoveryState = 'idle' | 'loading' | 'failed' | 'exhausted';
export type KeepState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'kept'; jobId: string }
  | { status: 'failed'; message: string }
  | { status: 'conflict'; message: string };

/** Check scope even for an empty feed: exhaustion must never hide invalid authority. */
export function selectDiscovery(
  feed: FeedResponse,
  universeId: string,
  privacyEpoch: number,
  visited: ReadonlySet<string>,
  currentAssetId: string | undefined,
): DiscoverySelection {
  if (feed.universeId !== universeId || feed.privacyEpoch !== privacyEpoch) {
    return { kind: 'invalid-scope' };
  }
  const next = feed.items.find(item => !visited.has(item.assetId) && item.assetId !== currentAssetId);
  return next ? { kind: 'item', item: next } : { kind: 'exhausted' };
}

export function canRequestDiscovery(keep: KeepState, discovery: DiscoveryState): boolean {
  return discovery !== 'loading' && keep.status !== 'saving' && keep.status !== 'failed' && keep.status !== 'conflict';
}
