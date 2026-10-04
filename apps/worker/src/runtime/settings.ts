/** Env-setting readers shared by the worker entrypoints. Two deliberately different contracts:
 * `strictIntSetting` rejects a malformed value (the entrypoint turns that into an `invalid_config`
 * exit), `lenientIntSetting` clamps or falls back silently so the projection worker never refuses
 * to start over a typo. Do not merge them. */

/** Unset means `fallback`; anything that is not a positive base-10 integer in `min..max` throws
 * `invalid_config`. */
export function strictIntSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('invalid_config');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('invalid_config');
  return value;
}

/** Unset, non-numeric or zero falls back to `fallback`; the result is clamped to `min..max`
 * (`max` defaults to no upper bound). Never throws. */
export function lenientIntSetting(
  name: string,
  fallback: number,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  return Math.min(
    max,
    Math.max(min, Number(process.env[name] ?? fallback) || fallback),
  );
}
