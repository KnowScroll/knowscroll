import { advanceClock, startClock, type FrameClock } from '../space/frame-clock';
import type { FrameScheduler } from '../space/render-loop';

/** The five animations of the Universe tab (D-114 to D-116). */
export type AnimationKind =
  'first-open' | 'enter-system' | 'enter-planet' | 'enter-planet-rings' | 'enter-world' | 'step-up';

/** What is playing: the animation and where the one time value `t` stands, in seconds. */
export interface AnimationRun {
  readonly kind: AnimationKind;
  readonly seconds: number;
  readonly t: number;
}

export type AnimationEnd = 'finished' | 'skipped';

export interface AnimationPlayer {
  /** Starts an animation from `t = 0`, replacing one that is playing (which ends as `skipped`). */
  start(kind: AnimationKind, seconds: number): void;
  /** What is playing now, or none. */
  current(): AnimationRun | undefined;
  /** Jumps to the end frame and ends it: Skip, and Back while it plays. Does nothing when none plays. */
  finish(): void;
  /** Called after every frame of the playing animation, with its `t`. */
  subscribe(listener: (run: AnimationRun) => void): () => void;
  /** Called once when an animation ends, however it ended. */
  onEnd(listener: (kind: AnimationKind, how: AnimationEnd) => void): () => void;
  /** Stops without an end frame. */
  dispose(): void;
}

/**
 * The one time value behind an animation. `t` advances by the time between frame stamps, clamped to 0.1 s
 * so a stall never jumps the story, and a frame is accepted at most every 33 ms, the cap of every drawing
 * in the tab (D-100). It never reads a clock of its own: the stamps are the ones `requestAnimationFrame`
 * hands out, so a test supplies them. Everything an animation shows is a pure function of this `t`.
 */
export function createAnimationPlayer(scheduler: FrameScheduler): AnimationPlayer {
  let run: { kind: AnimationKind; seconds: number } | undefined;
  let clock: FrameClock = startClock(0);
  let handle: number | null = null;
  const frameListeners = new Set<(run: AnimationRun) => void>();
  const endListeners = new Set<(kind: AnimationKind, how: AnimationEnd) => void>();

  const snapshot = (): AnimationRun | undefined =>
    run === undefined ? undefined : { kind: run.kind, seconds: run.seconds, t: Math.min(clock.t, run.seconds) };
  const cancel = (): void => {
    if (handle !== null) scheduler.cancel(handle);
    handle = null;
  };
  const finishWith = (how: AnimationEnd): void => {
    if (run === undefined) return;
    const ended = run;
    clock = { t: ended.seconds, lastDrawMs: clock.lastDrawMs };
    const last = snapshot();
    cancel();
    // Cleared before anyone is told, so a listener that asks for the end again (a Skip that races the last frame) finds nothing to end.
    run = undefined;
    if (last !== undefined) for (const listener of [...frameListeners]) listener(last);
    for (const listener of [...endListeners]) listener(ended.kind, how);
  };
  const frame = (nowMs: number): void => {
    handle = null;
    if (run === undefined) return;
    const step = advanceClock(clock, nowMs);
    clock = step.clock;
    if (step.draw) {
      if (clock.t >= run.seconds) {
        finishWith('finished');
        return;
      }
      const current = snapshot();
      if (current !== undefined) for (const listener of [...frameListeners]) listener(current);
    }
    handle = scheduler.request(frame);
  };

  return {
    start(kind, seconds) {
      if (run !== undefined) finishWith('skipped');
      run = { kind, seconds };
      clock = startClock(0);
      handle = scheduler.request(frame);
    },
    current: snapshot,
    finish: () => finishWith('skipped'),
    subscribe(listener) {
      frameListeners.add(listener);
      return () => void frameListeners.delete(listener);
    },
    onEnd(listener) {
      endListeners.add(listener);
      return () => void endListeners.delete(listener);
    },
    dispose() {
      cancel();
      run = undefined;
      frameListeners.clear();
      endListeners.clear();
    },
  };
}
