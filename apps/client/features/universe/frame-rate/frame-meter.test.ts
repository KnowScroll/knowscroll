import { createFrameMeter, describeFrames, describeLegs, LEGS_KEPT, ON_TIME_MS, WINDOW_MS } from './frame-meter';

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
    meter.record({ atMs: 10, drawMs: 3 });
    meter.record({ atMs: 60, drawMs: 3 });
    meter.record({ atMs: 60 + ON_TIME_MS + 16, drawMs: 3 });
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
    expect(describeFrames(null)).toBe('No 3D frames\nin the last 2 s');
  });

  it('never reads frames drawn outside the loop as a gap: two redraws with no stamp are not Infinity fps', () => {
    const meter = createFrameMeter();
    meter.record({ atMs: 0, drawMs: 2 });
    meter.record({ atMs: 0, drawMs: 2 });
    expect(meter.summary(500)).toBeNull();
    steady(meter, 600, 10, 33);
    meter.record({ atMs: 0, drawMs: 2 });
    steady(meter, 930, 10, 33);
    const summary = meter.summary(930 + 9 * 33)!;
    expect(Number.isFinite(summary.fps)).toBe(true);
    expect(summary.longestMs).toBe(33);
  });

  it('times a flight from the ask, so a stall at the ask counts, and keeps the last few, newest first', () => {
    const meter = createFrameMeter();
    steady(meter, 0, 10, 33);
    // Asked at 300; the first frame after it comes 400 ms after the frame before the ask.
    steady(meter, 697, 20, 33);
    meter.recordLeg({ label: 'star', startMs: 300, endMs: 697 + 19 * 33, programsLinked: 7 });
    const [leg] = meter.legs();
    expect(leg).toEqual({ label: 'star', frames: { onTime: 19 / 20, longestMs: 400 }, programsLinked: 7 });
    for (let index = 0; index < LEGS_KEPT + 2; index += 1)
      meter.recordLeg({ label: `leg ${index}`, startMs: 5000, endMs: 5001, programsLinked: 0 });
    expect(meter.legs().map((kept) => kept.label)).toEqual(['leg 5', 'leg 4', 'leg 3', 'leg 2']);
    expect(meter.legs()[0]!.frames).toBeNull();
  });

  it('says each flight in one line', () => {
    expect(
      describeLegs([
        { label: 'planet', frames: { onTime: 0.97, longestMs: 117.4 }, programsLinked: 0 },
        { label: 'star again', frames: null, programsLinked: 2 },
      ]),
    ).toBe('planet · 97% · longest 117 ms\nstar again · cut · 2 linked');
  });

  it('says it in two short lines', () => {
    expect(describeFrames({ fps: 29.4, onTime: 0.966, longestMs: 66.4, drawMs: 4.25 })).toBe(
      '29 fps · 97% on time\nlongest 66 ms · draw 4.3 ms',
    );
  });

  it('keeps the last line about the fingers, and has none before any touch', () => {
    const meter = createFrameMeter();
    expect(meter.gesture()).toBeNull();
    meter.recordGesture('ship held');
    meter.recordGesture('ship let go → CI system 2');
    expect(meter.gesture()).toBe('ship let go → CI system 2');
  });
});
