/** The labels a stored decision can carry. A decision always replays under the policy it names. */
export type ComposerPolicyVersion = 'composer-policy.v0' | 'composer-policy.v1';

/** Weights of a vertical move's score. `recentRepetition` and `recentTopic` are penalties: they are subtracted. */
export interface VerticalWeights {
  readonly intent: number;
  readonly interest: number;
  readonly format: number;
  readonly novelty: number;
  readonly semanticFit: number;
  readonly recentRepetition: number;
  readonly recentTopic: number;
}

/** Weights of a horizontal (series or related) move's score. */
export interface HorizontalWeights {
  readonly continuity: number;
  readonly intent: number;
  readonly format: number;
  readonly semanticFit: number;
  readonly recentRepetition: number;
}

/**
 * One versioned set of Composer parameters (blueprint §8: parameters, not claims). A policy is data:
 * the pure rules read it, so a stored decision replays under exactly the policy it names.
 */
export interface ComposerPolicy {
  readonly version: ComposerPolicyVersion;
  readonly fallback: 'lexical-admitted.v0';
  readonly mmrLambda: number;
  readonly explorationFraction: number;
  readonly maxCandidates: number;
  readonly maxOffers: number;
  readonly recentLimit: number;
  readonly recentWindowMs: number;
  readonly decisionRetentionDays: number;
  readonly vertical: VerticalWeights;
  readonly horizontal: HorizontalWeights;
  /**
   * How many of the newest recent encounters the recent-topic repeat penalty looks at, with weights
   * `span, span-1, ..., 1`. Zero switches the penalty off (v0).
   */
  readonly recentTopicSpan: number;
  /**
   * Prior strength `m` of a play-level cell, in encounters: the Format of a (topic, kind, play level)
   * cell is `(qualified + m * parentFit) / (measured + m)`. `null` reads the (topic, kind) parent only (v0).
   */
  readonly formatCellPrior: number | null;
  /** Exploration picks a play level first, then a candidate of it, so no level is crowded out (v1). */
  readonly explorationByPlayLevel: boolean;
}

const COMMON = {
  fallback: 'lexical-admitted.v0',
  mmrLambda: 0.2,
  explorationFraction: 0.1,
  maxCandidates: 100,
  maxOffers: 3,
  recentLimit: 20,
  recentWindowMs: 86_400_000,
  decisionRetentionDays: 30,
} as const;

/** The first policy. Every decision stored before v1 names it and replays under it byte for byte. */
export const COMPOSER_POLICY_V0: ComposerPolicy = Object.freeze({
  ...COMMON,
  version: 'composer-policy.v0',
  vertical: Object.freeze({
    intent: 0.35,
    interest: 0.2,
    format: 0.15,
    novelty: 0.15,
    semanticFit: 0.15,
    recentRepetition: 0.25,
    recentTopic: 0,
  }),
  horizontal: Object.freeze({
    continuity: 0.45,
    intent: 0.25,
    format: 0.15,
    semanticFit: 0.15,
    recentRepetition: 0.25,
  }),
  recentTopicSpan: 0,
  formatCellPrior: null,
  explorationByPlayLevel: false,
});

/**
 * Policy v1 (D-190): a pull-up leaves the topic more often. The vertical Intent weight drops from 0.35
 * to 0.15, and a candidate whose topic the person met in their last three encounters pays a penalty
 * (`recentTopic`, as heavy as a repeated explanation). Format is read per play level with shrinkage to the
 * topic's rate, and exploration covers each play level. Horizontal moves are unchanged. These numbers are
 * provisional until `composer replay-policy` has been read on stored dev decisions.
 */
export const COMPOSER_POLICY_V1: ComposerPolicy = Object.freeze({
  ...COMMON,
  version: 'composer-policy.v1',
  vertical: Object.freeze({
    intent: 0.15,
    interest: 0.2,
    format: 0.15,
    novelty: 0.15,
    semanticFit: 0.15,
    recentRepetition: 0.25,
    recentTopic: 0.25,
  }),
  horizontal: COMPOSER_POLICY_V0.horizontal,
  recentTopicSpan: 3,
  formatCellPrior: 4,
  explorationByPlayLevel: true,
});

/** The policy new decisions are made under. */
export function currentComposerPolicy(): ComposerPolicy {
  return COMPOSER_POLICY_V1;
}

const POLICIES: Readonly<Record<ComposerPolicyVersion, ComposerPolicy>> = {
  'composer-policy.v0': COMPOSER_POLICY_V0,
  'composer-policy.v1': COMPOSER_POLICY_V1,
};

/** The policy a stored decision's label names. */
export function policyOf(version: ComposerPolicyVersion): ComposerPolicy {
  return POLICIES[version];
}

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
