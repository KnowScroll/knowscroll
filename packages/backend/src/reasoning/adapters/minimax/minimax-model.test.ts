import { describe, expect, it } from 'vitest';
import { ModelNotSentError, ModelOutcomeUnknownError, ModelRejectedError } from '../../application/ports.js';
import {
  MINIMAX_MESSAGES_URL,
  MINIMAX_QUOTA_URL,
  makeMiniMaxModelPort,
  type MiniMaxSettings,
} from './minimax-model.js';

/**
 * Conformance of the MiniMax transport against a fake `fetch` (CI fixture; no network). Every key
 * and response below is a fixture. The real route was exercised separately from the Mac (#231
 * evidence), not here.
 */
const fixtureKey = 'sk-cp-FIXTUREfixtureFIXTUREfixture0000';
const canaries = {
  key: fixtureKey,
  presigned: 'https://oss.example/a.mp4?Signature=canary-presigned-Qw3&Expires=1',
  prompt: 'CANARY PROMPT about my private life',
} as const;

const settings: MiniMaxSettings = {
  apiKey: fixtureKey,
  model: 'MiniMax-M3',
  requestTimeoutMs: 200,
  quotaTimeoutMs: 200,
  quotaFloorPercent: 25,
  maxReplyBytes: 4_096,
  maxRequestBytes: 8_192,
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { impl, calls };
}

const okBody = JSON.stringify({
  id: 'msg_fixture_02',
  type: 'message',
  model: 'MiniMax-M3',
  content: [{ type: 'text', text: '{"ok": true}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0 },
});
const request = { system: 'system text', user: `user text ${canaries.prompt}`, maxOutputTokens: 256 };
const signal = () => new AbortController().signal;

/** A fetch that never answers until its signal aborts (the adapter's deadline or the caller). */
const hanging = (call: Call) =>
  new Promise<Response>((_, reject) => {
    call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

function networkError(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`connect ${code} ${canaries.prompt}`), { code }),
  });
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('the MiniMax transport (fake fetch)', () => {
  it('encodes deterministic canonical bytes with thinking disabled and no credential', () => {
    const port = makeMiniMaxModelPort(settings, fakeFetch(() => new Response(okBody)).impl);
    const first = new TextDecoder().decode(port.encode(request));
    expect(new TextDecoder().decode(port.encode({ ...request }))).toBe(first);
    expect(JSON.parse(first)).toEqual({
      max_tokens: 256,
      messages: [{ content: [{ text: request.user, type: 'text' }], role: 'user' }],
      model: 'MiniMax-M3',
      system: 'system text',
      thinking: { type: 'disabled' },
    });
    expect(first.startsWith('{"max_tokens":256,"messages":')).toBe(true);
    expect(first).not.toContain('sk-cp-');
  });

  it('asks MiniMax-M3.1-Flash for adaptive thinking at the requested effort, M3 for none, and sends the rest no thinking parameter', () => {
    const encoded = (model: MiniMaxSettings['model']) =>
      JSON.parse(
        new TextDecoder().decode(
          makeMiniMaxModelPort({ ...settings, model }, fakeFetch(() => new Response(okBody)).impl).encode({
            ...request,
            effort: 'low',
          }),
        ),
      ) as { model: string; thinking: { type: string }; output_config?: { effort: string } };
    expect(encoded('MiniMax-M3.1-Flash')).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
    // `disabled` is verified for M3 only; an unverified model is not sent a parameter it may refuse.
    expect(encoded('MiniMax-M3').thinking).toEqual({ type: 'disabled' });
    for (const model of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'] as const)
      expect(encoded(model)).not.toHaveProperty('thinking');
    for (const model of ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'] as const)
      expect(encoded(model)).not.toHaveProperty('output_config');
  });

  it('gives a role that names no effort the low effort, so thinking cannot eat a small ceiling', () => {
    const port = makeMiniMaxModelPort(
      { ...settings, model: 'MiniMax-M3.1-Flash' },
      fakeFetch(() => new Response(okBody)).impl,
    );
    expect(JSON.parse(new TextDecoder().decode(port.encode(request)))).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('drops thinking blocks, reports thinking tokens and refuses an answer from another model', async () => {
    const flash = { ...settings, model: 'MiniMax-M3.1-Flash' } as const;
    const body = (model: string) =>
      JSON.stringify({
        id: 'msg_fixture_03',
        model,
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'fixture' },
          { type: 'text', text: '{"ok": true}' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 117, output_tokens: 91, output_tokens_details: { thinking_tokens: 56 } },
      });
    const served = makeMiniMaxModelPort(flash, fakeFetch(() => new Response(body('MiniMax-M3.1-Flash'))).impl);
    const reply = await served.send(served.encode(request), signal());
    expect(reply).toMatchObject({
      usage: { outputTokens: 91, reasoningTokens: 56 },
      answer: { kind: 'text', text: '{"ok": true}', stop: 'end' },
    });
    expect(JSON.stringify(reply)).not.toContain('private reasoning');

    // An unknown model name is silently served by another model: the answer is refused, its usage is charged.
    const substitute = makeMiniMaxModelPort(flash, fakeFetch(() => new Response(body('MiniMax-M3'))).impl);
    const refusal = await thrown(substitute.send(substitute.encode(request), signal()));
    expect(refusal).toBeInstanceOf(ModelRejectedError);
    expect(refusal).toMatchObject({ code: 'MODEL_MISMATCH', usage: { outputTokens: 91 } });
  });

  it('sends exactly the given bytes once, with the key only in a header and redirects not followed', async () => {
    const fetch = fakeFetch(() => new Response(okBody, { status: 200 }));
    const port = makeMiniMaxModelPort(settings, fetch.impl);
    const body = port.encode(request);
    const reply = await port.send(body, signal());
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call?.url).toBe(MINIMAX_MESSAGES_URL);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    expect((call?.init.headers as Record<string, string>)['x-api-key']).toBe(fixtureKey);
    expect(new Uint8Array(call?.init.body as Uint8Array)).toEqual(body);
    expect(reply).toEqual({
      remoteId: 'msg_fixture_02',
      usage: { inputTokens: 20, outputTokens: 5, reasoningTokens: null, cachedTokens: 0 },
      answer: { kind: 'text', text: '{"ok": true}', stop: 'end' },
    });
  });

  it.each([
    [
      400,
      ModelRejectedError,
      'HTTP_400_INVALID_REQUEST_ERROR',
      { type: 'error', error: { type: 'invalid_request_error' } },
    ],
    [
      401,
      ModelRejectedError,
      'HTTP_401_AUTHENTICATION_ERROR',
      { type: 'error', error: { type: 'authentication_error' } },
    ],
    [429, ModelRejectedError, 'HTTP_429_RATE_LIMIT_ERROR', { type: 'error', error: { type: 'rate_limit_error' } }],
    [
      400,
      ModelRejectedError,
      'HTTP_400_UNRECOGNISED',
      { type: 'error', error: { type: 'sk_cp_pockeypockeypockeypocke' } },
    ],
    [500, ModelRejectedError, 'HTTP_500', 'internal error'],
    [503, ModelRejectedError, 'HTTP_503', ''],
    [529, ModelRejectedError, 'HTTP_529_OVERLOADED_ERROR', { type: 'error', error: { type: 'overloaded_error' } }],
    [502, ModelOutcomeUnknownError, 'HTTP_502', '<html>bad gateway</html>'],
    [504, ModelOutcomeUnknownError, 'HTTP_504', ''],
    [301, ModelRejectedError, 'HTTP_301', ''],
  ])('maps HTTP %i to %o (%s), reading no message', async (status, kind, code, body) => {
    const text =
      typeof body === 'string' ? body : JSON.stringify({ ...body, message: `${canaries.key} ${canaries.presigned}` });
    const fetch = fakeFetch(
      () =>
        new Response(status === 301 ? null : text, {
          status,
          headers: status === 301 ? { location: canaries.presigned } : {},
        }),
    );
    const error = await thrown(makeMiniMaxModelPort(settings, fetch.impl).send(new Uint8Array([123, 125]), signal()));
    expect(error).toBeInstanceOf(kind);
    expect((error as { code: string }).code).toBe(code);
    expect(fetch.calls).toHaveLength(1);
    for (const canary of Object.values(canaries))
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(canary);
  });

  it('reports connection refusal, DNS and TLS failures as not sent', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED']) {
      const port = makeMiniMaxModelPort(settings, fakeFetch(() => Promise.reject(networkError(code))).impl);
      const error = await thrown(port.send(new Uint8Array([123, 125]), signal()));
      expect(error).toBeInstanceOf(ModelNotSentError);
      expect((error as ModelNotSentError).code).toBe(`NOT_CONNECTED_${code}`);
    }
  });

  it('reports a reset connection, a timeout after dispatch and a caller abort as unknown', async () => {
    const reset = await thrown(
      makeMiniMaxModelPort(settings, fakeFetch(() => Promise.reject(networkError('ECONNRESET'))).impl).send(
        new Uint8Array([123, 125]),
        signal(),
      ),
    );
    expect(reset).toBeInstanceOf(ModelOutcomeUnknownError);
    expect((reset as ModelOutcomeUnknownError).code).toBe('CONNECTION_RESET');

    const timedOut = await thrown(
      makeMiniMaxModelPort(settings, fakeFetch(hanging).impl).send(new Uint8Array([123, 125]), signal()),
    );
    expect(timedOut).toBeInstanceOf(ModelOutcomeUnknownError);
    expect((timedOut as ModelOutcomeUnknownError).code).toBe('TIMEOUT_AFTER_DISPATCH');

    const caller = new AbortController();
    const aborted = makeMiniMaxModelPort({ ...settings, requestTimeoutMs: 10_000 }, fakeFetch(hanging).impl).send(
      new Uint8Array([123, 125]),
      caller.signal,
    );
    caller.abort();
    const abortError = await thrown(aborted);
    expect(abortError).toBeInstanceOf(ModelOutcomeUnknownError);
    expect((abortError as ModelOutcomeUnknownError).code).toBe('ABORTED_AFTER_DISPATCH');
  });

  it('refuses to send an already aborted or oversized request (nothing leaves)', async () => {
    const fetch = fakeFetch(() => new Response(okBody));
    const port = makeMiniMaxModelPort(settings, fetch.impl);
    const caller = new AbortController();
    caller.abort();
    expect(await thrown(port.send(new Uint8Array([123, 125]), caller.signal))).toBeInstanceOf(ModelNotSentError);
    expect(await thrown(port.send(new Uint8Array(8_193), signal()))).toBeInstanceOf(ModelNotSentError);
    expect(fetch.calls).toHaveLength(0);
  });

  it('bounds the answer read: a larger 200 body is an unreadable answer, an interrupted one unknown', async () => {
    const large = makeMiniMaxModelPort(settings, fakeFetch(() => new Response('x'.repeat(5_000))).impl);
    expect(await large.send(new Uint8Array([123, 125]), signal())).toEqual({
      usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null },
      answer: { kind: 'unreadable', code: 'REPLY_TOO_LARGE' },
    });
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      },
    });
    const interrupted = await thrown(
      makeMiniMaxModelPort(settings, fakeFetch(() => new Response(broken)).impl).send(
        new Uint8Array([123, 125]),
        signal(),
      ),
    );
    expect(interrupted).toBeInstanceOf(ModelOutcomeUnknownError);
    expect((interrupted as ModelOutcomeUnknownError).code).toBe('BODY_READ_INTERRUPTED');
  });

  it('observes the quota with one bounded GET and fails closed on anything unexpected', async () => {
    const good = JSON.stringify({
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_remaining_percent: 60 },
      ],
    });
    const fetch = fakeFetch(() => new Response(good));
    const port = makeMiniMaxModelPort(settings, fetch.impl);
    expect(await port.observeQuota(signal())).toEqual({
      verdict: 'available',
      intervalRemainingPercent: 80,
      weeklyRemainingPercent: 60,
    });
    expect(fetch.calls[0]?.url).toBe(MINIMAX_QUOTA_URL);
    expect(fetch.calls[0]?.init.method).toBe('GET');
    expect((fetch.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${fixtureKey}`);

    const failing: [string, () => Promise<Response> | Response][] = [
      ['QUOTA_HTTP_401', () => new Response('denied', { status: 401 })],
      ['QUOTA_RESPONSE_INVALID', () => new Response('not json')],
      ['QUOTA_TRANSPORT_FAILED', () => Promise.reject(networkError('ECONNREFUSED'))],
    ];
    for (const [reasonCode, respond] of failing)
      expect(await makeMiniMaxModelPort(settings, fakeFetch(respond).impl).observeQuota(signal())).toEqual({
        verdict: 'unavailable',
        intervalRemainingPercent: null,
        weeklyRemainingPercent: null,
        reasonCode,
      });
    expect(await makeMiniMaxModelPort(settings, fakeFetch(hanging).impl).observeQuota(signal())).toMatchObject({
      verdict: 'unavailable',
      reasonCode: 'QUOTA_TIMEOUT',
    });
  });

  it('accepts only a token-plan key and a supported text model', () => {
    expect(() => makeMiniMaxModelPort({ ...settings, apiKey: 'sk-payg-000000000000000000' })).toThrow('token-plan');
    expect(() =>
      makeMiniMaxModelPort({ ...settings, model: 'MiniMax-M3.1-Flash-Preview' as MiniMaxSettings['model'] }),
    ).toThrow('unsupported model');
  });
});
