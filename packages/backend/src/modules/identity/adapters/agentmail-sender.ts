import { assertOutsideTransaction } from '../../../infrastructure/postgres/transaction-marker.js';
import type { MailDelivery, MailSender, SignInMail } from '../application/ports.js';
import { SIGN_IN_LINK_TTL_MINUTES } from '../domain/policy.js';

/** A real send answers with a two-field JSON object; anything near this size is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface AgentMailOptions {
  /** A credential: passed only in the `Authorization` header of the one request. */
  readonly apiKey: string;
  readonly inboxId: string;
  /** `https://api.agentmail.to` in production (configuration refuses another base there). */
  readonly baseUrl: string;
  /** Covers the whole exchange, response body included. */
  readonly timeoutMs: number;
  /** Test seam only; the composition root never passes it. */
  readonly fetch?: typeof fetch;
}

/** The message: plain text and a minimal HTML part, both carrying the link (and nothing else personal). */
function messageBody(mail: SignInMail): string {
  const lines = [
    'Use this link to sign in to KnowScroll:',
    '',
    mail.link,
    '',
    `It works once and expires in ${SIGN_IN_LINK_TTL_MINUTES} minutes. If you did not ask for it, ignore this message; nothing changes.`,
  ];
  const escaped = mail.link.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const html =
    `<p>Use this link to sign in to KnowScroll:</p><p><a href="${escaped}">Sign in to KnowScroll</a></p>` +
    `<p>It works once and expires in ${SIGN_IN_LINK_TTL_MINUTES} minutes. If you did not ask for it, ignore this message; nothing changes.</p>`;
  return JSON.stringify({ to: mail.to, subject: 'Your KnowScroll sign-in link', text: lines.join('\n'), html });
}

/** Reads at most `MAX_RESPONSE_BYTES`; `undefined` for a larger or non-UTF-8 body. */
async function readBounded(response: Response): Promise<string | undefined> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    return undefined;
  }
}

function hasMessageId(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const id: unknown = (value as { message_id?: unknown }).message_id;
    return typeof id === 'string' && id.length > 0;
  } catch {
    return false;
  }
}

/**
 * The AgentMail `MailSender` (`docs/v2/operations/providers-and-secrets.md`, CF-40): exactly one
 * `POST {base}/v0/inboxes/{inbox}/messages/send` with `Authorization: Bearer <key>` and
 * `{to, subject, text, html}`; no retry; no redirect following (a 3xx is a failure); the timeout
 * covers the body; at most 64 KiB of response is read; success only for a 2xx whose JSON body
 * carries a `message_id`. Never throws: every failure becomes a fixed reason (with the HTTP status
 * when one arrived). The address, link and key never leave the request; nothing is logged here.
 * Refuses to run inside a database transaction.
 */
export function agentMailSender(options: AgentMailOptions): MailSender {
  const fetchImplementation = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v0/inboxes/${encodeURIComponent(options.inboxId)}/messages/send`;
  return async (mail): Promise<MailDelivery> => {
    try {
      assertOutsideTransaction('agentmail');
    } catch {
      return { kind: 'failed', reason: 'refused_in_transaction' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: messageBody(mail),
        });
      } catch {
        return { kind: 'failed', reason: controller.signal.aborted ? 'timeout' : 'network_error' };
      }
      let raw: string | undefined;
      try {
        raw = await readBounded(response);
      } catch {
        return {
          kind: 'failed',
          reason: controller.signal.aborted ? 'timeout' : 'network_error',
          status: response.status,
        };
      }
      if (response.status < 200 || response.status >= 300)
        return { kind: 'failed', reason: 'http_error', status: response.status };
      if (!hasMessageId(raw)) return { kind: 'failed', reason: 'malformed_response', status: response.status };
      return { kind: 'sent' };
    } finally {
      clearTimeout(timer);
    }
  };
}
