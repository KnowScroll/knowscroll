import type { QueryClient } from '@tanstack/react-query';
import type { SessionAccount, SessionClient } from '@knowscroll/contracts';
import {
  SCOPED_STORAGE_PREFIX,
  createAccountScope,
  purgeStorage,
  scopeIdOf,
  type AccountScope,
  type KeyValueStore,
  type ScopeStorageLifecycle,
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
import { createPrivacyClearSession, type PrivacyClearSession } from './privacy-clear';

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
  /** Manager-owned minimal Clear intent survives same-account privacy scope remounts. */
  readonly privacy: PrivacyClearSession;
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
  /**
   * Whose account a link opens, asked before redeeming it (review m8): the full address of a web
   * link; a native link answers only with this app's verifier, and masked.
   */
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
   * (`unavailable`); native fences immediately and confirms local cleanup/token removal even if the server is unavailable.
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
  readonly durableStorage?: ScopeStorageLifecycle;
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
  /**
   * The credential generation (re-review N5). It moves on whenever this device's credential may
   * change: a redemption starts and when it signs in, a sign-out starts, the session is dropped.
   * A session reread remembers the generation and the credential it was sent with, and an answer
   * that arrives for an older generation is ignored: it mounts nothing, signs nobody out and wipes
   * nothing from the secure store.
   */
  let generation = 0;
  let credentialTransition: number | undefined;
  let credentialWrites = Promise.resolve();
  async function changeToken(work: () => Promise<void> | undefined, current: () => boolean): Promise<void> {
    const changed = credentialWrites
      .catch(() => undefined)
      .then(async () => {
        if (!current()) throw new Error('credential_transition_ended');
        await work();
        if (!current()) throw new Error('credential_transition_ended');
      });
    credentialWrites = changed;
    return changed;
  }
  let cleanup = Promise.resolve();
  let mountedCredential: string | undefined;
  let refreshing: { readonly generation: number; readonly done: Promise<void> } | undefined;

  function set(next: AccountScopeState): void {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function endCurrentScope(): void {
    if (state.status === 'signed_in') {
      const scope = state.scope;
      scope.end();
      const previous = cleanup;
      cleanup = previous.then(() => scope.whenStorageClosed?.());
      void cleanup.catch(() => undefined);
    }
    options.durableStorage?.fence();
  }
  async function cleanNative(): Promise<void> {
    try {
      await cleanup;
    } catch {
      /* Explicit cleanup retry below must prove success. */
    }
    await options.durableStorage?.purge();
    cleanup = Promise.resolve();
  }

  /** Mounts the scope of `account` with `credential` (its session's bearer token, native only). */
  async function mount(account: SessionAccount, credential: string | undefined, expected = generation): Promise<void> {
    const current = () =>
      !disposed && generation === expected && (options.platform !== 'native' || token === credential);
    if (!current()) return;
    if (
      state.status === 'signed_in' &&
      state.scope.active &&
      state.scope.id === scopeIdOf(account) &&
      mountedCredential === credential
    )
      return;
    privacy.accountChanged(account.accountId);
    endCurrentScope();
    await cleanup;
    if (!current()) return;
    const store = options.durableStorage
      ? await options.durableStorage.prepare(
          { account, origin: new URL(options.baseUrl).origin, credential: credential ?? '' },
          current,
        )
      : options.store;
    if (!current()) {
      store.durability?.fence();
      await store.durability?.purge();
      return;
    }
    signedOutClient.clear();
    const connect = options.connect;
    const authorization = credential === undefined ? undefined : `Bearer ${credential}`;
    const scope: AccountScope = createAccountScope({
      account,
      baseUrl: options.baseUrl,
      fetch: fetchImplementation,
      authorization: () => authorization,
      onMismatch: () => void refreshOnce(),
      store,
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
    mountedCredential = credential;
    set({ status: 'signed_in', scope });
    if (!current() || state.status !== 'signed_in' || state.scope !== scope) scope.end();
  }

  async function signedOut(reason: 'none' | 'signed_out' | 'session_ended'): Promise<void> {
    generation += 1;
    const leaving = generation;
    privacy.reset();
    endCurrentScope();
    // Whatever any earlier scope left behind on this device goes too.
    purgeStorage(options.store, SCOPED_STORAGE_PREFIX);
    if (options.platform === 'native') {
      token = undefined;
      if (options.durableStorage) {
        await cleanNative();
        await changeToken(
          () => options.tokens?.clear(),
          () => !disposed && generation === leaving,
        );
      } else await options.tokens?.clear().catch(() => undefined);
    }
    if (disposed || generation !== leaving) return;
    signedOutClient.clear();
    signedOutClient = newQueryClient();
    set({ status: 'signed_out', reason });
  }

  async function refresh(): Promise<void> {
    // A reread must not publish a scope while a native credential write/clear is unresolved.
    if (options.durableStorage && credentialTransition !== undefined) return;
    const sentWith = generation;
    // The credential this reread presents (the auth client reads `token` as it sends).
    const credential = options.platform === 'native' ? token : undefined;
    const outcome = await auth.session();
    if (sentWith !== generation || disposed) return;
    switch (outcome.kind) {
      case 'signed_in':
        try {
          await mount(outcome.account, credential, sentWith);
        } catch {
          if (!disposed && generation === sentWith) set({ status: 'unavailable' });
        }
        return;
      case 'signed_out':
        try {
          await signedOut(state.status === 'signed_in' ? 'session_ended' : 'none');
        } catch {
          if (!disposed && generation === sentWith + 1) set({ status: 'unavailable' });
        }
        return;
      case 'unavailable':
        // Nothing to show until the API answers: first start, or a scope already ended (fenced
        // for a redemption that then failed).
        if (state.status === 'starting' || (state.status === 'signed_in' && !state.scope.active))
          set({ status: 'unavailable' });
        return;
    }
  }

  /**
   * One reread at a time per credential generation: a burst of refused requests
   * (`SCOPE_MISMATCH`) asks once; a reread of an older generation is never reused.
   */
  function refreshOnce(): Promise<void> {
    if (refreshing?.generation !== generation) {
      const entry = {
        generation,
        done: refresh().finally(() => {
          if (refreshing === entry) refreshing = undefined;
        }),
      };
      refreshing = entry;
    }
    return refreshing.done;
  }

  /** The server dropped the account's sockets: still signed in → reconnect; else end the scope. */
  async function recheckAfterRevocation(scope: AccountScope): Promise<void> {
    await refreshOnce();
    if (state.status === 'signed_in' && state.scope === scope) scope.reconnect();
  }

  const currentAccountIs = (accountId: string) =>
    state.status === 'signed_in' && state.scope.active && state.scope.account.accountId === accountId;

  const privacy = createPrivacyClearSession({
    current: () => (state.status === 'signed_in' ? state.scope : undefined),
    capture(scope) {
      if (
        disposed ||
        credentialTransition !== undefined ||
        state.status !== 'signed_in' ||
        state.scope !== scope ||
        !scope.active
      )
        return undefined;
      const capturedGeneration = generation;
      const accountId = scope.account.accountId;
      return {
        async finishAfterAttempt() {
          if (disposed || generation !== capturedGeneration) return false;
          if (state.status === 'signed_in' && state.scope.account.accountId !== accountId) return false;
          if (state.status === 'signed_in' && state.scope === scope) {
            // Fence old requests/rereads and private UI synchronously, before awaiting auth.
            generation += 1;
            endCurrentScope();
            signedOutClient.clear();
            signedOutClient = newQueryClient();
            set({ status: 'unavailable' });
            const recoveringGeneration = generation;
            await refreshOnce();
            return !disposed && generation === recoveringGeneration && currentAccountIs(accountId);
          }
          // Revocation may already have mounted this account's new epoch. Keep it live and use
          // it only for a current bound status read. ACK.toEpoch never creates authorization.
          if (state.status === 'signed_in') return state.scope.active;
          await refreshOnce();
          return !disposed && generation === capturedGeneration && currentAccountIs(accountId);
        },
      };
    },
  });

  return {
    getState: () => state,
    privacy,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    queryClient: () => (state.status === 'signed_in' ? state.scope.queryClient : signedOutClient),
    async start() {
      if (options.platform === 'native') {
        const startingGeneration = generation;
        try {
          const stored = await options.tokens?.read();
          if (disposed || startingGeneration !== generation) return;
          token = stored;
        } catch {
          if (disposed || startingGeneration !== generation) return;
          if (options.durableStorage) {
            set({ status: 'unavailable' });
            return;
          }
          token = undefined;
        }
        if (token === undefined) {
          try {
            await signedOut('none');
          } catch {
            set({ status: 'unavailable' });
          }
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
    async peek(linkToken) {
      // A native link answers only to its verifier (re-review nit).
      const codeVerifier =
        options.platform === 'native' ? await options.signInBinding?.verifier().catch(() => undefined) : undefined;
      return auth.peek({
        token: linkToken,
        client: options.platform,
        ...(codeVerifier === undefined ? {} : { codeVerifier }),
      });
    },
    async redeem(request) {
      const switching = state.status === 'signed_in';
      // The fence comes first (review M1): from here on, the current scope's requests are refused
      // here, before the answer can replace this device's credential (native: the new bearer
      // token being written to the secure store; web: the cookie the answer sets). Rereads in
      // flight belong to the old generation and are ignored when they answer (re-review N5).
      generation += 1;
      const transition = generation;
      credentialTransition = transition;
      privacy.reset();
      endCurrentScope();
      try {
        if (options.durableStorage) await cleanNative();
        if (disposed || credentialTransition !== transition) return { kind: 'unavailable' };
        let codeVerifier: string | undefined;
        if (options.platform === 'native')
          codeVerifier = await options.signInBinding?.verifier().catch(() => undefined);
        const outcome = await auth.redeem({
          ...request,
          client: options.platform,
          ...(codeVerifier === undefined ? {} : { codeVerifier }),
        });
        if (disposed || credentialTransition !== transition) return { kind: 'unavailable' };
        if (outcome.kind !== 'signed_in') {
          if (options.durableStorage && credentialTransition === transition) credentialTransition = undefined;
          if (switching) await refreshOnce();
          return outcome;
        }
        const { session, account } = outcome.response;
        generation += 1;
        const mounting = generation;
        let credential: string | undefined;
        if (session.kind === 'bearer') {
          credential = session.token;
          if (options.durableStorage) {
            await changeToken(
              () => options.tokens?.write(session.token),
              () => !disposed && generation === mounting,
            );
            if (disposed || generation !== mounting || credentialTransition !== transition)
              return { kind: 'unavailable' };
            token = session.token;
          } else {
            token = session.token;
            await options.tokens?.write(session.token);
          }
          await options.signInBinding?.clear().catch(() => undefined);
        }
        pendingEmail = undefined;
        await mount(account, credential, mounting);
        return outcome;
      } catch {
        if (!disposed && credentialTransition === transition) set({ status: 'unavailable' });
        return { kind: 'unavailable' };
      } finally {
        if (credentialTransition === transition) credentialTransition = undefined;
      }
    },
    async signOut(signOutOptions = {}) {
      generation += 1;
      const transition = generation;
      credentialTransition = transition;
      privacy.reset();
      if (options.durableStorage) endCurrentScope();
      try {
        const answer = await auth.signOut({ everywhere: signOutOptions.everywhere === true });
        if (disposed || credentialTransition !== transition) return 'unavailable';
        if (answer === 'unavailable' && options.platform === 'web') return 'unavailable';
        await signedOut('signed_out');
        return 'signed_out';
      } catch {
        if (!disposed && credentialTransition === transition) set({ status: 'unavailable' });
        return 'unavailable';
      } finally {
        if (credentialTransition === transition) credentialTransition = undefined;
      }
    },
    dispose() {
      generation += 1; // A deferred privacy recovery/session read must not create an orphan scope.
      privacy.reset(true);
      endCurrentScope();
      if (options.durableStorage) void cleanNative().catch(() => undefined);
      listeners.clear();
      disposed = true;
    },
  };
}
