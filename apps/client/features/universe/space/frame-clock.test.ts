import {
  advanceClock,
  cappedPixelRatio,
  FRAME_INTERVAL_MS,
  MAX_PIXEL_RATIO,
  MAX_STEP_SECONDS,
  startClock,
} from './frame-clock';

describe('the 30 fps clock', () => {
  it('draws the first stamp at once without advancing the scene', () => {
    const step = advanceClock(startClock(2), 1000);
    expect(step.draw).toBe(true);
    expect(step.clock.t).toBe(2);
  });

  it('skips frames that come before the interval and keeps the clock as it was', () => {
    const first = advanceClock(startClock(), 1000).clock;
    const early = advanceClock(first, 1000 + 16.7);
    expect(early.draw).toBe(false);
    expect(early.clock).toBe(first);
  });

  it('draws on a 60 Hz display every second frame, about 33 ms apart', () => {
    let clock = startClock();
    const drawn: number[] = [];
    for (let frame = 0; frame < 61; frame++) {
      const stamp = 1000 + (frame * 1000) / 60;
      const step = advanceClock(clock, stamp);
      clock = step.clock;
      if (step.draw) drawn.push(stamp);
    }
    const gaps = drawn.slice(1).map((stamp, index) => stamp - drawn[index]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FRAME_INTERVAL_MS - 1);
    expect(drawn.length).toBeGreaterThanOrEqual(30);
    expect(drawn.length).toBeLessThanOrEqual(32);
  });

  it('never advances the scene by more than 0.1 s in one frame', () => {
    const first = advanceClock(startClock(), 0).clock;
    const afterStall = advanceClock(first, 5000);
    expect(afterStall.draw).toBe(true);
    expect(afterStall.clock.t).toBeCloseTo(MAX_STEP_SECONDS, 10);
  });
});

describe('pixel ratio', () => {
  it.each([
    [1, 1],
    [1.25, 1.25],
    [2, MAX_PIXEL_RATIO],
    [3.5, MAX_PIXEL_RATIO],
    [0, 1],
    [Number.NaN, 1],
  ])('a display of %s draws at %s', (display, expected) => {
    expect(cappedPixelRatio(display)).toBe(expected);
  });
});
