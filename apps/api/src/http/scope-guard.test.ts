import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedCallers, Caller } from './callers.js';
import { admittedCaller, requiresScope, scopeGuard } from './scope-guard.js';

const caller: Caller = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 3,
  sessionId: '0199a000-0000-7000-8000-0000000000a1',
  credential: 'cookie',
};
const claim = `${caller.accountId}:3`;

function callers(resolve: () => Promise<Caller | undefined>): AuthenticatedCallers & { calls: number } {
  const fake = {
    calls: 0,
    resolve: () => {
      fake.calls += 1;
      return resolve();
    },
    sessionValid: () => Promise.resolve(true),
  };
  return fake;
}

async function run(
  guard: ReturnType<typeof scopeGuard>,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ request: Request; status?: number; body?: { code?: string }; next: boolean }> {
  const request = { path, headers } as unknown as Request;
  const sent: { status?: number; body?: string } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    setHeader() {
      return response;
    },
    end(body: string) {
      sent.body = body;
    },
  };
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  await guard(request, response as unknown as Response, next);
  return {
    request,
    next: nextCalled,
    ...(sent.status === undefined ? {} : { status: sent.status }),
    ...(sent.body === undefined ? {} : { body: JSON.parse(sent.body) as { code?: string } }),
  };
}

describe('the scope guard (re-review N3)', () => {
  it('covers every /v1 path, whatever its case, and only the reviewed opt-outs', () => {
    for (const path of ['/v1/saved', '/v1/actions', '/V1/Saved', '/v1/saved/', '/v1/anything/new', '/v1'])
      expect(requiresScope(path), path).toBe(true);
    for (const path of ['/auth/session', '/auth/redeem', '/health', '/socket.io/', '/v10/x', '/s/abc'])
      expect(requiresScope(path), path).toBe(false);
    expect(requiresScope('/v1/share/abc', ['/v1/share/{id}'])).toBe(false);
    expect(requiresScope('/v1/share/abc/more', ['/v1/share/{id}'])).toBe(true);
  });

  it('refuses without a caller (401) and with a missing or other claim (409), before any handler', async () => {
    const none = scopeGuard({ callers: callers(() => Promise.resolve(undefined)), logEvent: () => undefined });
    expect(await run(none, '/v1/saved', { 'x-ks-scope': claim })).toMatchObject({
      status: 401,
      body: { code: 'UNAUTHENTICATED' },
      next: false,
    });
    const guard = scopeGuard({ callers: callers(() => Promise.resolve(caller)), logEvent: () => undefined });
    const claims: Record<string, string>[] = [
      {},
      { 'x-ks-scope': `${caller.accountId}:2` },
      { 'x-ks-scope': `x${claim}` },
    ];
    for (const headers of claims)
      expect(await run(guard, '/v1/actions', headers)).toMatchObject({
        status: 409,
        body: { code: 'SCOPE_MISMATCH' },
        next: false,
      });
  });

  it('admits a matching claim and hands the caller to the handler; other routes pass untouched', async () => {
    const fake = callers(() => Promise.resolve(caller));
    const guard = scopeGuard({ callers: fake, logEvent: () => undefined });
    const admittedRun = await run(guard, '/v1/saved', { 'x-ks-scope': claim });
    expect(admittedRun.next).toBe(true);
    expect(admittedCaller(admittedRun.request)).toBe(caller);
    const before = fake.calls;
    const health = await run(guard, '/health');
    expect(health.next).toBe(true);
    expect(fake.calls).toBe(before);
    expect(() => admittedCaller(health.request)).toThrow('without the scope guard');
  });

  it('answers a retryable database failure as 503, like a handler would', async () => {
    const busy = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const guard = scopeGuard({ callers: callers(() => Promise.reject(busy)), logEvent: () => undefined });
    expect(await run(guard, '/v1/saved', { 'x-ks-scope': claim })).toMatchObject({
      status: 503,
      body: { code: 'SERVICE_UNAVAILABLE' },
      next: false,
    });
  });
});
