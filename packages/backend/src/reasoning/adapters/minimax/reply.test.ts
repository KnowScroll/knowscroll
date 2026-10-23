import { describe, expect, it } from 'vitest';
import {
  judgeQuota,
  parseMessagesReply,
  parseUsage,
  providerErrorCode,
  safeRemoteId,
  stripThinkingFraming,
} from './reply.js';

/** Response bodies below are fixtures shaped like the route's documented fields, not provider output. */
const answer = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'msg_fixture_01',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 214, output_tokens: 13, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 },
    ...extra,
  });

describe('MiniMax reply parsing (fixtures)', () => {
  it('joins text blocks, drops thinking blocks and reports usage and the remote ID', () => {
    const parsed = parseMessagesReply(
      answer([
        { type: 'thinking', thinking: 'private reasoning that must never be kept' },
        { type: 'text', text: '{"ok": true,' },
        { type: 'text', text: ' "echo": "lantern"}' },
      ]),
    );
    expect(parsed).toEqual({
      kind: 'reply',
      reply: {
        remoteId: 'msg_fixture_01',
        usage: { inputTokens: 214, outputTokens: 13, reasoningTokens: null, cachedTokens: 128 },
        answer: { kind: 'text', text: '{"ok": true, "echo": "lantern"}', stop: 'end' },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('private reasoning');
  });

  it('strips one leading <think> block from the answer text, and only a leading one', () => {
    expect(stripThinkingFraming('\n<think>planning…</think>\n{"ok": true}')).toEqual({
      ok: true,
      text: '\n{"ok": true}',
    });
    expect(stripThinkingFraming('{"note": "<think>kept</think>"}')).toEqual({
      ok: true,
      text: '{"note": "<think>kept</think>"}',
    });
    expect(stripThinkingFraming('<think>never closed')).toEqual({ ok: false });
    const parsed = parseMessagesReply(
      answer([{ type: 'text', text: '<think>budget gone' }], { stop_reason: 'max_tokens' }),
    );
    expect(parsed).toMatchObject({
      kind: 'reply',
      reply: { answer: { kind: 'unreadable', code: 'THINKING_UNTERMINATED' } },
    });
  });

  it('maps stop reasons and marks a cut-off answer', () => {
    expect(parseMessagesReply(answer([{ type: 'text', text: '{' }], { stop_reason: 'max_tokens' }))).toMatchObject({
      reply: { answer: { kind: 'text', stop: 'max_tokens' } },
    });
    expect(parseMessagesReply(answer([{ type: 'text', text: '{}' }], { stop_reason: 'tool_use' }))).toMatchObject({
      reply: { answer: { kind: 'text', stop: 'other' } },
    });
  });

  it('treats a body that is not a JSON object, or has no text, as an unreadable answer', () => {
    expect(parseMessagesReply('<html>gateway</html>')).toMatchObject({
      reply: { answer: { kind: 'unreadable', code: 'REPLY_NOT_JSON' } },
    });
    expect(parseMessagesReply('[]')).toMatchObject({
      reply: { answer: { kind: 'unreadable', code: 'REPLY_NOT_JSON' } },
    });
    expect(parseMessagesReply(answer([{ type: 'thinking', thinking: 'only this' }]))).toMatchObject({
      reply: { answer: { kind: 'unreadable', code: 'REPLY_NO_TEXT' } },
    });
  });

  it('treats an error object in a 200 body as a conclusive rejection with a sanitised code', () => {
    expect(
      parseMessagesReply(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'sk-cp-canary' } }),
      ),
    ).toEqual({ kind: 'rejected', code: 'PROVIDER_ERROR_OVERLOADED_ERROR' });
    expect(
      parseMessagesReply(JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })),
    ).toEqual({
      kind: 'rejected',
      code: 'PROVIDER_ERROR_MINIMAX_1008',
    });
  });

  it('parses usage defensively and never estimates', () => {
    expect(parseUsage(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
    expect(parseUsage({ input_tokens: -1, output_tokens: 1.5, cache_read_input_tokens: 'x' })).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
    expect(
      parseUsage({
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 2 },
      }),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 3,
      reasoningTokens: 2,
      cachedTokens: null,
    });
  });

  it('records only safe remote IDs and error codes (never messages)', () => {
    expect(safeRemoteId('msg_01abc')).toBe('msg_01abc');
    expect(safeRemoteId('sk-cp-looks-like-a-key-000000')).toBeUndefined();
    expect(safeRemoteId('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBeUndefined();
    expect(safeRemoteId('has spaces')).toBeUndefined();
    expect(providerErrorCode({ error: { type: 'rate_limit_error', message: 'secret' } })).toBe('RATE_LIMIT_ERROR');
  });

  it('records only error types it knows: a provider-chosen type becomes UNRECOGNISED', () => {
    for (const type of ['Rate Limit!', 'sk_cp_pockeypockeypockeypocke', 'ignore_previous_instructions', 'x'.repeat(40)])
      expect(providerErrorCode({ error: { type, message: 'sk-cp-secretsecretsecretsecret' } })).toBe('UNRECOGNISED');
    expect(providerErrorCode({ error: { type: 7 }, base_resp: { status_code: 1004 } })).toBe('MINIMAX_1004');
  });
});

describe('MiniMax quota judgement (fixtures shaped like the v1-verified response)', () => {
  const remains = (entries: unknown[], status = 0) => ({ base_resp: { status_code: status }, model_remains: entries });
  const general = (interval: unknown, weekly: unknown) => ({
    model_name: 'general',
    current_interval_remaining_percent: interval,
    current_weekly_remaining_percent: weekly,
  });

  it('is available when both windows are at or above the floor', () => {
    expect(judgeQuota(remains([general(99, 25)]), 25)).toEqual({
      verdict: 'available',
      intervalRemainingPercent: 99,
      weeklyRemainingPercent: 25,
    });
  });

  it('is insufficient below the floor, and records the observation', () => {
    expect(judgeQuota(remains([general(24, 90)]), 25)).toEqual({
      verdict: 'insufficient',
      intervalRemainingPercent: 24,
      weeklyRemainingPercent: 90,
      reasonCode: 'QUOTA_BELOW_FLOOR',
    });
  });

  it.each([
    ['a provider error', remains([general(99, 99)], 1004)],
    ['no general window', remains([{ ...general(99, 99), model_name: 'MiniMax-M3' }])],
    ['two general windows', remains([general(99, 99), general(99, 99)])],
    ['a missing percentage', remains([general(99, undefined)])],
    ['a percentage above 100', remains([general(101, 99)])],
    ['a non-object', 'nope'],
  ])('fails closed on %s', (_label, value) => {
    expect(judgeQuota(value, 25).verdict).toBe('unavailable');
  });
});
