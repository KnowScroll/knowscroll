/**
 * The pinned unit circle: 64 samples round a full turn, from a table of the first quarter. No
 * engine-dependent transcendental maths (`Math.sin`, `Math.cos`) is used, so every sample is the
 * same number on every engine. `silhouette.v1` and the world generator (`worldmap.v1`) share it.
 */
const QUARTER_CIRCLE = [
  0, 0.0980171403295606, 0.19509032201612825, 0.29028467725446233, 0.3826834323650898, 0.47139673682599764,
  0.5555702330196022, 0.6343932841636455, 0.7071067811865475, 0.7730104533627369, 0.8314696123025452,
  0.8819212643483549, 0.9238795325112867, 0.9569403357322089, 0.9807852804032304, 0.9951847266721968, 1,
] as const;

/** Sine of `index` sixty-fourths of a turn. Any integer index is accepted: it wraps. */
export function sineSample(index: number): number {
  const sample = ((index % 64) + 64) % 64;
  if (sample <= 16) return QUARTER_CIRCLE[sample] ?? 0;
  if (sample <= 32) return QUARTER_CIRCLE[32 - sample] ?? 0;
  if (sample <= 48) return -(QUARTER_CIRCLE[sample - 32] ?? 0);
  return -(QUARTER_CIRCLE[64 - sample] ?? 0);
}

/** Cosine of `index` sixty-fourths of a turn. */
export function cosineSample(index: number): number {
  return sineSample(index + 16);
}
