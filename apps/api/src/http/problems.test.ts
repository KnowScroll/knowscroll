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

  it('answers lock, timeout, deadlock and serialisation failures as a retryable 503 without logging a fault', () => {
    const { events, logEvent } = recordingLog();
    for (const code of ['SCOPE_BUSY', '55P03', '57014', '40P01', '40001']) {
      const wrapped = new Error('kysely wrapper', { cause: Object.assign(new Error('driver says no'), { code }) });
      expect(problemFromOrpcError(new ORPCError('INTERNAL_SERVER_ERROR', { cause: wrapped }), logEvent)).toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
    }
    expect(events).toEqual([]);
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
