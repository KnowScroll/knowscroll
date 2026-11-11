import type { FormatModel, InterestModel } from './interest.js';

/** The labels a stored decision can carry. A decision always replays under the policy it names. */
export type ComposerPolicyVersion =
  'composer-policy.v0' | 'composer-policy.v1' | 'composer-policy.v2' | 'composer-policy.v3';

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
   * cell is `(qualified + m * prior) / (measured + m)`, the prior being the rate of the person's other levels
   * (the (topic, kind) parent less this cell). `null` reads the (topic, kind) parent only (v0).
   */
  readonly formatCellPrior: number | null;
  /**
   * A Scroll drawn by exploration is replaced by a draw of a play level and then of a Scroll of it, so no level is
   * crowded out. Reels are not drawn by level, so the Reel/Scroll split of the pool is unchanged (v1).
   */
  readonly explorationByPlayLevel: boolean;
  /**
   * How the exploration branch is drawn. `one-in-ten` is the literal draw v0 and v1 were stored with (it equals their
   * `explorationFraction`, 0.10, and a stored decision must replay byte for byte); `by-fraction` reads
   * `explorationFraction` itself (v2), so changing the fraction changes the draw.
   */
  readonly explorationDraw: 'one-in-ten' | 'by-fraction';
  /**
   * What decides between candidates with equal scores. `lexical` is the immutable asset/revision order v0 and v1 were
   * stored with. `seeded-hash` orders them by a hash of the decision seed and the asset id (v2), so ties fall
   * differently for each person and each decision and stay reproducible from the stored seed.
   */
  readonly tieBreak: 'lexical' | 'seeded-hash';
  /**
   * Whether an explanation the person has already met is a soft score term (`novelty`, v0 and v1) or is left out of every
   * system-chosen offer while anything unseen is eligible, with a recorded last resort of the least recently met (`unseen-first`,
   * v2, #674 owner decision). Only a vertical move without an exact target is system-chosen; series, related, variant,
   * return and exact-target moves are the person's own and are never asked.
   */
  readonly encountered: 'score' | 'unseen-first';
  /**
   * How a topic's interest is scored. `null`: `A / (1 + A)` of the topic's own activity, 0.5 when the topic has no row (v0 to
   * v2). A model (v3, D-420): shrinkage toward the topic's system and the person's overall level, so a never-met topic of a
   * loved system scores above an unknown one and an old interest decays toward its prior, not below an unknown topic.
   */
  readonly interestModel: InterestModel | null;
  /**
   * How the format fit of a topic is learned. `null`: the topic's (kind, play level) cell shrunk toward its other levels, with
   * `formatCellPrior` (v0 to v2). A model (v3, D-420): topic, then system, then person, then a prior chosen by the candidate's
   * duration, so evidence of one format in a system informs a topic never read in it.
   */
  readonly formatModel: FormatModel | null;
  /**
   * The share of system-chosen first offers that are drawn from the format the person is not in, so that evidence of the other
   * format accrues where stickiness would never give it a chance (v3, D-420). The draw and its propensity are logged. 0 switches it off.
   * An explicit format request is never drawn against.
   */
  readonly formatExplorationFraction: number;
  /**
   * How retrieval is asked to read: named lanes with quotas and the person's top interest topics (`lanes`, v3), or the topic,
   * text and general lanes (`single`, v0 to v2). Retrieval is outside a frozen snapshot; the policy only says what to ask for,
   * and a candidate's lane is recorded in the snapshot.
   */
  readonly retrieval: 'single' | 'lanes';
  /**
   * How many of the person's top long-term interest topics a lane-reading retrieval asks for (the `continue` lane). 0 for a
   * policy that does not read lanes. Outside a frozen snapshot, like retrieval itself.
   */
  readonly interestTopK: number;
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
  explorationDraw: 'one-in-ten',
  tieBreak: 'lexical',
  encountered: 'score',
  interestModel: null,
  formatModel: null,
  formatExplorationFraction: 0,
  retrieval: 'single',
  interestTopK: 0,
});

/**
 * Policy v1 (D-190): a pull-up leaves the topic more often. The vertical Intent weight drops from 0.35
 * to 0.30, and a candidate whose topic the person met in their last three encounters pays a small penalty
 * (`recentTopic`, 0.05). Format is read per play level with shrinkage to the other levels' rate, and
 * exploration covers each play level. Horizontal moves are unchanged. The two numbers were chosen from
 * `composer replay-policy` over the stored decisions of dev (D-190); no v1 decision had been stored, so they
 * were set in place. A world makes decisions under v1 only where `KS_COMPOSER_POLICY=v1` is set (default `v0`).
 */
export const COMPOSER_POLICY_V1: ComposerPolicy = Object.freeze({
  ...COMMON,
  version: 'composer-policy.v1',
  vertical: Object.freeze({
    intent: 0.3,
    interest: 0.2,
    format: 0.15,
    novelty: 0.15,
    semanticFit: 0.15,
    recentRepetition: 0.25,
    recentTopic: 0.05,
  }),
  horizontal: COMPOSER_POLICY_V0.horizontal,
  recentTopicSpan: 3,
  formatCellPrior: 4,
  explorationByPlayLevel: true,
  explorationDraw: 'one-in-ten',
  tieBreak: 'lexical',
  encountered: 'score',
  interestModel: null,
  formatModel: null,
  formatExplorationFraction: 0,
  retrieval: 'single',
  interestTopK: 0,
});

/**
 * Policy v2 (#674, slice 1.2, D-408): a person always gets new content. Every number of v1 is kept; the rules change.
 * An explanation the person has already met (an activated exposure of its unit in either format) is left out of every
 * system-chosen offer while anything unseen is eligible, which are ranked as v1 ranks them (so a subject move still usually
 * leaves the topic, D-190); only when nothing unseen exists is the least recently met one offered, recorded. Exploration
 * draws only among the unseen, at the fraction this object holds, and equal scores are told apart by a seeded hash instead
 * of the asset id.
 * A world makes decisions under v2 only where `KS_COMPOSER_POLICY=v2` is set.
 */
export const COMPOSER_POLICY_V2: ComposerPolicy = Object.freeze({
  ...COMMON,
  version: 'composer-policy.v2',
  vertical: COMPOSER_POLICY_V1.vertical,
  horizontal: COMPOSER_POLICY_V1.horizontal,
  recentTopicSpan: COMPOSER_POLICY_V1.recentTopicSpan,
  formatCellPrior: COMPOSER_POLICY_V1.formatCellPrior,
  explorationByPlayLevel: true,
  explorationDraw: 'by-fraction',
  tieBreak: 'seeded-hash',
  encountered: 'unseen-first',
  interestModel: null,
  formatModel: null,
  formatExplorationFraction: 0,
  retrieval: 'single',
  interestTopK: 0,
});

/**
 * Policy v3 (#674, slices 4.2 and 5.2, D-420): long-term interest selects candidates, and format is learned with pooling.
 * Every rule and weight of v2 is kept (a person always gets new content, D-408); what changes is what the interest and format
 * features read and what retrieval is asked for. Interest is shrunk toward the topic's system and the person's overall level.
 * Format fit is estimated per topic, then system, then person, then a prior chosen by duration, and 5% of system-chosen first
 * offers are drawn from the format the person is not in, with the draw and its propensity logged, so evidence of the other
 * format accrues. Retrieval reads named lanes. The numbers are bench values for testing, not calibrated parameters; they were
 * compared with v2 by `composer replay-policy` before any world uses them. A world makes decisions under v3 only where
 * `KS_COMPOSER_POLICY=v3` is set.
 */
export const COMPOSER_POLICY_V3: ComposerPolicy = Object.freeze({
  ...COMPOSER_POLICY_V2,
  version: 'composer-policy.v3',
  interestModel: Object.freeze({
    base: 0.5,
    topicHalfSaturation: 1,
    systemHalfSaturation: 3,
    personHalfSaturation: 10,
    systemWeight: 0.5,
    personWeight: 0.1,
  }),
  formatModel: Object.freeze({
    personStrength: 8,
    systemStrength: 6,
    topicStrength: 4,
    cellStrength: 4,
    shortBelowMinutes: 3,
    longFromMinutes: 8,
    prior: Object.freeze({ short: 0.5, medium: 0.5, long: 0.5 }),
  }),
  formatExplorationFraction: 0.05,
  retrieval: 'lanes',
  interestTopK: 32,
});

/**
 * Which policy new decisions are made under (`KS_COMPOSER_POLICY`, D-190). It is chosen by configuration, so v1 is
 * not used before its numbers are: the default is `v0`. Replay never asks: a stored decision names its own policy.
 */
export type ComposerPolicySetting = 'v0' | 'v1' | 'v2' | 'v3';

export function composerPolicyFor(setting: ComposerPolicySetting): ComposerPolicy {
  return setting === 'v3'
    ? COMPOSER_POLICY_V3
    : setting === 'v2'
      ? COMPOSER_POLICY_V2
      : setting === 'v1'
        ? COMPOSER_POLICY_V1
        : COMPOSER_POLICY_V0;
}

const POLICIES: Readonly<Record<ComposerPolicyVersion, ComposerPolicy>> = {
  'composer-policy.v0': COMPOSER_POLICY_V0,
  'composer-policy.v1': COMPOSER_POLICY_V1,
  'composer-policy.v2': COMPOSER_POLICY_V2,
  'composer-policy.v3': COMPOSER_POLICY_V3,
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
/**
 * The tie-break of policy v2: FNV-1a over the decision seed and the asset id, so the order of equal scores differs per
 * seed (per person and decision) and is the same every time for the same seed. Pure; not a security hash.
 */
export function tieHash(seed: string, assetId: string): number {
  let state = 2166136261;
  for (const char of `${seed}\u0000${assetId}`) {
    state ^= char.codePointAt(0)!;
    state = Math.imul(state, 16777619);
  }
  // A final avalanche so that ids differing only in their last characters do not order the same way for every seed.
  state ^= state >>> 16;
  state = Math.imul(state, 2246822507);
  state ^= state >>> 13;
  state = Math.imul(state, 3266489909);
  state ^= state >>> 16;
  return state >>> 0;
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

/** A draw that succeeds with probability `fraction` (policy v2 exploration). The generator has 2^32 steps, so the error is below 2^-32. */
export function drawsWithin(random: () => number, fraction: number): boolean {
  return random() < fraction;
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
