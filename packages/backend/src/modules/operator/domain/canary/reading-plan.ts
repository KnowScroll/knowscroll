/**
 * How a reader's time on one Scroll or Reel becomes the observations the recorder sends (#674, D-413). The shapes
 * and bounds are those of the client recorder (`packages/client-core/src/recorder`): per-block visible intervals,
 * active dwell and value-free call interactions for a Scroll, one-second continuous playback samples for a Reel,
 * all in milliseconds since the reading began. A plan is derived from the document's own measures, and the server
 * judges qualification from what is reported, so a reader that is too quick is reported as such, never padded.
 * Pure: no clock, no I/O.
 */

/** A reading unit of a Scroll: a stop, a call or a v1 block, with the time its words take at the measures' pace. */
export interface ReadingUnit {
  readonly id: string;
  /** A call is counted when it is locked in or revealed, never by being visible alone. */
  readonly kind: 'read' | 'call';
  readonly nominalMs: number;
}

export interface ReadingSegment {
  readonly unitId: string;
  readonly kind: 'read' | 'call';
  readonly fromMs: number;
  readonly toMs: number;
}

export type CallInteraction = 'locked' | 'revealed';

export interface ReadingPlan {
  readonly segments: readonly ReadingSegment[];
  readonly interactions: readonly { readonly unitId: string; readonly kind: CallInteraction; readonly atMs: number }[];
  readonly durationMs: number;
}

/** A unit is never shown for less than this: above the qualification policy's own 500 ms visibility floor. */
export const MIN_UNIT_VIEW_MS = 600;
/** A call is looked at for this long: locked in after the first part, its reveal after the second. */
export const CALL_VIEW_MS = 3_000;
const CALL_LOCK_AT_MS = 1_500;
const CALL_REVEAL_AT_MS = 2_600;

/** Units read one after another, each for its share of the time its words take. */
export function planScrollReading(units: readonly ReadingUnit[], share: number): ReadingPlan {
  const segments: ReadingSegment[] = [];
  const interactions: { unitId: string; kind: CallInteraction; atMs: number }[] = [];
  let at = 0;
  for (const unit of units) {
    const length = unit.kind === 'call' ? CALL_VIEW_MS : Math.max(MIN_UNIT_VIEW_MS, Math.round(unit.nominalMs * share));
    segments.push({ unitId: unit.id, kind: unit.kind, fromMs: at, toMs: at + length });
    if (unit.kind === 'call') {
      interactions.push({ unitId: unit.id, kind: 'locked', atMs: at + CALL_LOCK_AT_MS });
      interactions.push({ unitId: unit.id, kind: 'revealed', atMs: at + CALL_REVEAL_AT_MS });
    }
    at += length;
  }
  return { segments, interactions, durationMs: at };
}

export type Interval = readonly [fromMs: number, toMs: number];

/** What one report carries for the time it covers: closed intervals and the interactions that happened in it. */
export interface ReadingWindow {
  readonly coverage: readonly { readonly unitId: string; readonly intervalsMs: readonly Interval[] }[];
  /** Active and at least one block visible. Contiguous time is one interval. */
  readonly dwell: readonly Interval[];
  readonly interactions: readonly { readonly unitId: string; readonly kind: CallInteraction; readonly atMs: number }[];
}

/** The part of the plan inside `(fromMs, toMs]`, intervals clipped to it. Reports tile time, so nothing repeats. */
export function readingWindow(plan: ReadingPlan, fromMs: number, toMs: number): ReadingWindow {
  const coverage: { unitId: string; intervalsMs: Interval[] }[] = [];
  const dwell: [number, number][] = [];
  for (const segment of plan.segments) {
    const from = Math.max(segment.fromMs, fromMs);
    const to = Math.min(segment.toMs, toMs);
    if (to <= from) continue;
    coverage.push({ unitId: segment.unitId, intervalsMs: [[from, to]] });
    const last = dwell.at(-1);
    if (last !== undefined && last[1] === from) last[1] = to;
    else dwell.push([from, to]);
  }
  return {
    coverage,
    dwell,
    interactions: plan.interactions.filter((interaction) => interaction.atMs > fromMs && interaction.atMs <= toMs),
  };
}

/** One second of playback, the recorder's sample: it never claims more media than active time. */
export const REEL_TICK_MS = 1_000;

export interface ReelSample {
  readonly activeMs: readonly [number, number];
  readonly mediaMs: readonly [number, number];
}

export interface ReelWatchPlan {
  readonly samples: readonly ReelSample[];
  readonly durationMs: number;
}

/** Continuous 1x playback from the start for `share` of the Reel's length, in one-second samples. */
export function planReelWatch(reelDurationMs: number, share: number): ReelWatchPlan {
  const watchedMs = Math.min(reelDurationMs, Math.max(REEL_TICK_MS, Math.round(reelDurationMs * share)));
  const samples: ReelSample[] = [];
  for (let from = 0; from < watchedMs; from += REEL_TICK_MS) {
    const to = Math.min(from + REEL_TICK_MS, watchedMs);
    samples.push({ activeMs: [from, to], mediaMs: [from, to] });
  }
  return { samples, durationMs: watchedMs };
}

/** The samples that ended inside `(fromMs, toMs]`. */
export function reelSamplesInWindow(plan: ReelWatchPlan, fromMs: number, toMs: number): readonly ReelSample[] {
  return plan.samples.filter((sample) => sample.activeMs[1] > fromMs && sample.activeMs[1] <= toMs);
}
