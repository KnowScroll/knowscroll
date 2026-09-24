/**
 * Thin fetch client for the released bootstrap HTTP contract, mirroring
 * apps/mobile/.../data/ApiClient.kt: same retry envelope (two attempts,
 * 400ms then 1200ms backoff on network failure or a transient 429/5xx),
 * the same non-retryable 409-on-interaction "conflict" distinction, and
 * strict client-side response-shape validation (never trust an unexpected
 * server shape into rendering).
 *
 * The client never reads or holds a bearer token: every request goes to a
 * same-origin relative `/v1/*` path. The Vite dev/preview proxy (vite.config.ts,
 * Node-side only) injects `Authorization` before forwarding to the configured
 * loopback API, or (ADR-0034, `KS_WEB_AUTH=cookie`) forwards the browser's own
 * cookie unchanged. This file must never import, construct, or reference a
 * bearer token.
 *
 * ADR-0034's other half lives here: a cookie session authenticates GET
 * requests on its own, but a mutating request also needs `X-CSRF-Token`. This
 * client keeps that token in memory only (never localStorage/sessionStorage,
 * and never anywhere it would survive a reload) -- see `csrfToken`/
 * `setCsrfToken`/`refreshCsrfToken` below.
 */
import { z, type ZodType } from 'zod';
import {
  accountDeletionReceiptSchema,
  eventStatus,
  exposureResponse,
  feedResponse,
  interactionResponse,
  magicLinkRequestedSchema,
  privacyExportResultSchema,
  privacyRecordingReceiptSchema,
  privacyResetReceiptSchema,
  sessionCsrfSchema,
  traceRevisit,
  universe,
  webSessionResponseSchema,
  worldSystemResponseSchema,
  type AccountDeletionReceipt,
  type AccountDeletionRequest,
  type EventStatus,
  type ExposureResponse,
  type FeedResponse,
  type InteractionResponse,
  type PrivacyExportResult,
  type PrivacyLifecycleRequest,
  type PrivacyRecordingReceipt,
  type PrivacyResetReceipt,
  type PrivacyResetRequest,
  type TraceRevisit,
  type Universe,
  type WebSessionResponse,
  type WorldSystemResponse,
} from './types.ts';

export type ApiError =
  | { kind: 'network'; message: string }
  | { kind: 'server'; statusCode: number; body: string }
  | { kind: 'protocol'; message: string }
  | { kind: 'interaction-conflict'; message: string };

export class ApiException extends Error {
  readonly error: ApiError;
  constructor(error: ApiError) {
    super(apiErrorMessage(error));
    this.error = error;
    this.name = 'ApiException';
  }
}

function apiErrorMessage(error: ApiError): string {
  switch (error.kind) {
    case 'network':
      return error.message;
    case 'server':
      return `HTTP ${error.statusCode}: ${error.body}`;
    case 'protocol':
      return error.message;
    case 'interaction-conflict':
      return error.message;
  }
}

export function isTransient(statusCode: number): boolean {
  return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

/** Only an unavailable transport/service should be retried by identity; other failures are terminal per attempt. */
export function isRetryableNetworkFailure(error: ApiError): boolean {
  return error.kind === 'network';
}

export interface ApiClientOptions {
  /** Base path for requests; defaults to same-origin `/v1` proxied by Vite. */
  basePath?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  delaysMs?: [number, number];
}

const DEFAULT_DELAYS: [number, number] = [400, 1200];

/** The subset of ApiClient the reader store depends on; lets tests inject a hand-written fake. */
export interface ReaderApi {
  getUniverse(): Promise<Universe>;
  /** `exclude`: what this discovery trip has on screen or already opened (#133). */
  getFeed(exclude?: Iterable<string>): Promise<FeedResponse>;
  postExposure(body: { decisionId: string; assetId: string; clientExposureId: string }): Promise<ExposureResponse>;
  postInteraction(body: { clientEventId: string; exposureId: string; assetId: string; kind: 'keep' }): Promise<InteractionResponse>;
  getEvent(eventId: string): Promise<EventStatus>;
  getTraceRevisit(eventId: string): Promise<TraceRevisit>;
  getWorlds(): Promise<WorldSystemResponse>;
  /** ADR-0030/#119: pause/resume/export/reset all require the caller to already know the
   * universe's own current `privacyEpoch` (from a real `GET /v1/universe`) and to reuse one
   * `requestId` per user intent across any retry -- the server is replay-keyed on it, so minting
   * a fresh id per retry would turn one intent into two actions. */
  postPrivacyPause(body: PrivacyLifecycleRequest): Promise<PrivacyRecordingReceipt>;
  postPrivacyResume(body: PrivacyLifecycleRequest): Promise<PrivacyRecordingReceipt>;
  postPrivacyExport(body: PrivacyLifecycleRequest): Promise<PrivacyExportResult>;
  postPrivacyReset(body: PrivacyResetRequest): Promise<PrivacyResetReceipt>;
  /** ADR-0034: ends the calling session (Android's bearer session too, though only a cookie
   * session ever needs the sign-in screen this drives the reader store to afterward). */
  postSessionRevoke(): Promise<void>;
  /** ADR-0035: one transaction, its own confirmation literal -- see `ACCOUNT_DELETE_CONFIRMATION`. */
  postAccountDelete(body: AccountDeletionRequest): Promise<AccountDeletionReceipt>;
}

export class ApiClient implements ReaderApi {
  private readonly basePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly delaysMs: [number, number];
  /** ADR-0034: the page's own CSRF token, derived server-side from the cookie session and handed
   * back once by `POST /v1/auth/web-session` or `GET /v1/session/csrf`. Held only in this instance
   * field -- never localStorage/sessionStorage -- so it is gone the moment the page reloads; a
   * fresh instance rediscovers it lazily the first time a mutating request needs it (see
   * `refreshCsrfToken`). A bearer/dev-proxy session never sets this: no browser attaches those
   * requests, so no CSRF check ever applies to them (ADR-0034 sec.3).
   */
  private csrfToken: string | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.basePath = options.basePath ?? '/v1';
    // Never store the bare `fetch` reference: native fetch throws "Illegal
    // invocation" in a real browser when later called as `this.fetchImpl(...)`,
    // because that detaches it from its required `Window` receiver. Wrapping
    // it in a closure calls the global by its own (correct) calling
    // convention regardless of how the wrapper itself is later invoked.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.maxAttempts = options.maxAttempts ?? 2;
    this.delaysMs = options.delaysMs ?? DEFAULT_DELAYS;
  }

  async getUniverse(): Promise<Universe> {
    return this.request('GET', '/universe', undefined, [200], false, universe);
  }

  async getFeed(exclude: Iterable<string> = []): Promise<FeedResponse> {
    return this.request('GET', feedPath(exclude), undefined, [200], false, feedResponse);
  }

  async postExposure(body: { decisionId: string; assetId: string; clientExposureId: string }): Promise<ExposureResponse> {
    return this.request('POST', '/exposures', body, [200, 201], false, exposureResponse);
  }

  async postInteraction(body: {
    clientEventId: string;
    exposureId: string;
    assetId: string;
    kind: 'keep';
  }): Promise<InteractionResponse> {
    return this.request('POST', '/interactions', body, [200, 201, 202], true, interactionResponse);
  }

  async getEvent(eventId: string): Promise<EventStatus> {
    return this.request('GET', `/events/${encodeURIComponent(eventId)}`, undefined, [200], false, eventStatus);
  }

  async getTraceRevisit(eventId: string): Promise<TraceRevisit> {
    return this.request('GET', `/traces/${encodeURIComponent(eventId)}`, undefined, [200], false, traceRevisit);
  }

  /** ADR-0028/#113: a pure read of the already-projected worlds/system state, never a recompute-on-read. */
  async getWorlds(): Promise<WorldSystemResponse> {
    return this.request('GET', '/worlds', undefined, [200], false, worldSystemResponseSchema);
  }

  /**
   * `treat409AsConflict` stays `false` for all four privacy routes, exactly like `getTraceRevisit`
   * above: a 409 here means the caller's `expectedPrivacyEpoch` is stale (ADR-0030's exact replay
   * contract), which is the same "your view of the universe is stale" fact `invalidatesReader`
   * already recognises generically for every other route in this app -- not the narrower
   * same-key-different-content case `postInteraction` alone uses `interaction-conflict` for.
   */
  async postPrivacyPause(body: PrivacyLifecycleRequest): Promise<PrivacyRecordingReceipt> {
    return this.request('POST', '/privacy/pause', body, [200], false, privacyRecordingReceiptSchema);
  }

  async postPrivacyResume(body: PrivacyLifecycleRequest): Promise<PrivacyRecordingReceipt> {
    return this.request('POST', '/privacy/resume', body, [200], false, privacyRecordingReceiptSchema);
  }

  async postPrivacyExport(body: PrivacyLifecycleRequest): Promise<PrivacyExportResult> {
    return this.request('POST', '/privacy/export', body, [200], false, privacyExportResultSchema);
  }

  async postPrivacyReset(body: PrivacyResetRequest): Promise<PrivacyResetReceipt> {
    return this.request('POST', '/privacy/reset', body, [200], false, privacyResetReceiptSchema);
  }

  async postSessionRevoke(): Promise<void> {
    await this.request('POST', '/session/revoke', {}, [204], false, emptyObjectSchema);
  }

  async postAccountDelete(body: AccountDeletionRequest): Promise<AccountDeletionReceipt> {
    return this.request('POST', '/account/delete', body, [200], false, accountDeletionReceiptSchema);
  }

  /** ADR-0026: `POST /v1/auth/magic-link` -- one fixed 202, deliberately indistinguishable
   * whether or not the address has an account (no CSRF: this route is exempt, see web-session.ts). */
  async postMagicLink(email: string): Promise<void> {
    await this.request('POST', '/auth/magic-link', { email }, [202], false, magicLinkRequestedSchema);
  }

  /** ADR-0034: consumes a magic-link sign-in token for the desktop cookie session. The server sets
   * the cookie itself (never in this response body); the returned `csrfToken` is the one thing the
   * caller must feed back into `setCsrfToken` so later mutating requests carry it immediately. */
  async postWebSession(token: string): Promise<WebSessionResponse> {
    return this.request('POST', '/auth/web-session', { token }, [200], false, webSessionResponseSchema);
  }

  /** Never persisted; see the `csrfToken` field doc comment. Passing `null` (sign-out, account
   * deletion, or a fresh 401) forgets it, so a later reused instance never sends a stale value. */
  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  /**
   * ADR-0034: true only when this credential is *confirmed* to be a bearer/dev-proxy session --
   * `GET /v1/session/csrf` answers 400 for exactly one reason ("Only a cookie session has a CSRF
   * token"), never for anything else. Any other outcome (200, 401, a network failure) returns
   * `false`: the safe default when this cannot be confirmed is to treat an ambient authentication
   * failure as "show the sign-in screen", not to risk silently leaving the reader at a dead end.
   *
   * This exists for exactly one caller (`Root`'s `onSignedOut` handler, #135): a bearer/dev-proxy
   * deployment has no sign-in surface of its own, so an *ambient* 401 there (the dev token
   * momentarily rejected, a test fault injection, ADR-0022's existing recovery flow) must keep
   * showing the reader app's own Unavailable-state-and-retry, exactly as it did before #135 --
   * never this screen. A cookie deployment's 401 (no cookie, revoked, deleted) is the one case
   * this screen exists for.
   */
  async isBearerSession(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.basePath}/session/csrf`, { headers: { Accept: 'application/json' } });
      return response.status === 400;
    } catch {
      return false;
    }
  }

  /**
   * CSRF retry wrapper (ADR-0034): every non-GET call goes through `attempt()` first. If it comes
   * back 403, this fetches the page's own token exactly once (`GET /v1/session/csrf` -- a 400 there
   * means a bearer/dev-proxy session, which never needed one) and retries the *same* call exactly
   * once more -- when no token was known yet, or when the one it sent turns out to be stale (a
   * session that ended and a new sign-in since, in the same page). A 403 for the page's *current*
   * token is a real refusal (cross-origin, say) and is not retried. This wraps `attempt()` rather than sitting inside
   * its per-attempt loop, so the existing transient-failure retry/backoff and requestId reuse
   * (the caller's own `body`, re-sent unchanged) are untouched -- a 403 is not itself a transient
   * status, so `attempt()` already throws immediately on it without consuming that loop's budget.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    expected: number[],
    treat409AsConflict: boolean,
    schema: ZodType<T>,
  ): Promise<T> {
    try {
      return await this.attempt(method, path, body, expected, treat409AsConflict, schema);
    } catch (error) {
      if (method === 'GET' || !isCsrfRefusal(error)) throw error;
      const sent = this.csrfToken;
      await this.refreshCsrfToken();
      if (sent !== null && this.csrfToken === sent) throw error;
      return this.attempt(method, path, body, expected, treat409AsConflict, schema);
    }
  }

  private async refreshCsrfToken(): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.basePath}/session/csrf`, { headers: { Accept: 'application/json' } });
      if (response.status !== 200) return; // 400: a bearer/dev-proxy session has no token to fetch.
      const parsed = sessionCsrfSchema.safeParse(JSON.parse(await response.text()));
      if (parsed.success) this.csrfToken = parsed.data.csrfToken;
    } catch {
      // A failed preflight never blocks the one allowed retry in `request()`: it simply fails again
      // with the same 403 if the session genuinely has no way to authenticate this change.
    }
  }

  private async attempt<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    expected: number[],
    treat409AsConflict: boolean,
    schema: ZodType<T>,
  ): Promise<T> {
    let lastError: ApiException | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const headers: Record<string, string> = body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' };
        // ADR-0034: sent whenever known, on every non-GET request -- a GET is never CSRF-gated.
        if (method !== 'GET' && this.csrfToken !== null) headers['X-CSRF-Token'] = this.csrfToken;
        const response = await this.fetchImpl(`${this.basePath}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        if (response.status === 409 && treat409AsConflict) {
          throw new ApiException({ kind: 'interaction-conflict', message: 'Interaction key reused with different content' });
        }
        if (expected.includes(response.status)) {
          let json: unknown;
          try {
            json = text.length ? JSON.parse(text) : {};
          } catch {
            throw new ApiException({ kind: 'protocol', message: 'Response was not valid JSON' });
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new ApiException({ kind: 'protocol', message: 'Response did not match the expected shape' });
          }
          return parsed.data;
        }
        if (isTransient(response.status)) {
          lastError = new ApiException({ kind: 'server', statusCode: response.status, body: text });
          if (attempt < this.maxAttempts) {
            await delay(this.delaysMs[attempt === 1 ? 0 : 1]);
            continue;
          }
          throw lastError;
        }
        throw new ApiException({ kind: 'server', statusCode: response.status, body: text });
      } catch (error) {
        if (error instanceof ApiException) {
          if (error.error.kind === 'interaction-conflict') throw error;
          lastError = error;
          if (attempt >= this.maxAttempts || !isRetryableNetworkFailure(error.error)) throw error;
          await delay(this.delaysMs[attempt === 1 ? 0 : 1]);
          continue;
        }
        // A thrown TypeError from fetch() means the network request itself failed
        // (connection refused/reset, DNS, CORS-like same-origin proxy failure).
        lastError = new ApiException({ kind: 'network', message: describeNetworkError(error) });
        if (attempt < this.maxAttempts) {
          await delay(this.delaysMs[attempt === 1 ? 0 : 1]);
          continue;
        }
      }
    }
    throw lastError ?? new ApiException({ kind: 'network', message: 'Unknown network failure' });
  }
}

/** ADR-0034: the one 403 shape `request()`'s CSRF retry reacts to -- any other server refusal
 * (including a 403 the app might one day return for an unrelated reason) is left as a terminal
 * error, never mistaken for "fetch a token and retry". */
function isCsrfRefusal(error: unknown): boolean {
  return error instanceof ApiException && error.error.kind === 'server' && error.error.statusCode === 403;
}

/** `POST /v1/session/revoke` answers 204 with no body; `attempt()` already turns an empty body
 * into `{}` for a schema to check, so this validates that there genuinely was nothing else there. */
const emptyObjectSchema = z.object({}).strict();

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) return error.message || 'Could not reach the bootstrap service';
  return 'Could not reach the bootstrap service';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Human-facing message for a caught error, mirroring ApiClient.kt's `message()` helper. */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiException)) return 'Connection interrupted. Please retry; your action keeps the same identity.';
  switch (error.error.kind) {
    case 'interaction-conflict':
      return 'This action could not be matched. Your existing keep has not been changed.';
    case 'server':
      if (error.error.statusCode === 401) return 'This device session is no longer available.';
      return 'Connection interrupted. Please retry; your action keeps the same identity.';
    default:
      return 'Connection interrupted. Please retry; your action keeps the same identity.';
  }
}

/** A 401/409/422 response (or an unrecoverable protocol mismatch) invalidates the reader's private state. */
export function invalidatesReader(error: unknown): boolean {
  if (!(error instanceof ApiException)) return false;
  return error.error.kind === 'server' && [401, 409, 422].includes(error.error.statusCode);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiException && error.error.kind === 'server' && error.error.statusCode === 401;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `/feed`, with at most the 256 most recent opened ids of this trip (#133). */
export function feedPath(exclude: Iterable<string>): string {
  const ids = [...new Set([...exclude].filter(id => UUID.test(id)))].slice(-256);
  return ids.length === 0 ? '/feed' : `/feed?exclude=${ids.join(',')}`;
}
