import { ORPCError } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { apiContract, SavedListProblemSchema, problemDetails, type ProblemCode } from '@knowscroll/contracts';
import { currentRequest, requestContextMiddleware } from './request-context.js';
import { keepProblem, problemFromOrpcError, sendProblem } from './problems.js';
const canary = 'PRIVATE-SAVED-CURSOR-RECEIVED-CANARY';
function context<T>(
  work: (response: Response, headers: Record<string, string>, value: () => unknown) => T,
  method = 'GET',
  path = '/v1/saved',
) {
  const headers: Record<string, string> = {};
  let body = '';
  const response = {
    once: vi.fn(),
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return response;
    },
    status: vi.fn(() => response),
    end: (v: string) => {
      body = v;
      return response;
    },
  };
  let result!: T;
  requestContextMiddleware(() => undefined)({ method, path } as Request, response as unknown as Response, () => {
    result = work(response as unknown as Response, headers, () => JSON.parse(body) as unknown);
  });
  return result;
}
describe('Saved GET closed private problems before parsing/auth', () => {
  it('selects only exact GET Saved routes and preserves the other Keep/Clear families', () => {
    for (const route of ['/v1/saved', '/V1/SAVED/'])
      context(
        (_, headers) => {
          expect(currentRequest()?.problemFamily).toBe('saved-list');
          expect(headers['cache-control']).toBe('private, no-store');
        },
        'GET',
        route,
      );
    for (const [method, route, expected] of [
      ['POST', '/v1/saved', undefined],
      ['GET', '/v1/saved/private', undefined],
      ['POST', '/v1/privacy/clear-exploration', 'privacy-clear'],
      ['POST', '/v1/experience/keep/remove', 'keep-remove'],
      ['POST', '/v1/experience/keep/read', 'keep-place'],
    ] as const)
      context(() => expect(currentRequest()?.problemFamily).toBe(expected), method, route);
  });
  it('emits every fixed list problem without token, extension, CAS or generic detail leakage', () =>
    context((response, headers, value) => {
      for (const code of Object.keys(apiContract.experience.listSaved['~orpc'].errorMap)) {
        sendProblem(response, { ...problemDetails(code as ProblemCode), detail: canary, instance: canary });
        expect(SavedListProblemSchema.parse(value())).toEqual(problemDetails(code as ProblemCode));
        expect(headers['cache-control']).toBe('private, no-store');
        expect(headers['content-type']).toBe('application/problem+json');
      }
      const cas = problemFromOrpcError(
        keepProblem({ code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 7 }),
        () => undefined,
      );
      expect(cas).toEqual(problemDetails('INTERNAL'));
    }));
  it('bounds and masks union/query issue paths and never repeats rejected token/key/message values', () =>
    context(() => {
      const issues = Array.from({ length: 40 }, () => ({
        path: ['cursor', { key: canary }, 3, canary, 'limit', 'filter', 'pagination', 'scope', 'more'],
        code: canary,
        received: canary,
        message: canary,
      }));
      const details = problemFromOrpcError(new ORPCError('BAD_REQUEST', { data: { issues } }), () => undefined);
      expect(SavedListProblemSchema.parse(details).issues).toHaveLength(32);
      expect(details.issues?.[0]).toEqual({
        path: ['cursor', 'unknown', 'unknown', 'unknown', 'limit', 'filter', 'pagination', 'unknown'],
        code: 'custom',
      });
      expect(JSON.stringify(details)).not.toContain(canary);
    }));
});
