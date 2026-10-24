import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

/** The words a friend's availability can be shown as. Anything else is shown as nothing. */
export type AvailabilityWord = 'online' | 'recently_active';

export interface AvailabilityState {
  /** Friends currently shown as available, by public person ID, with when each answer stops being fresh. */
  readonly fresh: ReadonlyMap<string, { readonly word: AvailabilityWord; readonly until: number }>;
}

export interface AvailabilitySession {
  readonly getState: () => AvailabilityState;
  readonly subscribe: (listener: () => void) => () => void;
  /** The word to show for a friend now, or nothing: unknown, hidden and expired are the same silence. */
  readonly wordOf: (personId: string) => AvailabilityWord | undefined;
  /** While the screen is in the foreground the answers are read again every `pollMs`. */
  readonly setForeground: (foreground: boolean) => void;
  readonly dispose: () => void;
}

export interface AvailabilitySessionOptions {
  readonly scope: AccountScope;
  readonly newId: () => string;
  readonly pollMs?: number;
  readonly now?: () => number;
}

export const AVAILABILITY_POLL_MS = 20_000;
const FRIENDS_PAGE = 50;
const MAX_PAGES = 4;

/**
 * Friends' availability for the Friends screen (blueprint §17). It reads the friends pages and keeps
 * only the words "Online" and "Recently active", each for the lease the server gave, counted from
 * when the read started: an answer older than its lease is dropped, so a friend whose app closed
 * cannot stay "Online" here, and a lost connection cannot extend a lease. Hidden, expired and
 * unknown are one answer on the wire, so there is nothing else to keep. Availability never says what
 * anyone is watching, and reading it is not consumption evidence.
 */
export function createAvailabilitySession(options: AvailabilitySessionOptions): AvailabilitySession {
  const { scope, newId } = options;
  const pollMs = options.pollMs ?? AVAILABILITY_POLL_MS;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let state: AvailabilityState = { fresh: new Map() };
  let poll: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  let ended = false;

  function publish(fresh: AvailabilityState['fresh']): void {
    if (ended || !scope.active) return;
    state = { fresh };
    for (const listener of [...listeners]) listener();
    scheduleExpiry();
  }

  /** The words stop at their lease even when no read comes: one timer for the earliest end. */
  function scheduleExpiry(): void {
    if (expiry !== undefined) clearTimeout(expiry);
    expiry = undefined;
    const ends = [...state.fresh.values()].map((entry) => entry.until);
    if (ends.length === 0) return;
    expiry = setTimeout(
      () => {
        const current = now();
        publish(new Map([...state.fresh].filter(([, entry]) => entry.until > current)));
      },
      Math.max(0, Math.min(...ends) - now()) + 1,
    );
  }

  async function readOnce(): Promise<void> {
    const startedAt = now();
    const fresh = new Map<string, { word: AvailabilityWord; until: number }>();
    try {
      let cursor: Parameters<typeof scope.api.friendPages.friends>[0]['cursor'];
      for (let pages = 0; pages < MAX_PAGES; pages += 1) {
        const page = await scope.api.friendPages.friends({
          version: 'friend-pages.v2',
          requestId: newId(),
          filter: 'friends',
          limit: FRIENDS_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items)
          if (item.state === 'friends' && item.availability.state !== 'unknown')
            fresh.set(item.peer.personId, {
              word: item.availability.state,
              until: startedAt + item.availability.validForMs,
            });
        cursor = page.next;
        if (cursor === undefined) break;
      }
      publish(fresh);
    } catch (error) {
      // No answer: what is shown ages out on its own lease; nothing is extended.
      if (talkFailure(error) === 'ended') return;
    }
  }

  const read = (): Promise<void> => (reading ??= readOnce().finally(() => (reading = undefined)));

  function dispose(): void {
    ended = true;
    if (poll !== undefined) clearInterval(poll);
    if (expiry !== undefined) clearTimeout(expiry);
    poll = expiry = undefined;
    listeners.clear();
    state = { fresh: new Map() };
  }
  scope.onEnd?.(dispose);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    wordOf(personId) {
      const entry = state.fresh.get(personId);
      return entry !== undefined && entry.until > now() ? entry.word : undefined;
    },
    setForeground(foreground) {
      if (ended) return;
      if (poll !== undefined) clearInterval(poll);
      poll = undefined;
      if (!foreground) return;
      void read();
      poll = setInterval(() => void read(), pollMs);
    },
    dispose,
  };
}
