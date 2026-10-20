export const COMPOSER_POLICY = Object.freeze({
  version: 'composer-policy.v0',
  fallback: 'lexical-admitted.v0',
  mmrLambda: 0.2,
  explorationFraction: 0.1,
  maxCandidates: 100,
  maxOffers: 3,
  recentLimit: 20,
  recentWindowMs: 86_400_000,
  decisionRetentionDays: 30,
} as const);
export function refKey(ref: { readonly assetId: string; readonly assetRevision: number }): string {
  return `${ref.assetId}@${String(ref.assetRevision)}`;
}
/** Versioned FNV-1a + xorshift32. Seed is decision input, not a security credential. */
export function randomSource(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
export function tokens(text: string): readonly string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 128);
}
export function overlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0.5;
  const left = new Set(a);
  const right = new Set(b);
  return [...left].filter((value) => right.has(value)).length / new Set([...left, ...right]).size;
}

/** Rejection sampling avoids modulo/floor bias, so branch and pool probabilities match the log. */
export function uniformIndex(random: () => number, size: number): number {
  const range = 4294967296;
  const ceiling = Math.floor(range / size) * size;
  let draw: number;
  do {
    draw = Math.floor(random() * range);
  } while (draw >= ceiling);
  return draw % size;
}
