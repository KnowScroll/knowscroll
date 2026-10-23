import { ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { problem, problemFromOrpcError } from './problems.js';

function recordingLog() {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const logEvent = ((event: string, fields: Record<string, unknown> = {}) =>
    events.push({ event, fields })) as unknown as LogEvent;
  return { events, logEvent };
}

describe('the outcome → RFC 9457 mapping', () => {
  it('maps a typed refusal to its catalogue status and code without logging', () => {
    const { events, logEvent } = recordingLog();
    expect(problemFromOrpcError(problem('CONFLICT'), logEvent)).toEqual({
      type: 'tag:knowscroll.space,2026:problem:conflict',
      title: 'This conflicts with the current state; reload and try again.',
      status: 409,
      code: 'CONFLICT',
    });
    expect(events).toEqual([]);
  });

  it('reports input validation failures by path and issue code, never the rejected value', () => {
    const { logEvent } = recordingLog();
    const error = new ORPCError('BAD_REQUEST', {
      data: {
        issues: [
          {
            path: [{ key: 'target' }, 'assetId'],
            code: 'invalid_format',
            message: 'secret-looking input hunter2',
            input: 'hunter2',
          },
        ],
      },
    });
    const details = problemFromOrpcError(error, logEvent);
    expect(details).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      issues: [{ path: ['target', 'assetId'], code: 'invalid_format' }],
    });
    expect(JSON.stringify(details)).not.toContain('hunter2');
  });

  it('maps oRPC 4xx codes to their problem instead of a 500', () => {
    const { events, logEvent } = recordingLog();
    const cases: [string, number, string][] = [
      ['UNAUTHORIZED', 401, 'UNAUTHENTICATED'],
      ['FORBIDDEN', 403, 'FORBIDDEN'],
      ['NOT_FOUND', 404, 'NOT_FOUND'],
      ['CONFLICT', 409, 'CONFLICT'],
      ['UNPROCESSABLE_CONTENT', 422, 'UNPROCESSABLE_REQUEST'],
      ['TOO_MANY_REQUESTS', 429, 'TOO_MANY_REQUESTS'],
    ];
    for (const [code, status, problemCode] of cases) {
      expect(problemFromOrpcError(new ORPCError(code), logEvent)).toMatchObject({ status, code: problemCode });
    }
    // An oRPC 4xx we do not know keeps a client-error meaning.
    expect(problemFromOrpcError(new ORPCError('SOMETHING_NEW', { status: 418 }), logEvent)).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
    expect(events).toEqual([]);
  });

  it('maps the command key conflict to 422 COMMAND_KEY_REUSED', () => {
    const { logEvent } = recordingLog();
    expect(problemFromOrpcError(problem('COMMAND_KEY_REUSED'), logEvent)).toMatchObject({
      type: 'tag:knowscroll.space,2026:problem:command-key-reused',
      status: 422,
      code: 'COMMAND_KEY_REUSED',
    });
  });

  it('answers lock, timeout, deadlock and serialisation failures as a retryable 503, logged once with their code', () => {
    const codes = ['SCOPE_BUSY', '55P03', '57014', '40P01', '40001'];
    for (const code of codes) {
      const { events, logEvent } = recordingLog();
      const wrapped = new Error('kysely wrapper', { cause: Object.assign(new Error('driver says no'), { code }) });
      expect(problemFromOrpcError(new ORPCError('INTERNAL_SERVER_ERROR', { cause: wrapped }), logEvent)).toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(events).toEqual([{ event: 'http.retryable_failure', fields: { reasonCode: code, error: wrapped } }]);
    }
  });

  it('answers an unexpected error with a sanitised INTERNAL problem and logs it exactly once', () => {
    const { events, logEvent } = recordingLog();
    const cause = new Error('connection to postgres://u:hunter2@db failed');
    const details = problemFromOrpcError(new ORPCError('INTERNAL_SERVER_ERROR', { cause }), logEvent);
    expect(details).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(JSON.stringify(details)).not.toContain('hunter2');
    expect(events).toEqual([{ event: 'http.unexpected_error', fields: { error: cause } }]);
  });
});

import type { Request, Response } from 'express';
import { KeepPlaceProblemSchema } from '@knowscroll/contracts';
import { requestContextMiddleware } from './request-context.js';
import { keepProblem } from './problems.js';
function inKeep<T>(work: () => T): T {
  let value: T | undefined;
  requestContextMiddleware(() => undefined)(
    { method: 'POST', path: '/V1/EXPERIENCE/KEEP/PLACE/' } as Request,
    { setHeader: () => undefined, once: () => undefined } as unknown as Response,
    () => {
      value = work();
    },
  );
  return value as T;
}
describe('finite Keep problem serializer, independent of caller authority', () => {
  it('masks unknown/numeric locations and drops values, messages, detail and instance', () => {
    const details = inKeep(() =>
      problemFromOrpcError(
        new ORPCError('BAD_REQUEST', {
          data: {
            issues: [
              {
                path: ['entry', 'PRIVATE-KEY', 412],
                code: 'unrecognized_keys',
                input: 'PRIVATE-VALUE',
                message: 'PRIVATE-MESSAGE',
              },
              { path: ['position', 'positionMs'], code: 'too_big', input: 'PRIVATE-VALUE' },
            ],
          },
        }),
        () => undefined,
      ),
    );
    expect(KeepPlaceProblemSchema.safeParse(details).success).toBe(true);
    expect(details.issues).toEqual([
      { path: ['entry', 'unknown', 'unknown'], code: 'unrecognized_keys' },
      { path: ['position', 'positionMs'], code: 'too_big' },
    ]);
    expect(JSON.stringify(details)).not.toContain('PRIVATE');
    expect(
      inKeep(() => problemFromOrpcError(problem('INVALID_REQUEST', { detail: 'PRIVATE-DETAIL' }), () => undefined)),
    ).not.toHaveProperty('detail');
  });
  it('closes malformed issue data without coercing hostile keys or exposing rejected values', () => {
    const error = new ORPCError('BAD_REQUEST', {
      data: { issues: [null, { path: [{ key: 'entry' }, { key: { private: 'CANARY' } }, 7], code: 'HOSTILE' }] },
    });
    const result = inKeep(() => problemFromOrpcError(error, () => undefined));
    expect(result.issues).toEqual([
      { path: [], code: 'custom' },
      { path: ['entry', 'unknown', 'unknown'], code: 'custom' },
    ]);
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(KeepPlaceProblemSchema.safeParse(result).success).toBe(true);
  });
  it('preserves only an internally validated stale revision; arbitrary error data cannot supply it', () => {
    const valid = inKeep(() =>
      problemFromOrpcError(
        keepProblem({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 9 }),
        () => undefined,
      ),
    );
    expect(valid).toMatchObject({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 9 });
    const original = keepProblem({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 11 });
    const cloned = new ORPCError(original.code, {
      status: original.status,
      message: original.message,
      data: { ...(original.data as object) },
      cause: original.cause,
      defined: true,
    });
    expect(inKeep(() => problemFromOrpcError(cloned, () => undefined))).toMatchObject({
      code: 'KEEP_PLACE_REVISION_STALE',
      currentPlaceRevision: 11,
    });
    for (const error of [
      new ORPCError('KEEP_PLACE_REVISION_STALE', { data: { currentPlaceRevision: 999 } }),
      keepProblem({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: NaN }),
    ]) {
      const details = inKeep(() => problemFromOrpcError(error, () => undefined));
      expect(details.code).toBe('INTERNAL');
      expect(details).not.toHaveProperty('currentPlaceRevision');
    }
  });
});
