import type { SessionSummary } from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

interface SessionsOwner {
  readonly api: Pick<ApiClient, 'account'>;
  readonly active: boolean;
}

/**
 * The person's own sessions for Account (P01). `ending` names the session being signed out, or
 * `others` while every other one is. `failed` means the last sign-out did not go through (offline
 * or refused) and the list is as it was.
 */
export interface AccountSessionsState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly sessions: readonly SessionSummary[];
  readonly ending: string | 'others' | undefined;
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
  let state: AccountSessionsState = { status: 'loading', sessions: [], ending: undefined, failed: false };
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
      if (mine === serial) set({ status: 'ready', sessions });
    } catch {
      if (mine === serial) set({ status: state.sessions.length > 0 ? 'ready' : 'unavailable' });
    }
  }

  async function sign(ending: string | 'others', send: () => Promise<unknown>): Promise<void> {
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
    end: (sessionId) => sign(sessionId, () => owner.api.account.endSession({ sessionId })),
    endOthers: () => sign('others', () => owner.api.account.endOtherSessions()),
  };
}
