/** Experimental activity.v0: routing signals, never learning or formation claims. */
export const ACTIVITY_POLICY = {
  version: 'activity.v0',
  halfLifeMs: 14 * 86400000,
  returnSeparationMs: 30 * 60000,
} as const;
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
