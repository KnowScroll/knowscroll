import {
  dragOf,
  DRAG_SHOWS_AT,
  EDGE_ZONE,
  partMoveOf,
  pullProgress,
  PULL_DISTANCE,
  SWIPE_DISTANCE,
} from './part-gesture';

const drag = (dx: number, dy: number, rest: { startedAtEnd?: boolean; startX?: number; screenWidth?: number } = {}) =>
  partMoveOf({ dx, dy, startedAtEnd: false, ...rest });

describe('what a drag on the text of a Scroll means', () => {
  it('moves between Parts only on a clear sideways swipe: left is next, right is back', () => {
    expect(drag(-SWIPE_DISTANCE, 4)).toBe('next-part');
    expect(drag(SWIPE_DISTANCE + 20, -10)).toBe('previous-part');
    expect(drag(-(SWIPE_DISTANCE - 1), 0)).toBeUndefined();
    // Mostly vertical with some sideways drift is reading.
    expect(drag(-80, 120)).toBeUndefined();
  });

  it('never navigates on vertical reading, however far, unless it is a pull past the very end', () => {
    expect(drag(0, -400)).toBeUndefined();
    expect(drag(0, 400)).toBeUndefined();
    expect(drag(0, -PULL_DISTANCE, { startedAtEnd: false })).toBeUndefined();
  });

  it('takes a deliberate pull up from the end as a new topic, and nothing shorter or sideways', () => {
    expect(drag(0, -PULL_DISTANCE, { startedAtEnd: true })).toBe('next-topic');
    expect(drag(10, -(PULL_DISTANCE - 1), { startedAtEnd: true })).toBeUndefined();
    expect(drag(0, PULL_DISTANCE, { startedAtEnd: true })).toBeUndefined();
    expect(drag(90, -100, { startedAtEnd: true })).toBeUndefined();
  });

  it('leaves the platform edge zones to Back', () => {
    expect(drag(-100, 0, { startX: EDGE_ZONE - 1, screenWidth: 390 })).toBeUndefined();
    expect(drag(100, 0, { startX: 390 - EDGE_ZONE + 1, screenWidth: 390 })).toBeUndefined();
    expect(drag(-100, 0, { startX: 200, screenWidth: 390 })).toBe('next-part');
  });
});

describe('what a drag shows while it is under way', () => {
  const at = (dx: number, dy: number, startedAtEnd = false) => dragOf({ dx, dy, startedAtEnd });

  it('shows a Part only once the drag is clearly sideways and past a nudge', () => {
    expect(at(-(DRAG_SHOWS_AT - 1), 0)).toBeUndefined();
    expect(at(-DRAG_SHOWS_AT, 2)).toEqual({ kind: 'part', dx: -DRAG_SHOWS_AT });
    expect(at(40, -4)).toEqual({ kind: 'part', dx: 40 });
    expect(at(-40, 90)).toBeUndefined();
  });

  it('shows a pull only from the end, upward, and fills as far as the release distance', () => {
    expect(at(0, -48, true)).toEqual({ kind: 'pull', progress: 0.5 });
    expect(at(0, -300, true)).toEqual({ kind: 'pull', progress: 1 });
    expect(at(0, -48, false)).toBeUndefined();
    expect(at(0, 48, true)).toBeUndefined();
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(-PULL_DISTANCE)).toBe(1);
  });

  it('agrees with the release: a drag shown as a pull or a Part is what partMoveOf takes at the same place', () => {
    expect(at(0, -PULL_DISTANCE, true)).toEqual({ kind: 'pull', progress: 1 });
    expect(partMoveOf({ dx: 0, dy: -PULL_DISTANCE, startedAtEnd: true })).toBe('next-topic');
    expect(at(-SWIPE_DISTANCE, 0)).toEqual({ kind: 'part', dx: -SWIPE_DISTANCE });
    expect(partMoveOf({ dx: -SWIPE_DISTANCE, dy: 0, startedAtEnd: false })).toBe('next-part');
  });
});
