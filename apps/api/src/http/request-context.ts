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
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The context of the request being handled, if any. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Express middleware: assigns the request ID, and logs `http.request_completed` with the route
 * template (never the raw URL), status, duration and problem code once the response finishes.
 */
export function requestContextMiddleware(logEvent: LogEvent) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const context: RequestContext = { requestId: randomUUID() };
    const startedAt = performance.now();
    response.setHeader('x-request-id', context.requestId);
    response.on('finish', () => {
      const route: unknown = (request.route as { path?: unknown } | undefined)?.path;
      logEvent('http.request_completed', {
        requestId: context.requestId,
        method: request.method,
        route: typeof route === 'string' ? route : 'unmatched',
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...(context.problemCode === undefined ? {} : { reasonCode: context.problemCode }),
      });
    });
    storage.run(context, next);
  };
}
