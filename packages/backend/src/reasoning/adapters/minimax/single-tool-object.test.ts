import { describe, expect, it } from 'vitest';
import { ModelNotSentError } from '../../application/ports.js';
import { MAX_ANSWER_CHARS, MAX_ANSWER_DEPTH } from '../../domain/output.js';
import { makeMiniMaxModelPort, type MiniMaxSettings } from './minimax-model.js';
import { OUTPUT_TOOL, requestReplyFormat } from './output-format.js';
import { parseMessagesReply } from './reply.js';

/** CI fixtures only: fake HTTP, no provider, quota, tool execution or generated content. */
const settings: MiniMaxSettings = {
  apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
  model: 'MiniMax-M3',
  requestTimeoutMs: 200,
  quotaTimeoutMs: 200,
  quotaFloorPercent: 25,
  maxReplyBytes: 524_288,
  maxRequestBytes: 262_144,
};
const request = { system: 'fixture system', user: 'fixture user', maxOutputTokens: 256 };
const signal = () => new AbortController().signal;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const usage = { inputTokens: 20, outputTokens: 5, reasoningTokens: null, cachedTokens: 3 };
const tool = (input: unknown = { ok: true }, name = 'submit_output') => ({ type: 'tool_use', name, input });
const response = (content: unknown[], stop_reason: unknown = 'tool_use', id: unknown = 'msg_fixture_tool') =>
  JSON.stringify({
    id,
    type: 'message',
    content,
    stop_reason,
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 3 },
  });

describe('single native output object (CI fixture)', () => {
  it('keeps literal historical text bytes and encodes only the fixed auto-choice data carrier', () => {
    const port = makeMiniMaxModelPort(settings);
    expect(decoder.decode(port.encode(request))).toBe(
      '{"max_tokens":256,"messages":[{"content":[{"text":"fixture user","type":"text"}],"role":"user"}],"model":"MiniMax-M3","system":"fixture system","thinking":{"type":"disabled"}}',
    );
    expect(port.supportsSingleToolObject).toBe(true);
    const input = { ...request, outputFormat: 'single-tool-object' as const };
    const body = port.encode(input);
    expect(body).toEqual(port.encode({ ...input }));
    const wire: unknown = JSON.parse(decoder.decode(body));
    expect(wire).toEqual({
      model: 'MiniMax-M3',
      max_tokens: 256,
      system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
      thinking: { type: 'disabled' },
      tools: [OUTPUT_TOOL],
      tool_choice: { type: 'auto' },
    });
    expect(decoder.decode(body)).not.toContain(settings.apiKey);
    expect(requestReplyFormat(decoder.decode(body))).toBe('single-tool-object');
    expect(requestReplyFormat(decoder.decode(port.encode(request)))).toBe('text');
  });

  it.each(['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'] as const)(
    'refuses opt-in on undocumented model %s without changing text encoding',
    async (model) => {
      const calls: RequestInit[] = [];
      const port = makeMiniMaxModelPort({ ...settings, model }, (_url, init) => {
        calls.push(init ?? {});
        return Promise.resolve(new Response(response([tool()])));
      });
      expect(port.supportsSingleToolObject).toBe(false);
      expect(JSON.parse(decoder.decode(port.encode(request)))).toMatchObject({ model });
      expect(() => port.encode({ ...request, outputFormat: 'single-tool-object' })).toThrow(ModelNotSentError);
      const m3 = makeMiniMaxModelPort(settings).encode({ ...request, outputFormat: 'single-tool-object' });
      await expect(port.send(m3, signal())).rejects.toMatchObject({ code: 'OUTPUT_FORMAT_UNSUPPORTED' });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    { tools: [] },
    { tools: [OUTPUT_TOOL] },
    { tool_choice: { type: 'auto' } },
    { tools: [OUTPUT_TOOL, OUTPUT_TOOL], tool_choice: { type: 'auto' } },
    { tools: [{ ...OUTPUT_TOOL, name: 'perform_action' }], tool_choice: { type: 'auto' } },
    { tools: [{ ...OUTPUT_TOOL, description: 'different' }], tool_choice: { type: 'auto' } },
    { tools: [{ ...OUTPUT_TOOL, input_schema: { type: 'object', properties: {} } }], tool_choice: { type: 'auto' } },
    { tools: [OUTPUT_TOOL], tool_choice: { type: 'tool', name: 'submit_output' } },
    { tools: [OUTPUT_TOOL], tool_choice: { type: 'auto', extra: true } },
    { tools: [{ ...OUTPUT_TOOL, extra: true }], tool_choice: { type: 'auto' } },
  ])('rejects unknown tool request configuration before any fetch: %j', async (config) => {
    let calls = 0;
    const port = makeMiniMaxModelPort(settings, () => {
      calls += 1;
      return Promise.resolve(new Response(response([tool()])));
    });
    await expect(
      port.send(encoder.encode(JSON.stringify({ model: 'MiniMax-M3', ...config })), signal()),
    ).rejects.toMatchObject({ code: 'OUTPUT_FORMAT_UNSUPPORTED' });
    expect(calls).toBe(0);
  });

  it('accepts one native object, preserves JSON values and usage, and drops private thinking', () => {
    const input = { z: ['a\\b', 'a"b', '🌱', 1, null], ok: true, nested: { note: '<think>literal</think>' } };
    const result = parseMessagesReply(
      response([{ type: 'thinking', thinking: 'PRIVATE-REASONING-CANARY' }, tool(input)]),
      'single-tool-object',
    );
    expect(result).toEqual({
      kind: 'reply',
      reply: {
        remoteId: 'msg_fixture_tool',
        usage,
        answer: {
          kind: 'text',
          text: '{"nested":{"note":"<think>literal</think>"},"ok":true,"z":["a\\\\b","a\\"b","🌱",1,null]}',
          stop: 'end',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-REASONING-CANARY');
  });

  it.each([
    [[], 'tool_use', 'REPLY_TOOL_MISSING'],
    [[{ type: 'thinking', thinking: 'private' }], 'tool_use', 'REPLY_TOOL_MISSING'],
    [[{ type: 'text', text: '{}' }], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[tool(), { type: 'text', text: '' }], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[{ type: 'text', text: 'private' }, tool()], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[tool(), tool()], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[tool({}, 'PRIVATE-WRONG-NAME')], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[tool('{}')], 'tool_use', 'REPLY_TOOL_INPUT_INVALID'],
    [[tool([])], 'tool_use', 'REPLY_TOOL_INPUT_INVALID'],
    [[tool(null)], 'tool_use', 'REPLY_TOOL_INPUT_INVALID'],
    [[tool(12)], 'tool_use', 'REPLY_TOOL_INPUT_INVALID'],
    [[tool(), { type: 'tool_result', content: 'private' }], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[null, tool()], 'tool_use', 'REPLY_TOOL_SHAPE_INVALID'],
    [[tool()], 'end_turn', 'REPLY_TOOL_STOP_INVALID'],
    [[tool()], null, 'REPLY_TOOL_STOP_INVALID'],
    [[tool()], 'unrecognised', 'REPLY_TOOL_STOP_INVALID'],
  ])('refuses ambiguous output without leaking it (%j, %s)', (content, stop, code) => {
    const result = parseMessagesReply(response(content, stop, 'sk-cp-PRIVATE-REMOTE'), 'single-tool-object');
    expect(result).toEqual({ kind: 'reply', reply: { usage, answer: { kind: 'unreadable', code } } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('preserves truncation before accepting even a complete native object', () => {
    expect(parseMessagesReply(response([tool()], 'max_tokens'), 'single-tool-object')).toMatchObject({
      reply: { usage, answer: { kind: 'text', text: '', stop: 'max_tokens' } },
    });
  });

  it('bounds native depth and serialized size and refuses numeric overflow before normalization', () => {
    let deep: unknown = {};
    for (let i = 0; i < MAX_ANSWER_DEPTH; i += 1) deep = { nested: deep };
    expect(parseMessagesReply(response([tool(deep)]), 'single-tool-object')).toMatchObject({
      reply: { usage, answer: { kind: 'unreadable', code: 'OUTPUT_TOO_DEEP' } },
    });
    expect(
      parseMessagesReply(response([tool({ long: 'x'.repeat(MAX_ANSWER_CHARS) })]), 'single-tool-object'),
    ).toMatchObject({ reply: { usage, answer: { kind: 'unreadable', code: 'OUTPUT_TOO_LARGE' } } });
    const overflow = response([tool({ number: 1 })]).replace('"number":1', '"number":1e400');
    expect(parseMessagesReply(overflow, 'single-tool-object')).toMatchObject({
      reply: { usage, answer: { kind: 'unreadable', code: 'REPLY_TOOL_INPUT_INVALID' } },
    });
  });

  it('does not accept a tool response as text or infer tool mode from the response', () => {
    expect(parseMessagesReply(response([tool()]))).toMatchObject({
      reply: { usage, answer: { kind: 'unreadable', code: 'REPLY_NO_TEXT' } },
    });
    expect(parseMessagesReply(response([{ type: 'text', text: '{}' }]))).toMatchObject({
      reply: { answer: { kind: 'text', text: '{}', stop: 'other' } },
    });
  });

  it('uses each frozen request mode on one shared port, makes one fetch per send, and executes nothing', async () => {
    const calls: Uint8Array[] = [];
    const port = makeMiniMaxModelPort(settings, async (_url, init) => {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      calls.push(bytes);
      // Let the second send enter before either response is interpreted.
      await Promise.resolve();
      const mode = requestReplyFormat(decoder.decode(bytes));
      return new Response(
        mode === 'single-tool-object'
          ? response([tool()])
          : response([{ type: 'text', text: '{"legacy":true}' }], 'end_turn'),
      );
    });
    const body = port.encode({ ...request, outputFormat: 'single-tool-object' });
    const saved = new Uint8Array(body);
    const first = port.send(body, signal());
    body.fill(0);
    const second = port.send(port.encode(request), signal());
    const [native, text] = await Promise.all([first, second]);
    expect(native.answer).toEqual({ kind: 'text', text: '{"ok":true}', stop: 'end' });
    expect(text.answer).toEqual({ kind: 'text', text: '{"legacy":true}', stop: 'end' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(saved);
  });
});
