import { createFrameMeter, describeFrames, ON_TIME_MS, WINDOW_MS } from './frame-meter';

/** Frames every `gapMs` from `fromMs`, each `drawMs` long. */
function steady(meter: ReturnType<typeof createFrameMeter>, fromMs: number, count: number, gapMs: number, drawMs = 4) {
  for (let index = 0; index < count; index += 1) meter.record({ atMs: fromMs + index * gapMs, drawMs });
  return fromMs + (count - 1) * gapMs;
}

describe('the frame meter', () => {
  it('reads a steady 30 fps loop as all on time', () => {
    const meter = createFrameMeter();
    const last = steady(meter, 1000, 120, 33.3);
    const summary = meter.summary(last)!;
    expect(summary.fps).toBeCloseTo(30, 0);
    expect(summary.onTime).toBe(1);
    expect(summary.longestMs).toBeCloseTo(33.3, 1);
    expect(summary.drawMs).toBe(4);
  });

  it('counts a frame that missed one refresh as on time and one that missed two as late', () => {
    const meter = createFrameMeter();
    meter.record({ atMs: 0, drawMs: 3 });
    meter.record({ atMs: 50, drawMs: 3 });
    meter.record({ atMs: 50 + ON_TIME_MS + 16, drawMs: 3 });
    const summary = meter.summary(200)!;
    expect(summary.onTime).toBe(0.5);
    expect(summary.longestMs).toBe(ON_TIME_MS + 16);
  });

  it('looks back two seconds only, and takes a long rest for the loop stopping, not a slow frame', () => {
    const meter = createFrameMeter();
    const last = steady(meter, 0, 60, 100, 9);
    steady(meter, last + 5000, 30, 33, 2);
    const summary = meter.summary(last + 5000 + 29 * 33)!;
    expect(summary.longestMs).toBe(33);
    expect(summary.drawMs).toBe(2);
  });

  it('has nothing to say when the loop drew no two frames in the window', () => {
    const meter = createFrameMeter();
    expect(meter.summary(0)).toBeNull();
    meter.record({ atMs: 10, drawMs: 1 });
    meter.record({ atMs: 40, drawMs: 1 });
    expect(meter.summary(40 + WINDOW_MS + 1)).toBeNull();
    expect(describeFrames(null)).toBe('No 3D frames in the last 2 s');
  });

  it('says it in one line', () => {
    expect(describeFrames({ fps: 29.4, onTime: 0.966, longestMs: 66.4, drawMs: 4.25 })).toBe(
      '29 fps · 97% on time · longest 66 ms · draw 4.3 ms',
    );
  });
});
