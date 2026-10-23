import type { Interval } from './intervals.js';
import type { ObservationBounds } from './policy.js';

/**
 * Bounds a client-claimed wall-clock time. Future claims beyond the skew allowance are clamped to
 * the receive time (the event is kept; only the claim is corrected); events older than the maximum
 * age are refused. Pure.
 */
export function boundOccurredAt(
  occurredAt: Date,
  receivedAt: Date,
  bounds: ObservationBounds,
): { readonly kind: 'ok'; readonly occurredAt: Date; readonly clamped: boolean } | { readonly kind: 'too_old' } {
  if (receivedAt.getTime() - occurredAt.getTime() > bounds.maxEventAgeMs) return { kind: 'too_old' };
  if (occurredAt.getTime() - receivedAt.getTime() > bounds.maxFutureSkewMs)
    return { kind: 'ok', occurredAt: receivedAt, clamped: true };
  return { kind: 'ok', occurredAt, clamped: false };
}

/**
 * The largest recorder offset (ms since the recorder started) an honest client can claim at the
 * time of receipt: the recorder starts after activation, so no offset can exceed the wall time that
 * has passed since activation, plus a little slack. Durations are therefore bounded by elapsed wall
 * time (blueprint §6 "client claims are bounded"). Pure.
 */
export function elapsedCapMs(activatedAt: Date, receivedAt: Date, bounds: ObservationBounds): number {
  return Math.max(0, receivedAt.getTime() - activatedAt.getTime()) + bounds.elapsedToleranceMs;
}

/**
 * Clips claimed intervals to `[0, capMs]`: an interval that ends beyond the cap is shortened, one
 * that starts at or beyond it is dropped. `bounded` says whether any claim was corrected. Pure.
 */
export function boundIntervals(
  intervals: readonly Interval[],
  capMs: number,
): { readonly intervals: Interval[]; readonly bounded: boolean } {
  const kept: Interval[] = [];
  let bounded = false;
  for (const [from, to] of intervals) {
    if (from >= capMs) {
      bounded = true;
      continue;
    }
    if (to > capMs) {
      kept.push([from, capMs]);
      bounded = true;
    } else kept.push([from, to]);
  }
  return { intervals: kept, bounded };
}
