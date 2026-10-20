import type { z } from 'zod';

/**
 * Strict output handling for model answers (blueprint §15 "strictly validate the structured
 * proposal"): exactly one JSON object, bare or in one fenced block, then the role's schema. A
 * malformed answer is recorded and rejected; nothing here guesses a valid proposal from it.
 */

/** Largest answer text considered for extraction (UTF-16 code units, a cheap pre-parse bound). */
export const MAX_ANSWER_CHARS = 262_144;

/** Why an answer is not usable. Stable codes, recorded on the attempt as its outcome code. */
export type InvalidOutputReason =
  | 'OUTPUT_EMPTY'
  | 'OUTPUT_NOT_ONE_JSON_OBJECT'
  | 'OUTPUT_SCHEMA_MISMATCH'
  | 'OUTPUT_TRUNCATED'
  | 'OUTPUT_TOO_LARGE'
  | 'REPLY_UNREADABLE';

export type Extraction =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: 'OUTPUT_EMPTY' | 'OUTPUT_NOT_ONE_JSON_OBJECT' | 'OUTPUT_TOO_LARGE' };

const fencePattern = /^```[A-Za-z0-9_-]{0,16}[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Extracts exactly one JSON object from an answer. Accepted forms, after trimming whitespace: a
 * bare JSON object, or one fenced block (```json … ```) containing one. Anything else — prose
 * around the object, two objects, an array, a scalar, a second fence — is refused. Pure.
 */
export function extractJsonObject(text: string): Extraction {
  if (text.length > MAX_ANSWER_CHARS) return { ok: false, reason: 'OUTPUT_TOO_LARGE' };
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'OUTPUT_EMPTY' };
  let candidate = trimmed;
  if (trimmed.startsWith('```')) {
    const fenced = fencePattern.exec(trimmed);
    if (fenced === null) return { ok: false, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
    candidate = (fenced[1] ?? '').trim();
    if (candidate.includes('```')) return { ok: false, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
  }
  if (!candidate.startsWith('{') || !candidate.endsWith('}'))
    return { ok: false, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { ok: false, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT' };
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * One validator finding, as sent back to the model in a repair request and kept on the attempt.
 * Built from the schema issue's structure (path, code, expectation), never from its message.
 */
export interface OutputIssue {
  readonly path: string;
  readonly code: string;
  readonly detail?: string;
}

/** Most issues kept; the rest are counted in a final `more` entry. */
export const MAX_ISSUES = 8;

const safeSegment = /^[A-Za-z0-9_-]{1,32}$/;

function pathOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .slice(0, 6)
    .map((segment) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : typeof segment === 'string' && safeSegment.test(segment)
          ? segment
          : '?',
    )
    .join('.')
    .replaceAll('.[', '[');
}

function primitiveList(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined;
  const shown = values
    .slice(0, 5)
    .filter((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map((value) => (typeof value === 'string' && !safeSegment.test(value) ? '?' : String(value)));
  return shown.length === 0 ? undefined : shown.join(', ');
}

function detailOf(issue: Readonly<Record<string, unknown>>): string | undefined {
  switch (issue['code']) {
    case 'invalid_type':
      return typeof issue['expected'] === 'string' ? `expected ${issue['expected']}` : undefined;
    case 'too_big':
      return typeof issue['maximum'] === 'number' ? `maximum ${issue['maximum']}` : undefined;
    case 'too_small':
      return typeof issue['minimum'] === 'number' ? `minimum ${issue['minimum']}` : undefined;
    case 'unrecognized_keys': {
      const keys = primitiveList(issue['keys']);
      return keys === undefined ? 'unexpected keys' : `unexpected keys: ${keys}`;
    }
    case 'invalid_value': {
      const values = primitiveList(issue['values']);
      return values === undefined ? undefined : `allowed: ${values}`;
    }
    case 'invalid_format':
      return typeof issue['format'] === 'string' && safeSegment.test(issue['format'])
        ? `format ${issue['format']}`
        : undefined;
    default:
      return undefined;
  }
}

/** Whether `path` names a member the value does not have (a missing required field). */
function isAbsent(value: unknown, path: readonly PropertyKey[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return true;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return false;
}

/**
 * Summarises schema issues for the model and the ledger. Bounded (`MAX_ISSUES`), structural only:
 * paths keep simple keys and indexes (anything else becomes `?`), details come from the schema's
 * expectations (types, bounds, allowed literals), never from the issue message or received values.
 * A type issue at a path the answer does not have is reported as `missing` (a required field).
 */
export function summariseIssues(issues: readonly z.core.$ZodIssue[], value?: unknown): readonly OutputIssue[] {
  const summary: OutputIssue[] = issues.slice(0, MAX_ISSUES).map((issue) => {
    const record = issue as unknown as Readonly<Record<string, unknown>>;
    const detail = detailOf(record);
    if (
      record['code'] === 'invalid_type' &&
      issue.path.length > 0 &&
      value !== undefined &&
      isAbsent(value, issue.path)
    )
      return {
        path: pathOf(issue.path),
        code: 'missing',
        detail: `required${detail === undefined ? '' : `; ${detail}`}`,
      };
    const code = typeof record['code'] === 'string' && safeSegment.test(record['code']) ? record['code'] : 'invalid';
    return { path: pathOf(issue.path), code, ...(detail === undefined ? {} : { detail }) };
  });
  if (issues.length > MAX_ISSUES)
    summary.push({ path: '(root)', code: 'more', detail: `${issues.length - MAX_ISSUES} more` });
  return summary;
}

/** The validator's verdict on one answer. */
export type OutputVerdict<T> =
  | { readonly valid: true; readonly output: T; readonly value: Readonly<Record<string, unknown>> }
  | { readonly valid: false; readonly reason: InvalidOutputReason; readonly issues: readonly OutputIssue[] };

/**
 * Validates an extracted, already-redacted value against the role's schema. `value` is what is
 * stored (and re-validated on a later delivery); `output` is the schema's parsed result.
 */
export function validateOutput<T>(schema: z.ZodType<T>, value: Readonly<Record<string, unknown>>): OutputVerdict<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { valid: true, output: parsed.data, value };
  return { valid: false, reason: 'OUTPUT_SCHEMA_MISMATCH', issues: summariseIssues(parsed.error.issues, value) };
}

/** The issue recorded for an answer that failed before schema validation. */
export function issueFor(reason: InvalidOutputReason): OutputIssue {
  switch (reason) {
    case 'OUTPUT_EMPTY':
      return { path: '(root)', code: 'empty', detail: 'the answer contained no JSON object' };
    case 'OUTPUT_NOT_ONE_JSON_OBJECT':
      return {
        path: '(root)',
        code: 'not_one_json_object',
        detail: 'answer with exactly one JSON object and nothing else',
      };
    case 'OUTPUT_TRUNCATED':
      return { path: '(root)', code: 'truncated', detail: 'the answer was cut off; answer more briefly' };
    case 'OUTPUT_TOO_LARGE':
      return { path: '(root)', code: 'too_large', detail: 'the answer was too large; answer more briefly' };
    case 'REPLY_UNREADABLE':
      return { path: '(root)', code: 'unreadable', detail: 'the answer could not be read' };
    case 'OUTPUT_SCHEMA_MISMATCH':
      return { path: '(root)', code: 'schema_mismatch' };
  }
}
