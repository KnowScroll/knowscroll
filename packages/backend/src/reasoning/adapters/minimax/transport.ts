/**
 * What every MiniMax transport shares: which connection failures mean nothing left the machine, a bounded body read
 * and a deadline joined to the caller's signal. No transport retries; the attempt ledger decides whether to send again.
 */

/** Connection failures that happen before any request byte can have reached the provider. */
export const notSentCodes: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** The first `code` in an error's cause chain (undici puts it on `cause`). */
export function errorCode(error: unknown, depth = 0): string | undefined {
  if (typeof error !== 'object' || error === null || depth > 4) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return errorCode((error as { cause?: unknown }).cause, depth + 1);
}

export class ReplyTooLargeError extends Error {
  override readonly name = 'ReplyTooLargeError';
}

/** Reads at most `limit` bytes of a body; cancels the stream and throws `ReplyTooLargeError` beyond it. */
export async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ReplyTooLargeError('reply exceeds its bound');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Discards a body without reading more than a little of it. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** A deadline and the caller's signal, combined; `timedOut` tells which one fired. */
export interface Deadline {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  callerAborted(): boolean;
  dispose(): void;
}

export function deadline(signal: AbortSignal, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    callerAborted: () => signal.aborted,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}
