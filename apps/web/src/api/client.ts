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
 * loopback API. This file must never import, construct, or reference a token.
 */
import type { ZodType } from 'zod';
import {
  eventStatus,
  exposureResponse,
  feedResponse,
  interactionResponse,
  privacyExportResultSchema,
  privacyRecordingReceiptSchema,
  privacyResetReceiptSchema,
  traceRevisit,
  universe,
  worldSystemResponseSchema,
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
  getFeed(): Promise<FeedResponse>;
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
}

export class ApiClient implements ReaderApi {
  private readonly basePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly delaysMs: [number, number];

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

  async getFeed(): Promise<FeedResponse> {
    return this.request('GET', '/feed', undefined, [200], false, feedResponse);
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

  private async request<T>(
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
        const response = await this.fetchImpl(`${this.basePath}${path}`, {
          method,
          headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
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
