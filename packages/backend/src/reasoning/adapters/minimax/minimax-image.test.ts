import { describe, expect, it } from 'vitest';
import { MINIMAX_IMAGE_MODEL, MINIMAX_IMAGE_URL, imageMimeOf, makeMiniMaxImagePort } from './minimax-image.js';

/**
 * The image transport over a scripted `fetch`: no network, no provider output. The bytes are a labelled CI FIXTURE (the
 * first bytes of a JPEG, a PNG and a WebP file), enough for the type check and nothing more.
 */
const KEY = 'sk-cp-FIXTUREfixtureFIXTUREfixture0000';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP')]);

const settings = { apiKey: KEY, requestTimeoutMs: 1_000, maxReplyBytes: 4_096 };
const signal = new AbortController().signal;

const reply = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const success = (bytes: Buffer): Response =>
  reply({
    data: { image_base64: [bytes.toString('base64')] },
    metadata: { success_count: '1' },
    base_resp: { status_code: 0 },
  });

function port(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = makeMiniMaxImagePort(settings, ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as unknown as typeof fetch);
  return { transport, calls };
}

const refusedConnection = (): never => {
  throw Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
  });
};

describe('the MiniMax image transport', () => {
  it('sends one request with the model, a wide band, the picture inline and the key in a header only', async () => {
    const { transport, calls } = port(() => success(JPEG));
    const outcome = await transport.generate({ prompt: 'A screenprint of a ringed planet.' }, signal);
    expect(outcome).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(url).toBe(MINIMAX_IMAGE_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    const sent = init.body as string;
    const body = JSON.parse(sent) as Record<string, unknown>;
    expect(body).toEqual({
      model: MINIMAX_IMAGE_MODEL,
      prompt: 'A screenprint of a ringed planet.',
      aspect_ratio: '21:9',
      response_format: 'base64',
      n: 1,
      prompt_optimizer: false,
    });
    expect(sent).not.toContain(KEY);
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it('accepts only a token-plan key, and says nothing of it', () => {
    expect(() => makeMiniMaxImagePort({ ...settings, apiKey: 'sk-api-not-a-plan-key-0000000000' })).toThrow(
      'only a token-plan (sk-cp-) key is accepted',
    );
  });

  it('knows an image by its first bytes, never by a name or a header', () => {
    expect(imageMimeOf(JPEG)).toBe('image/jpeg');
    expect(imageMimeOf(PNG)).toBe('image/png');
    expect(imageMimeOf(WEBP)).toBe('image/webp');
    expect(imageMimeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(imageMimeOf(Buffer.from([]))).toBeUndefined();
  });

  it('reports an image the provider made that is not an allowed type as unusable (it was produced, so it is paid for)', async () => {
    const { transport } = port(() => success(Buffer.from('<svg/>')));
    expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
      kind: 'unusable',
      code: 'IMAGE_NOT_RECOGNISED',
    });
  });

  describe('what each failure means for the money', () => {
    it('is not sent when the connection is refused: nothing left the machine', async () => {
      const { transport } = port(refusedConnection);
      expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
        kind: 'not_sent',
        code: 'NOT_CONNECTED_ECONNREFUSED',
      });
    });

    // Only what MiniMax documents as refused before an image is made counts nothing.
    it.each([1002, 1004, 1008, 1026, 2013, 2049])(
      'is a refusal that counts nothing: provider status %i',
      async (code) => {
        const { transport } = port(() => reply({ base_resp: { status_code: code } }));
        expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
          kind: 'rejected',
          code: `PROVIDER_${String(code)}`,
        });
      },
    );

    it.each([400, 401, 403, 404, 413, 422, 429])('is a refusal that counts nothing: HTTP %i', async (status) => {
      const { transport } = port(() => reply('refused', status));
      expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
        kind: 'rejected',
        code: `HTTP_${String(status)}`,
      });
    });

    // Anything else may have come after an image was made, and the pricing page does not say a failed image is free.
    it.each([1000, 1001, 1013, 1027, 2000, 2056, 9999])(
      'is unknown, charged and room-blocking: provider status %i',
      async (code) => {
        const { transport } = port(() => reply({ base_resp: { status_code: code } }));
        expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
          kind: 'unknown',
          code: `PROVIDER_${String(code)}`,
        });
      },
    );

    it.each([300, 302, 402, 405, 408, 409, 500, 501, 502, 503, 504, 529])('is unknown: HTTP %i', async (status) => {
      const { transport } = port(() => reply('maybe', status));
      expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
        kind: 'unknown',
        code: `HTTP_${String(status)}`,
      });
    });

    it('is unknown when images were blocked by content safety after they were generated', async () => {
      const { transport } = port(() =>
        reply({ metadata: { success_count: '0', failed_count: '1' }, base_resp: { status_code: 0 } }),
      );
      expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({
        kind: 'unknown',
        code: 'BLOCKED_AFTER_GENERATION',
      });
    });

    it.each([
      ['a success with no image', () => reply({ base_resp: { status_code: 0 } }), 'SUCCESS_WITHOUT_IMAGE'],
      ['a reply that is not JSON', () => reply('<html>'), 'REPLY_UNREADABLE'],
      ['a reply of the wrong shape', () => reply({ hello: 'world' }), 'REPLY_UNREADABLE'],
      ['a reply too large to read', () => reply('x'.repeat(5_000)), 'REPLY_TOO_LARGE'],
    ])('is unknown: %s', async (_name, respond, code) => {
      const { transport } = port(respond);
      expect(await transport.generate({ prompt: 'x' }, signal)).toEqual({ kind: 'unknown', code });
    });

    it('treats a reset after the request left as unknown, and a deadline as unknown too', async () => {
      const reset = port(() => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
        });
      });
      expect(await reset.transport.generate({ prompt: 'x' }, signal)).toEqual({
        kind: 'unknown',
        code: 'CONNECTION_RESET',
      });
      const slow = makeMiniMaxImagePort(
        { ...settings, requestTimeoutMs: 20 },
        ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })) as unknown as typeof fetch,
      );
      expect(await slow.generate({ prompt: 'x' }, signal)).toEqual({ kind: 'unknown', code: 'TIMEOUT_AFTER_DISPATCH' });
    });

    it('sends nothing when the caller has already stopped', async () => {
      const { transport, calls } = port(() => success(JPEG));
      const stopped = new AbortController();
      stopped.abort();
      expect(await transport.generate({ prompt: 'x' }, stopped.signal)).toEqual({
        kind: 'not_sent',
        code: 'ABORTED_BEFORE_DISPATCH',
      });
      expect(calls).toHaveLength(0);
    });
  });
});
