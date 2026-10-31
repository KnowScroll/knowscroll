import { z } from 'zod';
import type { ImageMime, ImageOutcome, ImagePort } from '../../application/image-port.js';
import { ReplyTooLargeError, deadline, discard, errorCode, notSentCodes, readBounded } from './transport.js';

/** The fixed image route (no endpoint override). Documented at platform.minimax.io/docs/api-reference/image-generation-t2i. */
export const MINIMAX_IMAGE_URL = 'https://api.minimax.io/v1/image_generation';
export const MINIMAX_IMAGE_MODEL = 'image-01';

export interface MiniMaxImageSettings {
  /** The same token-plan key as the text transport. A credential: sent only in a header, never logged or stored. */
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  /** Largest response body read. A base64 image of a wide band is a few hundred KB; this leaves room. */
  readonly maxReplyBytes: number;
}

/** The reply's fields that matter, tolerant of the provider sending counts as strings. */
const ReplySchema = z.object({
  data: z.object({ image_base64: z.array(z.string()).optional() }).nullish(),
  metadata: z
    .object({ success_count: z.coerce.number().optional(), failed_count: z.coerce.number().optional() })
    .nullish(),
  base_resp: z.object({ status_code: z.number().int() }),
});

const decoder = new TextDecoder('utf-8', { fatal: false });

/** The type of an image from its first bytes; a file name or a header the provider sent is never trusted. */
export function imageMimeOf(bytes: Uint8Array): ImageMime | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte))
    return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

function outcomeOfReply(text: string): ImageOutcome {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'unknown', code: 'REPLY_UNREADABLE' };
  }
  const reply = ReplySchema.safeParse(json);
  if (!reply.success) return { kind: 'unknown', code: 'REPLY_UNREADABLE' };
  const { base_resp: status, data, metadata } = reply.data;
  // A non-zero status is the provider saying it made nothing: rate limit, balance, a blocked prompt, bad parameters.
  if (status.status_code !== 0) return { kind: 'rejected', code: `PROVIDER_${String(status.status_code)}` };
  const encoded = data?.image_base64?.[0];
  if (encoded === undefined || encoded === '')
    return (metadata?.failed_count ?? 0) > 0
      ? { kind: 'rejected', code: 'BLOCKED_BY_SAFETY' }
      : { kind: 'unknown', code: 'SUCCESS_WITHOUT_IMAGE' };
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  const mime = imageMimeOf(bytes);
  return mime === undefined ? { kind: 'unusable', code: 'IMAGE_NOT_RECOGNISED' } : { kind: 'image', bytes, mime };
}

/**
 * The MiniMax image transport behind `ImagePort` (D-166): one `fetch`, no SDK, no retries, `redirect: "manual"`, one
 * deadline over the whole exchange and a bounded body read. The picture is requested inline (base64), so no second
 * request fetches a presigned address. The wide band ratio is fixed (21:9). Mapping: a refused connection or a failed
 * DNS or TLS handshake means nothing was sent; a timeout, reset or interrupted read after the request left, and a 502
 * or 504, mean the outcome is unknown; any other non-200 status, and a non-zero provider status, are conclusive
 * refusals. The key is sent only in a header. Nothing here logs.
 */
export function makeMiniMaxImagePort(settings: MiniMaxImageSettings, fetchImpl: typeof fetch = fetch): ImagePort {
  if (!settings.apiKey.startsWith('sk-cp-')) throw new Error('MiniMax: only a token-plan (sk-cp-) key is accepted');
  return {
    provider: 'minimax',
    model: MINIMAX_IMAGE_MODEL,
    requestTimeoutMs: settings.requestTimeoutMs,
    async generate(request, signal) {
      if (signal.aborted) return { kind: 'not_sent', code: 'ABORTED_BEFORE_DISPATCH' };
      const body = JSON.stringify({
        model: MINIMAX_IMAGE_MODEL,
        prompt: request.prompt,
        aspect_ratio: '21:9',
        response_format: 'base64',
        n: 1,
        prompt_optimizer: false,
      });
      const limit = deadline(signal, settings.requestTimeoutMs);
      const uncertain = (fallback: string): ImageOutcome => ({
        kind: 'unknown',
        code: limit.timedOut() ? 'TIMEOUT_AFTER_DISPATCH' : limit.callerAborted() ? 'ABORTED_AFTER_DISPATCH' : fallback,
      });
      try {
        let response: Response;
        try {
          response = await fetchImpl(MINIMAX_IMAGE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
            body,
            redirect: 'manual',
            signal: limit.signal,
          });
        } catch (error) {
          const code = errorCode(error);
          if (!limit.timedOut() && !limit.callerAborted() && code !== undefined && notSentCodes.has(code))
            return { kind: 'not_sent', code: `NOT_CONNECTED_${code}` };
          return uncertain(
            code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'CONNECTION_RESET' : 'TRANSPORT_OUTCOME_UNKNOWN',
          );
        }
        if (response.status !== 200) {
          await discard(response);
          return response.status === 502 || response.status === 504
            ? { kind: 'unknown', code: `HTTP_${String(response.status)}` }
            : { kind: 'rejected', code: `HTTP_${String(response.status)}` };
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBounded(response, settings.maxReplyBytes);
        } catch (error) {
          return error instanceof ReplyTooLargeError
            ? { kind: 'unknown', code: 'REPLY_TOO_LARGE' }
            : uncertain('BODY_READ_INTERRUPTED');
        }
        return outcomeOfReply(decoder.decode(bytes));
      } finally {
        limit.dispose();
      }
    },
  };
}
