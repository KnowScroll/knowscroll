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
    expect(problemFromOrpcError(problem('COMMAND_KEY_REUSED'), logEvent)).toEqual({
      type: 'tag:knowscroll.space,2026:problem:command-key-reused',
      title: 'This command ID was already used for a different request.',
      status: 422,
      code: 'COMMAND_KEY_REUSED',
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

  it('answers an unexpected error with a sanitised INTERNAL problem and logs it exactly once', () => {
    const { events, logEvent } = recordingLog();
    const cause = new Error('connection to postgres://u:hunter2@db failed');
    const details = problemFromOrpcError(new ORPCError('INTERNAL_SERVER_ERROR', { cause }), logEvent);
    expect(details).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(JSON.stringify(details)).not.toContain('hunter2');
    expect(events).toEqual([{ event: 'http.unexpected_error', fields: { error: cause } }]);
  });

  it('answers a personal-scope lock timeout as a retryable 503 without logging a fault', () => {
    const { events, logEvent } = recordingLog();
    const busy = Object.assign(new Error('lock not granted'), { code: 'SCOPE_BUSY' });
    expect(problemFromOrpcError(new ORPCError('INTERNAL_SERVER_ERROR', { cause: busy }), logEvent)).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(events).toEqual([]);
  });
});
