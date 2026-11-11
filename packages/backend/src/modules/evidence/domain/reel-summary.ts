import { intervalsLength, mergeIntervals, type Interval } from './intervals.js';
import type { ObservationRecord } from './reading-summary.js';

export const REEL_QUALIFICATION_POLICY_V0 = {
  version: 'reel-qualification.v0',
  minQ: 0.6,
  minInstrumentationVersion: 1,
} as const;

/**
 * Which media a Reel summary says was watched (#674, slice 5.1), recorded beside the qualification so a segment's
 * coverage can be judged later without the raw observations. It changes neither q nor the thresholds above.
 * Values are policy, not measurements: a new value is a new version.
 */
export const REEL_WATCHED_POLICY = {
  version: 'reel-watched.v1',
  /** Intervals are rounded inward to this grid, so what is recorded is never more than was watched. */
  gridMs: 100,
  /** The summary keeps at most this many intervals (the longest), a bound on a stored row. */
  maxIntervals: 32,
  /**
   * Watched media longer than the active time that could have produced it (by this ratio, plus the allowance) is not
   * attributed to any position: the reports overlap in wall time with different media positions, which one viewer
   * cannot do. The allowance covers the 100 ms a sample may exceed its own active time.
   */
  dwellRatio: 1.1,
  dwellAllowanceMs: 1000,
} as const;

/** The version of the Reel summary that carries `watched`. Earlier rows have no positions and bind no facet. */
export const REEL_SUMMARY_VERSION = 2;

/**
 * The unique media a viewer watched as disjoint `[from, to]` windows, rounded inward and bounded; empty when the
 * media reported cannot have been watched in the active time (see `REEL_WATCHED_POLICY`). Pure.
 */
export function watchedMedia(media: readonly Interval[], activeDwellMs: number): [number, number][] {
  const policy = REEL_WATCHED_POLICY;
  const merged = mergeIntervals(media);
  if (intervalsLength(merged) > activeDwellMs * policy.dwellRatio + policy.dwellAllowanceMs) return [];
  const rounded = merged
    .map(([from, to]): [number, number] => [
      Math.ceil(from / policy.gridMs) * policy.gridMs,
      Math.floor(to / policy.gridMs) * policy.gridMs,
    ])
    .filter(([from, to]) => to > from);
  return rounded
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]) || a[0] - b[0])
    .slice(0, policy.maxIntervals)
    .sort((a, b) => a[0] - b[0]);
}
/** Media coverage is a union, capped by both unique active wall time and admitted duration.
 * Missing samples or sequence gaps leave a short encounter unknown; an observed qualifying union
 * remains positive evidence. Sample boundaries exclude seeks, loops, buffering and hidden time. */
export function summariseReel(
  observations: readonly ObservationRecord[],
  durationMs: number,
  sessionElapsedMs?: number,
) {
  const media: Interval[] = [];
  const active: Interval[] = [];
  const activeBySession = new Map<string, Interval[]>();
  const sequences = new Map<string, Set<number>>();
  let watermark = 0;
  let instrumentation = Infinity;
  let reports = 0;
  for (const observation of observations) {
    watermark = Math.max(watermark, observation.seq);
    instrumentation = Math.min(instrumentation, observation.instrumentationVersion);
    const set = sequences.get(observation.sessionId) ?? new Set<number>();
    set.add(observation.deviceSequence);
    sequences.set(observation.sessionId, set);
    if (observation.body.kind !== 'reel.playback') continue;
    reports += 1;
    for (const sample of observation.body.samples) {
      const from = Math.max(0, sample.mediaMs[0]);
      const to = Math.min(durationMs, sample.mediaMs[1]);
      if (to > from) {
        media.push([from, to]);
        active.push(sample.activeMs);
        const intervals = activeBySession.get(observation.sessionId) ?? [];
        intervals.push(sample.activeMs);
        activeBySession.set(observation.sessionId, intervals);
      }
    }
  }
  if (sessionElapsedMs !== undefined && (!Number.isFinite(sessionElapsedMs) || sessionElapsedMs < 0))
    throw new Error('RECORDING_ELAPSED_INVALID');
  const activeDwellMs =
    sessionElapsedMs === undefined
      ? intervalsLength(mergeIntervals(active))
      : Math.floor(
          Math.min(
            sessionElapsedMs,
            [...activeBySession.values()].reduce(
              (sum, intervals) => sum + intervalsLength(mergeIntervals(intervals)),
              0,
            ),
          ),
        );
  const uniqueMediaMs = Math.min(intervalsLength(mergeIntervals(media)), activeDwellMs, durationMs);
  const q = Math.round((durationMs > 0 ? uniqueMediaMs / durationMs : 0) * 10000) / 10000;
  const gaps = [...sequences.values()].reduce((sum, set) => sum + Math.max(...set) - set.size, 0);
  const complete =
    uniqueMediaMs > 0 &&
    reports > 0 &&
    instrumentation >= REEL_QUALIFICATION_POLICY_V0.minInstrumentationVersion &&
    gaps === 0;
  const qualification = q >= REEL_QUALIFICATION_POLICY_V0.minQ ? 'qualified' : complete ? 'not_qualified' : 'unknown';
  return {
    inputWatermark: watermark,
    qualification,
    q,
    coverage: q,
    activeDwellMs,
    estimatedReadingMs: durationMs,
    summary: {
      v: REEL_SUMMARY_VERSION,
      uniqueMediaMs,
      durationMs,
      instrumentationVersion: Number.isFinite(instrumentation) ? instrumentation : 0,
      sequenceGaps: gaps,
      reports,
      watched: watchedMedia(media, activeDwellMs),
    },
  } as const;
}

export const REEL_RECORDING_QUALIFICATION_POLICY = {
  ...REEL_QUALIFICATION_POLICY_V0,
  version: 'reel-qualification.recording.v1',
} as const;
