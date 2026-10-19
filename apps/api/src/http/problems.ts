import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ORPCError } from '@orpc/server';
import type { NextFunction, Request, Response } from 'express';
import {
  PROBLEM_MEDIA_TYPE,
  problemCatalogue,
  problemDetails,
  type ProblemCode,
  type ProblemDetails,
  type ProblemIssue,
} from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { LOG_EVENT } from '../tokens.js';
import { currentRequest } from './request-context.js';

export interface ProblemData {
  readonly detail?: string;
  readonly issues?: ProblemIssue[];
}

/**
 * The single outcome → HTTP mapping of the API (blueprint §23 pattern 3). Contract handlers
 * raise oRPC errors whose code is a catalogue problem code; oRPC's own codes map to their
 * problem equivalents (any other 4xx keeps a 4xx meaning); everything else is an unexpected error,
 * logged once here and answered with a sanitised `INTERNAL` problem.
 */
export function problem(code: ProblemCode, extras: ProblemData = {}): ORPCError<ProblemCode, ProblemData> {
  return new ORPCError(code, {
    status: problemCatalogue[code].status,
    message: problemCatalogue[code].title,
    data: extras,
  });
}

function isProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(problemCatalogue, code);
}

/** oRPC's standard error codes and the problem each one means here. */
const orpcCodes: Partial<Record<string, ProblemCode>> = {
  BAD_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_SUPPORTED: 'METHOD_NOT_ALLOWED',
  NOT_ACCEPTABLE: 'INVALID_REQUEST',
  CONFLICT: 'CONFLICT',
  PRECONDITION_FAILED: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE_CONTENT: 'UNPROCESSABLE_REQUEST',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};

/** Converts any oRPC error into problem details. Used as oRPC's error body encoder. */
export function problemFromOrpcError(error: ORPCError<string, unknown>, logEvent: LogEvent): ProblemDetails {
  if (isProblemCode(error.code)) {
    const data = (error.data ?? {}) as ProblemData;
    return finish(problemDetails(error.code, data));
  }
  if (error.code === 'BAD_REQUEST')
    return finish(problemDetails('INVALID_REQUEST', { issues: validationIssues(error) }));
  const mapped =
    orpcCodes[error.code] ??
    (error.status >= 400 && error.status < 500 ? (statusCodes[error.status] ?? 'INVALID_REQUEST') : undefined);
  if (mapped !== undefined) return finish(problemDetails(mapped));
  logUnexpected(logEvent, error.cause ?? error);
  return finish(problemDetails('INTERNAL'));
}

/** Stable issue locations from an oRPC input validation failure; never the rejected values. */
function validationIssues(error: ORPCError<string, unknown>): ProblemIssue[] {
  const issues: unknown = (error.data as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 20).map((issue: unknown) => {
    const candidate = issue as { path?: unknown; code?: unknown };
    const path = Array.isArray(candidate.path)
      ? candidate.path.slice(0, 10).map((segment: unknown) => {
          const key: unknown =
            typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment;
          return typeof key === 'number' ? key : String(key).slice(0, 64);
        })
      : [];
    return {
      path,
      code: typeof candidate.code === 'string' && /^[a-z_]{1,40}$/.test(candidate.code) ? candidate.code : 'invalid',
    } satisfies ProblemIssue;
  });
}

function finish(details: ProblemDetails): ProblemDetails {
  const context = currentRequest();
  if (context !== undefined) context.problemCode = details.code;
  return details;
}

function logUnexpected(logEvent: LogEvent, error: unknown): void {
  const context = currentRequest();
  logEvent('http.unexpected_error', { ...(context === undefined ? {} : { requestId: context.requestId }), error });
}

/** Writes problem details with the RFC 9457 media type. */
export function sendProblem(response: Response, details: ProblemDetails): void {
  response.status(details.status).setHeader('content-type', PROBLEM_MEDIA_TYPE).end(JSON.stringify(details));
}

/**
 * Nest exception filter for failures outside oRPC handlers: unknown routes (404), methods, and
 * exceptions raised by the framework itself.
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOG_EVENT) private readonly logEvent: LogEvent) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    sendProblem(response, finish(problemForHttpException(exception, this.logEvent)));
  }
}

function problemForHttpException(exception: unknown, logEvent: LogEvent): ProblemDetails {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = statusCodes[status];
    if (code !== undefined) return problemDetails(code);
    if (status >= 400 && status < 500) return problemDetails('INVALID_REQUEST');
  }
  logUnexpected(logEvent, exception);
  return problemDetails('INTERNAL');
}

const statusCodes: Partial<Record<number, ProblemCode>> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_REQUEST',
  429: 'TOO_MANY_REQUESTS',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Express error middleware for body parsing, registered before the routes. Body parser errors
 * carry a `type` such as `entity.too.large`; anything else is unexpected.
 */
export function bodyErrorMiddleware(logEvent: LogEvent) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const type: unknown = (error as { type?: unknown } | null)?.type;
    const details =
      type === 'entity.too.large'
        ? problemDetails('PAYLOAD_TOO_LARGE')
        : type === 'entity.parse.failed'
          ? problemDetails('INVALID_REQUEST', { detail: 'The body is not valid JSON.' })
          : type === 'encoding.unsupported' || type === 'charset.unsupported'
            ? problemDetails('UNSUPPORTED_MEDIA_TYPE')
            : (logUnexpected(logEvent, error), problemDetails('INTERNAL'));
    sendProblem(response, finish(details));
  };
}

const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Refuses request bodies that are not JSON, so every body passes the size-limited JSON parser. */
export function requireJsonBodies() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const hasBody =
      request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? '0') > 0;
    if (bodyMethods.has(request.method) && hasBody && !request.is('application/json')) {
      sendProblem(response, finish(problemDetails('UNSUPPORTED_MEDIA_TYPE')));
      return;
    }
    next();
  };
}
