import type { SessionSummary } from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

interface SessionsOwner {
  readonly api: Pick<ApiClient, 'account'>;
  readonly active: boolean;
}

/** What is being signed out: one session, or every other one. */
export type SessionsEnding = { readonly kind: 'session'; readonly id: string } | { readonly kind: 'others' };

/**
 * The person's own sessions for Account (P01). `readAt` is when the list was read (milliseconds),
 * so "last used 2 days ago" is worked out from it, never from a clock read while drawing. `ending`
 * says what is being signed out. `failed` means the last sign-out did not go through (offline or
 * refused) and the list is as it was.
 */
export interface AccountSessionsState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly sessions: readonly SessionSummary[];
  readonly readAt: number;
  readonly ending: SessionsEnding | undefined;
  readonly failed: boolean;
}

export interface AccountSessionsSession {
  readonly getState: () => AccountSessionsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  /** Signs one other session out, then rereads the list. */
  readonly end: (sessionId: string) => Promise<void>;
  /** Signs every other session out, then rereads the list. */
  readonly endOthers: () => Promise<void>;
}

/** Sessions of one account scope. Answers that arrive after the scope ended are dropped by its fenced requests. */
export function createAccountSessionsSession(owner: SessionsOwner): AccountSessionsSession {
  let state: AccountSessionsState = { status: 'loading', sessions: [], readAt: 0, ending: undefined, failed: false };
  const listeners = new Set<() => void>();
  let serial = 0;

  function set(next: Partial<AccountSessionsState>): void {
    if (!owner.active) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  async function refresh(): Promise<void> {
    const mine = (serial += 1);
    try {
      const { sessions } = await owner.api.account.sessions();
      if (mine === serial) set({ status: 'ready', sessions, readAt: Date.now() });
    } catch {
      if (mine === serial) set({ status: state.sessions.length > 0 ? 'ready' : 'unavailable' });
    }
  }

  async function sign(ending: SessionsEnding, send: () => Promise<unknown>): Promise<void> {
    set({ ending, failed: false });
    try {
      await send();
    } catch (error) {
      // An id that is already gone is what the person asked for; anything else leaves the list as it was.
      if (apiProblem(error)?.code !== 'NOT_FOUND') {
        set({ ending: undefined, failed: true });
        return;
      }
    }
    set({ ending: undefined });
    await refresh();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    end: (sessionId) => sign({ kind: 'session', id: sessionId }, () => owner.api.account.endSession({ sessionId })),
    endOthers: () => sign({ kind: 'others' }, () => owner.api.account.endOtherSessions()),
  };
}
