/**
 * #132 — the worker-only MiniMax answer transport (ADR-0033 §2). MiniMax-M3 through the fixed
 * Anthropic-compatible subscription route; the caller supplies an `sk-cp-` key from the worker's
 * own environment. `ready()` runs the quota preflight before anything is scheduled or reserved;
 * `send()` posts exactly the reserved bytes once, with no redirects and no retries, and reports the
 * minimal receipt fields plus the reply text for the validator. Nothing here is logged or persisted:
 * no prompt, reply, header or key.
 */
import type { AnswerObservation, AnswerTransport } from '../reasoning/answer-worker.ts';
import { checkMiniMaxQuota } from './minimax-quota.ts';

export const MINIMAX_ANSWER_URL = 'https://api.minimax.io/anthropic/v1/messages';

const nullableCount = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

export function createMiniMaxAnswerTransport(options: { apiKey: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number }): AnswerTransport & {
  ready(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
} {
  if (!options.apiKey.startsWith('sk-cp-')) throw new Error('The answer route accepts only a MiniMax subscription (sk-cp-) key');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 45_000;
  return {
    kind: 'minimax',
    async ready(signal) {
      try { await checkMiniMaxQuota(options.apiKey, fetchImpl, signal); return { ok: true }; }
      catch { return { ok: false, reason: 'provider_quota_preflight_failed' }; }
    },
    async send({ body, signal }): Promise<AnswerObservation> {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        // A transport failure throws: the dispatch is then recorded as unknown, never retried.
        const response = await fetchImpl(MINIMAX_ANSWER_URL, {
          method: 'POST', redirect: 'manual', signal: controller.signal, body: Buffer.from(body),
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': options.apiKey },
        });
        let value: Record<string, unknown> | null = null;
        try { value = await response.json() as Record<string, unknown>; } catch { value = null; }
        const usage = (value?.usage ?? {}) as Record<string, unknown>;
        const observation = {
          remoteDisposition: 'terminal' as const, httpStatus: response.status,
          usage: { inputTokens: nullableCount(usage.input_tokens), outputTokens: nullableCount(usage.output_tokens), cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null },
        };
        if (response.status !== 200 || !value) {
          return { ...observation, outcome: response.status >= 400 && response.status < 500 && response.status !== 429 ? 'refusal' : 'error', text: null };
        }
        const blocks = Array.isArray(value.content) ? value.content as { type?: unknown; text?: unknown }[] : [];
        const text = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('');
        return { ...observation, outcome: 'success', text };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
