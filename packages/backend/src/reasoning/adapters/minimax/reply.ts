import type { ReportedUsage } from '../../domain/budgets.js';
import type { ModelReply, QuotaObservation, StopReason } from '../../application/ports.js';
import { canonicalJson, type CanonicalJson } from '../../../infrastructure/receipts/canonical.js';
import { MAX_ANSWER_CHARS, MAX_ANSWER_DEPTH, exceedsDepth } from '../../domain/output.js';
import { OUTPUT_TOOL_NAME, JSON_STRING_TOOL_NAME, type ReplyFormat } from './output-format.js';

/**
 * Pure parsing of MiniMax responses on the Anthropic-compatible route (providers-and-secrets.md).
 * Nothing here logs or keeps raw provider text beyond the answer the harness validates.
 */

/** Largest token count accepted from a provider (anything larger is treated as not reported). */
const MAX_REPORTED_TOKENS = 1_000_000_000;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REPORTED_TOKENS
    ? value
    : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Usage as MiniMax reports it on this route (Anthropic field names). Input counts new input plus
 * cache writes; cache reads are reported separately as cached tokens; reasoning tokens only when a
 * reasoning count is reported (thinking is disabled, so usually not). Missing or malformed counts
 * are `null` (never estimated).
 */
export function parseUsage(value: unknown): ReportedUsage {
  const usage = record(value);
  if (usage === undefined) return { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null };
  const input = count(usage['input_tokens']);
  const cacheWrite = count(usage['cache_creation_input_tokens']);
  const details = record(usage['output_tokens_details']);
  return {
    inputTokens: input === null ? null : input + (cacheWrite ?? 0),
    outputTokens: count(usage['output_tokens']),
    reasoningTokens: count(usage['reasoning_tokens']) ?? count(details?.['reasoning_tokens']),
    cachedTokens: count(usage['cache_read_input_tokens']),
  };
}

/**
 * Removes provider reasoning framing from an answer: one `<think>…</think>` block at the very
 * start (after whitespace). Only the adapter calls this, on provider output; user text never
 * passes through it, and a `<think>` anywhere else (for example inside a JSON string) is kept.
 */
export function stripThinkingFraming(
  text: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  const start = text.search(/\S/);
  if (start < 0 || !text.startsWith('<think>', start)) return { ok: true, text };
  const end = text.indexOf('</think>', start);
  if (end < 0) return { ok: false };
  return { ok: true, text: text.slice(end + '</think>'.length) };
}

const remoteIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A provider message ID safe to record, or `undefined` (wrong shape, or key/token-shaped). */
export function safeRemoteId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !remoteIdPattern.test(value)) return undefined;
  if (/^(?:sk|pk|rk)-/i.test(value) || /^eyJ/.test(value)) return undefined;
  return value;
}

function stopReason(value: unknown): StopReason {
  if (value === 'end_turn' || value === 'stop_sequence') return 'end';
  if (value === 'max_tokens') return 'max_tokens';
  return 'other';
}

/**
 * The error types of the Anthropic-compatible API that this route is known to use. The outcome
 * code is chosen by us, never copied from the provider: a type outside this list is recorded as
 * `UNRECOGNISED`, so a provider-controlled string can never reach a ledger row or a log.
 */
const knownErrorTypes: ReadonlySet<string> = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
  'timeout_error',
  'billing_error',
]);

/**
 * A provider error code safe to record: the Anthropic-style `error.type` when it is one of
 * `knownErrorTypes` (anything else is `UNRECOGNISED`), or MiniMax's numeric `base_resp.status_code`.
 * The message is never read.
 */
export function providerErrorCode(value: unknown): string | undefined {
  const body = record(value);
  if (body === undefined) return undefined;
  const type = record(body['error'])?.['type'];
  if (typeof type === 'string') return knownErrorTypes.has(type) ? type.toUpperCase() : 'UNRECOGNISED';
  const status = record(body['base_resp'])?.['status_code'];
  if (typeof status === 'number' && Number.isInteger(status) && status > 0 && status < 1_000_000)
    return `MINIMAX_${status}`;
  return undefined;
}

/** Outcome of reading a 200 response body. `rejected` carries a provider error code. */
export type ParsedReply =
  { readonly kind: 'reply'; readonly reply: ModelReply } | { readonly kind: 'rejected'; readonly code: string };

/**
 * Interprets a 200 response body (already bounded), using this call's request-selected format.
 * The opt-in requires one fixed data tool with native object input, then bounds and serializes it
 * for the unchanged harness validator. The default preserves historical joined text
 * blocks with thinking blocks dropped and a leading `<think>` block stripped, the stop reason,
 * usage and a safe remote ID. A body that is not a JSON object, or has no text, is an
 * `unreadable` answer (the provider did answer; nothing usable arrived). An error object in a
 * 200 body is a conclusive rejection.
 */
export function parseMessagesReply(text: string, format: ReplyFormat = 'text'): ParsedReply {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable('REPLY_NOT_JSON');
  }
  const body = record(value);
  if (body === undefined) return unreadable('REPLY_NOT_JSON');
  const usage = parseUsage(body['usage']);
  const remoteId = safeRemoteId(body['id']);
  const withId = remoteId === undefined ? {} : { remoteId };
  const baseStatus = record(body['base_resp'])?.['status_code'];
  if (body['type'] === 'error' || (typeof baseStatus === 'number' && baseStatus !== 0))
    return { kind: 'rejected', code: `PROVIDER_ERROR_${providerErrorCode(body) ?? 'UNSPECIFIED'}` };
  const content = Array.isArray(body['content']) ? (body['content'] as unknown[]) : [];
  if (format === 'single-tool-json-string.v1') {
    const failed = (code: string): ParsedReply => ({
      kind: 'reply',
      reply: { ...withId, usage, answer: { kind: 'unreadable', code } },
    });
    if (body['stop_reason'] === 'max_tokens')
      return { kind: 'reply', reply: { ...withId, usage, answer: { kind: 'text', text: '', stop: 'max_tokens' } } };
    if (body['stop_reason'] !== 'tool_use') return failed('REPLY_TOOL_STOP_INVALID');
    let input: Readonly<Record<string, unknown>> | undefined;
    for (const value of content) {
      const block = record(value);
      if (block?.['type'] === 'thinking') continue;
      if (block?.['type'] !== 'tool_use' || block['name'] !== JSON_STRING_TOOL_NAME || input !== undefined)
        return failed('REPLY_TOOL_SHAPE_INVALID');
      input = record(block['input']);
      if (input === undefined) return failed('REPLY_TOOL_INPUT_INVALID');
    }
    if (input === undefined) return failed('REPLY_TOOL_MISSING');
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'json') || typeof input['json'] !== 'string')
      return failed('REPLY_TOOL_INPUT_INVALID');
    const answer = input['json'];
    if (answer.length > MAX_ANSWER_CHARS) return failed('OUTPUT_TOO_LARGE');
    let parsed: unknown;
    try {
      // Strict bare JSON only. No fences, field coercion, second decoding or repair here.
      parsed = JSON.parse(answer);
    } catch {
      return failed('REPLY_TOOL_JSON_INVALID');
    }
    if (record(parsed) === undefined) return failed('REPLY_TOOL_JSON_INVALID');
    const values: unknown[] = [parsed];
    for (let value = values.pop(); value !== undefined; value = values.pop()) {
      if (typeof value === 'number' && !Number.isFinite(value)) return failed('REPLY_TOOL_JSON_INVALID');
      if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) values.push(child);
    }
    if (exceedsDepth(parsed, MAX_ANSWER_DEPTH)) return failed('OUTPUT_TOO_DEEP');
    // The unchanged harness still extracts, redacts, validates, semantically checks and bounds storage.
    return { kind: 'reply', reply: { ...withId, usage, answer: { kind: 'text', text: answer, stop: 'end' } } };
  }
  if (format === 'single-tool-object') {
    const failed = (code: string): ParsedReply => ({
      kind: 'reply',
      reply: { ...withId, usage, answer: { kind: 'unreadable', code } },
    });
    // Preserve the harness's truncation classification even if the cut-off tool input looks valid.
    if (body['stop_reason'] === 'max_tokens')
      return { kind: 'reply', reply: { ...withId, usage, answer: { kind: 'text', text: '', stop: 'max_tokens' } } };
    if (body['stop_reason'] !== 'tool_use') return failed('REPLY_TOOL_STOP_INVALID');
    let input: Readonly<Record<string, unknown>> | undefined;
    for (const value of content) {
      const block = record(value);
      if (block?.['type'] === 'thinking') continue;
      if (block?.['type'] !== 'tool_use' || block['name'] !== OUTPUT_TOOL_NAME || input !== undefined)
        return failed('REPLY_TOOL_SHAPE_INVALID');
      input = record(block['input']);
      if (input === undefined) return failed('REPLY_TOOL_INPUT_INVALID');
    }
    if (input === undefined) return failed('REPLY_TOOL_MISSING');
    if (exceedsDepth(input, MAX_ANSWER_DEPTH)) return failed('OUTPUT_TOO_DEEP');
    let answer: string;
    try {
      // Native parsed JSON only; canonicalJson additionally refuses non-finite numeric overflow.
      answer = canonicalJson(input as CanonicalJson);
    } catch {
      return failed('REPLY_TOOL_INPUT_INVALID');
    }
    if (answer.length > MAX_ANSWER_CHARS) return failed('OUTPUT_TOO_LARGE');
    return { kind: 'reply', reply: { ...withId, usage, answer: { kind: 'text', text: answer, stop: 'end' } } };
  }
  const texts = content
    .map((block) => record(block))
    .filter((block) => block?.['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block?.['text'] as string);
  if (texts.length === 0)
    return { kind: 'reply', reply: { ...withId, usage, answer: { kind: 'unreadable', code: 'REPLY_NO_TEXT' } } };
  const stripped = stripThinkingFraming(texts.join(''));
  if (!stripped.ok)
    return {
      kind: 'reply',
      reply: { ...withId, usage, answer: { kind: 'unreadable', code: 'THINKING_UNTERMINATED' } },
    };
  return {
    kind: 'reply',
    reply: { ...withId, usage, answer: { kind: 'text', text: stripped.text, stop: stopReason(body['stop_reason']) } },
  };

  function unreadable(code: string): ParsedReply {
    return {
      kind: 'reply',
      reply: {
        usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null },
        answer: { kind: 'unreadable', code },
      },
    };
  }
}

/**
 * Judges a token-plan quota response (v1 rule, providers-and-secrets.md): provider status 0,
 * exactly one `general` window, and the current interval and weekly remaining percentages both
 * finite and within 0–100. Both at or above `floorPercent` → `available`; otherwise
 * `insufficient`. Anything missing or ambiguous → `unavailable` (fail closed).
 */
export function judgeQuota(value: unknown, floorPercent: number): QuotaObservation {
  const invalid: QuotaObservation = {
    verdict: 'unavailable',
    intervalRemainingPercent: null,
    weeklyRemainingPercent: null,
    reasonCode: 'QUOTA_RESPONSE_INVALID',
  };
  const body = record(value);
  if (body === undefined || record(body['base_resp'])?.['status_code'] !== 0 || !Array.isArray(body['model_remains']))
    return invalid;
  const general = (body['model_remains'] as unknown[])
    .map((entry) => record(entry))
    .filter((entry) => entry?.['model_name'] === 'general');
  if (general.length !== 1) return { ...invalid, reasonCode: 'QUOTA_WINDOW_AMBIGUOUS' };
  const interval = general[0]?.['current_interval_remaining_percent'];
  const weekly = general[0]?.['current_weekly_remaining_percent'];
  const percent = (candidate: unknown) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= 100
      ? candidate
      : null;
  const intervalPercent = percent(interval);
  const weeklyPercent = percent(weekly);
  if (intervalPercent === null || weeklyPercent === null) return invalid;
  const available = intervalPercent >= floorPercent && weeklyPercent >= floorPercent;
  return {
    verdict: available ? 'available' : 'insufficient',
    intervalRemainingPercent: intervalPercent,
    weeklyRemainingPercent: weeklyPercent,
    ...(available ? {} : { reasonCode: 'QUOTA_BELOW_FLOOR' }),
  };
}
