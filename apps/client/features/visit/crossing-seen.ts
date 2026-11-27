import type { AccountScope } from '@knowscroll/client-core';

/**
 * The friends whose crossing this device has already shown (Round 7.3): the first time for a friend the film takes 7.5 s,
 * after that 3.6 s. It is a private convenience of this device, kept in the account scope's storage, so it is purged with
 * the scope on logout, account switch and privacy reset. It holds the public handles you visited and nothing else of them,
 * is never sent anywhere, never evidence, and does not change what a visit reads or shows.
 */
const KEY = 'universe.crossing-seen.v1';
/** The newest this many friends are kept; a person with more friends than this sees the long film again for the oldest. */
const MAX_FRIENDS = 200;
/** A handle longer than this is not one of ours. */
const MAX_HANDLE = 64;

type Scope = Pick<AccountScope, 'active' | 'storage'>;

/** Handles are public and compared without case. */
const keyOf = (handle: string): string => handle.trim().toLowerCase();

function read(scope: Scope): readonly string[] {
  if (!scope.active) return [];
  try {
    const raw = scope.storage.get(KEY);
    if (raw === undefined || raw === '') return [];
    if (raw.length <= MAX_FRIENDS * (MAX_HANDLE + 4) + 32) {
      const value: unknown = JSON.parse(raw);
      const list = typeof value === 'object' && value !== null ? (value as { handles?: unknown }).handles : undefined;
      if (Array.isArray(list) && list.every((item) => typeof item === 'string' && item.length <= MAX_HANDLE))
        return (list as string[]).slice(-MAX_FRIENDS);
    }
  } catch {
    // Unreadable storage or a damaged value is cleared below.
  }
  try {
    scope.storage.remove(KEY);
  } catch {
    // Nothing to clear if storage is blocked.
  }
  return [];
}

/** Whether the crossing to this friend has been shown on this device for this account. A damaged value is removed as it is read. */
export function crossingSeen(scope: Scope, handle: string): boolean {
  const key = keyOf(handle);
  return key !== '' && read(scope).includes(key);
}

/** Notes that the crossing to this friend has been shown. The newest are kept when there are too many. */
export function markCrossingSeen(scope: Scope, handle: string): void {
  const key = keyOf(handle);
  if (!scope.active || key === '' || key.length > MAX_HANDLE) return;
  try {
    const handles = [...read(scope).filter((seen) => seen !== key), key].slice(-MAX_FRIENDS);
    scope.storage.set(KEY, JSON.stringify({ handles }));
  } catch {
    // Storage may be full or blocked; the long film then plays again next time, which is harmless.
  }
}
