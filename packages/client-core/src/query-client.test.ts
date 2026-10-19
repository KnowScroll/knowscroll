import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type HealthResponse } from '@knowscroll/contracts';
import { createApiClient } from './api-client';
import { healthQueryKey, healthQueryOptions } from './health';
import { createQueryClient, queryRetryDelay, shouldRetryQuery } from './query-client';

describe('query retries', () => {
  it('retries network failures and server errors, at most twice', () => {
    expect(shouldRetryQuery(0, new TypeError('Network request failed'))).toBe(true);
    expect(shouldRetryQuery(1, new ORPCError('SERVICE_UNAVAILABLE', { status: 503 }))).toBe(true);
    expect(shouldRetryQuery(2, new TypeError('Network request failed'))).toBe(false);
  });

  it('never retries an answer the server gave on purpose (4xx)', () => {
    for (const status of [400, 401, 403, 404, 413]) {
      expect(shouldRetryQuery(0, new ORPCError('X', { status }))).toBe(false);
    }
  });

  it('backs off exponentially up to 8 s', () => {
    expect([0, 1, 2, 3, 4, 9].map(queryRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('never retries commands', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });
});

describe('health query', () => {
  const health: HealthResponse = {
    status: 'ok',
    world: 'dev',
    commit: '0123456789abcdef0123456789abcdef01234567',
    artifact: 'b'.repeat(64),
    migration: '0001_identity',
  };

  it('fetches /health through the typed client under a stable key', async () => {
    const api = createApiClient({
      baseUrl: 'https://app.dev.knowscroll.space',
      fetch: () => Promise.resolve(Response.json(health)),
    });
    const queryClient = createQueryClient();

    await expect(queryClient.fetchQuery(healthQueryOptions(api))).resolves.toEqual(health);
    expect(queryClient.getQueryData(healthQueryKey)).toEqual(health);
  });

  it('rejects an answer that does not match the contract', async () => {
    const api = createApiClient({
      baseUrl: 'https://app.dev.knowscroll.space',
      fetch: () => Promise.resolve(Response.json({ status: 'starting' })),
    });

    await expect(createQueryClient().fetchQuery(healthQueryOptions(api))).rejects.toThrow();
  });

  it('surfaces the problem document when the API is unavailable', async () => {
    const problem = problemDetails('SERVICE_UNAVAILABLE');
    const api = createApiClient({
      baseUrl: 'https://app.dev.knowscroll.space',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(problem), {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          }),
        ),
    });

    await expect(createQueryClient().fetchQuery({ ...healthQueryOptions(api), retry: false })).rejects.toMatchObject({
      status: 503,
      data: problem,
    });
  });
});
