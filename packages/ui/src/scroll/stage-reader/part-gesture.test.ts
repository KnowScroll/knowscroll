import { EDGE_ZONE, partMoveOf, PULL_DISTANCE, SWIPE_DISTANCE } from './part-gesture';

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
