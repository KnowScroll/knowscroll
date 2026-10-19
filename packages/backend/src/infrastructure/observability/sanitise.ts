/**
 * Sanitisation for diagnostics. Everything that leaves the process through `logEvent` passes
 * through these functions. They prefer dropping information to guessing what is safe.
 */

/** A sanitised error: class, optional stable code, stack frames and sanitised causes. Never the message. */
export interface SanitisedError {
  readonly errorClass: string;
  readonly code?: string;
  readonly frames: readonly string[];
  readonly cause?: SanitisedError;
}

const classPattern = /^[A-Za-z_$][\w$]{0,63}$/;
// Stable codes: our problem codes, Node codes (ECONNREFUSED, ERR_*) and PostgreSQL SQLSTATEs.
const codePattern = /^[A-Z0-9_]{2,64}$/;
const framePattern = /^\s+at\s/;
const MAX_FRAMES = 12;
const MAX_CAUSE_DEPTH = 3;
const MAX_FRAME_LENGTH = 300;

/**
 * Reduces any thrown value to class, code and stack frames. The message and any other property
 * are dropped: messages from drivers and SDKs can embed SQL, URLs, prompts or credentials.
 */
export function sanitiseError(value: unknown, depth = 0): SanitisedError {
  if (!(value instanceof Error)) {
    const kind =
      value === null ? 'null' : typeof value === 'object' ? 'NonErrorObject' : `Non${capitalise(typeof value)}`;
    // Some libraries emit plain objects copied from an error (pg-boss `error` events): keep the code.
    const plainCode: unknown =
      typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined;
    return {
      errorClass: kind,
      ...(typeof plainCode === 'string' && codePattern.test(plainCode) ? { code: plainCode } : {}),
      frames: [],
    };
  }
  const rawCode: unknown = (value as { code?: unknown }).code;
  const code = typeof rawCode === 'string' && codePattern.test(rawCode) ? rawCode : undefined;
  const frames = (value.stack ?? '')
    .split('\n')
    .filter((line) => framePattern.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => scrubText(shortenPaths(line.trim())).slice(0, MAX_FRAME_LENGTH));
  const cause =
    depth < MAX_CAUSE_DEPTH && value.cause !== undefined ? sanitiseError(value.cause, depth + 1) : undefined;
  return {
    errorClass: errorClassOf(value),
    ...(code === undefined ? {} : { code }),
    frames,
    ...(cause === undefined ? {} : { cause }),
  };
}

/** The most specific valid class name: the constructor (drivers often set `name` to "error"). */
function errorClassOf(error: Error): string {
  const constructorName = error.constructor.name;
  if (classPattern.test(constructorName) && constructorName !== 'Error') return constructorName;
  return typeof error.name === 'string' && classPattern.test(error.name) ? error.name : 'Error';
}

/** Keeps only the last two segments of file paths in a stack frame (no install paths or user names). */
function shortenPaths(frame: string): string {
  return frame.replace(/(?:file:\/\/)?(?:\/[^\s():/]+)*\/([^\s():/]+\/[^\s():/]+:\d+:\d+)/g, '$1');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const credentialParameter =
  /^(?:.*(?:token|secret|password|passwd|pwd|key|signature|sig|auth|credential|session|cookie|code|ticket|nonce)|x-amz-.*|expires)$/i;

/**
 * Returns a URL safe to record: credentials in the authority are removed, and the whole query
 * string is dropped when any parameter name looks like a credential (presigned URLs, magic
 * links, OAuth callbacks). Fragments are always dropped. Unparseable input becomes `[unparseable-url]`.
 */
export function sanitiseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input, 'http://relative.invalid');
  } catch {
    return '[unparseable-url]';
  }
  const relative = url.origin === 'http://relative.invalid';
  url.username = '';
  url.password = '';
  url.hash = '';
  const names = [...url.searchParams.keys()];
  if (names.some((name) => credentialParameter.test(name))) url.search = '';
  return relative ? `${url.pathname}${url.search}` : url.toString();
}

const textScrubbers: readonly (readonly [RegExp, string])[] = [
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
  // ?token=…&sig=… style parameters anywhere in text
  [
    /([?&;](?:[\w.-]*?(?:token|secret|password|passwd|key|signature|sig|auth|credential|session|code|ticket|nonce)|x-amz-[\w-]+|expires)=)[^&\s"'<>]*/gi,
    '$1[redacted]',
  ],
  // Cookie and session header values
  [/\b((?:set-)?cookie|session|sid)(\s*[:=]\s*)[^\s;,]+/gi, '$1$2[redacted]'],
  // Authorization header values
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  // JSON web tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  // Well-known key prefixes (OpenAI-style, GitHub, Slack, AWS)
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  // key=value / key: value pairs whose key names a credential
  [
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    '$1[redacted]',
  ],
  // Long opaque strings: likely tokens or keys (paths are shortened before this runs)
  [/[A-Za-z0-9+_=-]{40,}/g, '[redacted-opaque]'],
];

/** Removes credential-shaped substrings from free text (framework messages, stack frames). */
export function scrubText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of textScrubbers) result = result.replace(pattern, replacement);
  return result;
}
