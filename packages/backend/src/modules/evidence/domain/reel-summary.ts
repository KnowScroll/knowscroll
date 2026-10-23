import { intervalsLength, mergeIntervals, type Interval } from './intervals.js';
import type { ObservationRecord } from './reading-summary.js';

export const REEL_QUALIFICATION_POLICY_V0 = {
  version: 'reel-qualification.v0',
  minQ: 0.6,
  minInstrumentationVersion: 1,
} as const;
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
      v: 1,
      uniqueMediaMs,
      durationMs,
      instrumentationVersion: Number.isFinite(instrumentation) ? instrumentation : 0,
      sequenceGaps: gaps,
      reports,
    },
  } as const;
}

export const REEL_RECORDING_QUALIFICATION_POLICY = {
  ...REEL_QUALIFICATION_POLICY_V0,
  version: 'reel-qualification.recording.v1',
} as const;
