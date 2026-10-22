import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { RegionEncounterProblemSchema, problemDetails } from '@knowscroll/contracts';
import { regionEncounterDetails, regionEncounterIssues } from './region-encounter-problems.js';
import { requestContextMiddleware, currentRequest } from './request-context.js';
const canary = 'PRIVATE-REGION-REQUEST-CANARY';
describe('closed private Region problem boundary', () => {
  it('marks only the exact POST routes before Origin/auth/body parsing', () => {
    for (const path of ['/v1/experience/region/preview', '/V1/EXPERIENCE/REGION/OPEN/']) {
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
        },
        once: vi.fn(),
      } as unknown as Response;
      requestContextMiddleware(() => undefined)({ method: 'POST', path } as Request, res, () => {
        expect(currentRequest()?.problemFamily).toBe('region-encounter');
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
    const projected = regionEncounterIssues(issues);
    expect(projected).toHaveLength(32);
    expect(projected[0]?.path).toHaveLength(8);
    expect(JSON.stringify(projected)).not.toContain(canary);
    const value = regionEncounterDetails({
      ...problemDetails('INVALID_REQUEST'),
      detail: canary,
      instance: canary,
      issues,
    } as never);
    expect(RegionEncounterProblemSchema.parse(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toContain(canary);
    expect(regionEncounterDetails({ ...problemDetails('SAVED_CURSOR_UNAVAILABLE'), detail: canary })).toEqual(
      problemDetails('INTERNAL'),
    );
  });
});
