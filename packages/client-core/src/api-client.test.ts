import { describe, expect, it } from 'vitest';
import { problemDetails, type HealthResponse } from '@knowscroll/contracts';
import { apiKeepPlaceProblem, apiProblem, createApiClient, resolveApiOrigin } from './api-client';
import { createAccountScope, memoryStore } from './account-scope';

const health: HealthResponse = {
  status: 'ok',
  world: 'dev',
  commit: '0123456789abcdef0123456789abcdef01234567',
  artifact: 'a'.repeat(64),
  migration: 'none',
  relay: 'listening',
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
    expect(
      resolveApiOrigin({
        platform: 'native',
        allowDevelopmentHttp: false,
        configuredOrigin: 'https://app.stage.knowscroll.space/x',
      }),
    ).toEqual({
      ok: true,
      baseUrl: 'https://app.stage.knowscroll.space',
    });
  });

  it('refuses a native build without a configured origin', () => {
    expect(resolveApiOrigin({ platform: 'native', allowDevelopmentHttp: false, configuredOrigin: undefined })).toEqual({
      ok: false,
      reason: 'missing_origin',
    });
    expect(resolveApiOrigin({ platform: 'native', allowDevelopmentHttp: false, configuredOrigin: '  ' })).toEqual({
      ok: false,
      reason: 'missing_origin',
    });
  });

  it('refuses plain HTTP on native except to development hosts from development builds', () => {
    expect(
      resolveApiOrigin({
        platform: 'native',
        allowDevelopmentHttp: false,
        configuredOrigin: 'http://app.dev.knowscroll.space',
      }),
    ).toEqual({
      ok: false,
      reason: 'insecure_origin',
    });
    expect(
      resolveApiOrigin({ platform: 'native', allowDevelopmentHttp: true, configuredOrigin: 'http://10.0.2.2:3000' }),
    ).toEqual({
      ok: true,
      baseUrl: 'http://10.0.2.2:3000',
    });
    // A production build refuses plain HTTP even to a development host.
    expect(
      resolveApiOrigin({ platform: 'native', allowDevelopmentHttp: false, configuredOrigin: 'http://10.0.2.2:3000' }),
    ).toEqual({
      ok: false,
      reason: 'insecure_origin',
    });
  });

  it('refuses something that is not an http(s) origin', () => {
    expect(
      resolveApiOrigin({ platform: 'native', allowDevelopmentHttp: false, configuredOrigin: 'knowscroll://home' }),
    ).toEqual({
      ok: false,
      reason: 'invalid_origin',
    });
    expect(
      resolveApiOrigin({ platform: 'native', allowDevelopmentHttp: false, configuredOrigin: 'not a url' }),
    ).toEqual({
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

it('sends the four Universe reads through the actual typed scoped client as read-only POSTs', async () => {
  const uuid = '0199a000-0000-7000-8000-000000000001';
  const selection = { kind: 'universe' as const };
  const capabilities = {
    version: 'scene-client.v1' as const,
    descriptors: ['scene-descriptor.v1'],
    chunks: ['scene-chunk.v1'],
    manifests: ['scene-manifest.v1'],
    generators: ['silhouette.v1'],
    families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
    detail: 'low' as const,
    reducedMotion: true,
  };
  const reference = {
    universeId: uuid,
    privacyEpoch: 1,
    manifestSceneRevision: 7,
    chunkId: uuid,
    chunkSceneRevision: 6,
  };
  const calls: { path: string; method: string; scope: string | null; authorization: string | null; body: unknown }[] =
    [];
  const scope = createAccountScope({
    account: { accountId: uuid, universeId: uuid, privacyEpoch: 1, email: 'fixture@scene.test' },
    baseUrl: 'https://scene.fixture.test',
    store: memoryStore(),
    authorization: () => 'Bearer fixture-scope-only',
    fetch: async (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        scope: request.headers.get('x-ks-scope'),
        authorization: request.headers.get('authorization'),
        body: await request.json(),
      });
      // The API's existing private/no-store response policy, never an HTTP cache or new wire route.
      return Response.json({ fixture: true }, { headers: { 'cache-control': 'private, no-store' } });
    },
  });
  try {
    await scope.api.geography.read({ selection, limit: 100 });
    await scope.api.geography.deltas({ afterGeographyRevision: 3, limit: 10 });
    await scope.api.scenes.manifest({ selection, capabilities });
    await scope.api.scenes.chunk({ selection, capabilities, reference });
    expect(calls).toEqual(
      [
        { path: '/v1/universe/geography/read', body: { selection, limit: 100 } },
        { path: '/v1/universe/geography/deltas/read', body: { afterGeographyRevision: 3, limit: 10 } },
        { path: '/v1/universe/scenes/manifest/read', body: { selection, capabilities } },
        { path: '/v1/universe/scenes/chunks/read', body: { selection, capabilities, reference } },
      ].map((call) => ({ ...call, method: 'POST', scope: `${uuid}:1`, authorization: 'Bearer fixture-scope-only' })),
    );
    scope.end();
    await expect(scope.api.scenes.manifest({ selection, capabilities })).rejects.toMatchObject({ code: 'SCOPE_ENDED' });
    expect(calls).toHaveLength(4);
  } finally {
    scope.end();
  }
});

/** Authored transport fixture; no backend, device or provider operation. */
describe('strict Keep problems before the generic RFC9457 decoder', () => {
  const uuid = '0199a000-0000-7000-8000-000000000001';
  const command = {
    version: 'keep-place.v1' as const,
    commandId: uuid,
    entry: { assetId: uuid, assetRevision: 1, savedEntryId: uuid },
    expectedPlaceRevision: 0,
    position: { kind: 'reel' as const, positionMs: 12.75 },
  };
  it('retains only the strict authorized stale revision through the actual typed transport', async () => {
    const body = { ...problemDetails('KEEP_PLACE_REVISION_STALE'), currentPlaceRevision: 7 };
    const double = fakeFetch(
      () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    const api = createApiClient({ baseUrl: 'https://keep.fixture.test', fetch: double.fetch });
    const error: unknown = await api.keep.setPlace(command).catch((failure: unknown) => failure);
    expect(apiKeepPlaceProblem(error)).toEqual(body);
    expect(apiProblem(error)).not.toHaveProperty('currentPlaceRevision');
    expect(double.requests[0]?.url).toBe('https://keep.fixture.test/v1/experience/keep/place');
    expect(double.requests[0]?.method).toBe('POST');
  });
  it('refuses malformed, extra-field and status-mismatched Keep metadata without inferring a revision', async () => {
    for (const [extra, status] of [
      [{}, 409],
      [{ currentPlaceRevision: -1 }, 409],
      [{ currentPlaceRevision: 2, privateValue: 'fixture-canary' }, 409],
      [{ currentPlaceRevision: 2 }, 503],
    ] as const) {
      const double = fakeFetch(
        () =>
          new Response(JSON.stringify({ ...problemDetails('KEEP_PLACE_REVISION_STALE'), ...extra }), {
            status,
            headers: { 'content-type': 'application/problem+json' },
          }),
      );
      const api = createApiClient({ baseUrl: 'https://keep.fixture.test', fetch: double.fetch });
      const error: unknown = await api.keep.setPlace(command).catch((failure: unknown) => failure);
      expect(apiKeepPlaceProblem(error)).toBeUndefined();
    }
    expect(apiKeepPlaceProblem(new TypeError('fixture network'))).toBeUndefined();
  });
});
