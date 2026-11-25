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

/** How far back frames are kept, milliseconds. */
const KEPT_MS = 6000;

/** How many of the last flights the readout keeps. */
export const LEGS_KEPT = 4;

/**
 * One flight of the camera, from the moment the person asked for it (a tap, a key, a pinch let go) to the landing.
 * Timed from the ask, not from the flight's first frame: a stall at the moment the place changes counts.
 */
export interface FlightLeg {
  /** Where it went, as the readout names it ("star", "planet again"). */
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Shader programs linked during the flight: each one can hold a frame back on a phone. */
  readonly programsLinked: number;
}

/** A flight as the readout shows it. */
export interface LegSummary {
  readonly label: string;
  /** Null when not two frames were drawn: a cut (reduced motion) or a flight too short to measure. */
  readonly frames: Pick<FrameSummary, 'onTime' | 'longestMs'> | null;
  readonly programsLinked: number;
}

/** Collects frames as the loop draws them and sums up the recent ones. */
export interface FrameMeter {
  /** Notes one drawn frame, and forgets those too old to matter. */
  readonly record: (frame: FrameTime) => void;
  /** The last {@link WINDOW_MS} before `nowMs`, or null when no two frames were drawn in it. */
  summary(nowMs: number): FrameSummary | null;
  /** Notes a flight that has landed; the frames it covers are summed now, while the meter still holds them. */
  readonly recordLeg: (leg: FlightLeg) => void;
  /** The last {@link LEGS_KEPT} flights, the newest first. */
  legs(): readonly LegSummary[];
}

/** The middle value of a non-empty list (the mean of the two middle ones when the count is even). */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * The stamps of the frames the loop drew, in order. A frame drawn outside the loop (a redraw when something changed,
 * the still frame of reduced motion) has no stamp of its own: it comes in at 0 (`SpaceView`'s `onFrameTime`), and is
 * left out, so it never makes a gap (two of them once read as a frame rate of Infinity).
 */
function loopStamps(frames: readonly FrameTime[]): number[] {
  const stamps: number[] = [];
  for (const frame of frames) {
    const last = stamps[stamps.length - 1];
    if (frame.atMs !== 0 && (last === undefined || frame.atMs > last)) stamps.push(frame.atMs);
  }
  return stamps;
}

/** A meter with no frames yet. It holds state: make it once, with `useState`, not `useMemo`. */
export function createFrameMeter(): FrameMeter {
  let frames: FrameTime[] = [];
  let legs: readonly LegSummary[] = [];
  /** The gaps of a flight: from the last frame before it was asked for, to the last frame before it landed. */
  const legGaps = (leg: FlightLeg): number[] => {
    const all = loopStamps(frames);
    const before = all.filter((stamp) => stamp <= leg.startMs).slice(-1);
    const stamps = [...before, ...all.filter((stamp) => stamp > leg.startMs && stamp <= leg.endMs)];
    return stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
  };
  return {
    record(frame) {
      frames.push(frame);
      // Keep more than the longest flight (4.4 s), so a flight's frames are all here when it lands; that is also more
      // than one window, whose first frame needs the one before for its gap.
      const oldest = frame.atMs - KEPT_MS;
      if (frames[0]!.atMs < oldest) frames = frames.filter((kept) => kept.atMs >= oldest);
    },
    summary(nowMs) {
      const start = nowMs - WINDOW_MS;
      const inWindow = (frame: FrameTime): boolean => frame.atMs > start && frame.atMs <= nowMs;
      const inside = frames.filter(inWindow);
      const gaps: number[] = [];
      const stamps = loopStamps(frames);
      for (let index = 1; index < stamps.length; index += 1) {
        const gap = stamps[index]! - stamps[index - 1]!;
        if (stamps[index]! > start && stamps[index]! <= nowMs && gap <= PAUSE_MS) gaps.push(gap);
      }
      if (gaps.length === 0) return null;
      return {
        fps: (gaps.length * 1000) / gaps.reduce((sum, gap) => sum + gap, 0),
        onTime: gaps.filter((gap) => gap <= ON_TIME_MS).length / gaps.length,
        longestMs: Math.max(...gaps),
        drawMs: median(inside.map((frame) => frame.drawMs)),
      };
    },
    recordLeg(leg) {
      const gaps = legGaps(leg);
      const frames =
        gaps.length === 0
          ? null
          : { onTime: gaps.filter((gap) => gap <= ON_TIME_MS).length / gaps.length, longestMs: Math.max(...gaps) };
      legs = [{ label: leg.label, frames, programsLinked: leg.programsLinked }, ...legs].slice(0, LEGS_KEPT);
    },
    legs: () => legs,
  };
}

/** One line per flight: "star · 100% · longest 33 ms", with "· 2 linked" when shader programs were linked in it. */
export function describeLegs(legs: readonly LegSummary[]): string {
  return legs
    .map((leg) => {
      const frames =
        leg.frames === null
          ? 'cut'
          : `${Math.round(leg.frames.onTime * 100)}% · longest ${Math.round(leg.frames.longestMs)} ms`;
      return `${leg.label} · ${frames}${leg.programsLinked > 0 ? ` · ${leg.programsLinked} linked` : ''}`;
    })
    .join('\n');
}

/** The readout's two short lines: "29 fps · 97% on time" and "longest 66 ms · draw 4.3 ms". */
export function describeFrames(summary: FrameSummary | null): string {
  if (summary === null) return `No 3D frames\nin the last ${WINDOW_MS / 1000} s`;
  return [
    `${Math.round(summary.fps)} fps · ${Math.round(summary.onTime * 100)}% on time`,
    `longest ${Math.round(summary.longestMs)} ms · draw ${summary.drawMs.toFixed(1)} ms`,
  ].join('\n');
}
