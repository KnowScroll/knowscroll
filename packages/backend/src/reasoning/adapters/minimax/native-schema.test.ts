import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelNotSentError } from '../../application/ports.js';
import { deriveNativeInputSchema, type NativeInputSchema } from '../../domain/native-schema.js';
import {
  makeMiniMaxModelPort,
  MINIMAX_MESSAGES_URL,
  MINIMAX_QUOTA_URL,
  type MiniMaxSettings,
} from './minimax-model.js';
import { OUTPUT_TOOL_DESCRIPTION, SCHEMA_OUTPUT_TOOL_DESCRIPTION, requestReplyFormat } from './output-format.js';

const settings: MiniMaxSettings = {
  apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
  model: 'MiniMax-M3',
  requestTimeoutMs: 200,
  quotaTimeoutMs: 200,
  quotaFloorPercent: 25,
  maxReplyBytes: 524288,
  maxRequestBytes: 100000,
};
const request = {
  system: 'Fixture only',
  user: 'Fixture context',
  maxOutputTokens: 256,
  outputFormat: 'single-tool-object' as const,
};
const shape = deriveNativeInputSchema(z.strictObject({ sections: z.array(z.string()).max(4) }));
const signal = () => new AbortController().signal;
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('MiniMax advisory native input shape (fake HTTP only)', () => {
  it('adds one fixed auto-choice data carrier, hashes the full schema and preserves absent-schema bytes', () => {
    const port = makeMiniMaxModelPort(settings);
    const old = port.encode(request);
    const body = port.encode({ ...request, outputJsonSchema: shape });
    expect(body).toEqual(port.encode({ ...request, outputJsonSchema: shape }));
    expect(hash(body)).not.toBe(hash(old));
    const wire = JSON.parse(new TextDecoder().decode(body)) as { tools: unknown[]; tool_choice: unknown };
    expect(wire.tools).toEqual([
      { name: 'submit_output', description: SCHEMA_OUTPUT_TOOL_DESCRIPTION, input_schema: shape },
    ]);
    expect(wire.tool_choice).toEqual({ type: 'auto' });
    expect(requestReplyFormat(new TextDecoder().decode(body))).toBe('single-tool-object');
    expect(new TextDecoder().decode(port.encode(request))).toContain(OUTPUT_TOOL_DESCRIPTION);
    expect(port.encode(request)).toEqual(old);
    expect(new TextDecoder().decode(body)).not.toContain(settings.apiKey);
    const other = deriveNativeInputSchema(z.strictObject({ sections: z.array(z.string()).max(5) }));
    expect(hash(port.encode({ ...request, outputJsonSchema: other }))).not.toBe(hash(body));
  });

  it('makes one quota observation and one HTTP request with the exact frozen schema body, without execution', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const port = makeMiniMaxModelPort(settings, (url, init) => {
      const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: address, init: init ?? {} });
      return Promise.resolve(
        new Response(
          address === MINIMAX_QUOTA_URL
            ? JSON.stringify({
                base_resp: { status_code: 0 },
                model_remains: [
                  {
                    model_name: 'general',
                    current_interval_remaining_percent: 80,
                    current_weekly_remaining_percent: 90,
                  },
                ],
              })
            : JSON.stringify({
                type: 'message',
                id: 'msg_fixture',
                stop_reason: 'tool_use',
                content: [
                  { type: 'thinking', thinking: 'PRIVATE-THINKING' },
                  { type: 'tool_use', name: 'submit_output', input: { sections: ['Fixture'] } },
                ],
                usage: { input_tokens: 25, output_tokens: 10 },
              }),
        ),
      );
    });
    expect(await port.observeQuota(signal())).toMatchObject({
      verdict: 'available',
      intervalRemainingPercent: 80,
      weeklyRemainingPercent: 90,
    });
    const body = port.encode({ ...request, outputJsonSchema: shape });
    const kept = new Uint8Array(body);
    const response = port.send(body, signal());
    body.fill(0);
    expect(await response).toMatchObject({
      answer: { kind: 'text', text: '{"sections":["Fixture"]}' },
      usage: { inputTokens: 25, outputTokens: 10 },
    });
    expect(calls.map((c) => c.url)).toEqual([MINIMAX_QUOTA_URL, MINIMAX_MESSAGES_URL]);
    expect(calls[1]?.init.body).toEqual(kept);
    expect(calls[1]?.init.redirect).toBe('manual');
  });

  it('rejects unsupported, remote or over-limit schemas before fetch and keeps the old strict request decoder', async () => {
    let sends = 0;
    const port = makeMiniMaxModelPort(settings, () => {
      sends++;
      return Promise.resolve(new Response('{}'));
    });
    for (const outputJsonSchema of [
      { type: 'object', properties: {}, $ref: 'https://private.invalid' },
      { type: 'object', properties: {}, description: 'private' },
      { type: 'object', properties: { value: { enum: ['x'.repeat(1025)] } } },
    ])
      expect(() =>
        port.encode({ ...request, outputJsonSchema: outputJsonSchema as unknown as NativeInputSchema }),
      ).toThrow(ModelNotSentError);
    const supported = port.encode({ ...request, outputJsonSchema: shape });
    const malformed = JSON.parse(new TextDecoder().decode(supported)) as { tools: { input_schema: unknown }[] };
    const first = malformed.tools[0];
    if (first) first.input_schema = { type: 'object', properties: {}, $ref: '#/definitions/missing' };
    await expect(port.send(new TextEncoder().encode(JSON.stringify(malformed)), signal())).rejects.toMatchObject({
      code: 'OUTPUT_FORMAT_UNSUPPORTED',
    });
    expect(sends).toBe(0);
    const unsupported = makeMiniMaxModelPort({ ...settings, model: 'MiniMax-M2.7' });
    expect(unsupported.supportsNativeOutputSchema).toBe(false);
    expect(() => unsupported.encode({ ...request, outputJsonSchema: shape })).toThrow(ModelNotSentError);
    expect(() => port.encode({ ...request, outputFormat: undefined, outputJsonSchema: shape })).toThrow(
      ModelNotSentError,
    );
  });
});
