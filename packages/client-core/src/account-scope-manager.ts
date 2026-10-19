import type { QueryClient } from '@tanstack/react-query';
import type { SessionAccount, SessionClient } from '@knowscroll/contracts';
import {
  SCOPED_STORAGE_PREFIX,
  createAccountScope,
  purgeStorage,
  scopeIdOf,
  type AccountScope,
  type KeyValueStore,
} from './account-scope';
import type { ScopeConnection } from './account-scope';
import type { SocketContext } from './account-scope-socket';
import { createAuthClient, type AuthClient, type RedeemOutcome, type RequestLinkOutcome } from './auth-client';
import { createQueryClient } from './query-client';

type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

/** Where a native client keeps its bearer session token: the platform's secure store. */
export interface SessionTokenStore {
  read(): Promise<string | undefined>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Who the app is acting for. `signed_out.reason`: `none` (never signed in here), `signed_out`
 * (the person signed out), `session_ended` (the server no longer accepts the session: expired,
 * revoked or signed out elsewhere; A02 "You were signed out"). `unavailable`: the API could not
 * be asked (offline, down); nothing account-scoped is shown until it can be.
 */
export type AccountScopeState =
  | { readonly status: 'starting' }
  | { readonly status: 'signed_out'; readonly reason: 'none' | 'signed_out' | 'session_ended' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'signed_in'; readonly scope: AccountScope };

export interface AccountScopeManager {
  /** Stable between changes (for `useSyncExternalStore`). */
  readonly getState: () => AccountScopeState;
  readonly subscribe: (listener: () => void) => () => void;
  /** The query client of the current scope, or of the signed-out period (never shared between them). */
  readonly queryClient: () => QueryClient;
  /** Reads the current session once at startup. */
  readonly start: () => Promise<void>;
  /**
   * Rereads the session: another account or epoch ends the current scope and mounts the new one;
   * a refused session ends it (`session_ended`).
   */
  readonly refresh: () => Promise<void>;
  readonly requestLink: (email: string) => Promise<RequestLinkOutcome>;
  /** The address the last link was requested for (memory only, for "We sent a link to …"). */
  readonly pendingEmail: string | undefined;
  readonly redeem: (request: { readonly token: string; readonly commandId: string }) => Promise<RedeemOutcome>;
  /**
   * Ends the session on the server and the scope here. On the web, where only the server can
   * clear the HttpOnly cookie, a server that cannot be reached leaves the person signed in
   * (`unavailable`); native drops its token whatever the server answered.
   */
  readonly signOut: (options?: { readonly everywhere?: boolean }) => Promise<'signed_out' | 'unavailable'>;
  /** Ends the current scope and stops notifying (app teardown). */
  readonly dispose: () => void;
}

export interface AccountScopeManagerOptions {
  readonly baseUrl: string;
  readonly platform: SessionClient;
  readonly fetch?: Fetch;
  /** Native only: where the bearer token is kept. */
  readonly tokens?: SessionTokenStore;
  /** The scopes' local storage (web: `localStorage`). */
  readonly store: KeyValueStore;
  /** Opens a scope's hint socket (`connectScopeSocket`); none when omitted. */
  readonly connect?: (scope: AccountScope, context: SocketContext) => ScopeConnection;
  /** Test seam: the auth routes (defaults to `createAuthClient`). */
  readonly auth?: AuthClient;
}

/**
 * The AccountScope owner (blueprint §18): exactly one scope per `(accountId, privacyEpoch)` is
 * live at a time. Sign-out, an account switch (redeeming another account's link) and a privacy
 * epoch change end the current scope — stop its socket, cancel and fence its in-flight requests,
 * clear its query cache, purge its storage — before the next one is created, so nothing of one
 * account can appear in another's.
 */
export function createAccountScopeManager(options: AccountScopeManagerOptions): AccountScopeManager {
  const fetchImplementation: Fetch = options.fetch ?? ((request, init) => globalThis.fetch(request, init));
  let token: string | undefined;
  const authorization = () => (token === undefined ? undefined : `Bearer ${token}`);
  const auth =
    options.auth ?? createAuthClient({ baseUrl: options.baseUrl, fetch: fetchImplementation, authorization });
  const listeners = new Set<() => void>();
  let state: AccountScopeState = { status: 'starting' };
  let signedOutClient = createQueryClient();
  let pendingEmail: string | undefined;
  let disposed = false;

  function set(next: AccountScopeState): void {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function endCurrentScope(): void {
    if (state.status === 'signed_in') state.scope.end();
  }

  function mount(account: SessionAccount): void {
    if (state.status === 'signed_in' && state.scope.id === scopeIdOf(account)) return;
    endCurrentScope();
    signedOutClient.clear();
    const connect = options.connect;
    const scope: AccountScope = createAccountScope({
      account,
      baseUrl: options.baseUrl,
      fetch: fetchImplementation,
      authorization,
      store: options.store,
      ...(connect === undefined
        ? {}
        : {
            connect: (created: AccountScope) =>
              connect(created, {
                baseUrl: options.baseUrl,
                bearerToken: () => token,
                onRevoked: () => void recheckAfterRevocation(created),
              }),
          }),
    });
    set({ status: 'signed_in', scope });
  }

  async function signedOut(reason: 'none' | 'signed_out' | 'session_ended'): Promise<void> {
    endCurrentScope();
    // Whatever any earlier scope left behind on this device goes too.
    purgeStorage(options.store, SCOPED_STORAGE_PREFIX);
    if (options.platform === 'native') {
      token = undefined;
      await options.tokens?.clear().catch(() => undefined);
    }
    signedOutClient.clear();
    signedOutClient = createQueryClient();
    set({ status: 'signed_out', reason });
  }

  async function refresh(): Promise<void> {
    const outcome = await auth.session();
    switch (outcome.kind) {
      case 'signed_in':
        mount(outcome.account);
        return;
      case 'signed_out':
        await signedOut(state.status === 'signed_in' ? 'session_ended' : 'none');
        return;
      case 'unavailable':
        if (state.status === 'starting') set({ status: 'unavailable' });
        return;
    }
  }

  /** The server dropped the account's sockets: still signed in → reconnect; else end the scope. */
  async function recheckAfterRevocation(scope: AccountScope): Promise<void> {
    await refresh();
    if (state.status === 'signed_in' && state.scope === scope) scope.reconnect();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    queryClient: () => (state.status === 'signed_in' ? state.scope.queryClient : signedOutClient),
    async start() {
      if (options.platform === 'native') {
        try {
          token = await options.tokens?.read();
        } catch {
          // An unreadable secure store (locked device, missing module) is the same as no token.
          token = undefined;
        }
        if (token === undefined) {
          await signedOut('none');
          return;
        }
      }
      await refresh();
    },
    refresh,
    get pendingEmail() {
      return pendingEmail;
    },
    async requestLink(email) {
      const outcome = await auth.requestLink(email);
      if (outcome.kind === 'requested') pendingEmail = email.trim();
      return outcome;
    },
    async redeem(request) {
      const outcome = await auth.redeem({ ...request, client: options.platform });
      if (outcome.kind !== 'signed_in') return outcome;
      const { session, account } = outcome.response;
      if (session.kind === 'bearer') {
        token = session.token;
        await options.tokens?.write(session.token);
      }
      pendingEmail = undefined;
      mount(account);
      return outcome;
    },
    async signOut(signOutOptions = {}) {
      const answer = await auth.signOut({ everywhere: signOutOptions.everywhere === true });
      if (answer === 'unavailable' && options.platform === 'web') return 'unavailable';
      await signedOut('signed_out');
      return 'signed_out';
    },
    dispose() {
      endCurrentScope();
      listeners.clear();
      disposed = true;
    },
  };
}
