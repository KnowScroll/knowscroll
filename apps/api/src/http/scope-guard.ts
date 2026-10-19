import { ORPCError } from '@orpc/server';
import type { NextFunction, Request, Response } from 'express';
import { UNSCOPED_V1_ROUTES, problemDetails, type ProblemCode } from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { scopeClaimMatches, scopeClaimOfRequest, type AuthenticatedCallers, type Caller } from './callers.js';
import { problemFromOrpcError, sendProblem } from './problems.js';
import { currentRequest } from './request-context.js';

/** The caller the guard admitted, per request: handlers read it, never resolve one themselves. */
const admitted = new WeakMap<Request, Caller>();

function templatePattern(template: string): RegExp {
  const segments = template
    .toLowerCase()
    .split('/')
    .map((segment) => (/^\{[^/{}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${segments.join('/')}/?$`);
}

/**
 * Whether a request path is an account route that must carry the scope claim: every `/v1` path
 * (compared case-insensitively, as Express routes it) except the reviewed `UNSCOPED_V1_ROUTES`.
 */
export function requiresScope(path: string, unscoped: readonly string[] = UNSCOPED_V1_ROUTES): boolean {
  const lower = path.toLowerCase();
  if (lower !== '/v1' && !lower.startsWith('/v1/')) return false;
  return !unscoped.some((template) => templatePattern(template).test(lower));
}

function refuse(response: Response, code: ProblemCode): void {
  const details = problemDetails(code);
  const context = currentRequest();
  if (context !== undefined) context.problemCode = details.code;
  sendProblem(response, details);
}

/**
 * Express middleware in front of every route (re-review N3): for each `/v1` request it resolves
 * the caller from the credential (`UNAUTHENTICATED`, 401, when there is none) and requires the
 * scope claim to name that caller's account and current privacy epoch (`SCOPE_MISMATCH`, 409,
 * otherwise: review M1, m11), before any handler runs. The admitted caller is kept for the
 * handler (`admittedCaller`), so no `/v1` handler resolves a caller itself; a handler reached
 * without the guard fails closed. A database failure answers like any handler's (retryable 503 or
 * `INTERNAL`). Opt-outs are only the reviewed `UNSCOPED_V1_ROUTES`.
 */
export function scopeGuard(options: {
  readonly callers: AuthenticatedCallers;
  readonly logEvent: LogEvent;
  readonly unscoped?: readonly string[];
}) {
  const unscoped = options.unscoped ?? UNSCOPED_V1_ROUTES;
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (!requiresScope(request.path, unscoped)) {
      next();
      return;
    }
    let caller: Caller | undefined;
    try {
      caller = await options.callers.resolve(request.headers);
    } catch (error) {
      sendProblem(
        response,
        problemFromOrpcError(new ORPCError('INTERNAL_SERVER_ERROR', { cause: error }), options.logEvent),
      );
      return;
    }
    if (caller === undefined) {
      refuse(response, 'UNAUTHENTICATED');
      return;
    }
    if (!scopeClaimMatches(caller, scopeClaimOfRequest(request.headers))) {
      refuse(response, 'SCOPE_MISMATCH');
      return;
    }
    admitted.set(request, caller);
    next();
  };
}

/** The caller the scope guard admitted for this request; throws (500) if the guard did not run. */
export function admittedCaller(request: Request): Caller {
  const caller = admitted.get(request);
  if (caller === undefined) throw new Error('A /v1 handler ran without the scope guard');
  return caller;
}
