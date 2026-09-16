import {createHash} from 'node:crypto';
import {generateText, stepCountIs} from 'ai';
import {createMinimax} from 'vercel-minimax-ai-provider';

import {
  CERTIFICATION_LIMITS,
  type CertificationObservation,
  type CertificationRequest,
  type Json,
  type MiniMaxCertificationAdapter,
  type MiniMaxCertificationOptions,
} from './certification-contract.js';

const MODEL = 'MiniMax-M3';
const DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic/v1';

type RawResponse = {
  id?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  usage?: unknown;
};

type CapturedTransport = {
  dispatched: boolean;
  httpStatus: number | null;
  requestHash: string | null;
  rawResponse: RawResponse | null;
};

const emptyUsage = () => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
});

function nullableToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageFrom(raw: RawResponse | null): CertificationObservation['usage'] {
  if (raw?.usage === null || typeof raw?.usage !== 'object' || Array.isArray(raw.usage)) {
    return emptyUsage();
  }
  const usage = raw.usage as Record<string, unknown>;
  return {
    inputTokens: nullableToken(usage.input_tokens),
    outputTokens: nullableToken(usage.output_tokens),
    cacheReadTokens: nullableToken(usage.cache_read_input_tokens),
    cacheWriteTokens: nullableToken(usage.cache_creation_input_tokens),
    costUsd: null,
  };
}

function nativeContentFrom(raw: RawResponse | null): {[key: string]: Json}[] {
  if (!Array.isArray(raw?.content)) return [];
  return raw.content.filter(
    (part): part is {[key: string]: Json} => part !== null && typeof part === 'object' && !Array.isArray(part),
  );
}

function providerRequestIdFrom(raw: RawResponse | null, apiKey: string): string | null {
  const id = raw?.id;
  if (typeof id !== 'string' || id === apiKey || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) return null;
  return id;
}

function stopReasonFrom(raw: RawResponse | null): string | null {
  return typeof raw?.stop_reason === 'string' && raw.stop_reason.length <= 128 ? raw.stop_reason : null;
}

function observation(
  outcome: CertificationObservation['outcome'],
  transport: CapturedTransport,
  apiKey: string,
  text = '',
): CertificationObservation {
  const completed = outcome === 'completed';
  return {
    outcome,
    dispatched: transport.dispatched,
    httpStatus: transport.httpStatus,
    requestHash: transport.requestHash,
    providerRequestId: completed ? providerRequestIdFrom(transport.rawResponse, apiKey) : null,
    usage: usageFrom(transport.rawResponse),
    nativeContent: completed ? nativeContentFrom(transport.rawResponse) : [],
    text: completed ? text : '',
    stopReason: completed ? stopReasonFrom(transport.rawResponse) : null,
  };
}

function parseRawResponse(text: string): RawResponse | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RawResponse) : null;
  } catch {
    return null;
  }
}

function responseForSdk(rawText: string, response: Response): Response {
  return new Response(rawText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function hasValidOutputLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= CERTIFICATION_LIMITS.maxOutputTokens;
}

export function createMiniMaxCertificationAdapter(
  options: MiniMaxCertificationOptions,
): MiniMaxCertificationAdapter {
  const transportFetch = options.fetch ?? globalThis.fetch;
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;

  return {
    async invoke(request: CertificationRequest): Promise<CertificationObservation> {
      const transport: CapturedTransport = {
        dispatched: false,
        httpStatus: null,
        requestHash: null,
        rawResponse: null,
      };

      const {beforeDispatch, deadline, maxOutputTokens, signal, thinking} = request;
      let nativeMessages: CertificationRequest['messages'];
      let nativeTools: CertificationRequest['tools'];
      try {
        // Snapshot the charged request synchronously. Caller mutation while the
        // reservation is being persisted cannot alter the later wire body.
        nativeMessages = structuredClone(request.messages);
        nativeTools = request.tools === undefined ? undefined : structuredClone(request.tools);
      } catch {
        return observation('not_dispatched', transport, options.apiKey);
      }

      if (!hasValidOutputLimit(maxOutputTokens)) {
        return observation('not_dispatched', transport, options.apiKey);
      }
      if (signal.aborted) {
        return observation('aborted', transport, options.apiKey);
      }

      const deadlineMs = Date.parse(deadline);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
        return observation('timeout', transport, options.apiKey);
      }

      let abortKind: 'aborted' | 'timeout' | null = null;
      const controller = new AbortController();
      const onCallerAbort = () => {
        abortKind = 'aborted';
        controller.abort(signal.reason);
      };
      signal.addEventListener('abort', onCallerAbort, {once: true});
      const timeoutMs = Math.min(deadlineMs - Date.now(), CERTIFICATION_LIMITS.requestTimeoutMs);
      const timeout = setTimeout(() => {
        if (!controller.signal.aborted) {
          abortKind = 'timeout';
          controller.abort(new DOMException('Certification deadline reached', 'TimeoutError'));
        }
      }, timeoutMs);

      let fetchCalls = 0;
      const guardedFetch: typeof fetch = async (input, init) => {
        fetchCalls += 1;
        if (fetchCalls !== 1) throw new Error('Certification transport called more than once');
        if (typeof init?.body !== 'string') throw new Error('Certification request body is not serialized JSON');

        const generated: unknown = JSON.parse(init.body);
        if (generated === null || typeof generated !== 'object' || Array.isArray(generated)) {
          throw new Error('Certification request body is not an object');
        }
        const body: Record<string, unknown> = {
          ...(generated as Record<string, unknown>),
          model: MODEL,
          messages: nativeMessages,
          max_tokens: maxOutputTokens,
          thinking: {type: thinking},
        };
        if (nativeTools === undefined) delete body.tools;
        else {
          body.tools = nativeTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          }));
        }

        const serialized = JSON.stringify(body);
        const inputBytes = Buffer.byteLength(serialized, 'utf8');
        transport.requestHash = createHash('sha256').update(serialized).digest('hex');
        if (inputBytes > CERTIFICATION_LIMITS.maxInputBytes) {
          throw new RangeError('Certification request exceeds byte limit');
        }

        await beforeDispatch({
          requestHash: transport.requestHash,
          inputBytes,
          maxOutputTokens,
        });

        if (signal.aborted) {
          abortKind = 'aborted';
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        if (Date.now() >= deadlineMs || controller.signal.aborted) {
          if (abortKind === null) abortKind = 'timeout';
          throw controller.signal.reason ?? new DOMException('Deadline reached', 'TimeoutError');
        }

        transport.dispatched = true;
        const response = await transportFetch(input, {
          ...init,
          body: serialized,
          signal: controller.signal,
          redirect: 'manual',
        });
        transport.httpStatus = response.status;
        const rawText = await response.text();
        transport.rawResponse = parseRawResponse(rawText);
        return responseForSdk(rawText, response);
      };

      try {
        const provider = createMinimax({apiKey: options.apiKey, baseURL, fetch: guardedFetch});
        const result = await generateText({
          model: provider(MODEL),
          messages: [{role: 'user', content: 'certification transport fixture'}],
          maxOutputTokens,
          maxRetries: 0,
          stopWhen: stepCountIs(1),
          abortSignal: controller.signal,
        });
        return observation('completed', transport, options.apiKey, result.text);
      } catch {
        if (abortKind === 'aborted' || signal.aborted) {
          return observation('aborted', transport, options.apiKey);
        }
        if (abortKind === 'timeout' || Date.now() >= deadlineMs) {
          return observation('timeout', transport, options.apiKey);
        }
        if (!transport.dispatched) {
          return observation('not_dispatched', transport, options.apiKey);
        }
        if (transport.httpStatus !== null && (transport.httpStatus < 200 || transport.httpStatus >= 300)) {
          return observation('http_error', transport, options.apiKey);
        }
        if (transport.httpStatus !== null) {
          return observation('invalid_response', transport, options.apiKey);
        }
        return observation('transport_error', transport, options.apiKey);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
