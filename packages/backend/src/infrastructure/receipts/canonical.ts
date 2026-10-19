import { createHash } from 'node:crypto';

/** JSON values a command request may contain after validation. */
export type CanonicalJson =
  null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson | undefined };

/** Orders strings by Unicode code point (not UTF-16 code unit, which misorders astral characters). */
function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * Serialises a validated request deterministically: object keys sorted by Unicode code point, no
 * whitespace, `undefined` members omitted (so absent and `undefined` are the same, while `null` is
 * a value). Raw JSON property order therefore never makes two identical commands different
 * (blueprint §19). Refuses non-finite numbers and anything that is not plain JSON data (Dates,
 * class instances, Maps): those would silently serialise as `{}` and collide.
 */
export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${(value as readonly CanonicalJson[]).map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError(`Canonical JSON cannot contain a ${typeof value}`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Canonical JSON accepts plain objects only');
  const object = value as { readonly [key: string]: CanonicalJson | undefined };
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort(compareCodePoints);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as CanonicalJson)}`).join(',')}}`;
}

/**
 * The request hash stored with a receipt: SHA-256 over the operation name and the canonical
 * validated request (including the revisions it relied on).
 */
export function requestHash(operation: string, request: CanonicalJson): string {
  return createHash('sha256').update(operation).update('\n').update(canonicalJson(request)).digest('hex');
}
