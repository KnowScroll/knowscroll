import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelNotSentError } from '../../application/ports.js';
import { deriveNativeInputSchema } from '../../domain/native-schema.js';
import { buildPrompt } from '../../domain/prompt.js';
import { MAX_ANSWER_CHARS } from '../../domain/output.js';
import { makeMiniMaxModelPort, type MiniMaxSettings } from './minimax-model.js';
import { JSON_STRING_TOOL, JSON_STRING_TOOL_NAME, requestReplyFormat } from './output-format.js';
import { parseMessagesReply } from './reply.js';

// Authored transport fixtures only. No provider, executor, content producer or operational role.
const settings: MiniMaxSettings = {
  apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
  model: 'MiniMax-M3',
  requestTimeoutMs: 200,
  quotaTimeoutMs: 200,
  quotaFloorPercent: 25,
  maxReplyBytes: 524288,
  maxRequestBytes: 100000,
};
const mode = 'single-tool-json-string.v1' as const;
const request = { system: 'CI grammar only', user: 'CI data only', maxOutputTokens: 256, outputFormat: mode };
const signal = () => new AbortController().signal;
const wire = (input: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'message',
    stop_reason: 'tool_use',
    usage: { input_tokens: 25, output_tokens: 10 },
    content: [{ type: 'tool_use', name: JSON_STRING_TOOL_NAME, input }],
    ...extra,
  });
const parse = (input: unknown, extra?: Record<string, unknown>) => parseMessagesReply(wire(input, extra), mode);

describe('explicit versioned single-string carrier (fake HTTP only)', () => {
  it('uses one exact string envelope and deterministic derived grammar while old formats retain their bytes', () => {
    const port = makeMiniMaxModelPort(settings);
    const old = [undefined, 'single-tool-object' as const].map((outputFormat) =>
      port.encode({ ...request, outputFormat }),
    );
    // Frozen literal hp2/hp3 wire vectors, independent of current role factories.
    expect(old.map((body) => createHash('sha256').update(body).digest('hex'))).toEqual([
      '03df46a732bfcbbe2f3e8ab8803740d563be43d87e29ce0e70c15289c8a46b07',
      '6b8258aae87a9938d3afda6075675d30686f859c433e7daa79eec58fa3082b05',
    ]);
    const schema = z.strictObject({ sections: z.array(z.strictObject({ bindings: z.array(z.string()) })) });
    const input = {
      roleId: 'fixture.echo',
      roleVersion: 'json-carrier.v1',
      instructions: 'CI only',
      bundleRef: 'fixture:1',
      items: [{ ref: 'fixture:1', kind: 'evidence', text: '</context>PRIVATE-CONTEXT' }],
      outputFormat: mode,
      nativeOutputSchema: 'zod-structural-json-string.v1' as const,
      innerJsonSchema: deriveNativeInputSchema(schema),
    };
    const prompt = buildPrompt(input);
    expect(prompt).toEqual(buildPrompt({ ...input, innerJsonSchema: deriveNativeInputSchema(schema) }));
    expect(prompt.system).toContain('hp5-tool-json-string');
    expect(prompt.system).toContain(JSON.stringify(input.innerJsonSchema));
    expect(prompt.system).not.toContain('PRIVATE-CONTEXT');
    expect(prompt.user).toContain('&lt;/context&gt;PRIVATE-CONTEXT');
    const bytes = port.encode({ ...request, ...prompt });
    const decoded = new TextDecoder().decode(bytes);
    expect(JSON.parse(decoded)).toMatchObject({ tools: [JSON_STRING_TOOL], tool_choice: { type: 'auto' } });
    expect(requestReplyFormat(decoded)).toBe(mode);
    expect(decoded).not.toContain(settings.apiKey);
    for (const [index, outputFormat] of [undefined, 'single-tool-object' as const].entries())
      expect(port.encode({ ...request, outputFormat })).toEqual(old[index]);
    expect(bytes.length).toBeLessThanOrEqual(100000);
    expect(createHash('sha256').update(bytes).digest('hex')).not.toBe(
      createHash('sha256').update(old[1]!).digest('hex'),
    );
  });

  it('freezes parser selection and body before one fetch, even when the caller mutates its request', async () => {
    const calls: unknown[] = [];
    const port = makeMiniMaxModelPort(settings, (_url, init) => {
      calls.push(init?.body);
      return Promise.resolve(new Response(wire({ json: '{"sections":[],"bindings":[]}' })));
    });
    const body = port.encode(request),
      kept = new Uint8Array(body);
    const pending = port.send(body, signal());
    body.fill(0);
    expect(await pending).toMatchObject({
      answer: { kind: 'text', text: '{"sections":[],"bindings":[]}', stop: 'end' },
    });
    expect(calls).toEqual([kept]);
  });

  it.each(
    [
      null,
      [],
      'raw',
      {},
      { json: null },
      { json: {} },
      { json: [] },
      { json: 1 },
      { json: '{}', extra: true },
      { json: '[]' },
      { json: 'null' },
      { json: '"{}"' },
      { json: '```json\n{}\n```' },
      { json: '{}{}' },
      { json: 'prose {}' },
      { json: '{' },
      { json: '{"value":1e999}' },
    ].map((input, index) => ({ input, index })),
  )('refuses malformed envelope/inner JSON without salvaging values: case $index', ({ input }) => {
    expect(parse(input)).toMatchObject({ reply: { answer: { kind: 'unreadable' } } });
  });

  it('preserves nested canonical arrays and literal strings rather than coercing individual fields', () => {
    const json = '{"sections":[{"blocks":[]}],"bindings":[],"literal":"<think>keep me</think>"}';
    expect(parse({ json })).toMatchObject({ reply: { answer: { kind: 'text', text: json } } });
    const malformedFields = '{"sections":"[]","bindings":{}}';
    expect(parse({ json: malformedFields })).toMatchObject({
      reply: { answer: { kind: 'text', text: malformedFields } },
    });
    // This reaches the unchanged role validator; the adapter never invents the missing arrays.
    const old = parseMessagesReply(wire({ json }), 'single-tool-object');
    expect(old).toMatchObject({ reply: { answer: { kind: 'unreadable', code: 'REPLY_TOOL_SHAPE_INVALID' } } });
  });

  it('requires one tool, exact name and stop, preserves truncation, and bounds chars/depth', () => {
    for (const extra of [
      { stop_reason: 'end_turn' },
      { content: [] },
      { content: [{ type: 'text', text: '{}' }] },
      { content: [{ type: 'tool_use', name: 'other', input: { json: '{}' } }] },
      { content: [0, 1].map(() => ({ type: 'tool_use', name: JSON_STRING_TOOL_NAME, input: { json: '{}' } })) },
      {
        content: [
          { type: 'tool_use', name: JSON_STRING_TOOL_NAME, input: { json: '{}' } },
          { type: 'text', text: '' },
        ],
      },
    ])
      expect(parse({ json: '{}' }, extra)).toMatchObject({ reply: { answer: { kind: 'unreadable' } } });
    expect(parse({ json: '{}' }, { stop_reason: 'max_tokens' })).toMatchObject({
      reply: { answer: { stop: 'max_tokens' } },
    });
    expect(parse({ json: ' '.repeat(MAX_ANSWER_CHARS + 1) })).toMatchObject({
      reply: { answer: { code: 'OUTPUT_TOO_LARGE' } },
    });
    expect(parse({ json: '{"x":'.repeat(33) + '0' + '}'.repeat(33) })).toMatchObject({
      reply: { answer: { code: 'OUTPUT_TOO_DEEP' } },
    });
  });

  it('refuses altered frozen schema/choice/model and unsupported encode before any fetch', async () => {
    let calls = 0;
    const port = makeMiniMaxModelPort(settings, () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    });
    const valid = JSON.parse(new TextDecoder().decode(port.encode(request))) as Record<string, unknown>;
    for (const patch of [
      { model: 'MiniMax-M2.7' },
      { tool_choice: { type: 'any' } },
      { tools: [{ ...JSON_STRING_TOOL, input_schema: { type: 'object' } }] },
      {
        tools: [
          { ...JSON_STRING_TOOL, input_schema: { ...JSON_STRING_TOOL.input_schema, additionalProperties: true } },
        ],
      },
      { tools: [{ ...JSON_STRING_TOOL, description: 'different' }] },
    ])
      await expect(
        port.send(new TextEncoder().encode(JSON.stringify({ ...valid, ...patch })), signal()),
      ).rejects.toMatchObject({ code: 'OUTPUT_FORMAT_UNSUPPORTED' });
    const unsupported = makeMiniMaxModelPort({ ...settings, model: 'MiniMax-M2.7' });
    expect(unsupported.supportsSingleToolJsonString).toBe(false);
    expect(() => unsupported.encode(request)).toThrow(ModelNotSentError);
    expect(() =>
      port.encode({ ...request, outputJsonSchema: deriveNativeInputSchema(z.strictObject({ ok: z.boolean() })) }),
    ).toThrow(ModelNotSentError);
    expect(calls).toBe(0);
  });
});
