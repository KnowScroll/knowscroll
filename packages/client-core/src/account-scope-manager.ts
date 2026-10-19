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
import {
  createAuthClient,
  type AuthClient,
  type PeekOutcome,
  type RedeemOutcome,
  type RequestLinkOutcome,
} from './auth-client';
import { createQueryClient } from './query-client';

type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

/** Where a native client keeps its bearer session token: the platform's secure store. */
export interface SessionTokenStore {
  read(): Promise<string | undefined>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Native only (review m10): the device-held verifier a sign-in link is bound to (PKCE-style S256).
 * A link asked for with its challenge is redeemed only with the verifier, which never leaves the
 * platform secure store except in the redemption itself, so a link intercepted on its way to the
 * app (an unverified app link, another app's custom scheme) opens nothing elsewhere.
 */
export interface SignInBinding {
  /** The challenge to ask for a link with; creates and keeps a verifier when there is none. */
  challenge(): Promise<string>;
  /** The kept verifier, if any. */
  verifier(): Promise<string | undefined>;
  /** Forgets the verifier (after a redemption signed in). */
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
  /** Whose account a link opens, masked; asked before redeeming it (review m8). */
  readonly peek: (token: string) => Promise<PeekOutcome>;
  /**
   * Redeems a link. The current scope ends before the redemption is sent (review M1), so nothing
   * it starts afterwards can go out with the next account's credential; if the redemption does
   * not sign in, the session is read again and its scope mounted afresh.
   */
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
  /** Native only: the verifier sign-in links are bound to (review m10). */
  readonly signInBinding?: SignInBinding;
  /** The scopes' local storage (web: `localStorage`). */
  readonly store: KeyValueStore;
  /** Opens a scope's hint socket (`connectScopeSocket`); none when omitted. */
  readonly connect?: (scope: AccountScope, context: SocketContext) => ScopeConnection;
  /** Test seam: the auth routes (defaults to `createAuthClient`). */
  readonly auth?: AuthClient;
  /** Test seam: how each scope's and each signed-out period's QueryClient is made (`createQueryClient`). */
  readonly newQueryClient?: () => QueryClient;
}

/**
 * The AccountScope owner (blueprint §18): exactly one scope per `(accountId, privacyEpoch)` is
 * live at a time. Sign-out, an account switch (redeeming another account's link) and a privacy
 * epoch change end the current scope — stop its socket, cancel and fence its in-flight requests,
 * clear its query cache, purge its storage — before the next one is created, so nothing of one
 * account can appear in another's.
 *
 * Each scope carries its own credential, captured when it is created (native: the bearer token
 * of its session; web: none, the cookie travels by itself), and names itself on every request and
 * socket handshake (`X-KS-Scope`). The API refuses a request whose claim is not the presented
 * session's account and current epoch (`SCOPE_MISMATCH`), and the manager then rereads the
 * session: so a tab whose cookie another tab replaced, or a scope whose epoch changed without the
 * revocation notice arriving, is never served another scope's answers (review M1, m11).
 */
export function createAccountScopeManager(options: AccountScopeManagerOptions): AccountScopeManager {
  const fetchImplementation: Fetch = options.fetch ?? ((request, init) => globalThis.fetch(request, init));
  /** Native: this device's current bearer token, for the `/auth/*` routes only. */
  let token: string | undefined;
  const auth =
    options.auth ??
    createAuthClient({
      baseUrl: options.baseUrl,
      fetch: fetchImplementation,
      authorization: () => (token === undefined ? undefined : `Bearer ${token}`),
    });
  const listeners = new Set<() => void>();
  let state: AccountScopeState = { status: 'starting' };
  const newQueryClient = options.newQueryClient ?? createQueryClient;
  let signedOutClient = newQueryClient();
  let pendingEmail: string | undefined;
  let disposed = false;
  let refreshing: Promise<void> | undefined;

  function set(next: AccountScopeState): void {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function endCurrentScope(): void {
    if (state.status === 'signed_in') state.scope.end();
  }

  /** Mounts the scope of `account` with `credential` (its session's bearer token, native only). */
  function mount(account: SessionAccount, credential: string | undefined): void {
    if (state.status === 'signed_in' && state.scope.active && state.scope.id === scopeIdOf(account)) return;
    endCurrentScope();
    signedOutClient.clear();
    const connect = options.connect;
    const authorization = credential === undefined ? undefined : `Bearer ${credential}`;
    const scope: AccountScope = createAccountScope({
      account,
      baseUrl: options.baseUrl,
      fetch: fetchImplementation,
      authorization: () => authorization,
      onMismatch: () => void refreshOnce(),
      store: options.store,
      queryClient: newQueryClient(),
      ...(connect === undefined
        ? {}
        : {
            connect: (created: AccountScope) =>
              connect(created, {
                baseUrl: options.baseUrl,
                bearerToken: () => credential,
                onRevoked: () => void recheckAfterRevocation(created),
                onMismatch: () => void refreshOnce(),
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
    signedOutClient = newQueryClient();
    set({ status: 'signed_out', reason });
  }

  async function refresh(): Promise<void> {
    const outcome = await auth.session();
    switch (outcome.kind) {
      case 'signed_in':
        mount(outcome.account, options.platform === 'native' ? token : undefined);
        return;
      case 'signed_out':
        await signedOut(state.status === 'signed_in' ? 'session_ended' : 'none');
        return;
      case 'unavailable':
        // Nothing to show until the API answers: first start, or a scope already ended (fenced
        // for a redemption that then failed).
        if (state.status === 'starting' || (state.status === 'signed_in' && !state.scope.active))
          set({ status: 'unavailable' });
        return;
    }
  }

  /** One reread at a time: a burst of refused requests (`SCOPE_MISMATCH`) asks once. */
  function refreshOnce(): Promise<void> {
    refreshing ??= refresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  /** The server dropped the account's sockets: still signed in → reconnect; else end the scope. */
  async function recheckAfterRevocation(scope: AccountScope): Promise<void> {
    await refreshOnce();
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
    refresh: refreshOnce,
    get pendingEmail() {
      return pendingEmail;
    },
    async requestLink(email) {
      let codeChallenge: string | undefined;
      if (options.platform === 'native' && options.signInBinding !== undefined) {
        try {
          codeChallenge = await options.signInBinding.challenge();
        } catch {
          // No secure store: no binding, so no link this app could redeem.
          return { kind: 'unavailable' };
        }
      }
      const outcome = await auth.requestLink(email, codeChallenge);
      if (outcome.kind === 'requested') pendingEmail = email.trim();
      return outcome;
    },
    peek: (linkToken) => auth.peek({ token: linkToken, client: options.platform }),
    async redeem(request) {
      const switching = state.status === 'signed_in';
      // The fence comes first (review M1): from here on, the current scope's requests are refused
      // here, before the answer can replace this device's credential (native: the new bearer
      // token being written to the secure store; web: the cookie the answer sets).
      endCurrentScope();
      let codeVerifier: string | undefined;
      if (options.platform === 'native') codeVerifier = await options.signInBinding?.verifier().catch(() => undefined);
      const outcome = await auth.redeem({
        ...request,
        client: options.platform,
        ...(codeVerifier === undefined ? {} : { codeVerifier }),
      });
      if (outcome.kind !== 'signed_in') {
        if (switching) await refreshOnce();
        return outcome;
      }
      const { session, account } = outcome.response;
      let credential: string | undefined;
      if (session.kind === 'bearer') {
        credential = session.token;
        token = session.token;
        await options.tokens?.write(session.token);
        await options.signInBinding?.clear().catch(() => undefined);
      }
      pendingEmail = undefined;
      mount(account, credential);
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
