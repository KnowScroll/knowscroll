import { ORPCError } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { apiContract, RecordingProblemSchema, problemDetails, type ProblemCode } from '@knowscroll/contracts';
import { currentRequest, requestContextMiddleware } from './request-context.js';
import { bodyErrorMiddleware, keepProblem, problemFromOrpcError, requireJsonBodies, sendProblem } from './problems.js';
import { requiresScope, scopeGuard } from './scope-guard.js';

const canary = 'PRIVATE-RECORDING-EVENT-KEY-VALUE-CANARY';
const paths = ['/v1/privacy/recording/read', '/v1/privacy/recording/set', '/v1/observations/recording-batch'];
function response() {
  const headers: Record<string, string> = {};
  let body = '',
    status = 0;
  const r = {
    setHeader: (key: string, value: string) => {
      headers[key.toLowerCase()] = value;
      return r;
    },
    once: vi.fn(),
    status: (value: number) => {
      status = value;
      return r;
    },
    end: (value: string) => {
      body = value;
      return r;
    },
  };
  return { r: r as unknown as Response, headers, value: () => ({ status, body: JSON.parse(body) as unknown }) };
}
function context<T>(f: (r: ReturnType<typeof response>) => T, path = paths[0]!, method = 'POST'): T {
  const r = response();
  let result!: T;
  requestContextMiddleware(() => undefined)({ method, path } as Request, r.r, () => {
    result = f(r);
  });
  return result;
}

describe('closed recording errors/cache before body and authority (authored HTTP fixtures)', () => {
  it('selects exactly three mounted POSTs and grants no scope exemption', () => {
    for (const path of paths) {
      for (const variant of [path, path.toUpperCase() + '/'])
        context((r) => {
          expect(currentRequest()?.problemFamily).toBe('recording');
          expect(r.headers['cache-control']).toBe('private, no-store');
          expect(requiresScope(variant)).toBe(true);
        }, variant);
      context(() => expect(currentRequest()?.problemFamily).toBeUndefined(), path, 'GET');
      context(() => expect(currentRequest()?.problemFamily).toBeUndefined(), path + '/private');
    }
    context(() => expect(currentRequest()?.problemFamily).toBe('privacy-clear'), '/v1/privacy/clear-exploration');
    context(() => expect(currentRequest()?.problemFamily).toBeUndefined(), '/v1/observations/batch');
  });

  it('projects every declared error to a fixed closed RFC9457 response without extensions', () =>
    context((r) => {
      for (const code of Object.keys(apiContract.recording.read['~orpc'].errorMap)) {
        const untrusted = {
          ...problemDetails(code as ProblemCode),
          detail: canary,
          instance: canary,
          currentPlaceRevision: 9,
          currentEntry: canary,
        };
        sendProblem(r.r, untrusted);
        expect(RecordingProblemSchema.parse(r.value().body)).toEqual(problemDetails(code as ProblemCode));
        expect(r.value().status).toBe(problemDetails(code as ProblemCode).status);
        expect(r.headers['content-type']).toBe('application/problem+json');
        expect(r.headers['cache-control']).toBe('private, no-store');
        expect(JSON.stringify(r.value().body)).not.toContain(canary);
      }
    }));

  it('masks numeric/unknown/object paths, values and messages and bounds every issue', () =>
    context(() => {
      const issues = Array.from({ length: 40 }, () => ({
        path: ['events', 3, { key: canary }, canary, 'recordingGeneration', 'target', 'version', 'readId', canary],
        code: canary,
        message: canary,
        received: canary,
      }));
      const p = RecordingProblemSchema.parse(
        problemFromOrpcError(new ORPCError('BAD_REQUEST', { data: { issues } }), () => undefined),
      );
      expect(p.issues).toHaveLength(32);
      expect(p.issues?.[0]).toEqual({
        path: ['events', 'unknown', 'unknown', 'unknown', 'recordingGeneration', 'target', 'version', 'readId'],
        code: 'custom',
      });
      expect(JSON.stringify(p)).not.toContain(canary);
    }, paths[2]));

  it('cannot import a privileged stale-place marker or a different problem family', () =>
    context((r) => {
      const stale = keepProblem({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 7 });
      expect(problemFromOrpcError(stale, () => undefined)).toEqual(problemDetails('INTERNAL'));
      expect(currentRequest()?.problemCode).toBe('INTERNAL');
      sendProblem(r.r, { ...problemDetails('SHARING_REVISION_STALE'), currentEntry: canary } as never);
      expect(r.value().body).toEqual(problemDetails('INTERNAL'));
      expect(currentRequest()?.problemCode).toBe('INTERNAL');
    }));

  it('keeps preparse and unauthenticated replies closed/private on every recording route', async () => {
    for (const path of paths) {
      await context(async (r) => {
        for (const [type, code] of [
          ['entity.parse.failed', 'INVALID_REQUEST'],
          ['entity.too.large', 'PAYLOAD_TOO_LARGE'],
          ['charset.unsupported', 'UNSUPPORTED_MEDIA_TYPE'],
        ] as const) {
          bodyErrorMiddleware(() => undefined)({ type, message: canary }, {} as Request, r.r, vi.fn());
          expect(RecordingProblemSchema.parse(r.value().body).code).toBe(code);
          expect(JSON.stringify(r.value().body)).not.toContain(canary);
        }
        requireJsonBodies()(
          { method: 'POST', headers: { 'content-length': '12' }, is: () => false } as unknown as Request,
          r.r,
          vi.fn(),
        );
        expect(RecordingProblemSchema.parse(r.value().body).code).toBe('UNSUPPORTED_MEDIA_TYPE');
        const next = vi.fn();
        await scopeGuard({
          callers: { resolve: () => Promise.resolve(undefined), sessionValid: () => Promise.resolve(false) },
          logEvent: () => undefined,
        })({ path, headers: {} } as Request, r.r, next);
        expect(RecordingProblemSchema.parse(r.value().body).code).toBe('UNAUTHENTICATED');
        expect(next).not.toHaveBeenCalled();
        expect(r.headers['cache-control']).toBe('private, no-store');
      }, path);
    }
  });
});
