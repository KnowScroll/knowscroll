/**
 * #132 — the worker-only MiniMax answer transport (ADR-0033 §2), also the background inquiry path's
 * (ADR-0038) and model-written Scrolls' (ADR-0041): it sends whatever request bytes it is given.
 * MiniMax-M3 through the fixed Anthropic-compatible subscription route; the caller supplies an
 * `sk-cp-` key from its own process environment. `ready()` runs the quota preflight before anything
 * is scheduled or reserved; `send()` posts exactly the reserved bytes once, with no redirects and no
 * retries, and reports the minimal receipt fields plus the reply for the validator: its text, and
 * for a background inquiry's continuation (ADR-0042 §1) the whole assistant turn and its stop
 * reason. Nothing here is logged or persisted: no prompt, reply, header or key.
 */
import type { AssistantBlock } from '../../../../packages/core/src/reasoning/bridge-inquiry.ts';
import type { AnswerTransport } from '../reasoning/answer-worker.ts';
import type { InquiryObservation, InquiryTransport } from '../reasoning/inquiry-worker.ts';
import { checkMiniMaxQuota } from './minimax-quota.ts';

export const MINIMAX_ANSWER_URL = 'https://api.minimax.io/anthropic/v1/messages';

const nullableCount = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const isBlock = (b: unknown): b is AssistantBlock => b !== null && typeof b === 'object' && !Array.isArray(b) && typeof (b as { type?: unknown }).type === 'string';

/** One client serves answers and background inquiries (ADR-0038 §2), so both share its quota readiness. */
export type MiniMaxTransport = AnswerTransport & InquiryTransport & { ready(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> };

export function createMiniMaxAnswerTransport(options: { apiKey: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number; quotaTimeoutMs?: number }): MiniMaxTransport {
  if (!options.apiKey.startsWith('sk-cp-')) throw new Error('The answer route accepts only a MiniMax subscription (sk-cp-) key');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 45_000;
  return {
    kind: 'minimax',
    async ready(signal) {
      // Bounded: a quota endpoint that hangs must not stall the worker loop (projection runs there too).
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), options.quotaTimeoutMs ?? 10_000);
      try { await checkMiniMaxQuota(options.apiKey, fetchImpl, AbortSignal.any([signal, timeout.signal])); return { ok: true }; }
      catch { return { ok: false, reason: 'provider_quota_preflight_failed' }; }
      finally { clearTimeout(timer); }
    },
    async send({ body, signal }): Promise<InquiryObservation> {
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
        // Cache counters follow the certified route (ADR-0012): MiniMax reports much of a repeated
        // prompt as cache reads. They are recorded, not added to the input the budget charges.
        // A gateway timeout does not prove the provider stopped work: it stays unconfirmed.
        const observation = {
          remoteDisposition: response.status === 502 || response.status === 504 ? 'unconfirmed' as const : 'terminal' as const, httpStatus: response.status,
          usage: { inputTokens: nullableCount(usage.input_tokens), outputTokens: nullableCount(usage.output_tokens),
            cacheReadTokens: nullableCount(usage.cache_read_input_tokens), cacheWriteTokens: nullableCount(usage.cache_creation_input_tokens), costMicroUsd: null },
        };
        if (response.status !== 200 || !value) {
          return { ...observation, outcome: response.status >= 400 && response.status < 500 && response.status !== 429 ? 'refusal' : 'error', text: null, content: [], stopReason: null };
        }
        // The whole turn, thinking blocks included, in its original order: a continuation carries it back as it was.
        const content = Array.isArray(value.content) ? value.content.filter(isBlock) : [];
        const text = content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('');
        return { ...observation, outcome: 'success', text, content, stopReason: typeof value.stop_reason === 'string' ? value.stop_reason : null };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
