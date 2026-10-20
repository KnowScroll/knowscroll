import { OBSERVATION_LIMITS, READING_VISIBLE_FRACTION, SCROLL_INTERACTION_KINDS } from '@knowscroll/contracts';

/** `[fromMs, toMs)` since the recorder started. */
export type Interval = [from: number, to: number];

export type InteractionKind = (typeof SCROLL_INTERACTION_KINDS)[number];

/** What one report carries: closed time since the last report, ready to become events. */
export interface ReadingReport {
  readonly blocks: readonly {
    readonly blockId: string;
    readonly intervalsMs: readonly Interval[];
    readonly peakFraction: number;
  }[];
  /** When the article was active and at least one block was visible. */
  readonly activeIntervalsMs: readonly Interval[];
  readonly interactions: readonly { readonly blockId: string; readonly kind: InteractionKind; readonly atMs: number }[];
}

interface BlockState {
  /** The last visible fraction the renderer reported. */
  fraction: number;
  /** Start of the visible interval in progress (while active and at least the threshold), or null. */
  openSince: number | null;
  /** Closed intervals not yet reported. */
  intervals: Interval[];
  /** The largest fraction seen since the last report. */
  peak: number;
}

export interface ReadingTrackerOptions {
  /** Monotonic time the offsets are relative to (the recorder's start). */
  readonly startedAt: number;
  /** The fraction at which a block counts as visible; defaults to the contract's. */
  readonly visibleFraction?: number;
}

/**
 * Turns the renderer's observer calls into bounded time summaries (blueprint §18): per-block visible
 * intervals and active dwell, **only while the article is active**. A block is visible at a fraction
 * of at least the threshold; time while the article is inactive (app backgrounded, tab hidden, an
 * overlay open) belongs to no interval, so it can never become coverage. The tracker weights
 * nothing: the server computes coverage and q (blueprint §18 "Permanent topic scores ... never
 * calculated independently by the UI").
 *
 * Pure state machine: no timers, no I/O. Offsets are rounded to whole milliseconds, and an interval
 * that rounds to nothing is dropped. `report` hands out closed time and keeps what exceeds the
 * contract's per-event bounds for the next report, so no single event is too large.
 */
export class ReadingTracker {
  private readonly threshold: number;
  private readonly blocks = new Map<string, BlockState>();
  private readonly dwell: Interval[] = [];
  private dwellOpenSince: number | null = null;
  private active = true;
  private readonly reportedInteractions = new Set<string>();
  private readonly pendingInteractions: { blockId: string; kind: InteractionKind; atMs: number }[] = [];

  constructor(private readonly options: ReadingTrackerOptions) {
    this.threshold = options.visibleFraction ?? READING_VISIBLE_FRACTION;
  }

  private offset(at: number): number {
    return Math.max(0, Math.round(at - this.options.startedAt));
  }

  private visibleBlocks(): number {
    let count = 0;
    for (const state of this.blocks.values()) if (state.fraction >= this.threshold) count += 1;
    return count;
  }

  /** Closes an open interval at `at`, keeping it only when it has a length. */
  private close(list: Interval[], since: number, at: number): void {
    const from = this.offset(since);
    const to = this.offset(at);
    if (to > from) list.push([from, to]);
  }

  private syncDwell(at: number): void {
    const shouldBeOpen = this.active && this.visibleBlocks() > 0;
    if (shouldBeOpen && this.dwellOpenSince === null) this.dwellOpenSince = at;
    else if (!shouldBeOpen && this.dwellOpenSince !== null) {
      this.close(this.dwell, this.dwellOpenSince, at);
      this.dwellOpenSince = null;
    }
  }

  /** A block's visible fraction changed (a mount is a fraction, an unmount is 0). */
  visibility(event: { readonly blockId: string; readonly visibleFraction: number; readonly at: number }): void {
    const fraction = Math.min(1, Math.max(0, Number.isFinite(event.visibleFraction) ? event.visibleFraction : 0));
    let state = this.blocks.get(event.blockId);
    if (state === undefined) {
      state = { fraction: 0, openSince: null, intervals: [], peak: 0 };
      this.blocks.set(event.blockId, state);
    }
    state.fraction = fraction;
    state.peak = Math.max(state.peak, fraction);
    const visible = fraction >= this.threshold;
    if (this.active) {
      if (visible && state.openSince === null) state.openSince = event.at;
      else if (!visible && state.openSince !== null) {
        this.close(state.intervals, state.openSince, event.at);
        state.openSince = null;
      }
    }
    this.syncDwell(event.at);
  }

  /** The article became active or inactive; inactive time is never visible time. */
  activity(event: { readonly active: boolean; readonly at: number }): void {
    if (event.active === this.active) return;
    this.active = event.active;
    for (const state of this.blocks.values()) {
      if (!event.active && state.openSince !== null) {
        this.close(state.intervals, state.openSince, event.at);
        state.openSince = null;
      } else if (event.active && state.fraction >= this.threshold && state.openSince === null) {
        state.openSince = event.at;
      }
    }
    this.syncDwell(event.at);
  }

  /** A deliberate interaction: kept once per block and kind for the session. Never a value. */
  interaction(event: { readonly blockId: string; readonly kind: InteractionKind; readonly at: number }): void {
    if (!SCROLL_INTERACTION_KINDS.includes(event.kind)) return;
    const key = `${event.blockId}\u0000${event.kind}`;
    if (this.reportedInteractions.has(key)) return;
    this.reportedInteractions.add(key);
    this.pendingInteractions.push({ blockId: event.blockId, kind: event.kind, atMs: this.offset(event.at) });
  }

  /** Whether anything is waiting to be reported (closed time, an open interval, an interaction). */
  hasContent(): boolean {
    if (this.pendingInteractions.length > 0 || this.dwell.length > 0 || this.dwellOpenSince !== null) return true;
    for (const state of this.blocks.values()) if (state.intervals.length > 0 || state.openSince !== null) return true;
    return false;
  }

  /**
   * The closed time since the last report, up to the contract's per-event bounds. Intervals still
   * open are closed at `now` and reopened there, so a long read is reported as it goes. Anything
   * beyond the bounds stays for the next call (`hasMore`).
   */
  report(now: number): ReadingReport {
    for (const state of this.blocks.values()) {
      if (state.openSince !== null) {
        this.close(state.intervals, state.openSince, now);
        state.openSince = now;
      }
    }
    if (this.dwellOpenSince !== null) {
      this.close(this.dwell, this.dwellOpenSince, now);
      this.dwellOpenSince = now;
    }
    const blocks: { blockId: string; intervalsMs: Interval[]; peakFraction: number }[] = [];
    for (const [blockId, state] of this.blocks) {
      if (blocks.length >= OBSERVATION_LIMITS.maxBlocksPerCoverage) break;
      if (state.intervals.length === 0) continue;
      const taken = state.intervals.splice(0, OBSERVATION_LIMITS.maxIntervalsPerBlock);
      blocks.push({ blockId, intervalsMs: taken, peakFraction: roundFraction(state.peak) });
      if (state.intervals.length === 0) state.peak = state.fraction;
    }
    const activeIntervalsMs = this.dwell.splice(0, OBSERVATION_LIMITS.maxActiveIntervals);
    const interactions = this.pendingInteractions.splice(0, this.pendingInteractions.length);
    return { blocks, activeIntervalsMs, interactions };
  }

  /** Whether closed time beyond one event's bounds is still waiting (call `report` again). */
  hasMore(): boolean {
    if (this.dwell.length > 0) return true;
    for (const state of this.blocks.values()) if (state.intervals.length > 0) return true;
    return false;
  }
}

/** A fraction kept to three decimals: the contract takes a number in [0, 1], not a measurement. */
function roundFraction(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
