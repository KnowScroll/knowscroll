/**
 * The money rule of painted room backdrops (D-166). Amounts are whole millionths of a US dollar, so the arithmetic is
 * exact. The cap is code, not configuration: raising it is a reviewed change.
 */

/** One US dollar in total, across every room and every attempt. */
export const BACKDROP_SPEND_CAP_MICRO_USD = 1_000_000;

/**
 * What one image is estimated to cost, from the provider's published price. The estimate is recorded on every attempt,
 * whether the image is billed pay-as-you-go or drawn from a plan's quota, so the cap holds either way.
 */
export const BACKDROP_PRICING = {
  model: 'image-01',
  microUsdPerImage: 3_500,
  /** Where the price is published, and the day it was read there. Change both together. */
  sourceUrl: 'https://platform.minimax.io/docs/guides/pricing-paygo',
  checkedOn: '2026-10-31',
} as const;

/** The states of one image attempt, in the order they usually happen. `unknown` and `dispatched` are unresolved. */
export type BackdropAttemptState =
  'dispatched' | 'succeeded' | 'failed' | 'not_sent' | 'unknown' | 'reconciled' | 'written_off';

/** An attempt that may have reached the provider and has no outcome yet: nothing else may be sent for its room. */
export const isUnresolved = (state: BackdropAttemptState): boolean => state === 'dispatched' || state === 'unknown';

/**
 * What an attempt in this state counts against the cap. A call the provider refused, and one that never left, cost
 * nothing; every other state, including every unresolved one, keeps the whole estimate, so doubt never lowers the
 * total. Only an operator who has read the provider's own record settles an unknown attempt at nothing (`reconciled`).
 */
export function chargeOf(state: BackdropAttemptState, estimateMicroUsd: number): number {
  return state === 'failed' || state === 'not_sent' ? 0 : estimateMicroUsd;
}

export type SpendDecision =
  | { readonly kind: 'allowed'; readonly afterMicroUsd: number; readonly remainingMicroUsd: number }
  | { readonly kind: 'refused'; readonly recordedMicroUsd: number; readonly estimateMicroUsd: number };

/** Allowed only while the recorded total plus this estimate stays within the cap. */
export function decideSpend(
  recordedMicroUsd: number,
  estimateMicroUsd: number,
  capMicroUsd: number = BACKDROP_SPEND_CAP_MICRO_USD,
): SpendDecision {
  const afterMicroUsd = recordedMicroUsd + estimateMicroUsd;
  return afterMicroUsd > capMicroUsd
    ? { kind: 'refused', recordedMicroUsd, estimateMicroUsd }
    : { kind: 'allowed', afterMicroUsd, remainingMicroUsd: capMicroUsd - afterMicroUsd };
}
