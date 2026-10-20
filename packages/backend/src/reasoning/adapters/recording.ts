import { createHash } from 'node:crypto';
import { sanitiseUrl } from '../../infrastructure/observability/sanitise.js';

/**
 * The recording boundary for provider-returned values (CF-10, providers-and-secrets.md): a
 * provider answer can carry a third party's live credential, such as a presigned URL. Before
 * anything from an answer is stored or handed to a role, every string in it is cleaned:
 *
 * - URLs keep their scheme, host and path; userinfo and fragments are dropped, and the whole
 *   query string is dropped when any parameter name looks like a credential (`sanitiseUrl`).
 *   That covers `http(s)://…`, other schemes (`s3://`, `oss://`, `gs://`) and scheme-less
 *   `//host/path?…` references.
 * - Key- and token-shaped values are masked: `sk-`/`pk-`/`rk-` keys, JWTs, GitHub and Slack
 *   tokens, AWS access key IDs and `Bearer …` values.
 *
 * Ordinary prose is left alone (no broad "long opaque string" rule: that would alter content).
 */
const urlPatterns: readonly (readonly [RegExp, (url: string) => string])[] = [
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>\\]+/gi, (url) => sanitiseUrl(url)],
  // A scheme-relative reference (`//host.example/path?x`); the host needs a dot, so a comment
  // marker or a path fragment is not mistaken for one.
  [/(?<![\w:/.])\/\/[A-Za-z0-9-]+\.[^\s"'<>\\]+/g, (url) => sanitiseUrl(`https:${url}`).replace(/^https:/, '')],
];
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
  let result = text;
  for (const [pattern, clean] of urlPatterns) result = result.replace(pattern, clean);
  for (const [pattern, replacement] of keyPatterns) result = result.replace(pattern, replacement);
  return result;
}

/**
 * Deepest container nesting `redactRecorded` copies. The harness refuses deeper answers before
 * they reach this function (`OUTPUT_TOO_DEEP`); if a deeper value ever arrives anyway, the subtree
 * is REPLACED by `REDACTED_TOO_DEEP`, never passed through, so nothing below the bound can be
 * stored or returned unredacted.
 */
export const MAX_REDACTION_DEPTH = 64;

/** What replaces a subtree nested deeper than `MAX_REDACTION_DEPTH`. */
export const REDACTED_TOO_DEEP = '[redacted-too-deep]';

interface Frame {
  readonly source: object;
  readonly target: Record<string, unknown> | unknown[];
  /** Nesting level of `source` (the root is 1). */
  readonly depth: number;
}

/**
 * Cleans every string (keys and values) in a JSON object parsed from a provider answer, at every
 * depth. Iterative (an explicit stack), so hostile nesting cannot overflow the call stack; beyond
 * `MAX_REDACTION_DEPTH` a subtree is replaced, not copied.
 */
export function redactRecorded(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ source: value, target: root, depth: 1 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { source, target, depth } = frame;
    const entries: [string | number, unknown][] = Array.isArray(source)
      ? source.map((item, index): [number, unknown] => [index, item])
      : Object.entries(source);
    for (const [name, item] of entries) {
      let cleaned: unknown;
      if (typeof item === 'string') cleaned = redactProviderText(item);
      else if (typeof item !== 'object' || item === null) cleaned = item;
      else if (depth >= MAX_REDACTION_DEPTH) cleaned = REDACTED_TOO_DEEP;
      else {
        cleaned = Array.isArray(item) ? [] : {};
        stack.push({ source: item, target: cleaned as Record<string, unknown> | unknown[], depth: depth + 1 });
      }
      if (Array.isArray(target)) target[name as number] = cleaned;
      else
        // defineProperty, not assignment: a JSON key named `__proto__` stays an own data property.
        Object.defineProperty(target, redactProviderText(String(name)), {
          value: cleaned,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  return root;
}

/** SHA-256 of request bytes, lowercase hex (the attempt's request hash). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
