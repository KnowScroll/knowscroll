import { QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import {
  connectScopeSocket,
  createAccountScopeManager,
  type AccountScope,
  type AccountScopeManager,
  type AccountScopeState,
} from '@knowscroll/client-core';
import { appApiOrigin } from '../platform/api';
import { scopeStorage } from '../platform/scope-storage';
import { sessionTokens } from '../platform/session-tokens';
import { signInBinding } from '../platform/sign-in-binding';
import { newCommandId } from '../platform/command-id';

const AccountScopeContext = createContext<AccountScopeManager | null>(null);

/**
 * One key per scope object, not per scope id: a scope that ended and was mounted again for the
 * same account and epoch (a switching redemption that failed) is a new subtree too.
 */
const scopeKeys = new WeakMap<AccountScope, string>();
let scopeCount = 0;

function keyOf(scope: AccountScope): string {
  let key = scopeKeys.get(scope);
  if (key === undefined) {
    scopeCount += 1;
    key = `${scope.id}#${String(scopeCount)}`;
    scopeKeys.set(scope, key);
  }
  return key;
}

/**
 * The app's scope manager: the world's API origin (D-008), the platform's credential (web: the
 * HttpOnly cookie; native: the bearer token in the secure store), the scope storage and the hint
 * socket. Without a usable origin (a native build without `EXPO_PUBLIC_KS_API_ORIGIN`) every
 * request fails and the state is `unavailable`.
 */
export function createAppAccountScopeManager(): AccountScopeManager {
  const origin = appApiOrigin();
  return createAccountScopeManager({
    baseUrl: origin.ok ? origin.baseUrl : '',
    platform: Platform.OS === 'web' ? 'web' : 'native',
    ...(sessionTokens === undefined ? {} : { tokens: sessionTokens }),
    ...(signInBinding === undefined ? {} : { signInBinding }),
    store: scopeStorage,
    connect: connectScopeSocket,
  });
}

/**
 * The AccountScope provider (blueprint §18). It owns one scope per `(accountId, privacyEpoch)`:
 * the subtree gets that scope's QueryClient, and the provider is keyed by the scope, so on
 * sign-out, an account switch or a privacy epoch change the old subtree unmounts with its state
 * after the manager ended the old scope (socket closed, in-flight requests cancelled and fenced,
 * cache cleared, storage purged), and the new one mounts fresh. While the session is first read,
 * nothing renders (like the fonts above it), so the tree mounts once.
 */
export function AccountScopeProvider({
  children,
  manager: given,
}: {
  readonly children: ReactNode;
  /** Test seam: a manager over fixtures. */
  readonly manager?: AccountScopeManager;
}) {
  const [manager] = useState(() => given ?? createAppAccountScopeManager());
  useEffect(() => {
    void manager.start();
    return () => manager.dispose();
  }, [manager]);
  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  useEffect(() => {
    const policy = scope?.recording;
    if (!scope || !policy) return;
    policy.useIdSource(newCommandId);
    let appActive = AppState.currentState === 'active';
    let focused = typeof document === 'undefined' || document.hasFocus();
    const foreground = () =>
      appActive && focused && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    const refresh = () => {
      void policy.setForeground(scope.active && foreground());
    };
    const focus = () => {
      focused = true;
      refresh();
    };
    const background = () => {
      focused = false;
      void policy.setForeground(false);
    };
    const appState = AppState.addEventListener('change', (value) => {
      appActive = value === 'active';
      refresh();
    });
    const storage = (event: StorageEvent) => {
      if (event.key === `ks.scope.${scope.id}.recording.policy.signal`) {
        policy.invalidate();
        if (scope.active && foreground()) void policy.refresh();
        else void policy.setForeground(false);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', focus);
      window.addEventListener('blur', background);
      window.addEventListener('storage', storage);
      document.addEventListener('visibilitychange', refresh);
    }
    refresh();
    return () => {
      void policy.setForeground(false);
      appState.remove();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', focus);
        window.removeEventListener('blur', background);
        window.removeEventListener('storage', storage);
        document.removeEventListener('visibilitychange', refresh);
      }
    };
  }, [scope]);
  if (state.status === 'starting') return null;
  const key = state.status === 'signed_in' ? keyOf(state.scope) : 'signed-out';
  return (
    <AccountScopeContext.Provider value={manager}>
      <QueryClientProvider key={key} client={manager.queryClient()}>
        {children}
      </QueryClientProvider>
    </AccountScopeContext.Provider>
  );
}

/** The current account state and its manager (sign-in, sign-out, refresh). */
export function useAccountScope(): { readonly state: AccountScopeState; readonly manager: AccountScopeManager } {
  const manager = useContext(AccountScopeContext);
  if (manager === null) throw new Error('useAccountScope outside AccountScopeProvider');
  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);
  return { state, manager };
}

/** The signed-in person's initial for the avatar, or `undefined` when nobody is signed in. */
export function useAccountInitial(): string | undefined {
  const manager = useContext(AccountScopeContext);
  const state = useSyncExternalStore(
    manager?.subscribe ?? noSubscription,
    manager?.getState ?? signedOutState,
    manager?.getState ?? signedOutState,
  );
  if (state.status !== 'signed_in') return undefined;
  const first = state.scope.account.email.trim().charAt(0);
  return first === '' ? undefined : first.toUpperCase();
}

const noSubscription = () => () => undefined;
const signedOut: AccountScopeState = { status: 'signed_out', reason: 'none' };
const signedOutState = () => signedOut;
