import type { AccountScope } from '@knowscroll/client-core';

/**
 * The landmark the person has already looked at or put away (#694): once they press See it or close the large
 * landmark card, the card folds to its one-line pill for that landmark, and opens in full again only for a newer one.
 *
 * It is a private convenience of this device, kept in the account scope's storage, so it is purged with the scope on
 * logout, account switch and privacy reset. It is never sent anywhere, never evidence, and never changes the landmark
 * itself: the landmark, its list and its pennant all stay.
 */
const KEY = 'universe.landmark-seen.v1';
/** Landmark ids are `<assetId>:<revision>`; anything longer than this is not one of ours. */
const MAX_ID = 200;

/** The id of the landmark last seen or put away, or undefined when there is none. A damaged value is removed as it is read. */
export function readSeenLandmark(scope: Pick<AccountScope, 'active' | 'storage'>): string | undefined {
  if (!scope.active) return undefined;
  try {
    const raw = scope.storage.get(KEY);
    if (raw === undefined || raw === '') return undefined;
    if (raw.length <= MAX_ID + 32) {
      const value: unknown = JSON.parse(raw);
      const id =
        typeof value === 'object' && value !== null ? (value as { landmarkId?: unknown }).landmarkId : undefined;
      if (typeof id === 'string' && id.length > 0 && id.length <= MAX_ID) return id;
    }
  } catch {
    // Unreadable storage or a damaged value is cleared below.
  }
  clearSeenLandmark(scope);
  return undefined;
}

export function writeSeenLandmark(scope: Pick<AccountScope, 'active' | 'storage'>, landmarkId: string): void {
  if (!scope.active || landmarkId.length === 0 || landmarkId.length > MAX_ID) return;
  try {
    scope.storage.set(KEY, JSON.stringify({ landmarkId }));
  } catch {
    // Storage may be full or blocked; the card then simply folds for this visit only.
  }
}

function clearSeenLandmark(scope: Pick<AccountScope, 'storage'>): void {
  try {
    scope.storage.remove(KEY);
  } catch {
    // Nothing to clear if storage is blocked.
  }
}
