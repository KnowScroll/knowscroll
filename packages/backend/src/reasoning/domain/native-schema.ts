import { z } from 'zod';

/** Advisory input shape only. The original role parser/refinements remain authoritative. */
export const NATIVE_SCHEMA_MODE = 'zod-structural.v1';
export const NATIVE_SCHEMA_LIMITS = {
  bytes: 32_768,
  nodes: 4096,
  depth: 24,
  referenceDepth: 32,
  references: 256,
  mapEntries: 256,
  alternatives: 64,
  stringChars: 1024,
} as const;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type NativeInputSchema = { readonly type: 'object'; readonly [key: string]: Json };

const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const names = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/u;
const localReference = /^#\/definitions\/([A-Za-z_$][A-Za-z0-9_$.-]{0,127})$/u;
const url = /(?:https?|file|data):|\/\//iu;
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'definitions',
  '$ref',
  'items',
  'additionalItems',
  'anyOf',
  'oneOf',
  'allOf',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks data before serialization; never invokes an accessor, evaluates a pattern or resolves a URL. */
function boundedJson(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  let nodes = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const [v, depth] = frame;
    if (++nodes > NATIVE_SCHEMA_LIMITS.nodes || depth > NATIVE_SCHEMA_LIMITS.depth) return false;
    if (typeof v === 'string') {
      if (v.length > NATIVE_SCHEMA_LIMITS.stringChars || url.test(v) || /[\p{Cc}\p{Cf}]/u.test(v)) return false;
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
    } else if (typeof v === 'object' && v !== null) {
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        return false;
      if (Object.getOwnPropertySymbols(v).length !== 0) return false;
      for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if (Array.isArray(v) && key === 'length') continue;
        if (!d.enumerable || !Object.hasOwn(d, 'value')) return false;
        stack.push([d.value as unknown, depth + 1]);
      }
    } else if (v !== null && typeof v !== 'boolean') return false;
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= NATIVE_SCHEMA_LIMITS.bytes;
}

/**
 * Narrow Draft 7 subset emitted by our Zod input conversion. Local definitions only; no metadata,
 * remote refs, recursive references, unknown vocabulary or permissive fallback for unsupported types.
 * Used again against frozen persisted request bytes before fetch, independently of the caller mode.
 */
export function isNativeInputSchema(value: unknown): value is NativeInputSchema {
  if (!boundedJson(value) || !object(value) || value['type'] !== 'object' || !object(value['properties'])) return false;
  const definitions = value['definitions'];
  if (definitions !== undefined && !object(definitions)) return false;
  let references = 0;
  const children = new Map<object, readonly unknown[]>();
  const check = (schema: unknown, root = false): boolean => {
    if (typeof schema === 'boolean') return true;
    if (!object(schema)) return false;
    const nested: unknown[] = [];
    children.set(schema, nested);
    for (const [key, v] of Object.entries(schema)) {
      if (!keywords.has(key)) return false;
      if (key === 'properties' || key === 'definitions') {
        if ((key === 'definitions' && !root) || !object(v) || Object.keys(v).length > NATIVE_SCHEMA_LIMITS.mapEntries)
          return false;
        for (const [name, child] of Object.entries(v)) {
          if (!names.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name) || !check(child))
            return false;
          // Definitions are traversed independently below; only referenced ones contribute to input depth.
          if (key === 'properties') nested.push(child);
        }
      } else if (key === '$ref') {
        if (typeof v !== 'string' || ++references > NATIVE_SCHEMA_LIMITS.references) return false;
        const ref = localReference.exec(v)?.[1];
        if (ref === undefined || !object(definitions) || !Object.hasOwn(definitions, ref)) return false;
        nested.push(definitions[ref]);
      } else if (key === 'type') {
        if (
          !(typeof v === 'string'
            ? types.has(v)
            : Array.isArray(v) &&
              v.length > 0 &&
              v.length <= types.size &&
              v.every((t: unknown) => typeof t === 'string' && types.has(t)))
        )
          return false;
      } else if (key === 'required') {
        if (
          !Array.isArray(v) ||
          v.length > NATIVE_SCHEMA_LIMITS.mapEntries ||
          v.some((n: unknown) => typeof n !== 'string' || !names.test(n)) ||
          new Set(v).size !== v.length
        )
          return false;
      } else if (key === 'enum') {
        if (
          !Array.isArray(v) ||
          v.length === 0 ||
          v.length > NATIVE_SCHEMA_LIMITS.mapEntries ||
          v.some((x: unknown) => typeof x === 'object' && x !== null)
        )
          return false;
      } else if (key === 'const') {
        if (typeof v === 'object' && v !== null) return false;
      } else if (key === 'pattern') {
        if (typeof v !== 'string') return false;
      } else if (['items', 'additionalItems', 'additionalProperties'].includes(key)) {
        const entries: readonly unknown[] = Array.isArray(v) && key === 'items' ? v : [v];
        if (entries.length > NATIVE_SCHEMA_LIMITS.alternatives || !entries.every((child: unknown) => check(child)))
          return false;
        nested.push(...entries);
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
        if (
          !Array.isArray(v) ||
          v.length === 0 ||
          v.length > NATIVE_SCHEMA_LIMITS.alternatives ||
          !v.every((child: unknown) => check(child))
        )
          return false;
        nested.push(...(v as unknown[]));
      } else if (
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        (['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key) && (!Number.isSafeInteger(v) || v < 0)) ||
        (key === 'multipleOf' && v <= 0)
      )
        return false;
    }
    return true;
  };
  if (!check(value, true)) return false;
  const heights = new Map<object, number>();
  const height = (node: unknown, path = new Set<object>()): number => {
    if (!object(node)) return 0;
    if (path.has(node)) return Infinity;
    const kept = heights.get(node);
    if (kept !== undefined) return kept;
    if (path.size >= NATIVE_SCHEMA_LIMITS.referenceDepth) return Infinity;
    const next = new Set(path).add(node);
    const result = 1 + Math.max(0, ...(children.get(node) ?? []).map((child) => height(child, next)));
    heights.set(node, result);
    return result;
  };
  return (
    height(value) <= NATIVE_SCHEMA_LIMITS.referenceDepth &&
    (!object(definitions) ||
      Object.values(definitions).every((schema) => height(schema) <= NATIVE_SCHEMA_LIMITS.referenceDepth))
  );
}

/** Never executes transforms/refinements or copies registry metadata into the provider request. */
export function deriveNativeInputSchema(schema: z.ZodType): NativeInputSchema | undefined {
  try {
    // Zod adds a non-enumerable ~standard executable helper to its returned root. Copy only
    // enumerable schema data; the strict JSON guard must still reject such helpers on inputs.
    const result = {
      ...z.toJSONSchema(schema, {
        target: 'draft-07',
        io: 'input',
        metadata: z.registry(),
        unrepresentable: 'throw',
        cycles: 'throw',
        reused: 'ref',
      }),
    };
    // The sole generated dialect URL is unnecessary on a tool input schema; all other URLs refuse.
    delete result.$schema;
    return isNativeInputSchema(result) ? result : undefined;
  } catch {
    // Fixed refusal only: converter errors can contain role schema/metadata and must not be recorded.
    return undefined;
  }
}
