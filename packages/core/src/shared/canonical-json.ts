/**
 * Canonical JSON: object keys in code-unit order at every depth, arrays in order, values as
 * `JSON.stringify` writes them. The hashes stored for model requests and read-set slices depend on
 * these bytes. The insertion-order serializers in packages/db's reasoning storage and policy
 * modules are different on purpose and must not be switched to this one.
 */

/** Stable key order, so equal inputs give equal bytes and therefore an equal reserved hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
