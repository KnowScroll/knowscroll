import { createHash } from 'node:crypto';
import { sanitiseUrl } from '../../infrastructure/observability/sanitise.js';

/**
 * The recording boundary for provider-returned values (CF-10, providers-and-secrets.md): a
 * provider answer can carry a third party's live credential, such as a presigned URL. Before
 * anything from an answer is stored or handed to a role, every string in it is cleaned:
 *
 * - URLs keep their scheme, host and path; userinfo and fragments are dropped, and the whole
 *   query string is dropped when any parameter name looks like a credential (`sanitiseUrl`).
 * - Key- and token-shaped values are masked: `sk-`/`pk-`/`rk-` keys, JWTs, GitHub and Slack
 *   tokens, AWS access key IDs and `Bearer …` values.
 *
 * Ordinary prose is left alone (no broad "long opaque string" rule: that would alter content).
 */
const urlPattern = /\bhttps?:\/\/[^\s"'<>\\]+/gi;
const keyPatterns: readonly (readonly [RegExp, string])[] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
];

/** Cleans one provider-returned string (see the module comment). */
export function redactProviderText(text: string): string {
  let result = text.replace(urlPattern, (url) => sanitiseUrl(url));
  for (const [pattern, replacement] of keyPatterns) result = result.replace(pattern, replacement);
  return result;
}

const MAX_DEPTH = 32;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactProviderText(value);
  if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  // defineProperty, not assignment: a JSON key named `__proto__` stays an own data property.
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(result, redactProviderText(key), {
      value: redactValue(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}

/** Cleans every string (keys and values) in a JSON object parsed from a provider answer. */
export function redactRecorded(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactValue(value, 0) as Record<string, unknown>;
}

/** SHA-256 of request bytes, lowercase hex (the attempt's request hash). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
