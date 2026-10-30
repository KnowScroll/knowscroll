import { advanceClock, startClock, STILL_TIME_SECONDS, type FrameClock } from './frame-clock';

/** The browser's `requestAnimationFrame` pair, or a test double. */
export interface FrameScheduler {
  request(callback: (nowMs: number) => void): number;
  cancel(handle: number): void;
}

export interface RenderLoopOptions {
  /** Draws the scene at time `t` (seconds). A scene is a pure function of `t`. */
  readonly draw: (t: number, nowMs: number) => void;
  /** Reduced motion: exactly one frame, no loop. */
  readonly reducedMotion: boolean;
  readonly scheduler: FrameScheduler;
}

/** Controls one space view's drawing; the owner tells it when the view may draw. */
export interface RenderLoop {
  /**
   * Whether the view may draw: it is on screen, its route is focused and the app is in the
   * foreground. Inactive means no frame is scheduled at all.
   */
  setActive(active: boolean): void;
  /**
   * The picture was cleared (a resize): under reduced motion draws the still again now, or, while
   * inactive, as soon as the view becomes active. With motion the loop redraws by itself.
   */
  redraw(): void;
  /** Stops for good. */
  dispose(): void;
}

/**
 * The one render loop of a space view. Normal motion draws on every `requestAnimationFrame` that
 * the 30 fps clock accepts; going inactive cancels the pending frame, and resuming continues from
 * the same scene time (no catch-up jump). Reduced motion draws one still frame when the view first
 * becomes active and never schedules a loop.
 */
export function createRenderLoop({ draw, reducedMotion, scheduler }: RenderLoopOptions): RenderLoop {
  let clock: FrameClock = startClock(reducedMotion ? STILL_TIME_SECONDS : 0);
  let handle: number | null = null;
  let active = false;
  let disposed = false;
  let stillDrawn = false;
  /** The still was drawn, then the canvas was cleared while the view could not draw. */
  let stillStale = false;

  const frame = (nowMs: number): void => {
    handle = null;
    if (!active || disposed) return;
    const step = advanceClock(clock, nowMs);
    clock = step.clock;
    if (step.draw) draw(clock.t, nowMs);
    handle = scheduler.request(frame);
  };

  const stopLoop = (): void => {
    if (handle !== null) scheduler.cancel(handle);
    handle = null;
  };

  return {
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (!next) {
        stopLoop();
        return;
      }
      if (reducedMotion) {
        if (!stillDrawn || stillStale) {
          stillDrawn = true;
          stillStale = false;
          draw(clock.t, 0);
        }
        return;
      }
      // Resuming: the first stamp draws at the same `t`, so a long pause never advances the scene.
      clock = startClock(clock.t);
      handle = scheduler.request(frame);
    },
    redraw() {
      if (disposed || !reducedMotion) return;
      if (active) draw(clock.t, 0);
      else if (stillDrawn) stillStale = true;
    },
    dispose() {
      disposed = true;
      active = false;
      stopLoop();
    },
  };
}
