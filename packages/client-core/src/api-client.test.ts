import { describe, expect, it } from 'vitest';
import { problemDetails, type HealthResponse } from '@knowscroll/contracts';
import { apiProblem, createApiClient, resolveApiOrigin } from './api-client';

const health: HealthResponse = {
  status: 'ok',
  world: 'dev',
  commit: '0123456789abcdef0123456789abcdef01234567',
  artifact: 'a'.repeat(64),
  migration: 'none',
};

/** A labelled test double for the platform fetch: records requests and answers with `respond`. */
function fakeFetch(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const fetch = (request: Request) => {
    requests.push(request);
    return Promise.resolve(respond(request));
  };
  return { fetch, requests };
}

describe('resolveApiOrigin', () => {
  it('uses the page origin on the web (one origin per world)', () => {
    expect(resolveApiOrigin({ platform: 'web', pageOrigin: 'https://app.dev.knowscroll.space' })).toEqual({
      ok: true,
      baseUrl: 'https://app.dev.knowscroll.space',
    });
  });

  it('uses the configured origin on native and drops any path', () => {
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: 'https://app.stage.knowscroll.space/x' })).toEqual({
      ok: true,
      baseUrl: 'https://app.stage.knowscroll.space',
    });
  });

  it('refuses a native build without a configured origin', () => {
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: undefined })).toEqual({
      ok: false,
      reason: 'missing_origin',
    });
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: '  ' })).toEqual({
      ok: false,
      reason: 'missing_origin',
    });
  });

  it('refuses plain HTTP on native except for development hosts', () => {
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: 'http://app.dev.knowscroll.space' })).toEqual({
      ok: false,
      reason: 'insecure_origin',
    });
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: 'http://10.0.2.2:3000' })).toEqual({
      ok: true,
      baseUrl: 'http://10.0.2.2:3000',
    });
  });

  it('refuses something that is not an http(s) origin', () => {
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: 'knowscroll://home' })).toEqual({
      ok: false,
      reason: 'invalid_origin',
    });
    expect(resolveApiOrigin({ platform: 'native', configuredOrigin: 'not a url' })).toEqual({
      ok: false,
      reason: 'invalid_origin',
    });
  });
});

describe('createApiClient', () => {
  it('calls GET /health on the base URL and returns the typed body', async () => {
    const double = fakeFetch(() => Response.json(health));
    const api = createApiClient({ baseUrl: 'https://app.dev.knowscroll.space', fetch: double.fetch });

    await expect(api.health()).resolves.toEqual(health);
    expect(double.requests).toHaveLength(1);
    expect(double.requests[0]?.method).toBe('GET');
    expect(double.requests[0]?.url).toBe('https://app.dev.knowscroll.space/health');
  });

  it('turns an RFC 9457 problem into an error that carries the problem document', async () => {
    const problem = problemDetails('SERVICE_UNAVAILABLE');
    const double = fakeFetch(
      () =>
        new Response(JSON.stringify(problem), {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    const api = createApiClient({ baseUrl: 'https://app.dev.knowscroll.space', fetch: double.fetch });

    const error: unknown = await api.health().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(apiProblem(error)).toEqual(problem);
    expect(error).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('does not invent a problem for an error without one', async () => {
    const double = fakeFetch(
      () => new Response('upstream gone', { status: 502, headers: { 'content-type': 'text/plain' } }),
    );
    const api = createApiClient({ baseUrl: 'https://app.dev.knowscroll.space', fetch: double.fetch });

    const error: unknown = await api.health().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ status: 502 });
    expect(apiProblem(error)).toBeUndefined();
  });

  it('returns nothing from apiProblem for errors that are not API errors', () => {
    expect(apiProblem(new TypeError('Network request failed'))).toBeUndefined();
    expect(apiProblem(undefined)).toBeUndefined();
  });
});
