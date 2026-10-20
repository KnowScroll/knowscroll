import { AXIS_SLOP, HORIZONTAL_PAN, TWO_AXIS_PAN, classifyMove } from './arbitration';

describe('gesture arbitration', () => {
  it('leaves a movement undecided until it has travelled past the slop', () => {
    expect(classifyMove(0, 0)).toBe('undecided');
    expect(classifyMove(AXIS_SLOP - 1, 2)).toBe('undecided');
    expect(classifyMove(-3, AXIS_SLOP - 1)).toBe('undecided');
  });

  it('locks the axis the movement went furthest along: vertical reading wins a vertical movement', () => {
    expect(classifyMove(AXIS_SLOP, 0)).toBe('horizontal');
    expect(classifyMove(-30, 12)).toBe('horizontal');
    expect(classifyMove(4, AXIS_SLOP + 2)).toBe('vertical');
    expect(classifyMove(-12, -40)).toBe('vertical');
  });

  it('hands native gestures the same rule: active after the slop sideways, failed after the slop vertically', () => {
    expect(HORIZONTAL_PAN.activeOffsetX).toEqual([-AXIS_SLOP, AXIS_SLOP]);
    expect(HORIZONTAL_PAN.failOffsetY).toEqual([-AXIS_SLOP, AXIS_SLOP]);
  });

  it('lets a two-axis capture (a draggable token) start almost at once', () => {
    expect(TWO_AXIS_PAN.minDistance).toBeLessThan(AXIS_SLOP);
  });
});
