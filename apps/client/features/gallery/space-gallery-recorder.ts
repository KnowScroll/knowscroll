import type { SpaceFailure } from '../universe/space/space-surface';
import type { SpaceFrameSample } from '../universe/space/space-view';

/** What the gate tests read off `window.__ksSpace` (web) and the readout shows (native). */
export interface SpaceGalleryStats {
  readonly frames: number;
  /** Mean time between drawn frames in ms, or null before the second frame. */
  readonly meanIntervalMs: number | null;
  readonly minIntervalMs: number | null;
  readonly meanDrawMs: number | null;
  readonly lastProbe: { readonly litPixels: number; readonly sampledPixels: number; readonly signature: number } | null;
  readonly failure: SpaceFailure | null;
}

const KEPT_FRAMES = 240;

/**
 * Keeps the last frames of the gallery scene. Developer gallery only (the gallery is not in a
 * production export): the web smoke and the Android flow read the numbers it keeps.
 */
export class SpaceGalleryRecorder {
  private samples: SpaceFrameSample[] = [];
  private frameCount = 0;
  private probe: SpaceGalleryStats['lastProbe'] = null;
  private failureReason: SpaceFailure | null = null;

  record(sample: SpaceFrameSample): void {
    this.frameCount += 1;
    this.samples.push(sample);
    if (this.samples.length > KEPT_FRAMES) this.samples.shift();
    if (sample.probe !== undefined) this.probe = sample.probe;
  }

  fail(reason: SpaceFailure): void {
    this.failureReason = reason;
  }

  /** Forgets the frames kept so far (a test starts its measurement here). */
  reset(): void {
    this.samples = [];
  }

  stats(): SpaceGalleryStats {
    const stamps = this.samples.map((sample) => sample.atMs).filter((stamp) => stamp > 0);
    const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
    const mean = (values: readonly number[]): number | null =>
      values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      frames: this.frameCount,
      meanIntervalMs: mean(intervals),
      minIntervalMs: intervals.length === 0 ? null : Math.min(...intervals),
      meanDrawMs: mean(this.samples.map((sample) => sample.drawMs)),
      lastProbe: this.probe,
      failure: this.failureReason,
    };
  }

  /** The recorded frame stamps, for the tests that check pausing. */
  stamps(): number[] {
    return this.samples.map((sample) => sample.atMs);
  }
}
