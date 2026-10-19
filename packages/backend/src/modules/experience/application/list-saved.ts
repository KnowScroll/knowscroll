import type { PersonalAuthority } from '../../identity/public.js';
import type { ListSavedPorts, SavedItem } from './ports.js';

export const SAVED_PAGE_LIMIT = 100;

export type ListSavedResult =
  | { readonly kind: 'read'; readonly revision: number; readonly items: readonly SavedItem[] }
  | { readonly kind: 'refused'; readonly reason: 'universe_unavailable' | 'epoch_changed' };

/**
 * `listSaved`: the caller's saved items, newest first, at most `limit` (≤ 100), with the universe
 * revision they were read at so a client can compare it with `scope_changed` hints.
 * Authority is rechecked by the read (no lock: reads never block commands). Read-only.
 */
export function makeListSaved(ports: ListSavedPorts) {
  return async function listSaved(authority: PersonalAuthority, limit: number): Promise<ListSavedResult> {
    return ports.readSavedItems(authority, Math.max(1, Math.min(SAVED_PAGE_LIMIT, Math.trunc(limit))));
  };
}

export type ListSaved = ReturnType<typeof makeListSaved>;
