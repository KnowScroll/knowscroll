/**
 * A timestamp column as ISO-8601. Accepts a `Date` or anything `Date` can parse once stringified.
 * Callers that take only a `Date`, or that pass a non-string straight to `new Date`, keep their own
 * helpers because they behave differently for other inputs.
 */
export const toIsoString = (v: unknown) =>
  (v instanceof Date ? v : new Date(String(v))).toISOString();
