import type { FriendsFailure, FriendsState } from '@knowscroll/client-core';
import type { OuterFriend } from './friend-order';

/**
 * Reads every friend from the roster, page after page, through the Friends session (which already binds each reply to
 * its request, caps its size, refuses a cursor it has used and ends on a lost account). Only what the Friends list
 * already shows is kept: person id, handle and display name. The presence the roster carries is dropped here.
 */

/** What of a `FriendsSession` the read uses (so a test can hold a small one). */
export interface FriendsPager {
  getState(): FriendsState;
  selectFilter(filter: 'friends'): Promise<void>;
  nextPage(): Promise<void>;
}

export type FriendsRead =
  /** Every friend, or (`complete` false) the first pages of a roster longer than the read goes on for. */
  | { readonly status: 'ready'; readonly friends: readonly OuterFriend[]; readonly complete: boolean }
  /** The read stopped part way: the friends so far, never presented as all of them. */
  | { readonly status: 'offline' | 'failed'; readonly friends: readonly OuterFriend[]; readonly complete: false };

export interface ReadOptions {
  /** Most pages read (50 friends each): 8 is 400 friends. */
  readonly maxPages?: number;
  /** How many times a roster that changed while it was being read is started again from page one. */
  readonly restarts?: number;
  /** Stop going on after this long (ms); what has been read is kept. */
  readonly budgetMs?: number;
  readonly now?: () => number;
  /** False once the caller no longer wants the answer (a screen left, an account ended). */
  readonly wanted?: () => boolean;
}

/** A continuation the server will not honour any more: the roster changed under the read. */
const CHANGED: readonly FriendsFailure[] = ['refresh_required', 'conflict', 'unavailable', 'invalid'];

export async function readAllFriends(session: FriendsPager, options: ReadOptions = {}): Promise<FriendsRead> {
  const { maxPages = 8, restarts = 2, budgetMs = 20_000, now = Date.now, wanted = () => true } = options;
  const until = now() + budgetMs;
  let collected: OuterFriend[] = [];
  for (let attempt = 0; attempt <= restarts; attempt += 1) {
    collected = [];
    const seen = new Set<string>();
    let pages = 0;
    await session.selectFilter('friends');
    for (;;) {
      const state = session.getState();
      if (!wanted() || state.status !== 'active') return { status: 'failed', friends: collected, complete: false };
      const roster = state.roster;
      if (roster.status === 'unavailable') {
        // A page after the first that the server refuses means the roster changed: start again, as the session does.
        if (pages > 0 && CHANGED.includes(roster.reason) && attempt < restarts) break;
        return {
          status: roster.reason === 'network' ? 'offline' : 'failed',
          friends: collected,
          complete: false,
        };
      }
      // A read that was superseded or has not answered: the session holds no ready roster, so there is nothing to take.
      if (roster.status !== 'ready') return { status: 'failed', friends: collected, complete: false };
      for (const item of roster.data.items) {
        if (item.state !== 'friends' || seen.has(item.peer.personId)) continue;
        seen.add(item.peer.personId);
        collected.push({ personId: item.peer.personId, handle: item.peer.handle, name: item.peer.displayName });
      }
      pages += 1;
      // Only the absence of a continuation ends the roster: an empty page with one is progress, not the end.
      if (roster.data.next === undefined) return { status: 'ready', friends: collected, complete: true };
      if (pages >= maxPages || now() >= until) return { status: 'ready', friends: collected, complete: false };
      await session.nextPage();
    }
  }
  return { status: 'failed', friends: collected, complete: false };
}
