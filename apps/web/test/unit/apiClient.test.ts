/**
 * ADR-0034 — the client's own half of the desktop session cookie: it never holds a bearer token,
 * but a cookie session's mutating requests must carry `X-CSRF-Token`. This client keeps the token
 * in memory only (never localStorage/sessionStorage, never read back from anywhere but a real
 * `GET /v1/session/csrf` response), sends it on every non-GET request once known, and otherwise
 * discovers it lazily: a non-GET that comes back 403 triggers exactly one `GET /v1/session/csrf` and
 * at most one retry of the original request -- when no token was known yet, or the known one was
 * stale; never when the page's current token itself was refused.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/api/client.ts';

type Call = { input: RequestInfo | URL; init?: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
/** `null` (never `''`): the Fetch spec forbids any body -- even an empty string -- on a null-body
 * status (204/205/304), and `new Response('', {status:204})` throws exactly that. */
function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function fakeFetch(handler: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return handler({ input, init }, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init?.headers as Record<string, string> | undefined;
  if (!headers) return null;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key]! : null;
}

describe('ApiClient CSRF (ADR-0034)', () => {
  it('never sends X-CSRF-Token on a GET request', async () => {
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { universeId: 'u1', revision: 1, privacyEpoch: 0, recordingPausedAt: null, traces: [], capabilities: { reasoning: false, reels: false, worldEvolution: false } }));
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await client.getUniverse();
    expect(calls).toHaveLength(1);
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBeNull();
  });

  it('sends no X-CSRF-Token on a POST while no token is known yet, and none is fetched unless a 403 happens', async () => {
    const { calls, fetchImpl } = fakeFetch(() => emptyResponse(204));
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await client.postSessionRevoke();
    expect(calls).toHaveLength(1);
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBeNull();
  });

  it('on a 403 with no known token: fetches GET /v1/session/csrf once, then retries the original request once, carrying the fetched token', async () => {
    const { calls, fetchImpl } = fakeFetch((call, index) => {
      if (index === 0) return jsonResponse(403, { error: "This change needs the page's own request token" });
      if (index === 1) {
        expect(String(call.input)).toBe('/v1/session/csrf');
        return jsonResponse(200, { csrfToken: 'a'.repeat(64) });
      }
      return emptyResponse(204);
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await client.postSessionRevoke();
    expect(calls).toHaveLength(3);
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBeNull();
    expect(headerValue(calls[2]!, 'X-CSRF-Token')).toBe('a'.repeat(64));
  });

  it('once a token is known, every later non-GET request carries it immediately, with no preflight fetch', async () => {
    const { calls, fetchImpl } = fakeFetch(() => emptyResponse(204));
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    client.setCsrfToken('known-token');
    await client.postSessionRevoke();
    expect(calls).toHaveLength(1);
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBe('known-token');
  });

  it('a 400 from GET /v1/session/csrf (a bearer/dev-proxy session) still retries the original request once, without a token', async () => {
    const { calls, fetchImpl } = fakeFetch((_call, index) => {
      if (index === 0) return jsonResponse(403, { error: 'no token' });
      if (index === 1) return jsonResponse(400, { error: 'Only a cookie session has a CSRF token' });
      return emptyResponse(204);
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await client.postSessionRevoke();
    expect(calls).toHaveLength(3);
    expect(headerValue(calls[2]!, 'X-CSRF-Token')).toBeNull();
  });

  it('retries the original request only once for a 403 (a second 403 is a real, terminal failure)', async () => {
    const { calls, fetchImpl } = fakeFetch((_call, index) => {
      if (index === 1) return jsonResponse(200, { csrfToken: 'b'.repeat(64) });
      return jsonResponse(403, { error: 'still refused' });
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await expect(client.postSessionRevoke()).rejects.toMatchObject({ error: { kind: 'server', statusCode: 403 } });
    // attempt 1 (403), csrf fetch, attempt 2 (403 again) -- never a third original attempt.
    expect(calls).toHaveLength(3);
  });

  it('a 403 with a stale known token (e.g. from a session that since ended) fetches the current token once and retries once with it', async () => {
    const { calls, fetchImpl } = fakeFetch((call, index) => {
      if (index === 0) return jsonResponse(403, { error: 'stale token' });
      if (index === 1) {
        expect(String(call.input)).toBe('/v1/session/csrf');
        return jsonResponse(200, { csrfToken: 'd'.repeat(64) });
      }
      return emptyResponse(204);
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    client.setCsrfToken('stale-token');
    await client.postSessionRevoke();
    expect(calls).toHaveLength(3);
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBe('stale-token');
    expect(headerValue(calls[2]!, 'X-CSRF-Token')).toBe('d'.repeat(64));
  });

  it('two requests sent with a stale token: the one whose 403 arrives after the other refreshed it retries with the current token (verification N2)', async () => {
    let releaseB: () => void = () => {};
    const bHeld = new Promise<void>(resolve => { releaseB = resolve; });
    const { calls, fetchImpl } = fakeFetch((call, index) => {
      if (String(call.input) === '/v1/session/csrf') return jsonResponse(200, { csrfToken: 'n'.repeat(64) });
      const token = headerValue(call, 'X-CSRF-Token');
      if (token === 'stale-token') {
        // B's refusal (the second stale send) is held until A has refreshed and succeeded.
        if (index === 1) return bHeld.then(() => jsonResponse(403, { error: 'stale token' })) as unknown as Response;
        return jsonResponse(403, { error: 'stale token' });
      }
      return emptyResponse(204);
    });
    const client = new ApiClient({ fetchImpl: async (input, init) => fetchImpl(input, init), delaysMs: [0, 0] });
    client.setCsrfToken('stale-token');
    const a = client.postSessionRevoke();
    const b = client.postSessionRevoke();
    await a;
    releaseB();
    await b;
    const retried = calls.filter(c => headerValue(c, 'X-CSRF-Token') === 'n'.repeat(64));
    expect(retried).toHaveLength(2);
  });

  it('a 403 whose refreshed token is unchanged is a real refusal: no retry of the same doomed request', async () => {
    const { calls, fetchImpl } = fakeFetch((_call, index) => {
      if (index === 1) return jsonResponse(200, { csrfToken: 'known-token' });
      return jsonResponse(403, { error: 'cross-origin' });
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    client.setCsrfToken('known-token');
    await expect(client.postSessionRevoke()).rejects.toMatchObject({ error: { kind: 'server', statusCode: 403 } });
    expect(calls).toHaveLength(2); // the refused request and the one token check, nothing more
  });

  it('the same body (and requestId inside it) is sent on both the pre-CSRF and post-CSRF attempts', async () => {
    const bodies: unknown[] = [];
    const { fetchImpl } = fakeFetch((call, index) => {
      if (call.init?.body) bodies.push(JSON.parse(String(call.init.body)));
      if (index === 0) return jsonResponse(403, { error: 'no token' });
      if (index === 1) return jsonResponse(200, { csrfToken: 'c'.repeat(64) });
      return jsonResponse(200, {
        receiptId: 'r1', action: 'pause', privacyEpoch: 0, recordingPausedAt: null, appliedAt: '2026-01-01T00:00:00.000Z',
      });
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await client.postPrivacyPause({ requestId: 'req-1', expectedPrivacyEpoch: 0 });
    expect(bodies).toEqual([{ requestId: 'req-1', expectedPrivacyEpoch: 0 }, { requestId: 'req-1', expectedPrivacyEpoch: 0 }]);
  });

  it('existing transient-failure retry/backoff is unchanged: a 500 is retried by the normal attempt loop, unrelated to CSRF', async () => {
    const { calls, fetchImpl } = fakeFetch((_call, index) => (index === 0 ? emptyResponse(500) : emptyResponse(204)));
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0], maxAttempts: 2 });
    await client.postSessionRevoke();
    expect(calls).toHaveLength(2); // the ordinary transient retry, never the CSRF preflight path
  });

  it('isBearerSession is true only for a confirmed 400 from GET /v1/session/csrf', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(400, { error: 'Only a cookie session has a CSRF token' }));
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    expect(await client.isBearerSession()).toBe(true);
  });

  it('isBearerSession is false for a 200 (a real cookie session), a 401, or a network failure -- never a guess', async () => {
    const cookieSession = new ApiClient({ fetchImpl: fakeFetch(() => jsonResponse(200, { csrfToken: 'a'.repeat(64) })).fetchImpl, delaysMs: [0, 0] });
    expect(await cookieSession.isBearerSession()).toBe(false);

    const unauthorized = new ApiClient({ fetchImpl: fakeFetch(() => jsonResponse(401, { error: 'unauthorized' })).fetchImpl, delaysMs: [0, 0] });
    expect(await unauthorized.isBearerSession()).toBe(false);

    const broken = new ApiClient({ fetchImpl: async () => { throw new TypeError('network down'); }, delaysMs: [0, 0] });
    expect(await broken.isBearerSession()).toBe(false);
  });
});

describe('ApiClient: whether a failed call may still have been applied (#135 review)', () => {
  it('a 401 after a network failure inside the same call carries earlierAttemptMayHaveLanded', async () => {
    const { fetchImpl } = fakeFetch((_call, index) => {
      if (index === 0) throw new TypeError('connection reset');
      return jsonResponse(401, { error: 'Unauthorized' });
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0], maxAttempts: 2 });
    await expect(client.postAccountDelete({ requestId: 'req-1', expectedPrivacyEpoch: 0, confirmation: 'delete-my-account-and-history' }))
      .rejects.toMatchObject({ error: { kind: 'server', statusCode: 401 }, earlierAttemptMayHaveLanded: true });
  });

  it('a 401 after a 5xx inside the same call carries it too; after a 429 (refused outright) it does not', async () => {
    const after = (status: number) => new ApiClient({
      fetchImpl: fakeFetch((_call, index) => (index === 0 ? emptyResponse(status) : jsonResponse(401, { error: 'Unauthorized' }))).fetchImpl,
      delaysMs: [0, 0], maxAttempts: 2,
    });
    const body = { requestId: 'req-1', expectedPrivacyEpoch: 0, confirmation: 'delete-my-account-and-history' } as const;
    await expect(after(502).postAccountDelete(body)).rejects.toMatchObject({ earlierAttemptMayHaveLanded: true });
    await expect(after(429).postAccountDelete(body)).rejects.toMatchObject({ earlierAttemptMayHaveLanded: false });
  });

  it('a 401 on the very first attempt carries no such flag', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(401, { error: 'Unauthorized' }));
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0], maxAttempts: 2 });
    await expect(client.postAccountDelete({ requestId: 'req-1', expectedPrivacyEpoch: 0, confirmation: 'delete-my-account-and-history' }))
      .rejects.toMatchObject({ error: { kind: 'server', statusCode: 401 }, earlierAttemptMayHaveLanded: false });
  });
});
