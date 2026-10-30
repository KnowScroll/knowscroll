/**
 * The frame pacing rules of every space view (D-100). Pure: no timers, no GL, so they hold on
 * the web, on Hermes and in a unit test alike.
 */

/** A space view draws at most every 33 ms (a 30 fps cap). */
export const FRAME_INTERVAL_MS = 33;

/**
 * `requestAnimationFrame` stamps jitter around the display's vsync; a frame this much early still
 * counts, or a 60 Hz display would sometimes skip to 50 ms.
 */
const VSYNC_JITTER_MS = 1;

/** The drawing buffer is never denser than this many device pixels per layout pixel. */
export const MAX_PIXEL_RATIO = 1.5;

/** One frame never advances the scene by more than this, so a stall never makes a jump. */
export const MAX_STEP_SECONDS = 0.1;

/** The moment a reduced-motion view shows: a calm, composed frame of the scene. */
export const STILL_TIME_SECONDS = 4;

/** The scene's own time `t` and the stamp of the frame that produced it. */
export interface FrameClock {
  readonly t: number;
  readonly lastDrawMs: number | null;
}

/** A clock at `t` that has drawn nothing yet: the next stamp draws at once. */
export function startClock(t: number = 0): FrameClock {
  return { t, lastDrawMs: null };
}

/**
 * Decides whether a frame stamped `nowMs` is drawn, and the scene time to draw it at.
 * The first stamp after a start draws at the same `t`; later ones advance `t` by the elapsed
 * time clamped to {@link MAX_STEP_SECONDS}. A frame that comes too early changes nothing.
 */
export function advanceClock(clock: FrameClock, nowMs: number): { readonly draw: boolean; readonly clock: FrameClock } {
  if (clock.lastDrawMs === null) return { draw: true, clock: { t: clock.t, lastDrawMs: nowMs } };
  const elapsedMs = nowMs - clock.lastDrawMs;
  if (elapsedMs < FRAME_INTERVAL_MS - VSYNC_JITTER_MS) return { draw: false, clock };
  const stepSeconds = Math.min(Math.max(elapsedMs, 0) / 1000, MAX_STEP_SECONDS);
  return { draw: true, clock: { t: clock.t + stepSeconds, lastDrawMs: nowMs } };
}

/** The pixel ratio the drawing buffer uses on a display of `devicePixelRatio`. */
export function cappedPixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio < 1) return 1;
  return Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
}
