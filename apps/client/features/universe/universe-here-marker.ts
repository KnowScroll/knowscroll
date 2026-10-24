import type { AccountScope } from '@knowscroll/client-core';

/**
 * "You were here" (U04): the region a person left through its card's Open, so that coming back
 * shows where they were. It is a private convenience of this device, kept in the account scope's
 * storage, so it is purged with the scope on logout, account switch and privacy reset. It is never
 * sent anywhere and is never evidence of anything.
 */
const KEY = 'universe.here.v1';
/** A marker this old no longer says anything useful, so it is dropped. */
export const HERE_MARKER_MS = 14 * 24 * 60 * 60 * 1000;
/** Region IDs are opaque; anything longer than this is not one of ours. */
const MAX_ID = 200;

/**
 * The region id left from, or undefined when there is none. A value that is too old, dated in the
 * future or not ours is removed as it is read, so nothing stale stays on the device.
 */
export function readHereMarker(scope: Pick<AccountScope, 'active' | 'storage'>, now: number): string | undefined {
  if (!scope.active) return undefined;
  let raw: string | undefined;
  try {
    raw = scope.storage.get(KEY);
    if (raw === undefined || raw === '') return undefined;
    const marker = parseMarker(raw, now);
    if (marker !== undefined) return marker;
  } catch {
    // Unreadable storage or a damaged value is treated as stale below.
  }
  clearHereMarker(scope);
  return undefined;
}

function parseMarker(raw: string, now: number): string | undefined {
  if (raw.length > 400) return undefined;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return undefined;
  const { placeId, at } = value as { placeId?: unknown; at?: unknown };
  if (typeof placeId !== 'string' || placeId.length === 0 || placeId.length > MAX_ID) return undefined;
  if (typeof at !== 'number' || now - at > HERE_MARKER_MS || at > now + 60_000) return undefined;
  return placeId;
}

export function writeHereMarker(scope: Pick<AccountScope, 'active' | 'storage'>, placeId: string, now: number): void {
  if (!scope.active) return;
  try {
    scope.storage.set(KEY, JSON.stringify({ placeId, at: now }));
  } catch {
    // Storage may be full or blocked; the marker is a convenience.
  }
}

export function clearHereMarker(scope: Pick<AccountScope, 'storage'>): void {
  try {
    scope.storage.remove(KEY);
  } catch {
    // Nothing to clear if storage is blocked.
  }
}
