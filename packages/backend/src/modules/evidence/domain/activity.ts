/** The labels a stored activity revision can carry. A revision is read under the rule it names. */
export type ActivityPolicyVersion = 'activity.v0' | 'activity.v1';

/** Experimental activity rules: routing signals, never learning or formation claims. */
export interface ActivityPolicy {
  readonly version: ActivityPolicyVersion;
  readonly halfLifeMs: number;
  readonly returnSeparationMs: number;
  /**
   * The least coverage the source of a deliberate continuation must have for the +1.5 continuation
   * credit (H) to count. `null`: it always counts (v0).
   */
  readonly continuationMinCoverage: number | null;
}

/** The first rule. Revisions stored under it keep their meaning and are not rewritten. */
export const ACTIVITY_POLICY_V0: ActivityPolicy = {
  version: 'activity.v0',
  halfLifeMs: 14 * 86400000,
  returnSeparationMs: 30 * 60000,
  continuationMinCoverage: null,
};

/**
 * activity.v1 (D-191), the rule new revisions are written under: swiping on to Part 2 and Part 3 without
 * reading gives no continuation credit. The credit (H, +1.5, more than a fully read q of 0.6) counts only when the
 * source of the move has coverage of at least 0.5, the same bar a reading must clear to qualify. The arithmetic is
 * unchanged.
 */
export const ACTIVITY_POLICY: ActivityPolicy = {
  ...ACTIVITY_POLICY_V0,
  version: 'activity.v1',
  continuationMinCoverage: 0.5,
};

/**
 * Whether a deliberate series or related move credits the exposure it left (the H channel). `coverage` is
 * the coverage of that exposure's reading, or `null` when no reading of it was measured, which cannot
 * clear a bar. Pure: the bar comes from the policy.
 */
export function continuationCredit(
  policy: Pick<ActivityPolicy, 'continuationMinCoverage'>,
  move: { readonly horizontal: boolean; readonly coverage: number | null },
): boolean {
  if (!move.horizontal) return false;
  if (policy.continuationMinCoverage === null) return true;
  return move.coverage !== null && move.coverage >= policy.continuationMinCoverage;
}
export interface ActivityChannels {
  readonly q: number | null;
  readonly L: boolean;
  readonly B: boolean;
  readonly S: 0;
  readonly H: boolean;
  readonly R: boolean;
}
export function activity(channels: ActivityChannels): number {
  if (channels.q !== null && (!Number.isFinite(channels.q) || channels.q < 0 || channels.q > 1))
    throw new Error('ACTIVITY_INVALID');
  return Math.min(
    3,
    (channels.q ?? 0) +
      0.5 * Number(channels.L) +
      1.5 * Number(channels.B) +
      channels.S +
      1.5 * Number(channels.H) +
      2 * Number(channels.R),
  );
}
export function decay(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new Error('ACTIVITY_TIME_INVALID');
  return Math.pow(2, -(toMs - fromMs) / ACTIVITY_POLICY.halfLifeMs);
}
/** Decay the old aggregate once and replace this encounter's old contribution at the SAME time. */
export function replaceContribution(input: {
  readonly aggregate: number;
  readonly aggregateAt: number;
  readonly evaluatedAt: number;
  readonly encounterAt: number;
  readonly previous: number;
  readonly next: number;
}): number {
  const { aggregate, aggregateAt, evaluatedAt, encounterAt, previous, next } = input;
  if ([aggregate, previous, next].some((n) => !Number.isFinite(n) || n < 0)) throw new Error('ACTIVITY_INVALID');
  return Math.max(0, aggregate * decay(aggregateAt, evaluatedAt) + (next - previous) * decay(encounterAt, evaluatedAt));
}
