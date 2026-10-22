import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';

/**
 * Per-request diagnostic context. The request ID is generated here and returned in the
 * `x-request-id` response header; a client-supplied ID is never trusted (blueprint §26).
 */
export interface RequestContext {
  readonly requestId: string;
  problemCode?: string;
  readonly problemFamily?:
    'keep-place' | 'keep-remove' | 'privacy-clear' | 'saved-list' | 'region-encounter' | 'formation' | 'social';
}

/** Finite serializer/cache selection only, never caller or operation authority. */
export function isKeepPlaceRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return request.method === 'POST' && /^\/v1\/experience\/keep\/(?:read|place)\/?$/i.test(request.path);
}

/** New removal has a separate closed error family, selected before auth/body parsing. */
function isKeepRemovalRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return request.method === 'POST' && /^\/v1\/experience\/keep\/remove\/?$/i.test(request.path);
}

/** Only the two mounted privacy POSTs; this selects serialization, never authority. */
function isPrivacyClearRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return request.method === 'POST' && /^\/v1\/privacy\/clear-exploration(?:\/status)?\/?$/i.test(request.path);
}

/** Select only the eleven mounted methods/paths, never the wider declared Social surface. */
function isSocialRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return (
    (request.method === 'GET' && /^\/v1\/social\/profile\/?$/i.test(request.path)) ||
    (request.method === 'POST' &&
      /^\/v1\/social\/(?:profile|people\/lookup|pairs\/read|friends\/(?:request|accept|decline|cancel|remove|block|unblock))\/?$/i.test(
        request.path,
      ))
  );
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The context of the request being handled, if any. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Express middleware: assigns the request ID, and logs `http.request_completed` exactly once with
 * the route template (never the raw URL), status, duration and problem code when the response
 * finishes, or with `outcome: client_aborted` when the client disconnects first.
 */
export function requestContextMiddleware(logEvent: LogEvent) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const social = isSocialRequest(request);
    const keep = isKeepPlaceRequest(request);
    const removal = isKeepRemovalRequest(request);
    const privacy = isPrivacyClearRequest(request);
    const saved = request.method === 'GET' && /^\/v1\/saved\/?$/i.test(request.path);
    const region = request.method === 'POST' && /^\/v1\/experience\/region\/(?:preview|open)\/?$/i.test(request.path);
    const formation =
      request.method === 'POST' && /^\/v1\/universe\/formation\/(?:read|claim|acknowledge)\/?$/i.test(request.path);
    const context: RequestContext = {
      requestId: randomUUID(),
      ...(social ? { problemFamily: 'social' as const } : {}),
      ...(formation ? { problemFamily: 'formation' as const } : {}),
      ...(keep ? { problemFamily: 'keep-place' as const } : {}),
      ...(removal ? { problemFamily: 'keep-remove' as const } : {}),
      ...(privacy ? { problemFamily: 'privacy-clear' as const } : {}),
      ...(saved ? { problemFamily: 'saved-list' as const } : {}),
      ...(region ? { problemFamily: 'region-encounter' as const } : {}),
    };
    if (social) response.setHeader('cache-control', 'private, no-store');
    if (keep) response.setHeader('cache-control', 'private, no-store');
    if (removal) response.setHeader('cache-control', 'private, no-store');
    if (privacy) response.setHeader('cache-control', 'private, no-store');
    if (saved) response.setHeader('cache-control', 'private, no-store');
    if (formation) response.setHeader('cache-control', 'private, no-store');
    if (region) response.setHeader('cache-control', 'private, no-store');
    const startedAt = performance.now();
    response.setHeader('x-request-id', context.requestId);
    let logged = false;
    const complete = (aborted: boolean): void => {
      if (logged) return;
      logged = true;
      const route: unknown = (request.route as { path?: unknown } | undefined)?.path;
      logEvent('http.request_completed', {
        requestId: context.requestId,
        method: request.method,
        route: typeof route === 'string' ? route : 'unmatched',
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        // A client that disconnects before the response finished is recorded once as aborted.
        ...(aborted ? { outcome: 'client_aborted' } : {}),
        ...(context.problemCode === undefined ? {} : { reasonCode: context.problemCode }),
      });
    };
    response.once('finish', () => complete(false));
    response.once('close', () => complete(!response.writableFinished));
    storage.run(context, next);
  };
}
