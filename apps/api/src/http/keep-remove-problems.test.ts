import { ORPCError } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { apiContract, KeepRemovalProblemSchema, problemDetails, type ProblemCode } from '@knowscroll/contracts';
import { requestContextMiddleware, currentRequest } from './request-context.js';
import { bodyErrorMiddleware, keepProblem, problemFromOrpcError, requireJsonBodies, sendProblem } from './problems.js';
const canary = 'PRIVATE-REMOVE-RECEIVED-KEY-CANARY';
function response() {
  const headers: Record<string, string> = {};
  let body = '',
    status = 0;
  const r = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return r;
    },
    once: vi.fn(),
    status: (v: number) => {
      status = v;
      return r;
    },
    end: (s: string) => {
      body = s;
      return r;
    },
  };
  return { r: r as unknown as Response, headers, value: () => ({ status, body: JSON.parse(body) as unknown }) };
}
function context<T>(f: (r: ReturnType<typeof response>) => T, method = 'POST', path = '/v1/experience/keep/remove') {
  const r = response();
  let result!: T;
  requestContextMiddleware(() => undefined)({ method, path } as Request, r.r, () => {
    result = f(r);
  });
  return result;
}
describe('separate closed removal problem family before parsing/auth (synthetic HTTP objects)', () => {
  it('marks only the exact removal POST, case-insensitive/trailing slash, and sets private no-store first', () => {
    for (const path of ['/v1/experience/keep/remove', '/V1/EXPERIENCE/KEEP/REMOVE/'])
      context(
        (r) => {
          expect(currentRequest()?.problemFamily).toBe('keep-remove');
          expect(r.headers['cache-control']).toBe('private, no-store');
        },
        'POST',
        path,
      );
    context(() => expect(currentRequest()?.problemFamily).toBeUndefined(), 'GET');
    context(
      () => expect(currentRequest()?.problemFamily).toBeUndefined(),
      'POST',
      '/v1/experience/keep/remove/private',
    );
    context(() => expect(currentRequest()?.problemFamily).toBe('keep-place'), 'POST', '/v1/experience/keep/read');
  });
  it('emits all14 direct fixed RFC9457 shapes, discarding detail/instance/replacement/CAS', () =>
    context((r) => {
      const errors = apiContract.keep.remove['~orpc'].errorMap;
      expect(Object.keys(errors)).toHaveLength(14);
      for (const code of Object.keys(errors)) {
        const d = {
          ...problemDetails(code as ProblemCode),
          detail: canary,
          instance: canary,
          currentPlaceRevision: 12,
          currentEntry: canary,
        };
        sendProblem(r.r, d);
        const { status, body } = r.value();
        expect(KeepRemovalProblemSchema.parse(body)).toEqual(problemDetails(code as ProblemCode));
        expect(status).toBe(problemDetails(code as ProblemCode).status);
        expect(r.headers['content-type']).toBe('application/problem+json');
        expect(r.headers['cache-control']).toBe('private, no-store');
        expect(JSON.stringify(body)).not.toContain(canary);
      }
    }));
  it('masks every unrecognized/numeric/object key and bounds issue count/path without received values', () =>
    context(() => {
      const issues = Array.from({ length: 40 }, () => ({
        path: ['entry', 'savedEntryId', 2, { key: canary }, canary, 'position', 'assetId', 'version', canary],
        code: canary,
        received: canary,
        message: canary,
      }));
      const p = KeepRemovalProblemSchema.parse(
        problemFromOrpcError(new ORPCError('BAD_REQUEST', { data: { issues, detail: canary } }), () => undefined),
      );
      expect(p.issues).toHaveLength(32);
      expect(p.issues?.[0]).toEqual({
        path: ['entry', 'savedEntryId', 'unknown', 'unknown', 'unknown', 'unknown', 'assetId', 'version'],
        code: 'custom',
      });
      expect(JSON.stringify(p)).not.toContain(canary);
    }));
  it('cannot import an authorized place-stale marker or arbitrary catalogue extensions into removal', () =>
    context((r) => {
      const oldPlace = keepProblem({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 7 });
      const d = problemFromOrpcError(oldPlace, () => undefined);
      expect(d).toEqual(problemDetails('INTERNAL'));
      expect(currentRequest()?.problemCode).toBe('INTERNAL');
      sendProblem(r.r, { ...problemDetails('KEEP_PLACE_REVISION_STALE'), currentPlaceRevision: 7 } as never);
      expect(r.value().body).toEqual(problemDetails('INTERNAL'));
      expect(currentRequest()?.problemCode).toBe('INTERNAL');
    }));
  it('keeps preparse malformed/oversized/unsupported bodies closed and private', () =>
    context((r) => {
      for (const [type, code] of [
        ['entity.parse.failed', 'INVALID_REQUEST'],
        ['entity.too.large', 'PAYLOAD_TOO_LARGE'],
        ['charset.unsupported', 'UNSUPPORTED_MEDIA_TYPE'],
      ] as const) {
        bodyErrorMiddleware(() => undefined)({ type, message: canary }, {} as Request, r.r, vi.fn());
        expect(KeepRemovalProblemSchema.parse(r.value().body).code).toBe(code);
        expect(JSON.stringify(r.value().body)).not.toContain(canary);
        expect(r.headers['cache-control']).toBe('private, no-store');
      }
      requireJsonBodies()(
        { method: 'POST', headers: { 'content-length': '12' }, is: () => false } as unknown as Request,
        r.r,
        vi.fn(),
      );
      expect(KeepRemovalProblemSchema.parse(r.value().body).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }));
});
