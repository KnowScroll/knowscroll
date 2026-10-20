import type { ScrollReadingObserver } from '../observer';
import { createVisibilityTracker, isVisibilityEvent, visibleFractionOf } from './visibility';

describe('visibleFractionOf', () => {
  it('is the share of the block inside the reading viewport', () => {
    expect(visibleFractionOf(100, 100, 0, 800)).toBe(1);
    expect(visibleFractionOf(100, 100, 150, 800)).toBe(0.5);
    expect(visibleFractionOf(100, 100, 0, 150)).toBe(0.5);
    expect(visibleFractionOf(100, 100, 400, 800)).toBe(0);
    expect(visibleFractionOf(1000, 100, 0, 800)).toBe(0);
  });

  it('counts a block taller than the viewport by its own area', () => {
    expect(visibleFractionOf(0, 1000, 0, 500)).toBe(0.5);
  });

  it('treats a block or viewport with no size as not visible', () => {
    expect(visibleFractionOf(10, 0, 0, 800)).toBe(0);
    expect(visibleFractionOf(10, 100, 0, 0)).toBe(0);
  });
});

describe('isVisibilityEvent', () => {
  it('reports a change of at least a tenth', () => {
    expect(isVisibilityEvent(0.3, 0.4)).toBe(true);
    expect(isVisibilityEvent(0.8, 0.65)).toBe(true);
  });

  it('ignores a smaller change that crosses nothing', () => {
    expect(isVisibilityEvent(0.3, 0.35)).toBe(false);
    expect(isVisibilityEvent(0.6, 0.65)).toBe(false);
    expect(isVisibilityEvent(0.7, 0.7)).toBe(false);
  });

  it('reports crossing 0, 0.5 and 1 however small the move', () => {
    expect(isVisibilityEvent(0, 0.02)).toBe(true);
    expect(isVisibilityEvent(0.03, 0)).toBe(true);
    expect(isVisibilityEvent(0.48, 0.52)).toBe(true);
    expect(isVisibilityEvent(0.52, 0.48)).toBe(true);
    expect(isVisibilityEvent(0.96, 1)).toBe(true);
    expect(isVisibilityEvent(1, 0.96)).toBe(true);
  });
});

function recorder() {
  const events: { blockId: string; visibleFraction: number; at: number }[] = [];
  const observer: ScrollReadingObserver = {
    onBlockVisibility: (event) => events.push(event),
    onBlockInteraction: () => undefined,
    onActivity: () => undefined,
  };
  let now = 0;
  const tracker = createVisibilityTracker(
    () => observer,
    () => (now += 10),
  );
  return { events, tracker };
}

describe('the visibility tracker', () => {
  it('always reports a block that mounts and one that unmounts (as 0)', () => {
    const { events, tracker } = recorder();

    tracker.mounted('intro', 0);
    tracker.mounted('chart', 0.4);
    tracker.unmounted('intro');

    expect(events.map(({ blockId, visibleFraction }) => [blockId, visibleFraction])).toEqual([
      ['intro', 0],
      ['chart', 0.4],
      ['intro', 0],
    ]);
  });

  it('reports a measurement only when it is an event, against the last one reported', () => {
    const { events, tracker } = recorder();
    tracker.mounted('intro', 0);

    tracker.measured('intro', 0.04);
    tracker.measured('intro', 0.08);
    tracker.measured('intro', 0.16);
    tracker.measured('intro', 0.2);
    tracker.measured('intro', 0.55);

    expect(events.map((event) => event.visibleFraction)).toEqual([0, 0.04, 0.16, 0.55]);
  });

  it('settles a fraction that is 1 in practice, and stamps every event with the monotonic clock', () => {
    const { events, tracker } = recorder();
    tracker.mounted('intro', 0);

    tracker.measured('intro', 0.9996);

    expect(events[1]?.visibleFraction).toBe(1);
    expect(events.map((event) => event.at)).toEqual([10, 20]);
  });

  it('is silent without an observer', () => {
    const tracker = createVisibilityTracker(
      () => undefined,
      () => 0,
    );
    expect(() => {
      tracker.mounted('intro', 0);
      tracker.measured('intro', 1);
      tracker.unmounted('intro');
    }).not.toThrow();
  });
});
