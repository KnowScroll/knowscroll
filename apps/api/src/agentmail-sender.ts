/**
 * ADR-0027 — AgentMail delivers the real magic-link email. Implements the same `MagicLinkSender`
 * port `magic-link-sender.ts` already defines for `DevelopmentMagicLinkSink`; `createMagicLinkSender()`
 * there is the only place that constructs this class for real use.
 *
 * One POST, one attempt: a bounded timeout, a bounded response read, no automatic retry and no
 * redirect following (ADR-0027 section 1 — a retry is the person asking for another link, and a
 * silent resend would mint a second live token). `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` are
 * read only from the environment object this module's caller passes in — never sought elsewhere,
 * never written to a log, an error, a receipt or any file. `to`, the token and the link travel only
 * in the one outbound request body; nothing here persists or logs any of them (mirroring
 * `DevelopmentMagicLinkSink`, which never logs `to` either).
 */
import type { MagicLinkSender } from './magic-link-sender.ts';

/** The real AgentMail host every non-test caller reaches. Overridable — via the `baseUrl`
 * constructor option, which `createMagicLinkSender()` wires to `AGENTMAIL_BASE_URL` — for exactly
 * one reason: pointing this sender at a local fake HTTP server in tests. No test may exercise the
 * default; every test constructs this class with an explicit `baseUrl` naming its own fixture. */
const DEFAULT_BASE_URL = 'https://api.agentmail.to';

/** Bounded per ADR-0027 section 1: generously above a normal AgentMail round trip while still
 * failing well inside the sign-in route's own request lifecycle instead of hanging it. Documented
 * for operators in docs/operations/magic-link-delivery.md. */
export const AGENTMAIL_TIMEOUT_MS = 10_000;

/** The real response body is a two-field JSON object; this is far more than AgentMail has ever
 * needed and stops a misbehaving or hostile endpoint from forcing this process to buffer an
 * unbounded response (same discipline as `apps/worker/src/cutroom/http-client.ts`'s `readBody`). */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type AgentMailFailureReason = 'http_error' | 'timeout' | 'network_error' | 'malformed_response';

/**
 * Everything this module ever throws. Deliberately carries only fields safe to hand an operator: an
 * HTTP status (when one was received), a short fixed-vocabulary reason and the provider's own
 * message id (when a response supplied one) — never the recipient address, the token, the link or
 * the key, and never a raw provider response body. `describeSendFailure()` below is the one place
 * that turns *any* thrown value into that same closed shape, so a caller never has to trust that
 * everything reaching its `catch` block is one of these.
 */
export class AgentMailSendError extends Error {
  readonly httpStatus: number | null;
  readonly reason: AgentMailFailureReason;
  readonly messageId: string | null;

  constructor(reason: AgentMailFailureReason, httpStatus: number | null = null, messageId: string | null = null) {
    super(`AgentMail send failed: ${reason}`);
    this.name = 'AgentMailSendError';
    this.httpStatus = httpStatus;
    this.reason = reason;
    this.messageId = messageId;
  }
}

export interface SendFailureLogFields {
  httpStatus: number | null;
  reason: AgentMailFailureReason | 'unknown';
  messageId: string | null;
}

/**
 * The one function that turns a caught delivery failure into the shape an operator log may
 * actually carry. Defensive by construction — it never reads `.message` (or anything else) off an
 * arbitrary error, so a thrown value this module did not produce (a bug, a future refactor, an
 * unrelated sender) degrades to the same opaque `{httpStatus:null,reason:'unknown',messageId:null}`
 * rather than ever risking a leak through this path.
 */
export function describeSendFailure(error: unknown): SendFailureLogFields {
  if (error instanceof AgentMailSendError) {
    return { httpStatus: error.httpStatus, reason: error.reason, messageId: error.messageId };
  }
  return { httpStatus: null, reason: 'unknown', messageId: null };
}

export interface AgentMailSenderOptions {
  apiKey: string;
  inboxId: string;
  /** Purely so a test can point this sender at a local fake HTTP server; every real caller omits
   * this and reaches `DEFAULT_BASE_URL`. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Test-only seam for injecting a fetch that never resolves, to exercise the timeout path
   * without an actual multi-second wait. Never used by `createMagicLinkSender()`. */
  fetchImpl?: typeof fetch;
}

interface ParsedSendResponse {
  messageId: string;
  threadId: string | null;
}

/** Reads at most `MAX_RESPONSE_BYTES`. Returns `null` — never throws — for a declared or actual
 * body over that bound, so an oversized or hostile response becomes an ordinary malformed-response
 * failure rather than an unbounded memory read. */
async function readBoundedText(response: Response): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    return null;
  }
}

function parseSendResponse(raw: string | null): ParsedSendResponse | null {
  if (raw === null || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message_id !== 'string' || record.message_id.length === 0) return null;
  return { messageId: record.message_id, threadId: typeof record.thread_id === 'string' ? record.thread_id : null };
}

/** Best-effort extraction of a message id from an error-status body, purely as extra debugging
 * context for the operator; a body that does not parse simply yields `null` here rather than ever
 * surfacing raw response text. */
function messageIdFromErrorBody(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).message_id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  } catch {
    // Malformed error body: no message id to report, and nothing else in `raw` is ever logged.
  }
  return null;
}

function requestBody(to: string, link: string): string {
  const subject = 'Your KnowScroll sign-in link';
  const text = `Use this link to sign in to KnowScroll:\n\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, ignore this message.`;
  const html = `<p>Use this link to sign in to KnowScroll:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes and can be used once. If you did not request it, ignore this message.</p>`;
  return JSON.stringify({ to, subject, text, html });
}

/**
 * `MagicLinkSender` backed by AgentMail (ADR-0027): `POST /v0/inboxes/{inbox}/messages/send` with
 * `Authorization: Bearer <key>` and a strict `{to,subject,text,html}` body. One attempt, a bounded
 * timeout, a bounded response read, no retry, no redirect following (`redirect:'manual'` — a
 * redirect is never trusted or followed, and surfaces as an ordinary non-2xx failure). Never
 * persists or logs `to` beyond the one outbound request (mirroring `DevelopmentMagicLinkSink`); a
 * successful send's `message_id`/`thread_id` are recorded only as this instance's own delivery
 * metadata (`lastDelivery`, a test/operator-only accessor exactly like `DevelopmentMagicLinkSink
 * .sinkPath`) — never evidence that anybody read the mail.
 */
export class AgentMailSender implements MagicLinkSender {
  private readonly apiKey: string;
  private readonly inboxId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastDeliveryMetadata: ParsedSendResponse | null = null;

  constructor(options: AgentMailSenderOptions) {
    this.apiKey = options.apiKey;
    this.inboxId = options.inboxId;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? AGENTMAIL_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Test/operator-only accessor for the most recent successful send's provider metadata; a real
   * deployment never exposes this over HTTP. `null` until a send has succeeded at least once. */
  get lastDelivery(): ParsedSendResponse | null {
    return this.lastDeliveryMetadata;
  }

  async send(input: { to: string; link: string }): Promise<void> {
    const body = requestBody(input.to, input.link);
    const url = `${this.baseUrl}/v0/inboxes/${encodeURIComponent(this.inboxId)}/messages/send`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });
    } catch {
      if (controller.signal.aborted) throw new AgentMailSendError('timeout');
      throw new AgentMailSendError('network_error');
    } finally {
      clearTimeout(timer);
    }

    const raw = await readBoundedText(response);
    if (response.status < 200 || response.status >= 300) {
      throw new AgentMailSendError('http_error', response.status, messageIdFromErrorBody(raw));
    }
    const parsed = parseSendResponse(raw);
    if (!parsed) throw new AgentMailSendError('malformed_response', response.status);
    this.lastDeliveryMetadata = parsed;
  }
}
