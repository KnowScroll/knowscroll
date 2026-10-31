import { canonicalJson } from '../../../infrastructure/receipts/canonical.js';
import {
  ModelNotSentError,
  ModelOutcomeUnknownError,
  ModelRejectedError,
  type ModelPort,
  type ModelReply,
  type QuotaObservation,
} from '../../application/ports.js';
import { judgeQuota, parseMessagesReply, providerErrorCode } from './reply.js';
import { ReplyTooLargeError, deadline, discard, errorCode, notSentCodes, readBounded } from './transport.js';

/** The fixed Anthropic-compatible messages route of the token plan (no endpoint override). */
export const MINIMAX_MESSAGES_URL = 'https://api.minimax.io/anthropic/v1/messages';
/** The token-plan quota preflight (an observation, not a reservation). */
export const MINIMAX_QUOTA_URL = 'https://www.minimax.io/v1/token_plan/remains';
/** Text models available on the token-plan key (`MiniMax-M3.1-Flash-Preview` is not). */
export const MINIMAX_TEXT_MODELS = [
  'MiniMax-M3.1-Flash',
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
] as const;
export type MiniMaxModel = (typeof MINIMAX_TEXT_MODELS)[number];

export interface MiniMaxSettings {
  /** Token-plan key (`sk-cp-…`). A credential: sent only in a header, never logged or stored. */
  readonly apiKey: string;
  readonly model: MiniMaxModel;
  /** Whole-request deadline (connect, send, wait, read). */
  readonly requestTimeoutMs: number;
  readonly quotaTimeoutMs: number;
  /** Both quota windows must have at least this much remaining (v1 rule: 25). */
  readonly quotaFloorPercent: number;
  /** Largest response body read; a larger 200 answer is recorded as unreadable, not parsed. */
  readonly maxReplyBytes: number;
  /** Largest request body sent (the protected store's limit). */
  readonly maxRequestBytes: number;
}

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

/** `MiniMax-M3.1-Flash` thinks before it answers, adaptively, and refuses `thinking: disabled` (HTTP 400, code 2013). */
const thinksAdaptively = (model: MiniMaxModel): boolean => model === 'MiniMax-M3.1-Flash';

/**
 * The `thinking` parameter a model is known to accept. `disabled` is verified for `MiniMax-M3` only;
 * a model that has not been tried with a parameter is sent none, so the provider's own default
 * applies rather than a guess that may be refused.
 */
function thinkingParameter(model: MiniMaxModel): { readonly type: 'adaptive' | 'disabled' } | undefined {
  if (thinksAdaptively(model)) return { type: 'adaptive' };
  return model === 'MiniMax-M3' ? { type: 'disabled' } : undefined;
}
/**
 * A role that does not name an effort gets `low`: left alone the model once thought for 15,000
 * tokens and never answered, which would eat the small ceilings of decision roles.
 */
const DEFAULT_EFFORT = 'low';

/**
 * The MiniMax transport behind `ModelPort` (blueprint §15; providers-and-secrets.md).
 *
 * - `encode`: canonical JSON (sorted keys) of `{model, max_tokens, system, messages}` plus
 *   `thinking` for the models it is verified for (`adaptive` for M3.1-Flash, `disabled` for M3, none
 *   for the rest) and `output_config.effort` for a model that thinks adaptively (the role's, else
 *   `low`; without it thinking can use the whole token budget). Thinking tokens count against
 *   `max_tokens`. Thinking content (a
 *   `thinking` block, or `<think>` framing at the start of the text) is dropped from the answer in
 *   `reply.ts`, and only there.
 * - `send`: exactly one `fetch` (no SDK, no retries, `redirect: "manual"`), one deadline over the
 *   whole exchange, a bounded body read. Mapping: 200 → answer (or `unreadable`; an answer whose
 *   `model` is not the configured model is a conclusive `MODEL_MISMATCH` rejection); 3xx/4xx/429/
 *   500/503/529 → `ModelRejectedError` (conclusive); 502/504 → `ModelOutcomeUnknownError` (a
 *   gateway cannot say whether the provider processed it); connection refused/DNS/TLS before
 *   sending → `ModelNotSentError`; a timeout, reset or interrupted read after the request may have
 *   left → `ModelOutcomeUnknownError`. Error bodies are read (bounded) only for a sanitised error
 *   type; messages, headers and URLs from the provider are never kept.
 * - `observeQuota`: one bounded GET of the token-plan quota, judged by `judgeQuota`; never throws.
 *
 * The key is sent only in headers. Nothing here logs.
 */
export function makeMiniMaxModelPort(settings: MiniMaxSettings, fetchImpl: typeof fetch = fetch): ModelPort {
  if (!settings.apiKey.startsWith('sk-cp-')) throw new Error('MiniMax: only a token-plan (sk-cp-) key is accepted');
  if (!(MINIMAX_TEXT_MODELS as readonly string[]).includes(settings.model))
    throw new Error('MiniMax: unsupported model');

  return {
    provider: 'minimax',
    model: settings.model,
    encode(request) {
      return encoder.encode(
        canonicalJson({
          model: settings.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
          ...(thinkingParameter(settings.model) === undefined ? {} : { thinking: thinkingParameter(settings.model) }),
          ...(thinksAdaptively(settings.model) ? { output_config: { effort: request.effort ?? DEFAULT_EFFORT } } : {}),
        }),
      );
    },

    async observeQuota(signal): Promise<QuotaObservation> {
      const unavailable = (reasonCode: string): QuotaObservation => ({
        verdict: 'unavailable',
        intervalRemainingPercent: null,
        weeklyRemainingPercent: null,
        reasonCode,
      });
      if (signal.aborted) return unavailable('QUOTA_ABORTED');
      const limit = deadline(signal, settings.quotaTimeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(MINIMAX_QUOTA_URL, {
            method: 'GET',
            headers: { authorization: `Bearer ${settings.apiKey}`, accept: 'application/json' },
            redirect: 'manual',
            signal: limit.signal,
          });
        } catch {
          return unavailable(limit.timedOut() ? 'QUOTA_TIMEOUT' : 'QUOTA_TRANSPORT_FAILED');
        }
        if (response.status !== 200) {
          await discard(response);
          return unavailable(`QUOTA_HTTP_${response.status}`);
        }
        let text: string;
        try {
          text = decoder.decode(await readBounded(response, 65_536));
        } catch {
          return unavailable('QUOTA_READ_FAILED');
        }
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          return unavailable('QUOTA_RESPONSE_INVALID');
        }
        return judgeQuota(value, settings.quotaFloorPercent);
      } finally {
        limit.dispose();
      }
    },

    async send(body, signal): Promise<ModelReply> {
      if (body.byteLength > settings.maxRequestBytes) throw new ModelNotSentError('REQUEST_TOO_LARGE');
      if (signal.aborted) throw new ModelNotSentError('ABORTED_BEFORE_DISPATCH');
      // Snapshot once: fetch sees the same bytes even if the caller mutates its array.
      const frozenBody = new Uint8Array(body);
      const limit = deadline(signal, settings.requestTimeoutMs);
      const uncertain = (fallback: string) =>
        new ModelOutcomeUnknownError(
          limit.timedOut() ? 'TIMEOUT_AFTER_DISPATCH' : limit.callerAborted() ? 'ABORTED_AFTER_DISPATCH' : fallback,
        );
      try {
        let response: Response;
        try {
          response = await fetchImpl(MINIMAX_MESSAGES_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              'x-api-key': settings.apiKey,
            },
            body: frozenBody,
            redirect: 'manual',
            signal: limit.signal,
          });
        } catch (error) {
          const code = errorCode(error);
          if (!limit.timedOut() && !limit.callerAborted() && code !== undefined && notSentCodes.has(code))
            throw new ModelNotSentError(`NOT_CONNECTED_${code}`);
          throw uncertain(
            code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'CONNECTION_RESET' : 'TRANSPORT_OUTCOME_UNKNOWN',
          );
        }

        const status = response.status;
        if (status !== 200) {
          let detail: string | undefined;
          if (status >= 400) {
            try {
              detail = providerErrorCode(JSON.parse(decoder.decode(await readBounded(response, 16_384))));
            } catch {
              detail = undefined;
            }
          } else await discard(response);
          const code = `HTTP_${status}${detail === undefined ? '' : `_${detail}`}`;
          if (status === 502 || status === 504) throw new ModelOutcomeUnknownError(code);
          if (status >= 300 && status < 600) throw new ModelRejectedError(code);
          throw new ModelOutcomeUnknownError(code);
        }

        let bytes: Uint8Array;
        try {
          bytes = await readBounded(response, settings.maxReplyBytes);
        } catch (error) {
          if (error instanceof ReplyTooLargeError)
            return {
              usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null },
              answer: { kind: 'unreadable', code: 'REPLY_TOO_LARGE' },
            };
          throw uncertain('BODY_READ_INTERRUPTED');
        }
        const parsed = parseMessagesReply(decoder.decode(bytes), settings.model);
        if (parsed.kind === 'rejected') throw new ModelRejectedError(parsed.code, parsed.usage);
        return parsed.reply;
      } finally {
        limit.dispose();
      }
    },
  };
}
