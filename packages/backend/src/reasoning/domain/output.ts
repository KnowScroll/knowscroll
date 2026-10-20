import type { z } from 'zod';

/**
 * Strict output handling for model answers (blueprint §15 "strictly validate the structured
 * proposal"): exactly one JSON object, bare or in one fenced block, then the role's schema. A
 * malformed answer is refused with structural issues only; nothing guesses a valid proposal from it.
 */

/** Largest answer text considered for extraction (UTF-16 code units, a cheap pre-parse bound). */
export const MAX_ANSWER_CHARS = 262_144;

/**
 * Deepest container nesting an answer may have (the answer object itself is level 1). A real
 * proposal is shallow; deeper input is refused as `OUTPUT_TOO_DEEP` before anything is redacted,
 * validated or stored, so the recording boundary's own depth bound is never what stands between a
 * credential and the ledger.
 */
export const MAX_ANSWER_DEPTH = 32;

/**
 * Whether `value` nests containers deeper than `limit` levels (the value itself is level 1 when
 * it is an object or array). Iterative, so hostile depth cannot overflow the stack. Pure.
 */
export function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const [current, depth] = frame;
    if (typeof current !== 'object' || current === null) continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}

/** Why an answer is not usable. Stable codes, recorded on the attempt as its outcome code. */
export type InvalidOutputReason =
  | 'OUTPUT_EMPTY'
  | 'OUTPUT_NOT_ONE_JSON_OBJECT'
  | 'OUTPUT_SCHEMA_MISMATCH'
  | 'OUTPUT_TRUNCATED'
  | 'OUTPUT_TOO_LARGE'
  | 'OUTPUT_TOO_DEEP'
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

type SyntaxCategory =
  | 'expected_property'
  | 'expected_comma_or_separator'
  | 'unterminated_string'
  | 'unexpected_end'
  | 'unexpected_token'
  | 'other';

/**
 * Only fixed engine prefixes are recognised; none of the message (which can contain a secret
 * key, token, URL or source snippet) is copied. Unknown engines fall back to `other`.
 * Node22's V8 templates: nodejs/node v22.23.0, deps/v8/src/common/message-template.h.
 */
function syntaxCategory(error: unknown): SyntaxCategory {
  if (!(error instanceof SyntaxError)) return 'other';
  const message = error.message;
  if (
    message.startsWith("Expected property name or '}' in JSON at position ") ||
    message.startsWith('Expected double-quoted property name in JSON at position ')
  )
    return 'expected_property';
  if (
    message.startsWith("Expected ',' or '}' after property value in JSON at position ") ||
    message.startsWith("Expected ',' or ']' after array element in JSON at position ") ||
    message.startsWith("Expected ':' after property name in JSON at position ")
  )
    return 'expected_comma_or_separator';
  if (message.startsWith('Unterminated string in JSON at position ')) return 'unterminated_string';
  if (message === 'Unexpected end of JSON input') return 'unexpected_end';
  if (
    message.startsWith('Unexpected token ') ||
    message.startsWith('Unexpected number in JSON at position ') ||
    message.startsWith('Unexpected string in JSON at position ') ||
    message.startsWith('Unexpected non-whitespace character after JSON at position ')
  )
    return 'unexpected_token';
  return 'other';
}

/**
 * Diagnose only an already-refused extraction. This does not recover JSON or change acceptance.
 * OutputIssue is the existing persisted/trusted feedback shape; only static enums and a bounded
 * UTF-16 character count are added. No reply/hash, error text, unexpected character, key, value or offset.
 * Legacy issueFor and already-stored issues stay unchanged, preserving old repair request bytes.
 */
export function issueForExtraction(reason: InvalidOutputReason, text: string): OutputIssue {
  const base = issueFor(reason);
  if (reason !== 'OUTPUT_NOT_ONE_JSON_OBJECT' || text.length > MAX_ANSWER_CHARS) return base;
  let candidate = text.trim();
  let framing: 'bare' | 'fenced' | 'invalid_fence' | 'embedded_fence' = 'bare';
  if (candidate.startsWith('```')) {
    const fenced = fencePattern.exec(candidate);
    if (fenced === null) framing = 'invalid_fence';
    else {
      framing = 'fenced';
      candidate = (fenced[1] ?? '').trim();
      if (candidate.includes('```')) framing = 'embedded_fence';
    }
  }
  const prefix = candidate.startsWith('{')
    ? 'object'
    : candidate.startsWith('[')
      ? 'array'
      : /^(?:"|-?\d|true(?:\s|$)|false(?:\s|$)|null(?:\s|$))/u.test(candidate)
        ? 'scalar'
        : 'other';
  let phase: 'framing' | 'syntax' = 'framing';
  let category: SyntaxCategory = 'other';
  if ((framing === 'bare' || framing === 'fenced') && prefix === 'object') {
    // A second built-in parse only classifies a refusal; its result is never returned or applied.
    // Incomplete object-shaped replies can fail the extractor's closing-brace guard before parse.
    try {
      JSON.parse(candidate);
    } catch (error) {
      phase =
        error instanceof SyntaxError &&
        error.message.startsWith('Unexpected non-whitespace character after JSON at position ')
          ? 'framing'
          : 'syntax';
      category = syntaxCategory(error);
    }
  }
  return {
    ...base,
    detail: `${base.detail}; json-refusal.v1 phase=${phase} framing=${framing} prefix=${prefix} category=${category} chars=${candidate.length}`,
  };
}

/**
 * One validator finding, as sent back to the model in a repair request and kept on the attempt.
 * Built from schema structure, role-declared static semantic codes/hints or fixed extraction
 * categories, never reply text or error messages.
 */
export interface OutputIssue {
  readonly path: string;
  readonly code: string;
  readonly detail?: string;
}

/** Most issues kept; the rest are counted in a final `more` entry. */
export const MAX_ISSUES = 8;

const safeSegment = /^[A-Za-z0-9_-]{1,32}$/;

/** Static, code-owned semantic feedback, never built from context or provider/user values. */
export type SafeCustomIssues = Readonly<Record<string, string>>;
const customCode = /^[a-z][a-z0-9_]{0,63}$/u;

/** Admission bound for the optional role catalogue; no custom feedback is enabled by default. */
export function validSafeCustomIssues(catalogue: SafeCustomIssues): boolean {
  if (typeof catalogue !== 'object' || catalogue === null || Array.isArray(catalogue)) return false;
  const keys = Reflect.ownKeys(catalogue);
  if (keys.length > 128) return false;
  return keys.every((code) => {
    if (typeof code !== 'string' || !customCode.test(code) || code === 'constructor' || code === 'prototype')
      return false;
    // Lookup consumes own properties: admission must inspect all of them without invoking getters.
    const descriptor = Object.getOwnPropertyDescriptor(catalogue, code);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false;
    const hint: unknown = descriptor.value;
    return typeof hint === 'string' && hint.length > 0 && hint.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(hint);
  });
}

function customFeedback(
  issue: Readonly<Record<string, unknown>>,
  catalogue: SafeCustomIssues | undefined,
): { readonly code: string; readonly detail: string } | undefined {
  if (issue['code'] !== 'custom' || catalogue === undefined) return undefined;
  const params = issue['params'];
  if (typeof params !== 'object' || params === null || !Object.hasOwn(params, 'safeCode')) return undefined;
  const code = (params as Readonly<Record<string, unknown>>)['safeCode'];
  if (
    typeof code !== 'string' ||
    !customCode.test(code) ||
    code === 'constructor' ||
    code === 'prototype' ||
    !Object.hasOwn(catalogue, code)
  )
    return undefined;
  return { code, detail: catalogue[code] as string };
}

/** The parts of a Zod 4 schema definition the path walk reads (`schema._zod.def`). */
interface SchemaDef {
  readonly type?: string;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly element?: unknown;
  readonly valueType?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly options?: readonly unknown[];
  readonly items?: readonly unknown[];
  readonly rest?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  readonly getter?: () => unknown;
}

function defOf(schema: unknown): SchemaDef | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const internals = (schema as { _zod?: { def?: SchemaDef } })._zod;
  return internals?.def;
}

/** Wrappers that do not change which keys a value has. */
const transparent = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional']);

/** What one path segment means in the schema: its label in the summary and the schema below it. */
interface Step {
  readonly label: string;
  readonly next: unknown;
}

/**
 * Resolves one path segment against a schema. Only names the SCHEMA declares are ever returned as
 * names (object shape keys); array and tuple positions are numeric indexes; the keys of a record
 * or map are chosen by the model, so they become the fixed placeholder `[key]`. Anything the walk
 * cannot resolve returns `undefined` (the caller prints `?`).
 */
function stepInto(schema: unknown, segment: PropertyKey, first: boolean, depth = 0): Step | undefined {
  let current = schema;
  for (let unwrap = 0; unwrap < 8; unwrap += 1) {
    const def = defOf(current);
    if (def === undefined) return undefined;
    if (def.type !== undefined && transparent.has(def.type)) current = def.innerType;
    else if (def.type === 'pipe') current = def.in;
    else if (def.type === 'lazy' && def.getter !== undefined) current = def.getter();
    else break;
  }
  const def = defOf(current);
  if (def === undefined || depth > 4) return undefined;
  switch (def.type ?? '') {
    case 'object':
      return typeof segment === 'string' &&
        safeSegment.test(segment) &&
        def.shape !== undefined &&
        Object.prototype.hasOwnProperty.call(def.shape, segment)
        ? { label: first ? segment : `.${segment}`, next: def.shape[segment] }
        : undefined;
    case 'array':
      return typeof segment === 'number' ? { label: `[${segment}]`, next: def.element } : undefined;
    case 'tuple':
      return typeof segment === 'number'
        ? { label: `[${segment}]`, next: def.items?.[segment] ?? def.rest }
        : undefined;
    case 'record':
    case 'map':
      return { label: '[key]', next: def.valueType };
    case 'union':
      for (const option of def.options ?? []) {
        const step = stepInto(option, segment, first, depth + 1);
        if (step !== undefined) return step;
      }
      return undefined;
    case 'intersection':
      return stepInto(def.left, segment, first, depth + 1) ?? stepInto(def.right, segment, first, depth + 1);
    default:
      return undefined;
  }
}

/**
 * The path of an issue in the summary: `(root)`, schema-declared key names joined by `.`,
 * numeric indexes as `[n]`, and `[key]` for a record's model-chosen keys. No string that came from
 * the answer is ever part of it: an unknown key (or one below something the walk cannot resolve)
 * is `?`. Without a schema every name is `?`.
 */
function pathOf(path: readonly PropertyKey[], schema?: unknown): string {
  if (path.length === 0) return '(root)';
  let current = schema;
  let text = '';
  path.slice(0, 6).forEach((segment, index) => {
    const step = current === undefined ? undefined : stepInto(current, segment, index === 0);
    current = step?.next;
    text += step?.label ?? (typeof segment === 'number' ? `[${segment}]` : index === 0 ? '?' : '.?');
  });
  return text;
}

function primitiveList(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined;
  const shown = values
    .slice(0, 5)
    .filter((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map((value) => (typeof value === 'string' && !safeSegment.test(value) ? '?' : String(value)));
  return shown.length === 0 ? undefined : shown.join(', ');
}

/**
 * A bound with its unit, which the schema knows and the model does not: "at most 4 characters",
 * "at least 1 item", "at most 10" (a number). A bare number would be ambiguous to the model.
 */
function bound(limit: number, origin: unknown, phrase: string): string {
  const plural = limit === 1 ? '' : 's';
  const unit =
    origin === 'string' ? ` character${plural}` : origin === 'array' || origin === 'set' ? ` item${plural}` : '';
  return `${phrase} ${limit}${unit}`;
}

function detailOf(issue: Readonly<Record<string, unknown>>): string | undefined {
  switch (issue['code']) {
    case 'invalid_type':
      return typeof issue['expected'] === 'string' ? `expected ${issue['expected']}` : undefined;
    case 'too_big':
      return typeof issue['maximum'] === 'number'
        ? bound(issue['maximum'], issue['origin'], issue['inclusive'] === false ? 'fewer than' : 'at most')
        : undefined;
    case 'too_small':
      return typeof issue['minimum'] === 'number'
        ? bound(issue['minimum'], issue['origin'], issue['inclusive'] === false ? 'more than' : 'at least')
        : undefined;
    // The received key names are never echoed: they come from the rejected answer.
    case 'unrecognized_keys':
      return 'unexpected keys';
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
 * Summarises schema issues for the model and the ledger. Bounded (`MAX_ISSUES`):
 * paths contain only names the role's schema declares, numeric indexes and the placeholder `[key]`
 * (`pathOf`), details come from the schema's expectations (types, bounds, allowed literals),
 * never from the issue message, received values or received key names. An opted-in custom issue
 * contributes only its role-declared static code/hint; its path uses the same masking.
 * A type issue at a path the answer does not have is reported as `missing` (a required field).
 */
export function summariseIssues(
  issues: readonly z.core.$ZodIssue[],
  value?: unknown,
  schema?: unknown,
  safeCustomIssues?: SafeCustomIssues,
): readonly OutputIssue[] {
  const summary: OutputIssue[] = issues.slice(0, MAX_ISSUES).map((issue) => {
    const record = issue as unknown as Readonly<Record<string, unknown>>;
    const custom = customFeedback(record, safeCustomIssues);
    if (custom !== undefined) return { path: pathOf(issue.path, schema), ...custom };
    const detail = detailOf(record);
    if (
      record['code'] === 'invalid_type' &&
      issue.path.length > 0 &&
      value !== undefined &&
      isAbsent(value, issue.path)
    )
      return {
        path: pathOf(issue.path, schema),
        code: 'missing',
        detail: `required${detail === undefined ? '' : `; ${detail}`}`,
      };
    const code = typeof record['code'] === 'string' && safeSegment.test(record['code']) ? record['code'] : 'invalid';
    return { path: pathOf(issue.path, schema), code, ...(detail === undefined ? {} : { detail }) };
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
export function validateOutput<T>(
  schema: z.ZodType<T>,
  value: Readonly<Record<string, unknown>>,
  safeCustomIssues?: SafeCustomIssues,
): OutputVerdict<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { valid: true, output: parsed.data, value };
  return {
    valid: false,
    reason: 'OUTPUT_SCHEMA_MISMATCH',
    issues: summariseIssues(parsed.error.issues, value, schema, safeCustomIssues),
  };
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
    case 'OUTPUT_TOO_DEEP':
      return { path: '(root)', code: 'too_deep', detail: `nest objects at most ${MAX_ANSWER_DEPTH} levels deep` };
    case 'REPLY_UNREADABLE':
      return { path: '(root)', code: 'unreadable', detail: 'the answer could not be read' };
    case 'OUTPUT_SCHEMA_MISMATCH':
      return { path: '(root)', code: 'schema_mismatch' };
  }
}
