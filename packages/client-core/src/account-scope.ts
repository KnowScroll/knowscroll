import type { QueryClient } from '@tanstack/react-query';
import {
  PROBLEM_MEDIA_TYPE,
  SCOPE_HEADER,
  scopeClaimOf,
  type ProblemCode,
  type SessionAccount,
} from '@knowscroll/contracts';
import { createApiClient, type ApiClient } from './api-client';
import { createQueryClient } from './query-client';

type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

/**
 * Raised for a request made through a scope that has ended (sign-out, account switch, privacy
 * epoch change): the request is cancelled, and a response that still arrives is dropped, so it
 * can never repopulate another scope's state (blueprint §18).
 */
export class ScopeEndedError extends Error {
  override readonly name = 'ScopeEndedError';
  readonly code = 'SCOPE_ENDED';
  constructor() {
    super('The account scope this request belonged to has ended');
  }
}

/** Synchronous string storage under the scope (web: `localStorage`; native: memory for now). */
export interface KeyValueStore {
  keys(): readonly string[];
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Every key an account scope writes starts with this; purging a scope removes its keys. */
export const SCOPED_STORAGE_PREFIX = 'ks.scope.';

/** The scope's storage: keys are confined to `ks.scope.<account>:<epoch>.` and purged when it ends. */
export interface ScopedStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** A live connection the scope owns (the hint socket); closed first when the scope ends. */
export interface ScopeConnection {
  close(): void;
}

/** Opens the scope's hint socket (`account-scope-socket.ts`; a test double in tests). */
export type ConnectScope = (scope: AccountScope) => ScopeConnection;

/**
 * One account scope, keyed by `(accountId, privacyEpoch)` (blueprint §18): it owns the TanStack
 * QueryClient, the API client every account request goes through, the hint socket and the
 * scope's local storage. Nothing account-scoped lives outside it.
 */
export interface AccountScope {
  /** `<accountId>:<privacyEpoch>`: a new epoch is a new scope. */
  readonly id: string;
  readonly account: SessionAccount;
  readonly queryClient: QueryClient;
  /** Requests through it are cancelled when the scope ends; a late response is dropped. */
  readonly api: ApiClient;
  readonly storage: ScopedStorage;
  /** False once the scope has ended. */
  readonly active: boolean;
  /** Ephemeral playback URL/headers for this scope only; never persisted or logged. */
  mediaSource?(path: string): { readonly uri: string; readonly headers?: Record<string, string> };
  /** Playback resources stop synchronously before scoped requests/cache/storage are purged. */
  onEnd?(listener: () => void): () => void;
  /** Query keys of this scope start with `['scope', id]`. */
  queryKey(...parts: readonly (string | number)[]): readonly (string | number)[];
  /** Closes and reopens the hint socket (after the server dropped it and the session still holds). */
  reconnect(): void;
  /**
   * Ends the scope, in this order: stop its subscriptions (close the socket), cancel and fence
   * every in-flight request, clear its query cache, purge its storage. Idempotent.
   */
  end(): void;
}

/** A scope's id, which is also its claim on the wire (`X-KS-Scope`, review M1). */
export function scopeIdOf(account: Pick<SessionAccount, 'accountId' | 'privacyEpoch'>): string {
  return scopeClaimOf(account);
}

/** An AbortSignal that aborts when any of `signals` does (no `AbortSignal.any` on every runtime). */
function eitherSignal(signals: readonly (AbortSignal | null | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal === null || signal === undefined) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

const scopeMismatch: ProblemCode = 'SCOPE_MISMATCH';

/** Whether an answer is the API's refusal of a request made for another scope. */
async function isScopeMismatch(response: Response): Promise<boolean> {
  if (response.status !== 409 || !(response.headers.get('content-type') ?? '').startsWith(PROBLEM_MEDIA_TYPE))
    return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === scopeMismatch;
}

/**
 * Wraps `fetch` for one scope: refuses to start a request once the scope ended, cancels in-flight
 * requests when it ends, and drops a response that arrives after it ended (`ScopeEndedError`),
 * whatever the platform's fetch does with the abort. Every request carries the scope's claim
 * (`X-KS-Scope: <accountId>:<epoch>`), so the API serves it only for the account and epoch it was
 * made for (review M1: another tab switched account, or the privacy epoch changed); its refusal
 * (`SCOPE_MISMATCH`) calls `onMismatch`, and the scope manager rereads the session. `authorization`
 * (native bearer) is the scope's own credential, added to every request; the web sends its
 * same-origin cookie by itself.
 */
export function fencedFetch(options: {
  readonly fetch: Fetch;
  readonly ended: AbortSignal;
  readonly scope: string;
  readonly authorization: () => string | undefined;
  readonly onMismatch?: () => void;
}): Fetch {
  return async (request, init) => {
    if (options.ended.aborted) throw new ScopeEndedError();
    const authorization = options.authorization();
    const headers = new Headers(request.headers);
    if (authorization !== undefined) headers.set('authorization', authorization);
    headers.set(SCOPE_HEADER, options.scope);
    const fenced = new Request(request, { headers, signal: eitherSignal([request.signal, options.ended]) });
    let response: Response;
    try {
      response = await options.fetch(fenced, init === undefined ? undefined : { ...init, signal: fenced.signal });
    } catch (error) {
      if (options.ended.aborted) throw new ScopeEndedError();
      throw error;
    }
    if (options.ended.aborted) throw new ScopeEndedError();
    if (options.onMismatch !== undefined && (await isScopeMismatch(response))) options.onMismatch();
    return response;
  };
}

function scopedStorage(store: KeyValueStore, prefix: string, ended: AbortSignal): ScopedStorage {
  return {
    get: (key) => (ended.aborted ? undefined : (store.getItem(`${prefix}${key}`) ?? undefined)),
    set: (key, value) => {
      if (!ended.aborted) store.setItem(`${prefix}${key}`, value);
    },
    remove: (key) => {
      if (!ended.aborted) store.removeItem(`${prefix}${key}`);
    },
  };
}

/** Removes every key under `prefix` (one scope, or every scope with `SCOPED_STORAGE_PREFIX`). */
export function purgeStorage(store: KeyValueStore, prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.removeItem(key);
}

export interface AccountScopeOptions {
  readonly account: SessionAccount;
  readonly baseUrl: string;
  readonly fetch: Fetch;
  /**
   * This scope's own credential: the native bearer header (`Bearer kss_…`) of the session the
   * scope was created for, never another's (review M1); `undefined` on the web.
   */
  readonly authorization: () => string | undefined;
  /** The API refused a request as made for another scope: reread the session. */
  readonly onMismatch?: () => void;
  readonly store: KeyValueStore;
  readonly connect?: ConnectScope;
  /** Test seam: the query client to own (defaults to `createQueryClient()`). */
  readonly queryClient?: QueryClient;
}

/** Creates (and starts) one account scope. Only the scope manager calls it. */
export function createAccountScope(options: AccountScopeOptions): AccountScope {
  const id = scopeIdOf(options.account);
  const ended = new AbortController();
  const prefix = `${SCOPED_STORAGE_PREFIX}${id}.`;
  const queryClient = options.queryClient ?? createQueryClient();
  let connection: ScopeConnection | undefined;
  const endListeners = new Set<() => void>();
  const api = createApiClient({
    baseUrl: options.baseUrl,
    fetch: fencedFetch({
      fetch: options.fetch,
      ended: ended.signal,
      scope: id,
      authorization: options.authorization,
      ...(options.onMismatch === undefined ? {} : { onMismatch: options.onMismatch }),
    }),
  });
  const scope: AccountScope = {
    id,
    account: options.account,
    queryClient,
    api,
    storage: scopedStorage(options.store, prefix, ended.signal),
    get active() {
      return !ended.signal.aborted;
    },
    mediaSource(path) {
      if (ended.signal.aborted || !path.startsWith('/media/') || path.startsWith('//')) throw new ScopeEndedError();
      const authorization = options.authorization();
      return {
        uri: new URL(path, options.baseUrl).href,
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      };
    },
    onEnd(listener) {
      endListeners.add(listener);
      return () => {
        endListeners.delete(listener);
      };
    },
    queryKey: (...parts) => ['scope', id, ...parts],
    reconnect() {
      if (ended.signal.aborted || options.connect === undefined) return;
      connection?.close();
      connection = options.connect(scope);
    },
    end() {
      if (ended.signal.aborted) return;
      for (const listener of endListeners) {
        try {
          listener();
        } catch {
          /* A native resource already released must never prevent the scope fence. */
        }
      }
      endListeners.clear();
      connection?.close();
      connection = undefined;
      ended.abort(new ScopeEndedError());
      void queryClient.cancelQueries();
      queryClient.clear();
      purgeStorage(options.store, prefix);
    },
  };
  if (options.connect !== undefined) connection = options.connect(scope);
  return scope;
}

/** A `KeyValueStore` in memory (native until a persistent store is needed; tests). */
export function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    keys: () => [...values.keys()],
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}
