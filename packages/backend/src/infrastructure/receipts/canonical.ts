import { createHash } from 'node:crypto';

/** JSON values a command request may contain after validation. */
export type CanonicalJson =
  null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson | undefined };

/**
 * Serialises a validated request deterministically: object keys sorted by code point, no
 * whitespace, `undefined` members omitted. Raw JSON property order therefore never makes two
 * identical commands different (blueprint §19). Non-finite numbers are refused.
 */
export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${(value as readonly CanonicalJson[]).map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as { readonly [key: string]: CanonicalJson | undefined };
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as CanonicalJson)}`).join(',')}}`;
}

/**
 * The request hash stored with a receipt: SHA-256 over the operation name and the canonical
 * validated request (including the revisions it relied on).
 */
export function requestHash(operation: string, request: CanonicalJson): string {
  return createHash('sha256').update(operation).update('\n').update(canonicalJson(request)).digest('hex');
}
