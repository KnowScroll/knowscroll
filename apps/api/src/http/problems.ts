import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ORPCError } from '@orpc/server';
import type { NextFunction, Request, Response } from 'express';
import {
  PROBLEM_MEDIA_TYPE,
  KeepPlaceProblemSchema,
  KeepRemovalProblemSchema,
  KeepRemovalProblemIssueSchema,
  type KeepRemovalProblem,
  KeepProblemIssueSchema,
  type KeepPlaceProblem,
  problemCatalogue,
  problemDetails,
  type ProblemCode,
  type ProblemDetails,
  type ProblemIssue,
} from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { LOG_EVENT } from '../tokens.js';
import { currentRequest } from './request-context.js';
import { privacyDetails, privacyIssues } from './privacy-problems.js';
import { savedListDetails, savedListIssues } from './saved-list-problems.js';
import { regionEncounterDetails, regionEncounterIssues } from './region-encounter-problems.js';

export interface ProblemData {
  readonly detail?: string;
  readonly issues?: ProblemIssue[];
}

/**
 * The single outcome → HTTP mapping of the API (blueprint §23 pattern 3). Contract handlers
 * raise oRPC errors whose code is a catalogue problem code; oRPC's own codes map to their
 * problem equivalents (any other 4xx keeps a 4xx meaning); retryable database failures answer a
 * 503 with `Retry-After` and are logged once as `http.retryable_failure`; everything else is an
 * unexpected error, logged once as `http.unexpected_error` and answered with a sanitised
 * `INTERNAL` problem.
 */
export function problem(code: ProblemCode, extras: ProblemData = {}): ORPCError<ProblemCode, ProblemData> {
  return new ORPCError(code, {
    status: problemCatalogue[code].status,
    message: problemCatalogue[code].title,
    data: extras,
  });
}

const keepErrors = new WeakMap<object, KeepPlaceProblem>();
/** Only a validated closed use-case refusal can carry the authorized current CAS revision. */
export function keepProblem(refusal: {
  readonly code: KeepPlaceProblem['code'];
  readonly currentPlaceRevision?: number;
}): ORPCError<string, unknown> {
  const { type, title, status, code } = problemDetails(refusal.code);
  const parsed = KeepPlaceProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(code === 'KEEP_PLACE_REVISION_STALE' ? { currentPlaceRevision: refusal.currentPlaceRevision } : {}),
  });
  const details = parsed.success ? parsed.data : KeepPlaceProblemSchema.parse(problemDetails('INTERNAL'));
  // oRPC validates and clones declared errors/data, preserving cause. Only this in-memory
  // marker carries provenance; a copied error data object cannot manufacture it.
  const marker = new Error('KEEP_CLOSED_REFUSAL');
  keepErrors.set(marker, details);
  const error = new ORPCError(details.code, {
    status: details.status,
    message: details.title,
    data: details,
    cause: marker,
  });
  return error;
}
/** Closed catalogue fields; arbitrary details, values, instance and untrusted CAS data are discarded. */
function keepIssues(input: unknown): NonNullable<KeepPlaceProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const candidate = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const path = Array.isArray(candidate.path) ? candidate.path.slice(0, 8) : [];
    const code = KeepProblemIssueSchema.shape.code.safeParse(candidate.code);
    return {
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const token = KeepProblemIssueSchema.shape.path.element.safeParse(key);
        return token.success ? token.data : 'unknown';
      }),
      code: code.success ? code.data : 'custom',
    };
  });
}
function keepDetails(details: ProblemDetails): ProblemDetails {
  const { type, title, status, code } = details;
  const parsed = KeepPlaceProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: keepIssues(details.issues) }),
  });
  return parsed.success ? parsed.data : KeepPlaceProblemSchema.parse(problemDetails('INTERNAL'));
}

/** Removal never carries privileged place-CAS or replacement metadata. */
function keepRemovalIssues(input: unknown): NonNullable<KeepRemovalProblem['issues']> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((issue: unknown) => {
    const candidate = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown; code?: unknown }) : {};
    const path = Array.isArray(candidate.path) ? candidate.path.slice(0, 8) : [];
    const code = KeepRemovalProblemIssueSchema.shape.code.safeParse(candidate.code);
    return {
      path: path.map((segment: unknown) => {
        const key = segment !== null && typeof segment === 'object' && 'key' in segment ? segment.key : segment;
        const token = KeepRemovalProblemIssueSchema.shape.path.element.safeParse(key);
        return token.success ? token.data : 'unknown';
      }),
      code: code.success ? code.data : 'custom',
    };
  });
}
function keepRemovalDetails(details: ProblemDetails): KeepRemovalProblem {
  const { type, title, status, code } = details;
  const parsed = KeepRemovalProblemSchema.safeParse({
    type,
    title,
    status,
    code,
    ...(details.issues === undefined ? {} : { issues: keepRemovalIssues(details.issues) }),
  });
  return parsed.success ? parsed.data : KeepRemovalProblemSchema.parse(problemDetails('INTERNAL'));
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
  const trusted = error.cause !== null && typeof error.cause === 'object' ? keepErrors.get(error.cause) : undefined;
  if (trusted !== undefined) {
    const context = currentRequest();
    if (
      context?.problemFamily === 'keep-remove' ||
      context?.problemFamily === 'privacy-clear' ||
      context?.problemFamily === 'saved-list' ||
      context?.problemFamily === 'region-encounter'
    )
      return finish(trusted);
    if (context !== undefined) context.problemCode = trusted.code;
    return trusted;
  }
  if (isProblemCode(error.code)) {
    const data = (error.data ?? {}) as ProblemData;
    return finish(problemDetails(error.code, data));
  }
  if (error.code === 'BAD_REQUEST' && currentRequest()?.problemFamily === 'region-encounter')
    return finish(
      problemDetails('INVALID_REQUEST', {
        issues: regionEncounterIssues((error.data as { issues?: unknown } | undefined)?.issues),
      }),
    );
  if (error.code === 'BAD_REQUEST' && currentRequest()?.problemFamily === 'saved-list')
    return finish(
      problemDetails('INVALID_REQUEST', {
        issues: savedListIssues((error.data as { issues?: unknown } | undefined)?.issues),
      }),
    );
  if (error.code === 'BAD_REQUEST' && currentRequest()?.problemFamily === 'privacy-clear')
    return finish(
      problemDetails('INVALID_REQUEST', {
        issues: privacyIssues((error.data as { issues?: unknown } | undefined)?.issues),
      }),
    );
  if (error.code === 'BAD_REQUEST' && currentRequest()?.problemFamily === 'keep-remove')
    return finish(
      problemDetails('INVALID_REQUEST', {
        issues: keepRemovalIssues((error.data as { issues?: unknown } | undefined)?.issues),
      }),
    );
  if (error.code === 'BAD_REQUEST')
    return finish(
      problemDetails('INVALID_REQUEST', {
        issues:
          currentRequest()?.problemFamily === 'keep-place'
            ? keepIssues((error.data as { issues?: unknown } | undefined)?.issues)
            : validationIssues(error),
      }),
    );
  const mapped =
    orpcCodes[error.code] ??
    (error.status >= 400 && error.status < 500 ? (statusCodes[error.status] ?? 'INVALID_REQUEST') : undefined);
  if (mapped !== undefined) return finish(problemDetails(mapped));
  // Lock waits, statement timeouts, deadlocks and serialisation failures are answered as a
  // retryable 503, and logged once with their code: a timeout or deadlock is usually a real fault
  // (a slow query, a lock-order bug) even though the client may simply retry.
  const retryable = retryableFailureCode(error.cause);
  if (retryable !== undefined) {
    const context = currentRequest();
    logEvent('http.retryable_failure', {
      ...(context === undefined ? {} : { requestId: context.requestId }),
      reasonCode: retryable,
      error: error.cause,
    });
    return finish(problemDetails('SERVICE_UNAVAILABLE'));
  }
  logUnexpected(logEvent, error.cause ?? error);
  return finish(problemDetails('INTERNAL'));
}

/**
 * The code of a PostgreSQL or personal-scope failure a client may simply retry, if `error` is one:
 * `SCOPE_BUSY` (personal-scope lock not granted in time), `55P03` lock_not_available, `57014`
 * query_canceled (statement timeout), `40P01` deadlock_detected, `40001` serialization_failure.
 * Searched through the cause chain, because drivers and Kysely wrap errors.
 */
export function retryableFailureCode(error: unknown): string | undefined {
  const retryable = new Set(['SCOPE_BUSY', '55P03', '57014', '40P01', '40001']);
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === 'string' && retryable.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Seconds a client should wait before retrying a 503 (`Retry-After`). */
export const RETRY_AFTER_SECONDS = 1;

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
  if (context?.problemFamily === 'region-encounter') {
    const closed = regionEncounterDetails(details);
    context.problemCode = closed.code;
    return closed;
  }
  if (context?.problemFamily === 'saved-list') {
    const closed = savedListDetails(details);
    context.problemCode = closed.code;
    return closed;
  }
  if (context?.problemFamily === 'privacy-clear') {
    const closed = privacyDetails(details);
    context.problemCode = closed.code;
    return closed;
  }
  if (context?.problemFamily === 'keep-remove') {
    const closed = keepRemovalDetails(details);
    context.problemCode = closed.code;
    return closed;
  }
  if (context !== undefined) context.problemCode = details.code;
  return context?.problemFamily === 'keep-place' ? keepDetails(details) : details;
}

function logUnexpected(logEvent: LogEvent, error: unknown): void {
  const context = currentRequest();
  logEvent('http.unexpected_error', { ...(context === undefined ? {} : { requestId: context.requestId }), error });
}

/** Writes problem details with the RFC 9457 media type (and `Retry-After` on a 503). */
export function sendProblem(response: Response, details: ProblemDetails): void {
  if (currentRequest()?.problemFamily === 'region-encounter') {
    details = regionEncounterDetails(details);
    const context = currentRequest();
    if (context !== undefined) context.problemCode = details.code;
    response.setHeader('cache-control', 'private, no-store');
  }
  if (currentRequest()?.problemFamily === 'saved-list') {
    details = savedListDetails(details);
    const context = currentRequest();
    if (context !== undefined) context.problemCode = details.code;
    response.setHeader('cache-control', 'private, no-store');
  }
  if (currentRequest()?.problemFamily === 'privacy-clear') {
    details = privacyDetails(details);
    const context = currentRequest();
    if (context !== undefined) context.problemCode = details.code;
    response.setHeader('cache-control', 'private, no-store');
  }
  if (currentRequest()?.problemFamily === 'keep-remove') {
    details = keepRemovalDetails(details);
    const context = currentRequest();
    if (context !== undefined) context.problemCode = details.code;
    response.setHeader('cache-control', 'private, no-store');
  }
  if (currentRequest()?.problemFamily === 'keep-place') {
    // Already validated trusted stale replies retain their sole authorized extension.
    const trusted = KeepPlaceProblemSchema.safeParse(details);
    details = trusted.success ? trusted.data : keepDetails(details);
    response.setHeader('cache-control', 'private, no-store');
  }
  if (details.status === 503) response.setHeader('retry-after', String(RETRY_AFTER_SECONDS));
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
