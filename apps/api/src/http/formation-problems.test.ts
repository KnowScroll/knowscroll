import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { FormationPresentationProblemSchema, problemDetails } from '@knowscroll/contracts';
import { formationDetails, formationIssues } from './formation-problems.js';
import { requestContextMiddleware, currentRequest } from './request-context.js';
const canary = 'PRIVATE-FORMATION-REQUEST-CANARY';
describe('closed private Formation problem boundary', () => {
  it('marks only the exact POST routes before Origin/auth/body parsing', () => {
    for (const path of [
      '/v1/universe/formation/read',
      '/V1/UNIVERSE/FORMATION/CLAIM/',
      '/v1/universe/formation/acknowledge',
    ]) {
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
        },
        once: vi.fn(),
      } as unknown as Response;
      requestContextMiddleware(() => undefined)({ method: 'POST', path } as Request, res, () => {
        expect(currentRequest()?.problemFamily).toBe('formation');
        expect(headers['cache-control']).toBe('private, no-store');
      });
    }
  });
  it('bounds issues and removes values/free text/unknown keys/private extensions', () => {
    const issues = Array.from({ length: 40 }, () => ({
      path: ['target', 'regionId', canary, 1, { key: canary }, 'capabilities', 'blocks', canary, canary],
      code: canary,
      message: canary,
      received: canary,
    }));
    const projected = formationIssues(issues);
    expect(projected).toHaveLength(32);
    expect(projected[0]?.path).toHaveLength(8);
    expect(JSON.stringify(projected)).not.toContain(canary);
    const value = formationDetails({
      ...problemDetails('INVALID_REQUEST'),
      detail: canary,
      instance: canary,
      issues,
    } as never);
    expect(FormationPresentationProblemSchema.parse(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toContain(canary);
    expect(formationDetails({ ...problemDetails('SAVED_CURSOR_UNAVAILABLE'), detail: canary })).toEqual(
      problemDetails('INTERNAL'),
    );
  });
});
