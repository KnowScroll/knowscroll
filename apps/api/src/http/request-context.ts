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
    | 'keep-place'
    | 'keep-remove'
    | 'privacy-clear'
    | 'recording'
    | 'saved-list'
    | 'region-encounter'
    | 'formation'
    | 'social';
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

/** Exact mounted recording POSTs only; selection grants no scope or collection authority. */
function isRecordingRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return (
    request.method === 'POST' &&
    /^\/v1\/(?:privacy\/recording\/(?:read|set)|observations\/recording-batch)\/?$/i.test(request.path)
  );
}

/**
 * Select only the mounted Social methods and paths, never the wider declared surface: profiles,
 * pairs, invites, rosters, conversations, share links, sharing settings, visits and the public share preview.
 */
function isSocialRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return (
    (request.method === 'GET' &&
      /^\/v1\/social\/(?:profile|invites|visibility|presence\/preference|read-receipts)\/?$/i.test(request.path)) ||
    (request.method === 'POST' &&
      /^\/v1\/social\/(?:profile|visibility|presence\/preference|read-receipts|visits\/read|friends\/page|requests\/page|people\/lookup|pairs\/read|invites\/(?:resolve|create|revoke)|friends\/(?:request|accept|decline|cancel|remove|block|unblock)|conversations\/(?:start|inbox|read|history|changes|send|send\/read|react|mark-read|mute|leave)|threads\/(?:create|read|history|changes|send|react|respond|mark-read|leave|inbox|snippets\/open|places\/(?:read|set|hide))|content-shares\/(?:create|revoke|read|list|resolve))\/?$/i.test(
        request.path,
      )) ||
    (request.method === 'POST' && /^\/s\/preview\/?$/i.test(request.path))
  );
}

/** Idea-room POSTs: they share Social's problem family and private cache policy (D-051). */
function isRoomsRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  return (
    request.method === 'POST' &&
    /^\/v1\/rooms\/(?:list|read|join|leave|invite|moderate|stations|discussions\/(?:create|read|history|changes|send|pin|hide|snippets\/open)|activities\/(?:list|read|create|vote|moderate)|inhabitants\/ask)\/?$/i.test(
      request.path,
    )
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
    const social = isSocialRequest(request) || isRoomsRequest(request);
    const keep = isKeepPlaceRequest(request);
    const removal = isKeepRemovalRequest(request);
    const privacy = isPrivacyClearRequest(request);
    const recording = isRecordingRequest(request);
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
      ...(recording ? { problemFamily: 'recording' as const } : {}),
      ...(saved ? { problemFamily: 'saved-list' as const } : {}),
      ...(region ? { problemFamily: 'region-encounter' as const } : {}),
    };
    if (social) response.setHeader('cache-control', 'private, no-store');
    if (keep) response.setHeader('cache-control', 'private, no-store');
    if (removal) response.setHeader('cache-control', 'private, no-store');
    if (privacy) response.setHeader('cache-control', 'private, no-store');
    if (recording) response.setHeader('cache-control', 'private, no-store');
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
