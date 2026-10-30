import { STILL_TIME_SECONDS } from './frame-clock';
import { createRenderLoop, type FrameScheduler } from './render-loop';

/** A scheduler the test drives by hand, one frame stamp at a time. */
function manualScheduler() {
  let pending: ((nowMs: number) => void) | null = null;
  let requests = 0;
  const scheduler: FrameScheduler = {
    request(callback) {
      pending = callback;
      requests += 1;
      return requests;
    },
    cancel() {
      pending = null;
    },
  };
  return {
    scheduler,
    pending: () => pending !== null,
    requests: () => requests,
    run(nowMs: number) {
      const callback = pending;
      pending = null;
      callback?.(nowMs);
    },
  };
}

describe('the render loop', () => {
  it('draws on accepted frames and schedules the next one', () => {
    const frames = manualScheduler();
    const drawn: number[] = [];
    const loop = createRenderLoop({ draw: (t) => drawn.push(t), reducedMotion: false, scheduler: frames.scheduler });
    loop.setActive(true);
    frames.run(1000);
    frames.run(1016);
    frames.run(1033);
    expect(drawn).toHaveLength(2);
    expect(drawn[1]).toBeCloseTo(0.033, 3);
    expect(frames.pending()).toBe(true);
  });

  it('schedules nothing while inactive, and resumes at the same scene time', () => {
    const frames = manualScheduler();
    const drawn: number[] = [];
    const loop = createRenderLoop({ draw: (t) => drawn.push(t), reducedMotion: false, scheduler: frames.scheduler });
    loop.setActive(true);
    frames.run(0);
    frames.run(40);
    loop.setActive(false);
    expect(frames.pending()).toBe(false);
    const before = drawn.at(-1)!;
    loop.setActive(true);
    frames.run(60_000);
    expect(drawn.at(-1)).toBe(before);
    expect(frames.pending()).toBe(true);
  });

  it('with reduced motion draws exactly one frame and starts no loop', () => {
    const frames = manualScheduler();
    const drawn: number[] = [];
    const loop = createRenderLoop({ draw: (t) => drawn.push(t), reducedMotion: true, scheduler: frames.scheduler });
    loop.setActive(true);
    loop.setActive(false);
    loop.setActive(true);
    expect(drawn).toEqual([STILL_TIME_SECONDS]);
    expect(frames.requests()).toBe(0);
  });

  it('redraws a reduced-motion view after a resize, still without a loop', () => {
    const frames = manualScheduler();
    const drawn: number[] = [];
    const loop = createRenderLoop({ draw: (t) => drawn.push(t), reducedMotion: true, scheduler: frames.scheduler });
    loop.setActive(true);
    loop.redraw();
    expect(drawn).toEqual([STILL_TIME_SECONDS, STILL_TIME_SECONDS]);
    expect(frames.requests()).toBe(0);
  });

  it('stops for good when disposed', () => {
    const frames = manualScheduler();
    const drawn: number[] = [];
    const loop = createRenderLoop({ draw: (t) => drawn.push(t), reducedMotion: false, scheduler: frames.scheduler });
    loop.setActive(true);
    loop.dispose();
    loop.setActive(true);
    frames.run(1000);
    expect(drawn).toHaveLength(0);
    expect(frames.pending()).toBe(false);
  });
});
