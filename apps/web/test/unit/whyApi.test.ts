/**
 * #133 — "What led here" on the web: `GET /v1/decisions/:decisionId/why?assetId=` and
 * `POST /v1/encounters/feedback` (ADR-0032 §5), parsed as strictly as Android's `parseWhy`
 * (apps/mobile/.../data/Why.kt): the client adds nothing and refuses a payload the server could not
 * have recorded -- an unknown field, family, evidence kind or correction, or an explanation of some
 * other encounter. A 404 is the honest "no recorded explanation", not an error. The correction is a
 * mutating request, so it goes through the same CSRF-aware `request()` path as every other (ADR-0034).
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/api/client.ts';
import { encounterFeedbackReceiptOf, whyOf } from './fakeApi.ts';

type Call = { input: RequestInfo | URL; init?: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

const DECISION = whyOf().decisionId;
const ASSET = whyOf().assetId;

function clientAnswering(body: unknown, status = 200) {
  const fake = fakeFetch(() => jsonResponse(status, body));
  return { ...fake, client: new ApiClient({ fetchImpl: fake.fetchImpl, delaysMs: [0, 0] }) };
}

describe('ApiClient.getWhy (#133)', () => {
  it('reads the recorded explanation of exactly this encounter, as a GET that never carries a CSRF token', async () => {
    const { client, calls } = clientAnswering(whyOf());
    client.setCsrfToken('known-token');
    const why = await client.getWhy(DECISION, ASSET);
    expect(why).toEqual(whyOf());
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(`/v1/decisions/${DECISION}/why?assetId=${ASSET}`);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBeNull();
  });

  it('a 404 is the honest "no recorded explanation", not an error', async () => {
    const { client } = clientAnswering({ error: 'No recorded explanation for this encounter' }, 404);
    await expect(client.getWhy(DECISION, ASSET)).resolves.toBeNull();
  });

  it('any other refusal stays an error (a 401 is never mistaken for "nothing recorded")', async () => {
    const { client } = clientAnswering({ error: 'Unauthorized' }, 401);
    await expect(client.getWhy(DECISION, ASSET)).rejects.toMatchObject({ error: { kind: 'server', statusCode: 401 } });
  });

  it.each<[string, unknown]>([
    ['an unknown top-level field', { ...whyOf(), interests: ['space'] }],
    ['a missing field', (({ corrected: _omit, ...rest }) => rest)(whyOf())],
    ['an unknown family', { ...whyOf(), family: 'engagement' }],
    ['an unknown evidence kind', { ...whyOf(), evidence: [{ kind: 'profile', trait: 'curious' }] }],
    ['an unknown field inside an evidence step', { ...whyOf(), evidence: [{ ...whyOf().evidence[0]!, score: 0.9 }] }],
    ['an unknown act in the path', { ...whyOf(), evidence: [{ ...whyOf().evidence[0]!, markKind: 'watch' }] }],
    ['an unknown correction', { ...whyOf(), corrections: ['less_like_this', 'block_source'] }],
    ['an explanation of another decision', { ...whyOf(), decisionId: '99999999-0000-4000-8000-000000000000' }],
    ['an explanation of another Scroll', { ...whyOf(), assetId: '99999999-0000-4000-8000-000000000000' }],
    ['a correction offered on an unmapped (fallback) encounter', { ...whyOf(), family: 'fallback', evidence: [], corrections: ['less_like_this'], corrected: [] }],
    ['"wrong connection" offered where no connection was crossed', { ...whyOf(), evidence: [whyOf().evidence[0]!], corrections: ['less_like_this', 'wrong_connection'] }],
    ['a correction recorded that the encounter does not support', { ...whyOf({ family: 'continue', evidence: [whyOf().evidence[0]!], corrections: ['less_like_this'] }), corrected: ['wrong_connection'] }],
  ])('refuses %s', async (_label, body) => {
    const { client } = clientAnswering(body);
    await expect(client.getWhy(DECISION, ASSET)).rejects.toMatchObject({ error: { kind: 'protocol' } });
  });

  it('accepts every recorded step kind the Composer can cite, and an honest empty fallback path', async () => {
    const steps = whyOf({
      family: 'continue',
      evidence: [
        { kind: 'question', concept: 'physics.gravity' },
        { kind: 'outside', domain: 'life' },
      ],
      corrections: ['less_like_this'],
      corrected: ['less_like_this'],
    });
    await expect(clientAnswering(steps).client.getWhy(DECISION, ASSET)).resolves.toEqual(steps);
    const fallback = whyOf({ family: 'fallback', evidence: [], corrections: [], corrected: [] });
    await expect(clientAnswering(fallback).client.getWhy(DECISION, ASSET)).resolves.toEqual(fallback);
  });
});

describe('ApiClient.postEncounterFeedback (#133, ADR-0034)', () => {
  const body = {
    clientFeedbackId: '30000000-0000-4000-8000-000000000001',
    decisionId: DECISION,
    assetId: ASSET,
    kind: 'less_like_this' as const,
    expectedPrivacyEpoch: 2,
  };

  it('POSTs exactly the correction, carrying the page CSRF token, and accepts only the 201 receipt', async () => {
    const { client, calls } = clientAnswering(encounterFeedbackReceiptOf(), 201);
    client.setCsrfToken('known-token');
    await expect(client.postEncounterFeedback(body)).resolves.toEqual(encounterFeedbackReceiptOf());
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe('/v1/encounters/feedback');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(headerValue(calls[0]!, 'X-CSRF-Token')).toBe('known-token');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(body);
  });

  it('a 403 with no token yet fetches the page token once and resends the same clientFeedbackId', async () => {
    const bodies: unknown[] = [];
    const { calls, fetchImpl } = fakeFetch((call, index) => {
      if (call.init?.body) bodies.push(JSON.parse(String(call.init.body)));
      if (index === 0) return jsonResponse(403, { error: 'This change needs the page’s own request token' });
      if (index === 1) {
        expect(String(call.input)).toBe('/v1/session/csrf');
        return jsonResponse(200, { csrfToken: 'e'.repeat(64) });
      }
      return jsonResponse(201, encounterFeedbackReceiptOf());
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0] });
    await client.postEncounterFeedback(body);
    expect(calls).toHaveLength(3);
    expect(headerValue(calls[2]!, 'X-CSRF-Token')).toBe('e'.repeat(64));
    expect(bodies).toEqual([body, body]);
  });

  it('a lost response is retried with the same body: one intent, one clientFeedbackId', async () => {
    const bodies: unknown[] = [];
    const { fetchImpl } = fakeFetch((call, index) => {
      bodies.push(JSON.parse(String(call.init?.body)));
      if (index === 0) throw new TypeError('connection reset');
      return jsonResponse(201, encounterFeedbackReceiptOf());
    });
    const client = new ApiClient({ fetchImpl, delaysMs: [0, 0], maxAttempts: 2 });
    await client.postEncounterFeedback(body);
    expect(bodies).toEqual([body, body]);
  });

  it.each<[string, unknown]>([
    ['an unknown field', { ...encounterFeedbackReceiptOf(), profile: {} }],
    ['an unknown field in the suppression', { ...encounterFeedbackReceiptOf(), suppressed: { ...encounterFeedbackReceiptOf().suppressed, score: 1 } }],
    ['a receipt for another correction', encounterFeedbackReceiptOf({ kind: 'wrong_connection' })],
  ])('refuses a receipt with %s', async (_label, receipt) => {
    const { client } = clientAnswering(receipt, 201);
    await expect(client.postEncounterFeedback(body)).rejects.toMatchObject({ error: { kind: 'protocol' } });
  });

  it('a stale epoch (409) and an uncorrectable encounter (422) come back as the server said them', async () => {
    await expect(clientAnswering({ error: 'Feedback privacy epoch is stale' }, 409).client.postEncounterFeedback(body)).rejects.toMatchObject({
      error: { kind: 'server', statusCode: 409 },
    });
    await expect(clientAnswering({ error: 'An unmapped encounter has no route to correct' }, 422).client.postEncounterFeedback(body)).rejects.toMatchObject({
      error: { kind: 'server', statusCode: 422 },
    });
  });
});
