/**
 * The Universe's frame-rate readout, for checking speed on a real phone: what the drawing loop did over the last
 * {@link WINDOW_MS}. Pure, so the summary is the same on the web, on Hermes and in a test. It reaches the main bundle
 * (the readout wraps the screen), so it must never import three.js.
 */

/** One drawn frame: when it was drawn and how long `draw` took on the CPU (the GPU's share is not in it). */
export interface FrameTime {
  /** The frame's `requestAnimationFrame` stamp, milliseconds. */
  readonly atMs: number;
  readonly drawMs: number;
}

/** What the readout shows. */
export interface FrameSummary {
  /** Frames per second while the loop was drawing: a loop that rests because nothing moves is not slow. */
  readonly fps: number;
  /** The share of gaps between frames that were on time (at most {@link ON_TIME_MS}), 0 to 1. */
  readonly onTime: number;
  /** The longest gap between two frames, milliseconds. */
  readonly longestMs: number;
  /** The median CPU time of `draw`, milliseconds. */
  readonly drawMs: number;
}

/** How far back the readout looks. */
export const WINDOW_MS = 2000;

/**
 * A gap is on time when it is at most this long. The loop draws at most every 33 ms, so on a 60 Hz screen a
 * frame comes 33 or 50 ms after the last: one missed refresh is still on time, two are not.
 */
export const ON_TIME_MS = 51;

/** A gap longer than this is the loop resting (nothing moved, the screen was away), not a slow frame. */
const PAUSE_MS = 1000;

/** Collects frames as the loop draws them and sums up the recent ones. */
export interface FrameMeter {
  /** Notes one drawn frame, and forgets those too old to matter. */
  readonly record: (frame: FrameTime) => void;
  /** The last {@link WINDOW_MS} before `nowMs`, or null when no two frames were drawn in it. */
  summary(nowMs: number): FrameSummary | null;
}

/** The middle value of a non-empty list (the mean of the two middle ones when the count is even). */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** A meter with no frames yet. It holds state: make it once, with `useState`, not `useMemo`. */
export function createFrameMeter(): FrameMeter {
  let frames: FrameTime[] = [];
  return {
    record(frame) {
      frames.push(frame);
      // Keep a little more than one window: the first frame inside it needs the one before for its gap.
      const oldest = frame.atMs - WINDOW_MS * 2;
      if (frames[0]!.atMs < oldest) frames = frames.filter((kept) => kept.atMs >= oldest);
    },
    summary(nowMs) {
      const start = nowMs - WINDOW_MS;
      const inWindow = (frame: FrameTime): boolean => frame.atMs > start && frame.atMs <= nowMs;
      const inside = frames.filter(inWindow);
      const gaps: number[] = [];
      for (let index = 1; index < frames.length; index += 1) {
        const frame = frames[index]!;
        const gap = frame.atMs - frames[index - 1]!.atMs;
        if (inWindow(frame) && gap <= PAUSE_MS) gaps.push(gap);
      }
      if (gaps.length === 0) return null;
      return {
        fps: (gaps.length * 1000) / gaps.reduce((sum, gap) => sum + gap, 0),
        onTime: gaps.filter((gap) => gap <= ON_TIME_MS).length / gaps.length,
        longestMs: Math.max(...gaps),
        drawMs: median(inside.map((frame) => frame.drawMs)),
      };
    },
  };
}

/** The readout's two short lines: "29 fps · 97% on time" and "longest 66 ms · draw 4.3 ms". */
export function describeFrames(summary: FrameSummary | null): string {
  if (summary === null) return `No 3D frames\nin the last ${WINDOW_MS / 1000} s`;
  return [
    `${Math.round(summary.fps)} fps · ${Math.round(summary.onTime * 100)}% on time`,
    `longest ${Math.round(summary.longestMs)} ms · draw ${summary.drawMs.toFixed(1)} ms`,
  ].join('\n');
}
