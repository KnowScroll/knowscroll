import type { ScrollReadingObserver } from '../observer';

/**
 * How much of a block's area is inside the reading viewport, in [0, 1]. A block with no height
 * is not visible.
 */
export function visibleFractionOf(
  blockTop: number,
  blockHeight: number,
  viewportTop: number,
  viewportHeight: number,
): number {
  if (!(blockHeight > 0) || !(viewportHeight > 0)) return 0;
  const top = Math.max(blockTop, viewportTop);
  const bottom = Math.min(blockTop + blockHeight, viewportTop + viewportHeight);
  const visible = Math.max(0, bottom - top);
  return Math.min(1, visible / blockHeight);
}

/** A reported change is worth an event when it moved by at least this much (spec of the observer). */
export const VISIBILITY_STEP = 0.1;

/** The fractions whose crossing is always reported. */
const THRESHOLDS = [0, 0.5, 1] as const;

/** Rounds away measurement noise so a fraction that is 1 in practice reports as 1. */
function settle(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.abs(clamped - 1) < 1e-3 ? 1 : Math.abs(clamped) < 1e-3 ? 0 : clamped;
}

function crossed(previous: number, next: number, threshold: number): boolean {
  // 0 means "any of the block is visible"; 0.5 and 1 mean "at least that much is visible".
  return threshold === 0 ? previous > 0 !== next > 0 : previous >= threshold !== next >= threshold;
}

/** Whether going from `previous` to `next` is an event: a move of ≥ 0.1, or a crossing of 0, 0.5 or 1. */
export function isVisibilityEvent(previous: number, next: number): boolean {
  if (Math.abs(next - previous) >= VISIBILITY_STEP - 1e-9) return true;
  return THRESHOLDS.some((threshold) => crossed(previous, next, threshold));
}

export interface VisibilityTracker {
  /** A block mounted, with the fraction it has now: always reported. */
  mounted(blockId: string, fraction: number): void;
  /** A block's visible fraction was measured again: reported only when it is an event. */
  measured(blockId: string, fraction: number): void;
  /** A block unmounted: reported as fraction 0. */
  unmounted(blockId: string): void;
}

/**
 * Turns measurements into the observer's visibility events (≥ 0.1 change, a crossing of 0, 0.5
 * or 1, mount, unmount). One place decides, so the web (IntersectionObserver) and native (layout
 * plus scroll offset) measurers report by the same rule. `clock` is a monotonic millisecond
 * clock (`performance.now()`).
 */
export function createVisibilityTracker(
  observer: () => ScrollReadingObserver | undefined,
  clock: () => number,
): VisibilityTracker {
  const reported = new Map<string, number>();
  const report = (blockId: string, fraction: number) => {
    reported.set(blockId, fraction);
    observer()?.onBlockVisibility({ blockId, visibleFraction: fraction, at: clock() });
  };
  return {
    mounted(blockId, fraction) {
      report(blockId, settle(fraction));
    },
    measured(blockId, fraction) {
      const next = settle(fraction);
      const previous = reported.get(blockId);
      if (previous === undefined || isVisibilityEvent(previous, next)) report(blockId, next);
    },
    unmounted(blockId) {
      reported.delete(blockId);
      observer()?.onBlockVisibility({ blockId, visibleFraction: 0, at: clock() });
    },
  };
}

/** The monotonic clock the observer's `at` fields use. */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
