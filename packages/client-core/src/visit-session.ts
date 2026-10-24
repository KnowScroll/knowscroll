import type { PublicPersonRef, VisitorWorldSnapshot } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

type Available = Extract<VisitorWorldSnapshot, { status: 'available' }>;
export type VisitedSystem = Available['projection']['systems'][number];

/** Who to visit: by handle (a link, a friend row) or by public person ID. */
export type VisitTarget =
  { readonly kind: 'handle'; readonly handle: string } | { readonly kind: 'person'; readonly personId: string };

export type VisitState =
  | { readonly status: 'loading' }
  /** The shared list. `stale` is set while reads fail: the last list is shown only for a short while. */
  | {
      readonly status: 'ready';
      readonly owner: PublicPersonRef;
      readonly systems: readonly VisitedSystem[];
      readonly stale: boolean;
    }
  /**
   * Not shown. Never shared with you, no longer shared, an ended friendship, a block, an unknown
   * person: the server gives one answer for all of them, so this state cannot say which.
   * `wasShown` is the visitor's own memory of this visit, not something the server said.
   */
  | { readonly status: 'unavailable'; readonly wasShown: boolean; readonly ownerName: string | undefined }
  | { readonly status: 'offline' }
  | { readonly status: 'ended' };

export interface VisitSession {
  readonly getState: () => VisitState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the visit now. Every read rechecks the friendship and the owner's audience on the server. */
  readonly read: () => Promise<void>;
  /** While the screen is in the foreground the visit rereads every `pollMs`, so a revocation shows soon. */
  readonly setForeground: (foreground: boolean) => void;
  /** Drops the list and stops polling. Nothing of a visit is kept after this. */
  readonly dispose: () => void;
}

export interface VisitSessionOptions {
  readonly scope: AccountScope;
  readonly target: VisitTarget;
  readonly pollMs?: number;
  /** How long the last list stays on screen while reads get no answer. */
  readonly staleMs?: number;
  readonly now?: () => number;
}

export const VISIT_POLL_MS = 15_000;
export const VISIT_STALE_MS = 2 * 60_000;

/**
 * The data behind U06, the friend visit. It holds one list in memory, replaced by every read and
 * dropped the moment a read says the visit is not available: nothing is cached on disk or in a query
 * cache, so "nothing from it is kept on your side" is literally true. Visiting is a read of what the
 * owner chose to publish. It is never consumption evidence for either person, and the session never
 * reports that anyone visited anything.
 *
 * Revocation reaches the visitor on the next read: at most `pollMs` while the screen is open, at once
 * when it comes back to the foreground. An offline visitor keeps the last list for `staleMs` and then
 * loses it, so a revocation cannot be hidden by losing the connection.
 */
export function createVisitSession(options: VisitSessionOptions): VisitSession {
  const { scope, target } = options;
  const pollMs = options.pollMs ?? VISIT_POLL_MS;
  const staleMs = options.staleMs ?? VISIT_STALE_MS;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let state: VisitState = { status: 'loading' };
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastAnswerAt = now();
  let shown = false;
  let ownerName: string | undefined;
  let reading: Promise<void> | undefined;
  let ended = false;

  function publish(next: VisitState): void {
    if (ended || !scope.active) return;
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  async function readOnce(): Promise<void> {
    try {
      const snapshot = await scope.api.sharing.visit({
        version: 'sharing.v1',
        target,
        capabilities: { presentations: ['list.v1'] },
      });
      lastAnswerAt = now();
      if (snapshot.status === 'available') {
        shown = true;
        ownerName = snapshot.owner.displayName;
        publish({ status: 'ready', owner: snapshot.owner, systems: snapshot.projection.systems, stale: false });
      } else publish({ status: 'unavailable', wasShown: shown, ownerName: shown ? ownerName : undefined });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') {
        publish({ status: 'unavailable', wasShown: shown, ownerName: shown ? ownerName : undefined });
        return;
      }
      // No answer, or an answer that is not one: keep the last list briefly, then drop it.
      if (state.status === 'ready' && now() - lastAnswerAt < staleMs) publish({ ...state, stale: true });
      else publish({ status: 'offline' });
    }
  }

  const read = (): Promise<void> => (reading ??= readOnce().finally(() => (reading = undefined)));

  function dispose(): void {
    ended = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    listeners.clear();
    state = { status: 'ended' };
  }
  scope.onEnd?.(dispose);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read,
    setForeground(foreground) {
      if (ended) return;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (!foreground) return;
      void read();
      timer = setInterval(() => void read(), pollMs);
    },
    dispose,
  };
}
