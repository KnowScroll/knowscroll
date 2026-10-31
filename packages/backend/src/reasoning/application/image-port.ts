/**
 * The transport behind one painted image (D-166). It is not a model call: it returns pixels, not an answer to parse,
 * so it has no role, schema or repair. Its caller owns the attempt ledger and the money rule; this port sends one
 * request, once, and says only what happened.
 */

/** The image types a backdrop may be stored as. */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageRequest {
  readonly prompt: string;
}

/**
 * What one request came to. `not_sent` means nothing left the machine; `rejected` that the provider refused with one of
 * the refusals it documents as coming before an image is made, so nothing was charged (a rate limit, authentication,
 * balance, a blocked prompt, bad parameters); `unknown` that the request may have been processed and billed (a timeout,
 * a reset, HTTP 408 or a 5xx, a status the documentation does not list, a success with no image, an image blocked by
 * content safety after it was generated), so the caller keeps its charge and never sends it again blind. `unusable` is an
 * image the provider made that is not one of the allowed types: it was produced, so it was paid for.
 */
export type ImageOutcome =
  | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly mime: ImageMime }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'not_sent'; readonly code: string }
  | { readonly kind: 'unknown'; readonly code: string }
  | { readonly kind: 'unusable'; readonly code: string };

export interface ImagePort {
  readonly provider: 'minimax';
  readonly model: string;
  /** The deadline of one request; an attempt still dispatched well past it has an unknown outcome. */
  readonly requestTimeoutMs: number;
  /** Sends the request once. Never throws for a provider outcome; refuses to run inside a database transaction. */
  generate(request: ImageRequest, signal: AbortSignal): Promise<ImageOutcome>;
}
